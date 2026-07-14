import { isJsonObject, type JsonObject, type JsonValue } from "../core/json.js";
import type { Logger } from "../core/logger.js";
import type {
  ModelCatalog,
  ModelRerouteEvent,
  RateLimitSnapshot,
  ThreadTokenUsage,
  TokenUsageBreakdown,
  TurnRunRequest,
  TurnRunResult,
} from "../core/types.js";
import { errorMessage, errorToJson } from "../core/errors.js";
import type { CounterlaneConfig } from "../config/types.js";
import { ApprovalController } from "./approvals.js";
import { parseModelCatalog, parseRateLimits } from "./catalog.js";
import { JsonRpcClient } from "./json-rpc.js";
import { StdioJsonRpcTransport } from "./transport.js";
import { COUNTERLANE_BUILD_ID } from "../identity.js";
import { COUNTERLANE_DEVELOPER_INSTRUCTIONS } from "./instructions.js";
import { throwIfAborted } from "../core/abort.js";
import { stableStringify } from "../core/utils.js";

export interface TurnCompletion {
  status: string;
  error?: JsonObject | null;
}

const MODEL_LIST_PAGE_SIZE = 100;
const MAX_MODEL_LIST_PAGES = 100;
const MAX_MODEL_LIST_ENTRIES = MODEL_LIST_PAGE_SIZE * MAX_MODEL_LIST_PAGES;
const MAX_MODEL_LIST_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_TURN_NOTIFICATIONS = 512;
const MAX_BUFFERED_TURN_NOTIFICATION_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_TURN_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_TURN_REROUTES = 512;

export class CodexAppServer {
  readonly #config: CounterlaneConfig;
  readonly #logger: Logger;
  readonly #transport: StdioJsonRpcTransport;
  readonly #rpc: JsonRpcClient;
  #planType: string | null = null;
  #initialized = false;

