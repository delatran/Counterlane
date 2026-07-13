import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MCP_TRUSTED_CODEX_ARGS_ENV, MCP_TRUSTED_CODEX_COMMAND_ENV } from "../../src/mcp/tools.js";
import { createTestRepository, mockAppServerPath, projectRoot } from "../helpers.js";

void test("official MCP SDK connects to Counterlane over stdio and invokes a route tool", async () => {
  const repository = await configuredRepository();
  const client = new Client({ name: "counterlane-sdk-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js", "mcp", "--stdio"],
    cwd: projectRoot,
    env: mcpEnvironment(),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "counterlane");
    assert.equal(transport.pid === null, false);

    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "counterlane_route"));

    const result = await client.callTool({
      name: "counterlane_route",
      arguments: {
        cwd: repository,
        prompt: "Rename the typo exactly and run the tests.",
        proofTier: "basic",
        speed: "fast",
      },
    });
    assert.notEqual("toolResult" in result, true);
    if ("toolResult" in result) {
      throw new Error("Unexpected compatibility tool result");
    }
    assert.equal(result.isError, undefined);
    const structured = result.structuredContent as Record<string, unknown>;
    const selected = structured["selected"] as Record<string, unknown>;
    assert.equal(selected["speed"], "fast");
    assert.equal(selected["proofTier"], "basic");
    const verification = structured["verification"] as Record<string, unknown>;
    assert.equal(verification["posture"], "no-verifier");
    assert.equal(verification["selectedCommandCount"], 0);
  } finally {
    await client.close().catch(() => undefined);
  }
});

void test("official MCP cancellation interrupts delegated Codex work and records a non-learning cancellation outcome", async () => {
  const repository = await configuredRepository();
  const requestLog = `${repository}/.counterlane/mock-requests.jsonl`;
  const controller = new AbortController();
  const client = new Client({ name: "counterlane-cancel-sdk-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js", "mcp", "--stdio"],
    cwd: projectRoot,
    env: mcpEnvironment({
      MOCK_TURN_DELAY_MS: "5000",
      MOCK_USAGE_BEFORE_DELAY: "1",
      MOCK_REQUEST_LOG: requestLog,
    }),
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const call = client.callTool(
      {
        name: "counterlane_run",
        arguments: {
          cwd: repository,
          prompt: "Make the verified fixture change.",
          mode: "auto",
        },
      },
      undefined,
      { signal: controller.signal },
    );
    const rejected = assert.rejects(call, /test cancellation|RequestTimeout/u);
    await waitForMockRequest(requestLog, "turn/start");
    controller.abort(new Error("test cancellation"));
    await rejected;

    const telemetryPath = `${repository}/.counterlane/events.jsonl`;
    const cancellation = await waitForTelemetryOutcome(telemetryPath, "cancelled");
    assert.equal(cancellation["successful"], false);
    assert.equal(cancellation["outcome"], "cancelled");
  } finally {
    await client.close().catch(() => undefined);
  }
});

void test("official MCP SDK connects to Counterlane over Streamable HTTP with bearer authentication", async () => {
  const port = await freePort();
  const token = "counterlane-sdk-test-token";
  const child = spawn(
    process.execPath,
    [
      "dist/cli.js",
      "mcp",
      "--http",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--path",
      "/mcp",
      "--allow-root",
      projectRoot,
    ],
    {
      cwd: projectRoot,
      env: mcpEnvironment({ COUNTERLANE_MCP_TOKEN: token }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const client = new Client({ name: "counterlane-http-sdk-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });

  try {
    await waitForReady(`http://127.0.0.1:${port}/healthz`);
    // SDK 1.29.0 has an exactOptionalPropertyTypes-only declaration mismatch
    // between StreamableHTTPClientTransport and Transport. The runtime contract is identical.
    await client.connect(transport as unknown as Transport);
    assert.equal(client.getServerVersion()?.name, "counterlane");
    assert.equal(transport.protocolVersion, "2025-11-25");
    assert.ok(transport.sessionId);

    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "counterlane_compare"));
    await client.ping();

    await transport.terminateSession();
    assert.equal(transport.sessionId, undefined);
  } finally {
    await client.close().catch(() => undefined);
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
});

void test("official Streamable HTTP MCP cancellation interrupts remote delegated work", async () => {
  const repository = await configuredRepository();
  const port = await freePort();
  const token = "counterlane-http-cancel-token";
  const child = spawn(
    process.execPath,
    [
      "dist/cli.js", "mcp", "--http", "--host", "127.0.0.1",
      "--port", String(port), "--path", "/mcp", "--allow-root", repository,
    ],
    {
      cwd: projectRoot,
      env: mcpEnvironment({
        COUNTERLANE_MCP_TOKEN: token,
        MOCK_TURN_DELAY_MS: "5000",
        MOCK_USAGE_BEFORE_DELAY: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const client = new Client({ name: "counterlane-http-cancel-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const controller = new AbortController();

  try {
    await waitForReady(`http://127.0.0.1:${port}/healthz`);
    await client.connect(transport as unknown as Transport);
    const call = client.callTool(
      {
        name: "counterlane_run",
        arguments: { cwd: repository, prompt: "Make the verified fixture change.", mode: "auto" },
      },
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("remote test cancellation")), 350).unref();
    await assert.rejects(call, /remote test cancellation|RequestTimeout/u);
    // Cancellation may now win before an arm exists, in which case emitting a
    // fabricated route outcome would be incorrect. If an outcome did reach the
    // ledger, it must never claim success.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const event = await readTelemetryOutcomeIfPresent(`${repository}/.counterlane/events.jsonl`, "cancelled");
    assert.notEqual(event?.["successful"], true);
  } finally {
    await client.close().catch(() => undefined);
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
});

async function configuredRepository(): Promise<string> {
  const repository = await createTestRepository();
  await writeFile(
    `${repository}/counterlane.config.json`,
    `${JSON.stringify({ codex: { command: process.execPath, args: [mockAppServerPath] } }, null, 2)}\n`,
    "utf8",
  );
  return repository;
}

async function waitForMockRequest(path: string, expectedMethod: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      if (text.split("\n").some((line) => {
        if (line.length === 0) return false;
        const request = JSON.parse(line) as { method?: string };
        return request.method === expectedMethod;
      })) return;
    } catch {
      // The delegated App Server has not received the request yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for mock App Server request ${expectedMethod}`);
}

function mcpEnvironment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    [MCP_TRUSTED_CODEX_COMMAND_ENV]: process.execPath,
    [MCP_TRUSTED_CODEX_ARGS_ENV]: JSON.stringify([mockAppServerPath]),
    ...overrides,
  } as Record<string, string>;
}

async function waitForTelemetryOutcome(path: string, expected: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      for (const line of text.trim().split("\n")) {
        const event = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
        if (event.type === "route.observed" && event.payload?.["outcome"] === expected) return event.payload;
      }
    } catch {
      // The event has not been flushed yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Timed out waiting for route outcome ${expected}`);
}

async function readTelemetryOutcomeIfPresent(path: string, expected: string): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, "utf8");
    for (const line of text.trim().split("\n")) {
      if (line.length === 0) continue;
      const event = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      if (event.type === "route.observed" && event.payload?.["outcome"] === expected) return event.payload;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Unable to allocate test port");
  }
  const port = address.port;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

async function waitForReady(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("HTTP MCP server did not become ready");
}
