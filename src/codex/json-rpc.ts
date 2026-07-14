import { EventEmitter } from "node:events";
import { CodexProtocolError, errorMessage } from "../core/errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../core/json.js";
import type { Logger } from "../core/logger.js";
import { MAX_TIMER_DELAY_MS } from "../core/utils.js";
import { hasId, hasMethod, type JsonRpcId } from "./protocol.js";
import { StdioJsonRpcTransport } from "./transport.js";

interface PendingRequest {
  method: string;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export type ServerRequestHandler = (method: string, params: JsonValue | undefined) => Promise<JsonValue>;

/**
 * JSON-RPC itself does not make requests idempotent. Keep this registry small
 * and pessimistic: only repeated observations are eligible for transparent
 * overload retry. State-creating methods must be reconciled by their caller
 * instead of being replayed with a new request id.
 */
const RETRY_SAFE_READ_METHODS = new Set([
  "model/list",
  "account/read",
  "account/rateLimits/read",
]);
const MAX_READ_RETRIES = 3;

export class JsonRpcClient extends EventEmitter {
  readonly #transport: StdioJsonRpcTransport;
  readonly #logger: Logger;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #nextId = 1;
  #serverRequestHandler: ServerRequestHandler | null = null;

  public constructor(options: {
    transport: StdioJsonRpcTransport;
    logger: Logger;
    requestTimeoutMs: number;
  }) {
    super();
    assertRequestTimeout(options.requestTimeoutMs);
    this.#transport = options.transport;
    this.#logger = options.logger;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#transport.on("message", (message: JsonObject) => {
      void this.#handleMessage(message).catch((error: unknown) => {
        this.#logger.warn("JSON-RPC message handling failed", { error: errorMessage(error) });
      });
    });
    this.#transport.on("exit", (details: JsonObject) => {
      this.#rejectAll(new CodexProtocolError("Codex App Server exited.", undefined, details));
      this.emit("exit", details);
    });
    this.#transport.on("error", (error: Error) => {
      this.#rejectAll(error);
      this.emit("error", error);
    });
  }

  public setServerRequestHandler(handler: ServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  public async request<T extends JsonValue = JsonValue>(
    method: string,
    params?: JsonValue,
    timeoutMs = this.#requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<T> {
    assertRequestTimeout(timeoutMs);
    const maximumAttempts = RETRY_SAFE_READ_METHODS.has(method) ? MAX_READ_RETRIES : 1;
    const deadlineMs = Date.now() + timeoutMs;
    throwIfAborted(signal);
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          throw new CodexProtocolError(`JSON-RPC request timed out: ${method}`, undefined, { method, timeoutMs });
        }
        return (await this.#requestOnce(method, params, remainingMs, signal)) as T;
      } catch (error) {
        const retryable = error instanceof CodexProtocolError && error.rpcCode === -32_001;
        if (!retryable || attempt === maximumAttempts) {
          throw error;
        }
        const backoffMs = 100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 75);
        if (Date.now() + backoffMs >= deadlineMs) {
          throw new CodexProtocolError(`JSON-RPC request timed out before retry: ${method}`, undefined, {
            method,
            timeoutMs,
            attempt,
          });
        }
        this.#logger.warn("Codex App Server is overloaded; retrying request", { method, attempt, backoffMs });
        await sleepWithSignal(backoffMs, signal);
      }
    }
    throw new CodexProtocolError(`Request failed after retries: ${method}`);
  }

  #requestOnce(
    method: string,
    params: JsonValue | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const id = this.#nextId++;
    const payload: JsonObject = { id, method };
    if (params !== undefined) {
      payload["params"] = params;
    }

    const promise = new Promise<JsonValue>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        if (pending !== undefined) this.#cleanupPending(id, pending);
        reject(new CodexProtocolError(`JSON-RPC request timed out: ${method}`, undefined, { method, timeoutMs }));
      }, timeoutMs);
      timer.unref();
      const onAbort = signal === undefined ? undefined : (): void => {
        const pending = this.#pending.get(id);
        if (pending !== undefined) this.#cleanupPending(id, pending);
        reject(abortError(signal.reason));
      };
      this.#pending.set(id, {
        method,
        resolve: resolvePromise,
        reject,
        timer,
        ...(signal === undefined ? {} : { signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
      });
      signal?.addEventListener("abort", onAbort as () => void, { once: true });
      if (signal?.aborted === true) onAbort?.();
    });

    if (!this.#pending.has(id)) return promise;
    try {
      this.#transport.send(payload);
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#cleanupPending(id, pending);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return promise;
  }

  public notify(method: string, params?: JsonValue): void {
    const payload: JsonObject = { method };
    if (params !== undefined) {
      payload["params"] = params;
    }
    this.#transport.send(payload);
  }

  async #handleMessage(message: JsonObject): Promise<void> {
    if (hasId(message) && !hasMethod(message)) {
      this.#handleResponse(message);
      return;
    }

    if (hasId(message) && hasMethod(message)) {
      await this.#handleServerRequest(message.id, message.method, message["params"]);
      return;
    }

    if (hasMethod(message)) {
      this.emit("notification", message.method, message["params"]);
      this.emit(`notification:${message.method}`, message["params"]);
      return;
    }

    this.#logger.warn("Ignoring unrecognized JSON-RPC message", { message });
  }

  #handleResponse(message: JsonObject & { id: JsonRpcId }): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      this.#logger.debug("Received response for unknown JSON-RPC id", { id: message.id });
      return;
    }
    this.#cleanupPending(message.id, pending);

    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    if (hasResult === hasError) {
      pending.reject(new CodexProtocolError(
        `Malformed JSON-RPC response for ${pending.method}: expected exactly one of result or error.`,
        undefined,
        { method: pending.method, response: message },
      ));
      return;
    }

    if (hasError) {
      if (!isJsonObject(message["error"])) {
        pending.reject(new CodexProtocolError(
          `Malformed JSON-RPC error response for ${pending.method}.`,
          undefined,
          { method: pending.method, response: message },
        ));
        return;
      }
      const errorObject = message["error"];
      const code = typeof errorObject["code"] === "number" ? errorObject["code"] : undefined;
      const text = typeof errorObject["message"] === "string" ? errorObject["message"] : `Request failed: ${pending.method}`;
      pending.reject(new CodexProtocolError(text, code, { method: pending.method, error: errorObject }));
      return;
    }

    pending.resolve(message["result"] as JsonValue);
  }

  async #handleServerRequest(id: JsonRpcId, method: string, params: JsonValue | undefined): Promise<void> {
    try {
      if (this.#serverRequestHandler === null) {
        throw new Error(`No handler installed for server request: ${method}`);
      }
      const result = await this.#serverRequestHandler(method, params);
      this.#transport.send({ id, result });
    } catch (error) {
      this.#logger.warn("Server request handler failed", { method, error: errorMessage(error) });
      this.#transport.send({
        id,
        error: {
          code: -32_000,
          message: errorMessage(error),
        },
      });
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      this.#cleanupPendingByValue(pending);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #cleanupPending(id: JsonRpcId, pending: PendingRequest): void {
    this.#pending.delete(id);
    this.#cleanupPendingByValue(pending);
  }

  #cleanupPendingByValue(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }
}

function assertRequestTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new CodexProtocolError(
      `JSON-RPC timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}.`,
      undefined,
      { timeoutMs },
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal.reason);
}

function abortError(reason: unknown): Error {
  const error = reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" && reason.length > 0 ? reason : "JSON-RPC request aborted.");
  if (error.name === "Error") error.name = "AbortError";
  return error;
}

function sleepWithSignal(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, milliseconds);
    timer.unref();
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal?.reason));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}
