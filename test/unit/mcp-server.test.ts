import { strict as assert } from "node:assert";
import { Readable } from "node:stream";
import { test } from "node:test";
import { readBoundedStdioFrames } from "../../src/mcp/server.js";

void test("bounded MCP stdio reader drops oversized chunked frames and recovers", async () => {
  const input = Readable.from([
    Buffer.from("1234"),
    Buffer.from("5678"),
    Buffer.from("9\n{}\r\n"),
  ]);
  const frames = [];
  for await (const frame of readBoundedStdioFrames(input, 8)) frames.push(frame);
  assert.deepEqual(frames, [
    { oversized: true },
    { oversized: false, line: "{}" },
  ]);
});

void test("bounded MCP stdio reader rejects invalid limits", async () => {
  const frames = readBoundedStdioFrames(Readable.from([]), 0);
  await assert.rejects(frames.next(), /positive safe integer/u);
});
