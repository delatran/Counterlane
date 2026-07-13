#!/usr/bin/env node
import * as readline from "node:readline";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const threads = new Map();
const interruptedTurns = new Set();
let initialized = false;
let transportClosed = false;
lines.once("close", () => {
  transportClosed = true;
});

for await (const line of lines) {
  if (line.trim() === "") continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (typeof message?.method !== "string") continue;
  if (message.id === undefined) {
    if (message.method === "initialized") initialized = true;
    continue;
  }

  const { id, method, params = {} } = message;
  if (process.env.MOCK_REQUEST_LOG) {
    await appendFile(process.env.MOCK_REQUEST_LOG, `${JSON.stringify({ id, method, params })}\n`, "utf8");
  }
  try {
    if (method !== "initialize" && !initialized) {
      send({ id, error: { code: -32002, message: "Not initialized" } });
      continue;
    }
    switch (method) {
      case "initialize":
        initialized = true;
        send({ id, result: { userAgent: "counterlane-mock/1", codexHome: "/tmp/mock-codex", platformFamily: "unix", platformOs: process.platform } });
        break;
      case "account/read":
        send({ id, result: { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false } });
        break;
      case "account/rateLimits/read":
        send({ id, result: { rateLimits: { limitId: "codex", limitName: "Mock 5h", primary: { usedPercent: await nextUsedPercent(), windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 7200 } }, rateLimitsByLimitId: {} } });
        break;
      case "model/list":
        await delayFromEnvironment("MOCK_MODEL_LIST_DELAY_MS");
        if (transportClosed) break;
        send({ id, result: modelPage(params) });
        break;
      case "thread/start": {
        const thread = makeThread(params.cwd, params.model, params.serviceTier);
        threads.set(thread.id, thread);
        send({ id, result: { thread } });
        notify("thread/started", { thread });
        break;
      }
      case "thread/resume": {
        if (!threads.has(params.threadId)) threads.set(params.threadId, makeThread(process.cwd(), "gpt-5.6-sol"));
        send({ id, result: { thread: threads.get(params.threadId) } });
        break;
      }
      case "thread/fork": {
        const source = threads.get(params.threadId) ?? makeThread(process.cwd(), "gpt-5.6-sol");
        const thread = makeThread(params.cwd ?? source.cwd, params.model ?? source.model, params.serviceTier ?? source.serviceTier);
        thread.forkedFromId = params.threadId;
        threads.set(thread.id, thread);
        send({ id, result: { thread } });
        notify("thread/started", { thread });
        break;
      }
      case "thread/delete":
        if (process.env.MOCK_FAIL_THREAD_DELETE === "1") {
          send({ id, error: { code: -32000, message: "synthetic thread deletion failure" } });
          break;
        }
        threads.delete(params.threadId);
        send({ id, result: {} });
        break;
      case "turn/interrupt":
        if (typeof params.turnId === "string") interruptedTurns.add(params.turnId);
        send({ id, result: {} });
        break;
      case "turn/start": {
        const thread = threads.get(params.threadId) ?? makeThread(params.cwd ?? process.cwd(), params.model);
        thread.cwd = params.cwd ?? thread.cwd;
        thread.model = params.model ?? thread.model;
        thread.serviceTier = params.serviceTier === null ? null : (params.serviceTier ?? thread.serviceTier);
        threads.set(params.threadId, thread);
        const turnId = randomUUID();
        const turn = turnObject(turnId, "inProgress");
        queueMicrotask(() => void executeTurn(params.threadId, turnId, thread, params));
        const responseDelay = Number(process.env.MOCK_TURN_START_RESPONSE_DELAY_MS ?? "0");
        const respond = () => {
          if (process.env.MOCK_TURN_START_RESPONSE_MODE === "missing-turn-id") {
            send({ id, result: { turn: { status: "inProgress" } } });
          } else if (process.env.MOCK_TURN_START_RESPONSE_MODE === "mismatched-turn-id") {
            send({ id, result: { turn: turnObject(randomUUID(), "inProgress") } });
          } else {
            send({ id, result: { turn } });
          }
        };
        if (Number.isFinite(responseDelay) && responseDelay > 0) {
          const timer = setTimeout(respond, responseDelay);
          timer.unref();
        } else {
          respond();
        }
        break;
      }
      default:
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    send({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
}

function modelPage(params) {
  const encoded = process.env.MOCK_MODEL_LIST_PAGES_JSON;
  if (encoded === undefined) return { data: models(), nextCursor: null };
  const pages = JSON.parse(encoded);
  const key = typeof params.cursor === "string" ? params.cursor : "__first__";
  const page = pages[key];
  if (page === null || typeof page !== "object" || Array.isArray(page)) {
    return { data: [], nextCursor: null };
  }
  return page;
}

async function nextUsedPercent() {
  const sequencePath = process.env.MOCK_USED_PERCENT_SEQUENCE_FILE;
  if (!sequencePath) return Number(process.env.MOCK_USED_PERCENT ?? 10);
  const values = JSON.parse(await readFile(sequencePath, "utf8"));
  if (!Array.isArray(values) || values.length === 0 || !Number.isFinite(values[0])) {
    throw new Error("MOCK_USED_PERCENT_SEQUENCE_FILE must contain a non-empty numeric array");
  }
  const [next, ...remaining] = values;
  await writeFile(sequencePath, JSON.stringify(remaining.length > 0 ? remaining : [next]), "utf8");
  return next;
}

async function delayFromEnvironment(name) {
  const delayMs = Number(process.env[name] ?? "0");
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function executeTurn(threadId, turnId, thread, params) {
  const model = String(params.model ?? thread.model ?? "gpt-5.6-sol");
  const input = Array.isArray(params.input) ? params.input : [];
  const prompt = input.map((item) => item?.text ?? "").join("\n");
  if (process.env.MOCK_SUPPRESS_TURN_STARTED !== "1") {
    notify("turn/started", {
      ...(process.env.MOCK_OMIT_TURN_STARTED_THREAD_ID === "1" ? {} : { threadId }),
      turn: turnObject(turnId, "inProgress"),
    });
  }
  const bufferedFloodCount = Number(process.env.MOCK_BUFFERED_EVENT_FLOOD_COUNT ?? "0");
  if (Number.isSafeInteger(bufferedFloodCount) && bufferedFloodCount > 0) {
    for (let index = 0; index < bufferedFloodCount; index += 1) {
      notify("item/agentMessage/delta", { threadId, turnId, itemId: `flood-${index}`, delta: "x" });
    }
  }
  if (process.env.MOCK_GLOBAL_WARNING === "1") {
    notify("warning", { message: "global warning without turn identity" });
  }
  if (process.env.MOCK_ERROR_WITHOUT_THREAD_ID === "1") {
    notify("error", { turnId, error: { message: "turn-scoped error without thread identity" }, willRetry: true });
  }
  if (typeof process.env.MOCK_REROUTE_TO_MODEL === "string" && process.env.MOCK_REROUTE_TO_MODEL.length > 0) {
    notify("model/rerouted", {
      threadId,
      turnId,
      fromModel: model,
      toModel: process.env.MOCK_REROUTE_TO_MODEL,
      reason: "synthetic backend reroute",
    });
  }

  const shouldFail = (model.includes("luna") && prompt.includes("MOCK_FAIL_LUNA")) ||
    (model.includes("terra") && prompt.includes("MOCK_FAIL_TERRA")) ||
    (model.includes("sol") && prompt.includes("MOCK_FAIL_SOL"));
  const usage = usageFor(model, String(params.effort ?? "medium"));
  if (process.env.MOCK_USAGE_BEFORE_DELAY === "1") {
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 256000 } });
  }
  const configuredDelay = Number(process.env.MOCK_TURN_DELAY_MS ?? "0");
  const delayMs = Number.isFinite(configuredDelay) && configuredDelay > 0
    ? configuredDelay
    : (params.serviceTier ?? thread.serviceTier) === "fast" ? 3 : 12;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (transportClosed) return;
  if (process.env.MOCK_CANCEL_TURN === "1") {
    notify("turn/completed", completionParams(threadId, turnId, "cancelled"));
    return;
  }
  if (interruptedTurns.has(turnId)) {
    notify("turn/completed", completionParams(threadId, turnId, "interrupted"));
    return;
  }

  const target = join(thread.cwd, "answer.txt");
  await writeFile(target, shouldFail ? "incorrect\n" : "correct\n", "utf8");

  const diffResult = spawnSync("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd: thread.cwd, encoding: "utf8" });
  const diff = diffResult.stdout ?? "";
  notify("turn/diff/updated", { threadId, turnId, diff });

  const serviceTier = params.serviceTier ?? thread.serviceTier ?? "standard";
  const message = shouldFail ? `Mock ${model} at ${serviceTier} produced an intentionally incorrect patch.` : `Mock ${model} at ${serviceTier} completed the task.`;
  notify("item/agentMessage/delta", { threadId, turnId, itemId: randomUUID(), delta: message });
  notify("item/completed", { threadId, turnId, item: { id: randomUUID(), type: "agentMessage", text: message, phase: "final" } });

  if (process.env.MOCK_USAGE_BEFORE_DELAY !== "1") {
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 256000 } });
  }
  notify("turn/completed", completionParams(threadId, turnId, "completed"));
}