  private constructor(options: {
    config: CounterlaneConfig;
    logger: Logger;
    transport: StdioJsonRpcTransport;
    rpc: JsonRpcClient;
  }) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#transport = options.transport;
    this.#rpc = options.rpc;
    this.#rpc.on("error", (error: Error) => {
      this.#logger.warn("Codex App Server transport error", { error: errorMessage(error) });
    });
  }

  public static async connect(options: {
    config: CounterlaneConfig;
    cwd: string;
    logger: Logger;
    signal?: AbortSignal;
  }): Promise<CodexAppServer> {
    const transport = new StdioJsonRpcTransport({
      command: options.config.codex.command,
      args: options.config.codex.args,
      cwd: options.cwd,
      startupTimeoutMs: options.config.codex.startupTimeoutMs,
      shutdownTimeoutMs: options.config.codex.shutdownTimeoutMs,
      logger: options.logger.child({ component: "codex-transport" }),
    });
    await transport.start(options.signal);

    try {
      const rpc = new JsonRpcClient({
        transport,
        logger: options.logger.child({ component: "json-rpc" }),
        requestTimeoutMs: options.config.codex.requestTimeoutMs,
      });
      const approvalController = new ApprovalController({
        logger: options.logger.child({ component: "approvals" }),
      });
      rpc.setServerRequestHandler((method, params) => approvalController.handle(method, params));

      const server = new CodexAppServer({ config: options.config, logger: options.logger, transport, rpc });
      await server.#initialize(options.signal);
      return server;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  public get pid(): number | undefined {
    return this.#transport.pid;
  }

  public async listModels(signal?: AbortSignal): Promise<ModelCatalog> {
    const rawModels: JsonValue[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let rawModelBytes = 0;

    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
      const response = await this.#rpc.request(
        "model/list",
        { limit: MODEL_LIST_PAGE_SIZE, includeHidden: true, ...(cursor === undefined ? {} : { cursor }) },
        this.#config.codex.requestTimeoutMs,
        signal,
      );
      if (!isJsonObject(response) || !Array.isArray(response["data"])) {
        throw new Error("model/list returned a malformed page without a data array.");
      }
      rawModelBytes += Buffer.byteLength(JSON.stringify(response["data"]));
      if (rawModelBytes > MAX_MODEL_LIST_BYTES) {
        throw new Error(`model/list exceeded the ${MAX_MODEL_LIST_BYTES}-byte aggregate safety bound.`);
      }
      rawModels.push(...response["data"]);
      if (rawModels.length > MAX_MODEL_LIST_ENTRIES) {
        throw new Error(`model/list exceeded the ${MAX_MODEL_LIST_ENTRIES} entry safety bound.`);
      }

      const nextCursor = response["nextCursor"];
      if (nextCursor === undefined || nextCursor === null) {
        const parsed = parseModelCatalog({ data: rawModels });
        const byId = new Map<string, (typeof parsed.models)[number]>();
        for (const model of parsed.models) {
          const previous = byId.get(model.id);
          if (previous !== undefined && stableStringify(previous.raw) !== stableStringify(model.raw)) {
            throw new Error(`model/list returned conflicting duplicate entries for model id ${JSON.stringify(model.id)}.`);
          }
          byId.set(model.id, previous ?? model);
        }
        return { ...parsed, models: [...byId.values()] };
      }
      if (typeof nextCursor !== "string" || nextCursor.length === 0) {
        throw new Error("model/list returned an invalid nextCursor.");
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`model/list repeated cursor ${JSON.stringify(nextCursor)}.`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error(`model/list exceeded the ${MAX_MODEL_LIST_PAGES} page safety bound.`);
  }

  public async readRateLimits(signal?: AbortSignal): Promise<RateLimitSnapshot> {
    const response = await this.#rpc.request(
      "account/rateLimits/read",
      undefined,
      this.#config.codex.requestTimeoutMs,
      signal,
    ).catch((error: unknown) => {
      throwIfAborted(signal);
      this.#logger.warn("Rate-limit data is unavailable; paired and premium routes will fail closed", {
        error: errorMessage(error),
      });
      return {};
    });
    return parseRateLimits(response, this.#planType);
  }

  public async startThread(options: {
    cwd: string;
    modelId?: string;
    serviceTier?: string | null;
    ephemeral?: boolean;
  }): Promise<string> {
    const params: JsonObject = {
      cwd: options.cwd,
      approvalPolicy: this.#config.codex.approvalPolicy,
      sandbox: this.#config.codex.sandbox.type === "workspaceWrite" ? "workspace-write" : "read-only",
      serviceName: "counterlane_codex",
      developerInstructions: COUNTERLANE_DEVELOPER_INSTRUCTIONS,
      ephemeral: options.ephemeral ?? true,
    };
    if (options.modelId !== undefined) {
      params["model"] = options.modelId;
    }
    if (options.serviceTier !== undefined) {
      params["serviceTier"] = options.serviceTier;
    }
    const response = await this.#rpc.request("thread/start", params);
    return requireNestedString(response, ["thread", "id"], "thread/start response did not include thread.id");
  }

  public async resumeThread(threadId: string): Promise<void> {
    await this.#rpc.request("thread/resume", { threadId });
  }

  public async forkThread(options: {
    threadId: string;
    lastTurnId?: string;
    cwd?: string;
    modelId?: string;
    serviceTier?: string | null;
  }): Promise<string> {
    const params: JsonObject = {
      threadId: options.threadId,
      ephemeral: true,
      approvalPolicy: this.#config.codex.approvalPolicy,
      sandbox: this.#config.codex.sandbox.type === "workspaceWrite" ? "workspace-write" : "read-only",
      developerInstructions: COUNTERLANE_DEVELOPER_INSTRUCTIONS,
    };
    if (options.lastTurnId !== undefined) params["lastTurnId"] = options.lastTurnId;
    if (options.cwd !== undefined) params["cwd"] = options.cwd;
    if (options.modelId !== undefined) params["model"] = options.modelId;
    if (options.serviceTier !== undefined) params["serviceTier"] = options.serviceTier;
    const response = await this.#rpc.request("thread/fork", params);
    return requireNestedString(response, ["thread", "id"], "thread/fork response did not include thread.id");
  }

  public async deleteThread(threadId: string): Promise<void> {
    try {
      await this.#rpc.request("thread/delete", { threadId });
    } catch (error) {
      this.#logger.debug("Unable to delete ephemeral thread", { threadId, error: errorMessage(error) });
      throw error;
    }
  }

  public async runTurn(request: TurnRunRequest): Promise<TurnRunResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    if (request.signal?.aborted === true) {
      throw abortError(request.signal.reason);
    }

    let turnId: string | null = null;
    let latestDiff = "";
    let finalMessage = "";
    let streamedMessage = "";
    let tokenUsage: ThreadTokenUsage | undefined;
    const reroutes: ModelRerouteEvent[] = [];
    const warnings: string[] = [];
    let rawEventCount = 0;
    let completionResolve: ((value: TurnCompletion) => void) | null = null;
    let abortRequested = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let abortCompletionListener: (() => void) | undefined;
    const interruptPromises = new Map<string, Promise<void>>();
    let terminalNotificationObserved = false;
    let protocolContainment: Promise<void> | null = null;
    const buffered: Array<{ method: string; params: JsonValue | undefined; bytes: number }> = [];
    let bufferedBytes = 0;
    let retainedTextBytes = 0;
    let latestDiffBytes = 0;
    let finalMessageBytes = 0;
    let protocolFailure: Error | null = null;

    const completion = new Promise<TurnCompletion>((resolvePromise) => {
      completionResolve = resolvePromise;
    });

    const containProtocolFailure = (message: string): void => {
      if (protocolFailure !== null) return;
      protocolFailure = new Error(message);
      protocolFailure.name = "CodexProtocolError";
      warnings.push(message);
      completionResolve?.({ status: "failed", error: errorToJson(protocolFailure) });
      protocolContainment ??= this.close();
    };
    const reserveAdditionalText = (bytes: number): boolean => {
      if (retainedTextBytes + bytes <= MAX_RETAINED_TURN_TEXT_BYTES) {
        retainedTextBytes += bytes;
        return true;
      }
      containProtocolFailure(
        `Codex turn retained text exceeded the ${MAX_RETAINED_TURN_TEXT_BYTES}-byte safety bound.`,
      );
      return false;
    };
    const appendWarning = (message: string): void => {
      if (!reserveAdditionalText(Buffer.byteLength(message))) return;
      warnings.push(message);
    };
    const bufferNotification = (method: string, params: JsonValue | undefined): void => {
      const bytes = Buffer.byteLength(JSON.stringify([method, params ?? null]));
      if (
        buffered.length >= MAX_BUFFERED_TURN_NOTIFICATIONS ||
        bufferedBytes + bytes > MAX_BUFFERED_TURN_NOTIFICATION_BYTES
      ) {
        containProtocolFailure(
          `Codex turn emitted too much state before turn/start settled ` +
          `(maximum ${MAX_BUFFERED_TURN_NOTIFICATIONS} notifications and ${MAX_BUFFERED_TURN_NOTIFICATION_BYTES} bytes).`,
        );
        return;
      }
      buffered.push({ method, params, bytes });
      bufferedBytes += bytes;
    };
    const drainBuffered = (): void => {
      for (const event of buffered.splice(0, buffered.length)) {
        bufferedBytes -= event.bytes;
        processNotification(event.method, event.params);
      }
    };

    const processNotification = (method: string, paramsValue: JsonValue | undefined): void => {
      const params = isJsonObject(paramsValue) ? paramsValue : {};
      const eventThreadId = stringField(params, "threadId");
      if (method === "warning") {
        if (eventThreadId !== undefined && eventThreadId !== request.threadId) return;
        const message = stringField(params, "message");
        if (message !== undefined) appendWarning(message);
        rawEventCount += 1;
        return;
      }
      if (method === "error") {
        if (eventThreadId !== undefined && eventThreadId !== request.threadId) return;
        const errorTurnId = stringField(params, "turnId");
        if (turnId === null && errorTurnId !== undefined) {
          bufferNotification(method, paramsValue);
          return;
        }
        if (errorTurnId !== undefined && errorTurnId !== turnId) return;
        const error = isJsonObject(params["error"]) ? params["error"] : params;
        appendWarning(stringField(error, "message") ?? "Codex turn emitted an error.");
        rawEventCount += 1;
        return;
      }
      if (eventThreadId === undefined) {
        if (isTurnStateNotification(method)) {
          const message = `${method} notification omitted threadId; Counterlane closed the App Server to prevent cross-turn contamination.`;
          appendWarning(message);
          completionResolve?.({ status: "failed", error: { name: "CodexProtocolError", message } });
          protocolContainment ??= this.close();
        }
        return;
      }
      if (eventThreadId !== request.threadId) return;

      const eventTurnId = stringField(params, "turnId") ?? nestedString(params, ["turn", "id"]);
      if (eventTurnId === undefined) {
        if (isTurnStateNotification(method)) {
          const message = `${method} notification omitted turnId; Counterlane closed the App Server to prevent cross-turn contamination.`;
          appendWarning(message);
          completionResolve?.({ status: "failed", error: { name: "CodexProtocolError", message } });
          protocolContainment ??= this.close();
        }
        return;
      }
      if (turnId === null) {
        if (method === "turn/started") {
          rawEventCount += 1;
          // A caller can cancel while turn/start is still waiting for its RPC
          // response. Capture the streamed turn id so we can interrupt the
          // remote turn instead of orphaning it.
          turnId = eventTurnId;
          drainBuffered();
          if (abortRequested || isAborted(request.signal)) {
            void interrupt("Codex turn interrupted while turn/start was still settling.");
          }
        } else {
          bufferNotification(method, paramsValue);
        }
        return;
      }
      rawEventCount += 1;
      if (eventTurnId !== turnId) return;

      switch (method) {
        case "turn/diff/updated": {
          const diff = stringField(params, "diff");
          if (diff !== undefined) {
            const bytes = Buffer.byteLength(diff);
            retainedTextBytes -= latestDiffBytes;
            if (reserveAdditionalText(bytes)) {
              latestDiff = diff;
              latestDiffBytes = bytes;
            } else {
              retainedTextBytes += latestDiffBytes;
            }
          }
          break;
        }
        case "item/agentMessage/delta": {
          const delta = stringField(params, "delta");
          if (delta !== undefined) {
            const bytes = Buffer.byteLength(delta);
            if (reserveAdditionalText(bytes)) {
              streamedMessage += delta;
            }
          }
          break;
        }
        case "item/completed": {
          const item = isJsonObject(params["item"]) ? params["item"] : null;
          if (item?.["type"] === "agentMessage" && typeof item["text"] === "string") {
            const bytes = Buffer.byteLength(item["text"]);
            retainedTextBytes -= finalMessageBytes;
            if (reserveAdditionalText(bytes)) {
              finalMessage = item["text"];
              finalMessageBytes = bytes;
            } else {
              retainedTextBytes += finalMessageBytes;
            }
          }
          break;
        }
        case "thread/tokenUsage/updated": {
          const parsed = parseThreadTokenUsage(params["tokenUsage"]);
          if (parsed !== null) tokenUsage = parsed;
          break;
        }
        case "model/rerouted": {
          const fromModel = stringField(params, "fromModel");
          const toModel = stringField(params, "toModel");
          if (fromModel !== undefined && toModel !== undefined) {
            const reason = stringField(params, "reason");
            if (reroutes.length >= MAX_TURN_REROUTES) {
              containProtocolFailure(`Codex turn exceeded the ${MAX_TURN_REROUTES}-reroute safety bound.`);
              break;
            }
            const bytes = Buffer.byteLength(fromModel) + Buffer.byteLength(toModel) +
              (reason === undefined ? 0 : Buffer.byteLength(reason));
            if (reserveAdditionalText(bytes)) {
              reroutes.push({ fromModel, toModel, ...(reason === undefined ? {} : { reason }) });
            }
          }
          break;
        }
        case "turn/completed": {
          terminalNotificationObserved = true;
          const turn = isJsonObject(params["turn"]) ? params["turn"] : {};
          const parsed = parseTurnCompletion(turn);
          if (parsed.error?.["name"] === "CodexProtocolError") {
            appendWarning(String(parsed.error["message"]));
          }
          completionResolve?.(parsed);
          break;
        }
        default:
          break;
      }
    };

    const onNotification = (method: string, params: JsonValue | undefined): void => processNotification(method, params);
    const onExit = (details: JsonObject): void => {
      completionResolve?.({
        status: "failed",
        error: { name: "CodexAppServerExit", message: "Codex App Server exited during the turn.", details },
      });
    };
    const onRpcError = (error: Error): void => {
      completionResolve?.({ status: "failed", error: errorToJson(error) });
    };
    const interruptTurn = (remoteTurnId: string, reason: string): Promise<void> => {
      const pending = interruptPromises.get(remoteTurnId);
      if (pending !== undefined) return pending;
      appendWarning(reason);
      const interruptTimeoutMs = Math.max(
        1,
        Math.min(this.#config.codex.requestTimeoutMs, this.#config.codex.shutdownTimeoutMs),
      );
      const requestPromise = this.#rpc
        .request("turn/interrupt", { threadId: request.threadId, turnId: remoteTurnId }, interruptTimeoutMs)
        .then(() => undefined)
        .catch((error: unknown) => {
          appendWarning(`Unable to interrupt Codex turn ${remoteTurnId} cleanly: ${errorMessage(error)}`);
        });
      interruptPromises.set(remoteTurnId, requestPromise);
      return requestPromise;
    };
    const interrupt = (reason: string): Promise<void> => {
      if (turnId === null) return Promise.resolve();
      return interruptTurn(turnId, reason);
    };
    const waitForTerminalOrClose = async (warning: string): Promise<void> => {
      let terminalTimeoutHandle: NodeJS.Timeout | undefined;
      try {
        const terminalObserved = await Promise.race([
          completion.then(() => terminalNotificationObserved),
          new Promise<boolean>((resolvePromise) => {
            terminalTimeoutHandle = setTimeout(
              () => resolvePromise(false),
              this.#config.codex.shutdownTimeoutMs,
            );
            terminalTimeoutHandle.unref();
          }),
        ]);
        if (!terminalObserved) {
          appendWarning(warning);
          await this.close();
        }
      } finally {
        if (terminalTimeoutHandle !== undefined) clearTimeout(terminalTimeoutHandle);
      }
    };
    const onAbort = (): void => {
      abortRequested = true;
      void interrupt("Codex turn interrupted by caller cancellation.");
    };

    this.#rpc.on("notification", onNotification);
    this.#rpc.on("exit", onExit);
    this.#rpc.on("error", onRpcError);
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const params: JsonObject = {
        ...request.extraParams,
        threadId: request.threadId,
        input: [{ type: "text", text: request.prompt }],
        cwd: request.cwd,
        approvalPolicy: request.approvalPolicy,
        sandboxPolicy: request.sandboxPolicy as unknown as JsonObject,
        model: request.modelId,
        effort: request.effort,
      };
      if (request.serviceTier !== undefined) params["serviceTier"] = request.serviceTier;
      if (request.outputSchema !== undefined) params["outputSchema"] = request.outputSchema;

      // Do not locally cancel the JSON-RPC request after it has been sent. The
      // App Server has no generic request-cancellation primitive, so dropping
      // the pending response could orphan a turn. Caller cancellation is
      // translated into turn/interrupt as soon as either turn/started or the
      // turn/start response reveals the turn id.
      await request.beforeTurnStart?.();
      const response = await this.#rpc.request(
        "turn/start",
        params,
        this.#config.codex.requestTimeoutMs,
      );
      const responseTurnId = requireNestedString(response, ["turn", "id"], "turn/start response did not include turn.id");
      if (turnId !== null && turnId !== responseTurnId) {
        const streamedTurnId = turnId;
        const message = `turn/start response id ${responseTurnId} did not match streamed id ${streamedTurnId}.`;
        appendWarning(`${message} Counterlane interrupted both ids and closed the App Server.`);
        const containmentRequests = [
          interruptTurn(streamedTurnId, "Counterlane interrupted the streamed turn after a turn-id mismatch."),
          interruptTurn(responseTurnId, "Counterlane interrupted the response turn after a turn-id mismatch."),
        ];
        await Promise.all(containmentRequests);
        await this.close();
        return buildTurnResult({
          request,
          turnId: streamedTurnId,
          completed: {
            status: "failed",
            error: { name: "CodexProtocolError", message },
          },
          finalMessage,
          streamedMessage,
          latestDiff,
          tokenUsage,
          reroutes,
          warnings,
          startedAt,
          startedAtMs,
          rawEventCount,
        });
      }
      turnId = responseTurnId;
      drainBuffered();
      if (abortRequested || isAborted(request.signal)) {
        await interrupt("Codex turn interrupted before execution settled.");
      }

      const timeoutCompletion = new Promise<TurnCompletion>((resolvePromise) => {
        timeoutHandle = setTimeout(() => {
          resolvePromise({
            status: "interrupted",
            error: {
              name: "TurnTimeoutError",
              message: `Codex turn timed out after ${this.#config.codex.turnTimeoutMs} ms.`,
            },
          });
          void interrupt(`Codex turn exceeded ${this.#config.codex.turnTimeoutMs} ms and was interrupted.`);
        }, this.#config.codex.turnTimeoutMs);
        timeoutHandle.unref();
      });
      const abortCompletion = request.signal === undefined
        ? new Promise<TurnCompletion>(() => undefined)
        : new Promise<TurnCompletion>((resolvePromise) => {
            if (request.signal?.aborted === true) {
              resolvePromise({ status: "interrupted", error: errorToJson(abortError(request.signal.reason)) });
              return;
            }
            abortCompletionListener = () => {
              resolvePromise({ status: "interrupted", error: errorToJson(abortError(request.signal?.reason)) });
            };
            request.signal?.addEventListener("abort", abortCompletionListener, { once: true });
          });

      const completed = await Promise.race([completion, timeoutCompletion, abortCompletion]);
      if (protocolContainment !== null) await protocolContainment;
      if (completed.status === "interrupted" && turnId !== null) {
        const interruption = interrupt("Codex turn interruption was finalized by Counterlane.");
        await waitForTerminalOrClose(
          `Codex did not emit turn/completed within ${this.#config.codex.shutdownTimeoutMs} ms after interruption; closing the App Server to stop further mutations.`,
        );
        await interruption;
      }
      return buildTurnResult({
        request,
        turnId,
        completed,
        finalMessage,
        streamedMessage,
        latestDiff,
        tokenUsage,
        reroutes,
        warnings,
        startedAt,
        startedAtMs,
        rawEventCount,
      });
    } catch (error) {
      const knownTurnId = turnId;
      if (knownTurnId === null) {
        await this.close();
        throw protocolFailure ?? error;
      }
      appendWarning(`Codex turn failed: ${errorMessage(error)}`);
      const interruption = interrupt("Codex turn/start failed after the remote turn began; Counterlane interrupted it.");
      await waitForTerminalOrClose(
        `Codex did not emit turn/completed within ${this.#config.codex.shutdownTimeoutMs} ms after turn/start failed; closing the App Server to stop further mutations.`,
      );
      await interruption;
      return buildTurnResult({
        request,
        turnId: knownTurnId,
        completed: { status: abortRequested ? "interrupted" : "failed", error: errorToJson(error) },
        finalMessage,
        streamedMessage,
        latestDiff,
        tokenUsage,
        reroutes,
        warnings,
        startedAt,
        startedAtMs,
        rawEventCount,
      });
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      request.signal?.removeEventListener("abort", onAbort);
      if (abortCompletionListener !== undefined) {
        request.signal?.removeEventListener("abort", abortCompletionListener);
      }
      this.#rpc.off("notification", onNotification);
      this.#rpc.off("exit", onExit);
      this.#rpc.off("error", onRpcError);
    }
  }

  public async close(): Promise<void> {
    await this.#transport.close();
  }

  async #initialize(signal?: AbortSignal): Promise<void> {
    if (this.#initialized) {
      return;
    }
    const capabilities: JsonObject = {};
    if (this.#config.codex.experimentalApi) {
      capabilities["experimentalApi"] = true;
    }
    await this.#rpc.request("initialize", {
      clientInfo: {
        name: "counterlane",
        title: "Counterlane",
        version: COUNTERLANE_BUILD_ID,
      },
      ...(Object.keys(capabilities).length === 0 ? {} : { capabilities }),
    }, this.#config.codex.requestTimeoutMs, signal);
    this.#rpc.notify("initialized", {});
    this.#initialized = true;

    this.#rpc.on("notification:account/updated", (value: JsonValue | undefined) => {
      if (isJsonObject(value) && (typeof value["planType"] === "string" || value["planType"] === null)) {
        this.#planType = value["planType"];
      }
    });

    const account = await this.#rpc.request(
      "account/read",
      undefined,
      this.#config.codex.requestTimeoutMs,
      signal,
    ).catch(() => {
      throwIfAborted(signal);
      return null;
    });
    if (isJsonObject(account)) {
      const direct = account["planType"];
      const nested = isJsonObject(account["account"]) ? account["account"]["planType"] : undefined;
      if (typeof direct === "string" || direct === null) {
        this.#planType = direct;
      } else if (typeof nested === "string" || nested === null) {
        this.#planType = nested;
      }
    }
  }
}

