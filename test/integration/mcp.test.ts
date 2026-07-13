import { strict as assert } from "node:assert";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { MAX_MCP_STDIO_FRAME_BYTES } from "../../src/mcp/server.js";
import { MCP_TRUSTED_CODEX_ARGS_ENV, MCP_TRUSTED_CODEX_COMMAND_ENV } from "../../src/mcp/tools.js";
import { createTestRepository, mockAppServerPath, projectRoot } from "../helpers.js";

void test("Counterlane MCP exposes direct routing tools and live speed capabilities", async () => {
  const repository = await createTestRepository();
  await writeFile(
    `${repository}/counterlane.config.json`,
    `${JSON.stringify({ codex: { command: process.execPath, args: [mockAppServerPath] } }, null, 2)}\n`,
    "utf8",
  );

  const child = spawn(process.execPath, ["dist/cli.js", "mcp", "--stdio"], {
    cwd: projectRoot,
    env: mcpEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();

  try {
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    const initialized = await nextJson(iterator);
    assert.equal(initialized["id"], 1);
    assert.equal((initialized["result"] as Record<string, unknown>)?.["protocolVersion"], "2025-11-25");

    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await nextJson(iterator);
    const tools = ((listed["result"] as Record<string, unknown>)?.["tools"] ?? []) as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool["name"]);
    assert.ok(names.includes("counterlane_route"));
    assert.ok(names.includes("counterlane_execute"));
    assert.ok(names.includes("counterlane_compare"));

    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "counterlane_models", arguments: { cwd: repository } },
    });
    const called = await nextJson(iterator);
    const toolResult = called["result"] as Record<string, unknown>;
    assert.equal(toolResult["isError"], undefined);
    const structured = toolResult["structuredContent"] as Record<string, unknown>;
    const models = structured["models"] as Array<Record<string, unknown>>;
    const terra = models.find((model) => String(model["id"]).includes("terra"));
    assert.ok(terra);
    const speedTiers = terra?.["speedTiers"] as Array<Record<string, unknown>>;
    assert.deepEqual(speedTiers.map((tier) => tier["id"]), ["standard", "fast"]);
    const quota = structured["quota"] as Record<string, unknown>;
    assert.equal(quota["raw"], undefined, "MCP must not export unrecognized raw account payload fields");
    assert.ok(quota["primary"] !== undefined);

    send(child, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "counterlane_route",
        arguments: {
          cwd: repository,
          prompt: "Rename the typo exactly and run tests.",
          speed: "fast",
        },
      },
    });
    const routed = await nextJson(iterator);
    const routedResult = routed["result"] as Record<string, unknown>;
    assert.equal(routedResult["isError"], undefined);
    const routedStructured = routedResult["structuredContent"] as Record<string, unknown>;
    const selected = routedStructured["selected"] as Record<string, unknown>;
    assert.equal(selected["speed"], "fast");
    assert.deepEqual(routedStructured["constraints"], { speedId: "fast" });
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
});