function completionParams(threadId, turnId, status) {
  const turn = turnObject(turnId, status);
  if (process.env.MOCK_OMIT_TURN_COMPLETED_TURN_ID === "1") delete turn.id;
  return { threadId, turn };
}

function models() {
  const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
  return [
    model("gpt-5.6-luna", "GPT-5.6 Luna", false, efforts.slice(0, 5), false),
    model("gpt-5.6-terra", "GPT-5.6 Terra", false, efforts.slice(0, 5), true),
    model("gpt-5.6-sol", "GPT-5.6 Sol", true, efforts, true),
  ];
}

function model(id, displayName, isDefault, efforts, supportsFast) {
  return {
    id,
    model: id,
    displayName,
    description: `Mock catalog entry for ${displayName}`,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
    defaultReasoningEffort: "medium",
    inputModalities: ["text"],
    supportsPersonality: true,
    additionalSpeedTiers: supportsFast ? ["fast"] : [],
    serviceTiers: supportsFast ? [{ id: "fast", name: "Fast", description: "Mock 1.5x latency tier" }] : [],
    defaultServiceTier: null,
    isDefault,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
  };
}

function makeThread(cwd = process.cwd(), model = "gpt-5.6-sol", serviceTier = null) {
  return {
    id: randomUUID(),
    preview: "",
    ephemeral: true,
    model,
    serviceTier,
    cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    turns: [],
    status: { type: "idle" },
    path: null,
  };
}

function turnObject(id, status) {
  return { id, items: [], itemsView: { type: "full" }, status, error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: status === "completed" || status === "interrupted" ? Math.floor(Date.now() / 1000) : null, durationMs: status === "completed" || status === "interrupted" ? 20 : null };
}

function usageFor(model, effort) {
  const family = model.includes("sol") ? 5 : model.includes("terra") ? 2.5 : 1;
  const effortWeight = effort === "max" ? 2.2 : effort === "xhigh" ? 1.7 : effort === "high" ? 1.3 : effort === "low" ? 0.8 : effort === "ultra" ? 4 : 1;
  const inputTokens = Math.round(1600 * family * effortWeight);
  const cachedInputTokens = Math.round(inputTokens * 0.25);
  const outputTokens = Math.round(300 * family * effortWeight);
  const reasoningOutputTokens = Math.round(outputTokens * 0.5);
  return { totalTokens: inputTokens + outputTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

function notify(method, params) { send({ method, params }); }
function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
