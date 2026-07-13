import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { projectRoot } from "../helpers.js";

void test("Counterlane MCP supports a session-aware, bearer-protected Streamable HTTP transport", async () => {
  const port = await freePort();
  const token = "test-token";
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
      "--allow-origin",
      "https://chatgpt.com",
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, COUNTERLANE_MCP_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    await waitForReady(`http://127.0.0.1:${port}/healthz`);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(unauthorized.status, 401);


    const invalidAccept = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
        origin: "https://chatgpt.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 21, method: "initialize", params: {} }),
    });
    assert.equal(invalidAccept.status, 406);

    const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        origin: "https://chatgpt.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    });
    assert.equal(initialized.status, 200);
    const payload = await initialized.json() as Record<string, unknown>;
    assert.equal(payload["id"], 2);
    assert.equal((payload["result"] as Record<string, unknown>)["protocolVersion"], "2025-11-25");
    const sessionId = initialized.headers.get("mcp-session-id");
    assert.ok(sessionId);


    const initializedNotification = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        origin: "https://chatgpt.com",
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    assert.equal(initializedNotification.status, 202);
    assert.equal(initialized.headers.get("access-control-allow-origin"), "https://chatgpt.com");

    const mismatchedVersion = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/list", params: {} }),
    });
    assert.equal(mismatchedVersion.status, 400);

    const tools = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    assert.equal(tools.status, 200);
    const toolsPayload = await tools.json() as { result: { tools: Array<{ name: string }> } };
    assert.ok(toolsPayload.result.tools.some((tool) => tool.name === "counterlane_route"));

    const rejectedOrigin = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
    });
    assert.equal(rejectedOrigin.status, 403);

    const closed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId },
    });
    assert.equal(closed.status, 204);
    const closedSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-session-id": sessionId,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
    });
    assert.equal(closedSession.status, 404);

  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => undefined);
  }
});

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
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("HTTP MCP server did not become ready");
}
