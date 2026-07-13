import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { CodexAppServer } from "../../src/codex/app-server.js";
import { Logger } from "../../src/core/logger.js";
import { createTestRepository, mockAppServerPath, testConfig } from "../helpers.js";

void test("App Server adapter performs handshake, catalog discovery, quota read, and a streamed turn", async () => {
  const repository = await createTestRepository();
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [mockAppServerPath],
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const catalog = await server.listModels();
    assert.equal(catalog.models.length, 3);
    assert.ok(catalog.models.some((model) => model.id.includes("sol")));
    const terra = catalog.models.find((model) => model.id.includes("terra"));
    assert.deepEqual(terra?.serviceTiers.map((tier) => tier.id), ["fast"]);
    const limits = await server.readRateLimits();
    assert.equal(limits.primary?.primary?.usedPercent, 10);

    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra", serviceTier: "fast" });
    const result = await server.runTurn({
      threadId,
      prompt: "Fix answer.txt",
      cwd: repository,
      modelId: "gpt-5.6-terra",
      effort: "medium",
      serviceTier: "fast",
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [repository], networkAccess: false },
    });
    assert.equal(result.status, "completed");
    assert.match(result.finalMessage, /at fast completed/u);
    assert.ok((result.tokenUsage?.last.totalTokens ?? 0) > 0);
    assert.match(result.diff, /answer\.txt/u);
    assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "correct\n");
  } finally {
    await server.close();
  }
});

void test("model discovery consumes every bounded page and deduplicates repeated model ids", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-model-pages-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  const model = (id: string) => ({
    id,
    model: id,
    displayName: id,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
  });
  const pages = {
    __first__: { data: [model("page-one")], nextCursor: "page-2" },
    "page-2": { data: [model("page-one"), model("page-two")], nextCursor: null },
  };
  await writeFile(
    wrapper,
    `process.env.MOCK_MODEL_LIST_PAGES_JSON = ${JSON.stringify(JSON.stringify(pages))};\n` +
      `await import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const base = testConfig();
  const config = testConfig({ codex: { ...base.codex, command: process.execPath, args: [wrapper] } });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    assert.deepEqual((await server.listModels()).models.map((entry) => entry.id), ["page-one", "page-two"]);
  } finally {
    await server.close();
  }
});

void test("model discovery rejects a repeated pagination cursor", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-model-cursor-loop-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  const pages = {
    __first__: { data: [], nextCursor: "loop" },
    loop: { data: [], nextCursor: "loop" },
  };
  await writeFile(
    wrapper,
    `process.env.MOCK_MODEL_LIST_PAGES_JSON = ${JSON.stringify(JSON.stringify(pages))};\n` +
      `await import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const base = testConfig();
  const config = testConfig({ codex: { ...base.codex, command: process.execPath, args: [wrapper] } });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    await assert.rejects(server.listModels(), /repeated cursor/u);
  } finally {
    await server.close();
  }
});