function buildTurnResult(options: {
  request: TurnRunRequest;
  turnId: string;
  completed: TurnCompletion;
  finalMessage: string;
  streamedMessage: string;
  latestDiff: string;
  tokenUsage: ThreadTokenUsage | undefined;
  reroutes: ModelRerouteEvent[];
  warnings: string[];
  startedAt: string;
  startedAtMs: number;
  rawEventCount: number;
}): TurnRunResult {
  const completedAtMs = Date.now();
  return {
    threadId: options.request.threadId,
    turnId: options.turnId,
    status: options.completed.status,
    finalMessage: options.finalMessage.length > 0 ? options.finalMessage : options.streamedMessage,
    diff: options.latestDiff,
    ...(options.tokenUsage === undefined ? {} : { tokenUsage: options.tokenUsage }),
    reroutes: options.reroutes,
    warnings: options.warnings,
    ...(options.completed.error === undefined ? {} : { error: options.completed.error }),
    startedAt: options.startedAt,
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - options.startedAtMs,
    rawEventCount: options.rawEventCount,
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function abortError(reason: unknown): Error {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason.length > 0
      ? reason
      : "Operation aborted.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function parseThreadTokenUsage(value: JsonValue | undefined): ThreadTokenUsage | null {
  if (!isJsonObject(value) || !isJsonObject(value["total"]) || !isJsonObject(value["last"])) {
    return null;
  }
  const total = parseBreakdown(value["total"]);
  const last = parseBreakdown(value["last"]);
  if (total === null || last === null) {
    return null;
  }
  const contextWindow = value["modelContextWindow"];
  return {
    total,
    last,
    ...(
      contextWindow === null ||
      (typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0)
        ? { modelContextWindow: contextWindow }
        : {}
    ),
  };
}

function parseBreakdown(value: JsonObject): TokenUsageBreakdown | null {
  const fields = ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
  if (fields.some((field) => !Number.isSafeInteger(value[field]) || (value[field] as number) < 0)) {
    return null;
  }
  const parsed = {
    totalTokens: value["totalTokens"] as number,
    inputTokens: value["inputTokens"] as number,
    cachedInputTokens: value["cachedInputTokens"] as number,
    outputTokens: value["outputTokens"] as number,
    reasoningOutputTokens: value["reasoningOutputTokens"] as number,
  };
  if (
    parsed.cachedInputTokens > parsed.inputTokens ||
    parsed.reasoningOutputTokens > parsed.outputTokens ||
    parsed.totalTokens !== parsed.inputTokens + parsed.outputTokens
  ) {
    return null;
  }
  return parsed;
}

export function parseTurnCompletion(value: JsonObject): TurnCompletion {
  const status = stringField(value, "status");
  if (status === undefined || !["completed", "failed", "interrupted", "cancelled"].includes(status)) {
    return protocolFailure(
      status === undefined
        ? "turn/completed did not include a terminal turn.status."
        : `turn/completed included unsupported turn.status: ${status}`,
    );
  }
  const rawError = value["error"];
  if (rawError !== undefined && rawError !== null && !isJsonObject(rawError)) {
    return protocolFailure("turn/completed included a non-object turn.error value.");
  }
  const error = isJsonObject(rawError) ? rawError : rawError === null ? null : undefined;
  if (status === "completed" && error !== undefined && error !== null) {
    return protocolFailure("turn/completed reported status=completed together with a non-null error.");
  }
  return { status, ...(error === undefined ? {} : { error }) };
}

function protocolFailure(message: string): TurnCompletion {
  return {
    status: "failed",
    error: {
      name: "CodexProtocolError",
      message,
    },
  };
}

function requireNestedString(value: JsonValue, path: string[], message: string): string {
  const result = nestedString(isJsonObject(value) ? value : {}, path);
  if (result === undefined) {
    throw new Error(message);
  }
  return result;
}

function nestedString(object: JsonObject, path: string[]): string | undefined {
  let current: JsonValue = object;
  for (const segment of path) {
    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment] ?? null;
  }
  return typeof current === "string" ? current : undefined;
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

function isTurnStateNotification(method: string): boolean {
  return method === "turn/started" ||
    method === "turn/diff/updated" ||
    method === "item/agentMessage/delta" ||
    method === "item/completed" ||
    method === "thread/tokenUsage/updated" ||
    method === "model/rerouted" ||
    method === "turn/completed";
}
