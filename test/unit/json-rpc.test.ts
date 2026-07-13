import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { test } from "node:test";
import { CodexProtocolError } from "../../src/core/errors.js";
import type { JsonObject } from "../../src/core/json.js";
import { Logger } from "../../src/core/logger.js";
import { JsonRpcClient } from "../../src/codex/json-rpc.js";
import type { StdioJsonRpcTransport } from "../../src/codex/transport.js";

class FakeTransport extends EventEmitter {
  public readonly sent: JsonObject[] = [];
  public throwOnSend = false;

  public send(message: JsonObject): void {
    if (this.throwOnSend) throw new Error("transport already closed");
    this.sent.push(message);
  }
}

void test("JSON-RPC responses must contain exactly one of result or error", async () => {
  const transport = new FakeTransport();
  const client = new JsonRpcClient({
    transport: transport as unknown as StdioJsonRpcTransport,
    logger: new Logger({ level: "silent", json: true }),
    requestTimeoutMs: 1_000,
  });
  const missing = client.request("initialize");
  const missingId = transport.sent.at(-1)?.["id"];
  transport.emit("message", { id: missingId });
  await assert.rejects(missing, (error: unknown) =>
    error instanceof CodexProtocolError && /exactly one of result or error/u.test(error.message)
  );

  const both = client.request("model/list");
  const bothId = transport.sent.at(-1)?.["id"];
  transport.emit("message", { id: bothId, result: null, error: { code: -1, message: "bad" } });
  await assert.rejects(both, (error: unknown) =>
    error instanceof CodexProtocolError && /exactly one of result or error/u.test(error.message)
  );
});

void test("JSON-RPC accepts an explicit null result", async () => {
  const transport = new FakeTransport();
  const client = new JsonRpcClient({
    transport: transport as unknown as StdioJsonRpcTransport,
    logger: new Logger({ level: "silent", json: true }),
    requestTimeoutMs: 1_000,
  });
  const request = client.request("account/read");
  const id = transport.sent.at(-1)?.["id"];
  transport.emit("message", { id, result: null });
  assert.equal(await request, null);
});

void test("JSON-RPC never sends a request when cancellation wins during listener registration", async () => {
  const transport = new FakeTransport();
  const client = new JsonRpcClient({
    transport: transport as unknown as StdioJsonRpcTransport,
    logger: new Logger({ level: "silent", json: true }),
    requestTimeoutMs: 1_000,
  });
  const signal = {
    aborted: false,
    reason: new Error("cancelled during registration"),
    addEventListener(_type: string, listener: () => void): void {
      listener();
    },
    removeEventListener(): void {
      // The synthetic signal has no retained listener after synchronous abort.
    },
  } as unknown as AbortSignal;

  await assert.rejects(client.request("turn/start", undefined, 1_000, signal), /cancelled during registration/u);
  assert.deepEqual(transport.sent, []);
});

void test("server-request reply failures are contained instead of becoming unhandled rejections", async () => {
  const transport = new FakeTransport();
  let log = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      log += chunk.toString();
      callback();
    },
  });
  const client = new JsonRpcClient({
    transport: transport as unknown as StdioJsonRpcTransport,
    logger: new Logger({ level: "warn", json: false, stream }),
    requestTimeoutMs: 1_000,
  });
  client.setServerRequestHandler(async () => null);
  transport.throwOnSend = true;
  transport.emit("message", { id: 7, method: "item/tool/requestUserInput", params: {} });
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  assert.match(log, /JSON-RPC message handling failed/u);
  assert.match(log, /transport already closed/u);
});

void test("JSON-RPC rejects timer overflow before registering or sending a request", async () => {
  const logger = new Logger({ level: "silent", json: true });
  assert.throws(
    () => new JsonRpcClient({
      transport: new FakeTransport() as unknown as StdioJsonRpcTransport,
      logger,
      requestTimeoutMs: 2_147_483_648,
    }),
    /timeoutMs must be a positive safe integer/u,
  );

  const transport = new FakeTransport();
  const client = new JsonRpcClient({
    transport: transport as unknown as StdioJsonRpcTransport,
    logger,
    requestTimeoutMs: 1_000,
  });
  await assert.rejects(client.request("model/list", undefined, 2_147_483_648), /timeoutMs/u);
  assert.deepEqual(transport.sent, []);
});