void test("model discovery rejects conflicting duplicate model ids across pages", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-model-conflict-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  const first = {
    id: "conflicted-model",
    model: "conflicted-model",
    displayName: "First definition",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
  };
  const pages = {
    __first__: { data: [first], nextCursor: "page-2" },
    "page-2": { data: [{ ...first, displayName: "Conflicting definition" }], nextCursor: null },
  };
  await writeFile(
    wrapper,
    `process.env.MOCK_MODEL_LIST_PAGES_JSON = ${JSON.stringify(JSON.stringify(pages))};\n` +
      `await import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const base = testConfig();
  const config = testConfig({ codex: { ...base.codex, command: process.execPath, args: [wrapper] } });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    await assert.rejects(server.listModels(), /conflicting duplicate entries/u);
  } finally {
    await server.close();
  }
});

void test("thread forks receive isolated cwd, model, and service-tier overrides", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-log-"));
  const requestLog = join(directory, "requests.jsonl");
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_REQUEST_LOG = ${JSON.stringify(requestLog)};\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const parent = await server.startThread({ cwd: repository, modelId: "gpt-5.6-sol", serviceTier: null });
    await server.forkThread({
      threadId: parent,
      cwd: repository,
      modelId: "gpt-5.6-terra",
      serviceTier: "fast",
    });
  } finally {
    await server.close();
  }
  const requests = (await readFile(requestLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  const initialize = requests.find((request) => request.method === "initialize");
  assert.equal(((initialize?.params["clientInfo"] as Record<string, unknown>)?.["version"]), "source");
  const fork = requests.find((request) => request.method === "thread/fork");
  assert.equal(fork?.params["cwd"], repository);
  assert.equal(fork?.params["model"], "gpt-5.6-terra");
  assert.equal(fork?.params["serviceTier"], "fast");
  assert.match(String(fork?.params["developerInstructions"]), /isolated repository worktree/u);
});

void test("ephemeral thread deletion failures remain observable to runner cleanup", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-thread-delete-failure-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_FAIL_THREAD_DELETE = "1";\n` +
      `await import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const base = testConfig();
  const config = testConfig({ codex: { ...base.codex, command: process.execPath, args: [wrapper] } });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    await assert.rejects(server.deleteThread(threadId), /synthetic thread deletion failure/u);
  } finally {
    await server.close();
  }
});

void test("caller cancellation interrupts an active turn and preserves partial token usage", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-abort-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_TURN_DELAY_MS = "500";\nprocess.env.MOCK_USAGE_BEFORE_DELAY = "1";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
      turnTimeoutMs: 5_000,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("test cancellation")), 40);
    const result = await server.runTurn({
      threadId,
      prompt: "Fix answer.txt",
      cwd: repository,
      modelId: "gpt-5.6-terra",
      effort: "medium",
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [repository], networkAccess: false },
      signal: controller.signal,
    });
    clearTimeout(timer);
    assert.equal(result.status, "interrupted");
    assert.ok((result.tokenUsage?.last.totalTokens ?? 0) > 0, "partial usage must not disappear on cancellation");
    assert.ok(result.durationMs < 1_000);
    assert.ok(result.durationMs >= 400, "runTurn must wait for terminal turn/completed before returning");
    assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "wrong\n");
    assert.match(result.warnings.join("\n"), /interrupt|cancell/iu);
  } finally {
    await server.close();
  }
});

void test("cancellation during a delayed turn/start response does not orphan the remote turn", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-start-abort-"));
  const requestLog = join(directory, "requests.jsonl");
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_REQUEST_LOG = ${JSON.stringify(requestLog)};\nprocess.env.MOCK_TURN_START_RESPONSE_DELAY_MS = "250";\nprocess.env.MOCK_TURN_DELAY_MS = "800";\nprocess.env.MOCK_USAGE_BEFORE_DELAY = "1";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 5_000,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("cancel while starting")), 40);
    const result = await server.runTurn({
      threadId,
      prompt: "Fix answer.txt",
      cwd: repository,
      modelId: "gpt-5.6-terra",
      effort: "medium",
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [repository], networkAccess: false },
      signal: controller.signal,
    });
    clearTimeout(timer);
    assert.equal(result.status, "interrupted");
    assert.notEqual(result.turnId, "unknown");
    assert.ok((result.tokenUsage?.last.totalTokens ?? 0) > 0);
    const requests = (await readFile(requestLog, "utf8")).trim().split("\n").map(
      (line) => JSON.parse(line) as { method: string; params: Record<string, unknown> },
    );
    assert.ok(requests.some((request) => request.method === "turn/interrupt"), "remote turn must be interrupted");
  } finally {
    await server.close();
  }
});

void test("turn notifications are bounded while turn/start is still unresolved", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-buffer-bound-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_SUPPRESS_TURN_STARTED = "1";\n` +
      `process.env.MOCK_BUFFERED_EVENT_FLOOD_COUNT = "513";\n` +
      `process.env.MOCK_TURN_START_RESPONSE_DELAY_MS = "1000";\n` +
      `process.env.MOCK_TURN_DELAY_MS = "2000";\n` +
      `await import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const base = testConfig();
  const config = testConfig({
    codex: {
      ...base.codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 5_000,
      turnTimeoutMs: 5_000,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    await assert.rejects(
      server.runTurn(turnRequest(threadId, repository)),
      /emitted too much state before turn\/start settled/u,
    );
    assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "wrong\n");
  } finally {
    await server.close();
  }
});

void test("buffered turn notifications contribute to rawEventCount exactly once", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-buffer-count-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_SUPPRESS_TURN_STARTED = "1";\n` +
      `process.env.MOCK_BUFFERED_EVENT_FLOOD_COUNT = "1";\n` +
      `process.env.MOCK_TURN_START_RESPONSE_DELAY_MS = "100";\n` +
      `await import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const base = testConfig();
  const config = testConfig({
    codex: {
      ...base.codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 2_000,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    const result = await server.runTurn(turnRequest(threadId, repository));
    assert.equal(result.status, "completed");
    assert.equal(result.rawEventCount, 6);
  } finally {
    await server.close();
  }
});

void test("a timed-out turn/start response interrupts the streamed remote turn before returning failure", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-start-timeout-"));
  const requestLog = join(directory, "requests.jsonl");
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_REQUEST_LOG = ${JSON.stringify(requestLog)};\nprocess.env.MOCK_TURN_START_RESPONSE_DELAY_MS = "600";\nprocess.env.MOCK_TURN_DELAY_MS = "250";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    config.codex.requestTimeoutMs = 100;
    const result = await server.runTurn(turnRequest(threadId, repository));

    assert.equal(result.status, "failed");
    assert.notEqual(result.turnId, "unknown");
    assert.ok(result.durationMs >= 200, "runTurn must wait for the interrupted turn to become terminal");
    assert.match(result.warnings.join("\n"), /turn\/start|interrupt/iu);
    assert.ok(
      (await readRequestLog(requestLog)).some((request) => request.method === "turn/interrupt"),
      "the known remote turn must be interrupted after turn/start times out",
    );
    await delay(500);
    assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "wrong\n");
  } finally {
    await server.close();
  }
});

void test("a malformed turn/start response interrupts the streamed remote turn and waits for terminal state", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-start-malformed-"));
  const requestLog = join(directory, "requests.jsonl");
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_REQUEST_LOG = ${JSON.stringify(requestLog)};\nprocess.env.MOCK_TURN_START_RESPONSE_MODE = "missing-turn-id";\nprocess.env.MOCK_TURN_START_RESPONSE_DELAY_MS = "40";\nprocess.env.MOCK_TURN_DELAY_MS = "200";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 500,
      turnTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    const result = await server.runTurn(turnRequest(threadId, repository));

    assert.equal(result.status, "failed");
    assert.ok(result.durationMs >= 150, "runTurn must wait for turn/completed after a malformed response");
    assert.match(String(result.error?.["message"]), /turn\/start response did not include turn\.id/iu);
    assert.ok(
      (await readRequestLog(requestLog)).some((request) => request.method === "turn/interrupt"),
      "the known remote turn must be interrupted after a malformed turn/start response",
    );
    await delay(100);
    assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "wrong\n");
  } finally {
    await server.close();
  }
});

void test("mismatched streamed and response turn ids interrupt both candidates and close fail-closed", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-start-mismatch-"));
  const requestLog = join(directory, "requests.jsonl");
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_REQUEST_LOG = ${JSON.stringify(requestLog)};\nprocess.env.MOCK_TURN_START_RESPONSE_MODE = "mismatched-turn-id";\nprocess.env.MOCK_TURN_START_RESPONSE_DELAY_MS = "40";\nprocess.env.MOCK_TURN_DELAY_MS = "200";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 500,
      turnTimeoutMs: 5_000,
      shutdownTimeoutMs: 500,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    const result = await server.runTurn(turnRequest(threadId, repository));

    assert.equal(result.status, "failed");
    assert.match(String(result.error?.["message"]), /did not match streamed id/iu);
    const interruptedIds = (await readRequestLog(requestLog))
      .filter((request) => request.method === "turn/interrupt")
      .map((request) => request.params["turnId"]);
    assert.equal(interruptedIds.length, 2, "both plausible remote turn ids must be interrupted");
    assert.equal(new Set(interruptedIds).size, 2);
    await delay(300);
    assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "wrong\n");
  } finally {
    await server.close();
  }
});

void test("turn/start failure without a streamed turn id closes the transport before a remote mutation", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-start-unknown-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_SUPPRESS_TURN_STARTED = "1";\nprocess.env.MOCK_TURN_START_RESPONSE_DELAY_MS = "600";\nprocess.env.MOCK_TURN_DELAY_MS = "250";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 2_000,
      turnTimeoutMs: 5_000,
      shutdownTimeoutMs: 500,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  const pid = server.pid;
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    config.codex.requestTimeoutMs = 100;
    await assert.rejects(server.runTurn(turnRequest(threadId, repository)), /timed out.*turn\/start/iu);
    await delay(350);
    assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "wrong\n");
    if (pid !== undefined) {
      await waitForProcessExit(pid, 1_000);
      assert.equal(processExists(pid), false, "the App Server must be terminated when the remote turn id is unknown");
    }
  } finally {
    await server.close();
  }
});

void test("turn notifications without thread identity close fail-closed before remote mutation", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-missing-thread-id-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_OMIT_TURN_STARTED_THREAD_ID = "1";\nprocess.env.MOCK_TURN_DELAY_MS = "200";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 500,
      turnTimeoutMs: 1_000,
      shutdownTimeoutMs: 300,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    const result = await server.runTurn(turnRequest(threadId, repository));
    assert.equal(result.status, "failed");
    assert.match(String(result.error?.["message"]), /turn\/started notification omitted threadId/u);
    await delay(300);
    assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "wrong\n");
  } finally {
    await server.close();
  }
});

void test("turn completion without turn identity cannot be accepted as terminal success", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-missing-turn-id-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_OMIT_TURN_COMPLETED_TURN_ID = "1";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 500,
      turnTimeoutMs: 1_000,
      shutdownTimeoutMs: 300,
    },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    const result = await server.runTurn(turnRequest(threadId, repository));
    assert.equal(result.status, "failed");
    assert.match(String(result.error?.["message"]), /turn\/completed notification omitted turnId/u);
  } finally {
    await server.close();
  }
});

void test("valid global warning and retryable error notifications do not close the App Server", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-global-notifications-"));
  const wrapper = join(directory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_GLOBAL_WARNING = "1";\nprocess.env.MOCK_ERROR_WITHOUT_THREAD_ID = "1";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const config = testConfig({
    codex: { ...testConfig().codex, command: process.execPath, args: [wrapper] },
  });
  const server = await CodexAppServer.connect({
    config,
    cwd: repository,
    logger: new Logger({ level: "error", json: false }),
  });
  try {
    const threadId = await server.startThread({ cwd: repository, modelId: "gpt-5.6-terra" });
    const result = await server.runTurn(turnRequest(threadId, repository));
    assert.equal(result.status, "completed");
    assert.match(result.warnings.join("\n"), /global warning without turn identity/u);
    assert.match(result.warnings.join("\n"), /turn-scoped error without thread identity/u);
    assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "correct\n");
  } finally {
    await server.close();
  }
});

void test("failed App Server initialization terminates the spawned process tree", async () => {
  const repository = await createTestRepository();
  const directory = await mkdtemp(join(tmpdir(), "counterlane-app-server-init-fail-"));
  const pidFile = join(directory, "pid.txt");
  const wrapper = join(directory, "hung-app-server.mjs");
  await writeFile(
    wrapper,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
    "utf8",
  );
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: process.execPath,
      args: [wrapper],
      requestTimeoutMs: 500,
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 250,
    },
  });
  await assert.rejects(
    CodexAppServer.connect({
      config,
      cwd: repository,
      logger: new Logger({ level: "error", json: false }),
    }),
    /timed out|transport|server/iu,
  );
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  await waitForProcessExit(pid, 2_000);
  assert.equal(processExists(pid), false, "failed initialization must not leave the App Server running");
});

void test("a pre-aborted App Server connection never attempts to spawn", async () => {
  const repository = await createTestRepository();
  const controller = new AbortController();
  controller.abort(new Error("connection cancelled before spawn"));
  const config = testConfig({
    codex: {
      ...testConfig().codex,
      command: "__counterlane_command_that_must_not_spawn__",
      args: [],
    },
  });
  await assert.rejects(
    CodexAppServer.connect({
      config,
      cwd: repository,
      logger: new Logger({ level: "error", json: false }),
      signal: controller.signal,
    }),
    (error: unknown) =>
      error instanceof Error && error.name === "AbortError" && /cancelled before spawn/u.test(error.message),
  );
});

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function turnRequest(threadId: string, repository: string) {
  return {
    threadId,
    prompt: "Fix answer.txt",
    cwd: repository,
    modelId: "gpt-5.6-terra",
    effort: "medium" as const,
    approvalPolicy: "never" as const,
    sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [repository], networkAccess: false },
  };
}

async function readRequestLog(path: string): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
