import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { Logger } from "../../src/core/logger.js";
import { createLinkedAbortScope } from "../../src/core/abort.js";
import {
  MAX_TIMER_DELAY_MS,
  readUtf8Bounded,
  sleep,
  stableStringify,
  withTimeout,
  writeUtf8Atomic,
} from "../../src/core/utils.js";

void test("withTimeout rejects on time even when cleanup never settles", async () => {
  const startedAt = Date.now();
  const slowTimer = setTimeout(() => undefined, 1_000);
  try {
    await assert.rejects(
      withTimeout(
        new Promise<never>(() => undefined),
        20,
        "deadline reached",
        () => new Promise<void>(() => undefined),
      ),
      /deadline reached/u,
    );
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    clearTimeout(slowTimer);
  }
});

void test("withTimeout contains cleanup rejection and preserves the timeout error", async () => {
  const slowTimer = setTimeout(() => undefined, 1_000);
  try {
    await assert.rejects(
      withTimeout(
        new Promise<never>(() => undefined),
        10,
        "deadline reached",
        async () => {
          throw new Error("cleanup failed");
        },
      ),
      /deadline reached/u,
    );
  } finally {
    clearTimeout(slowTimer);
  }
});

void test("timer and bounded-read helpers reject values that overflow their runtime primitives", async () => {
  for (const invalid of [-1, 0.5, MAX_TIMER_DELAY_MS + 1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => sleep(invalid), /Sleep duration/u);
  }
  assert.throws(
    () => createLinkedAbortScope({ timeoutMs: MAX_TIMER_DELAY_MS + 1 }),
    /timeoutMs must be a positive safe integer/u,
  );
  await assert.rejects(
    withTimeout(Promise.resolve("unused"), MAX_TIMER_DELAY_MS + 1, "unused"),
    /Timeout must be a positive safe integer/u,
  );
  await assert.rejects(
    readUtf8Bounded("never-opened", Number.MAX_SAFE_INTEGER),
    /below Number\.MAX_SAFE_INTEGER/u,
  );
});

void test("structured logger fields cannot spoof canonical record identity", () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const logger = new Logger({
    level: "debug",
    json: true,
    stream,
    context: { level: "context-level", message: "context-message" },
  });
  logger.warn("canonical message", {
    timestamp: "forged timestamp",
    level: "field-level",
    message: "field-message",
  });

  const record = JSON.parse(output) as Record<string, unknown>;
  assert.equal(record["level"], "warn");
  assert.equal(record["message"], "canonical message");
  assert.notEqual(record["timestamp"], "forged timestamp");
  assert.match(String(record["timestamp"]), /^\d{4}-\d{2}-\d{2}T/u);
});

void test("concurrent atomic writes use collision-free staging files and leave no residue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-atomic-write-"));
  const path = join(directory, "result.json");
  try {
    const values = Array.from({ length: 64 }, (_value, index) => `value-${index}\n`);
    await Promise.all(values.map((value) => writeUtf8Atomic(path, value)));
    assert.ok(values.includes(await readFile(path, "utf8")));
    assert.deepEqual(await readdir(directory), ["result.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("stable JSON fails with bounded errors for excessive depth and circular input", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => stableStringify(circular), /cannot encode a circular value/u);

  let cursor: Record<string, unknown> = {};
  const root = cursor;
  for (let depth = 0; depth < 140; depth += 1) {
    const next: Record<string, unknown> = {};
    cursor["next"] = next;
    cursor = next;
  }
  assert.throws(() => stableStringify(root), /128-level depth safety limit/u);
});
