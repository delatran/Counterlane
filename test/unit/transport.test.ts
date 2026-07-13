import { strict as assert } from "node:assert";
import { once } from "node:events";
import { test } from "node:test";
import { Logger } from "../../src/core/logger.js";
import { StdioJsonRpcTransport } from "../../src/codex/transport.js";

void test("App Server transport rejects timer overflow before spawning", () => {
  assert.throws(
    () => new StdioJsonRpcTransport({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      startupTimeoutMs: 2_147_483_648,
      shutdownTimeoutMs: 2_000,
      logger: new Logger({ level: "silent", json: true }),
    }),
    /startupTimeoutMs must be a positive safe integer/u,
  );
});

void test("App Server transport rejects an oversized unterminated JSON-RPC frame", async () => {
  const transport = new StdioJsonRpcTransport({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(2*1024*1024+1));setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    logger: new Logger({ level: "silent", json: true }),
  });
  const errorEvent = once(transport, "error");
  await transport.start();
  const [error] = await errorEvent;
  assert.match(String(error), /frame exceeded 2097152 bytes/u);
  await transport.close();
});