void test("stdio MCP requires a valid initialize negotiation before accepting initialized", async () => {
  const child = spawn(process.execPath, ["dist/cli.js", "mcp", "--stdio"], {
    cwd: projectRoot,
    env: mcpEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(child, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const premature = await nextJson(iterator);
    assert.equal((premature["error"] as Record<string, unknown>)?.["code"], -32002);

    send(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1900-01-01" },
    });
    const unsupported = await nextJson(iterator);
    assert.equal((unsupported["error"] as Record<string, unknown>)?.["code"], -32602);

    send(child, { jsonrpc: "1.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    const invalidJsonRpc = await nextJson(iterator);
    assert.equal((invalidJsonRpc["error"] as Record<string, unknown>)?.["code"], -32600);
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
});

void test("stdio MCP rejects an oversized frame before parsing and accepts the next frame", async () => {
  const child = spawn(process.execPath, ["dist/cli.js", "mcp", "--stdio"], {
    cwd: projectRoot,
    env: mcpEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    child.stdin.write(`${"x".repeat(MAX_MCP_STDIO_FRAME_BYTES + 1)}\n`);
    const oversized = await nextJson(iterator);
    assert.equal((oversized["error"] as Record<string, unknown>)?.["code"], -32000);

    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    const initialized = await nextJson(iterator);
    assert.equal(initialized["id"], 1);
    assert.equal((initialized["result"] as Record<string, unknown>)?.["protocolVersion"], "2025-11-25");
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
});

void test("stdio MCP rejects duplicate in-flight ids and bounds concurrent requests", async () => {
  const repository = await createTestRepository({ verifier: false });
  const logDirectory = await mkdtemp(join(tmpdir(), "counterlane-mcp-stdio-budget-"));
  const requestLog = join(logDirectory, "requests.jsonl");
  const child = spawn(process.execPath, ["dist/cli.js", "mcp", "--stdio"], {
    cwd: projectRoot,
    env: mcpEnvironment({
      MOCK_MODEL_LIST_DELAY_MS: "30000",
      MOCK_REQUEST_LOG: requestLog,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const toolCall = (id: string | number): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "counterlane_models", arguments: { cwd: repository } },
  });
  try {
    send(child, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    assert.equal((await nextJson(iterator))["id"], 0);
    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });

    send(child, toolCall("duplicate"));
    await waitForRequest(requestLog, "model/list");
    send(child, toolCall("duplicate"));
    const duplicate = await nextJson(iterator);
    assert.equal(duplicate["id"], "duplicate");
    assert.equal((duplicate["error"] as Record<string, unknown>)?.["code"], -32600);
    assert.match(String((duplicate["error"] as Record<string, unknown>)?.["message"]), /duplicate in-flight/iu);

    for (let id = 2; id <= 8; id += 1) send(child, toolCall(id));
    send(child, toolCall(9));
    const capacity = await nextJson(iterator);
    assert.equal(capacity["id"], 9);
    assert.equal((capacity["error"] as Record<string, unknown>)?.["code"], -32004);

    send(child, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "duplicate" } });
    for (let id = 2; id <= 8; id += 1) {
      send(child, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
    }
  } finally {
    lines.close();
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
});

void test("HTTP MCP reserves session capacity and rejects duplicate in-flight ids", async () => {
  const repository = await createTestRepository({ verifier: false });
  const logDirectory = await mkdtemp(join(tmpdir(), "counterlane-mcp-http-races-"));
  const requestLog = join(logDirectory, "requests.jsonl");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/mcp`;
  const child = spawn(
    process.execPath,
    [
      "dist/cli.js", "mcp", "--http", "--host", "127.0.0.1", "--port", String(port), "--path", "/mcp",
      "--max-sessions", "1", "--max-session-concurrency", "2",
    ],
    {
      cwd: projectRoot,
      env: mcpEnvironment({
        MOCK_MODEL_LIST_DELAY_MS: "30000",
        MOCK_REQUEST_LOG: requestLog,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await waitForReady(`http://127.0.0.1:${port}/healthz`);
    const initialize = (id: number): Promise<HttpRpcResult> => httpRpc(url, {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    const responses = await Promise.all([initialize(1), initialize(2)]);
    const accepted = responses.find((entry) => entry.response.status === 200);
    const rejected = responses.find((entry) => entry.response.status === 503);
    assert.ok(accepted, "exactly one initialize request should reserve the only session slot");
    assert.ok(rejected, "the competing initialize request should observe capacity");
    assert.equal((rejected.body["error"] as Record<string, unknown>)?.["code"], -32003);
    const sessionId = accepted.response.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const sessionHeaders = {
      "MCP-Session-Id": sessionId,
      "MCP-Protocol-Version": "2025-11-25",
    };
    await httpRpc(url, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, sessionHeaders);

    const request = {
      jsonrpc: "2.0",
      id: 77,
      method: "tools/call",
      params: { name: "counterlane_models", arguments: { cwd: repository } },
    };
    const first = httpRpc(url, request, sessionHeaders);
    await waitForRequest(requestLog, "model/list");
    const duplicate = await httpRpc(url, request, sessionHeaders);
    assert.equal(duplicate.response.status, 400);
    assert.equal((duplicate.body["error"] as Record<string, unknown>)?.["code"], -32600);
    assert.match(String((duplicate.body["error"] as Record<string, unknown>)?.["message"]), /duplicate in-flight/iu);
    await httpRpc(url, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 77, reason: "race regression complete" },
    }, sessionHeaders);
    await first;
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
});

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function mcpEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [MCP_TRUSTED_CODEX_COMMAND_ENV]: process.execPath,
    [MCP_TRUSTED_CODEX_ARGS_ENV]: JSON.stringify([mockAppServerPath]),
    ...overrides,
  };
}

async function nextJson(
  iterator: AsyncIterator<string>,
): Promise<Record<string, unknown>> {
  const next = await Promise.race([
    iterator.next(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("MCP response timed out")), 10_000)),
  ]);
  if (next.done) {
    throw new Error("MCP process closed before responding");
  }
  return JSON.parse(next.value) as Record<string, unknown>;
}

interface HttpRpcResult {
  response: Response;
  body: Record<string, unknown>;
}

async function httpRpc(
  url: string,
  message: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<HttpRpcResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return { response, body: text.length === 0 ? {} : JSON.parse(text) as Record<string, unknown> };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Unable to allocate a test port");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
}

async function waitForReady(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The child server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Timed out waiting for MCP HTTP server");
}

async function waitForRequest(path: string, method: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).includes(`"method":"${method}"`)) return;
    } catch {
      // The mock App Server creates its request log lazily.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for mock App Server request ${method}`);
}
