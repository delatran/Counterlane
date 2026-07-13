import { strict as assert } from "node:assert";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { testConfig } from "../helpers.js";

void test("telemetry reads a bounded tail and tolerates a torn final line", async () => {
  const root = await mkdtemp(join(tmpdir(), "counterlane-telemetry-"));
  const store = new TelemetryStore(root, testConfig({
    dataDirectory: ".counterlane",
    telemetry: {
      enabled: true,
      includePrompt: false,
      allowHostLedgerLearning: false,
      file: "events.jsonl",
      maximumReadEvents: 3,
      maximumReadBytes: 4_096,
    },
  }));

  for (let index = 0; index < 7; index += 1) {
    await store.append("test.event", { index });
  }
  await appendFile(store.trustedPath, '{"id":"torn"', "utf8");

  const events = await store.readAll();
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.payload["index"]), [4, 5, 6]);
  const recent = await store.readRecent(2);
  assert.deepEqual(recent.map((event) => event.payload["index"]), [5, 6]);
});

void test("telemetry reads wait for queued appends", async () => {
  const root = await mkdtemp(join(tmpdir(), "counterlane-telemetry-"));
  const store = new TelemetryStore(root, testConfig());
  const append = store.append("test.event", { committed: true });
  const events = await store.readAll();
  await append;
  assert.equal(events.at(-1)?.payload["committed"], true);
});

void test("historical learning is disabled unless the host explicitly opts in", async () => {
  const root = await mkdtemp(join(tmpdir(), "counterlane-telemetry-learning-"));
  const disabled = new TelemetryStore(root, testConfig());
  await disabled.append("route.observed", { outcome: "success" });
  assert.deepEqual(await disabled.readLearningEvents(), []);

  const enabled = new TelemetryStore(root, testConfig({
    telemetry: { ...testConfig().telemetry, allowHostLedgerLearning: true },
  }));
  assert.equal((await enabled.readLearningEvents()).length, 1);
});

void test("repository-local telemetry cannot inject learning events", async () => {
  const root = await mkdtemp(join(tmpdir(), "counterlane-telemetry-invalid-id-"));
  const store = new TelemetryStore(root, testConfig());
  await store.append("test.valid", { ok: true }, "valid-experiment");
  await appendFile(store.path, `${JSON.stringify({
    id: "bad",
    type: "experiment.completed",
    timestamp: new Date().toISOString(),
    experimentId: 123,
    payload: {},
  })}\n`, "utf8");
  await appendFile(store.path, `${JSON.stringify({
    id: "forged-well-shaped",
    type: "experiment.completed",
    timestamp: new Date().toISOString(),
    experimentId: "forged-experiment",
    payload: { utilityDelta: 1_000_000, treatmentSuccessful: true },
  })}\n`, "utf8");
  const events = await store.readAll();
  assert.deepEqual(events.map((event) => event.id).length, 1);
  assert.equal(events[0]?.experimentId, "valid-experiment");
});

void test("a failed telemetry write does not poison later appends", async () => {
  const root = await mkdtemp(join(tmpdir(), "counterlane-telemetry-recovery-"));
  const config = testConfig({ dataDirectory: ".counterlane" });
  const store = new TelemetryStore(root, config);
  const blockedDirectory = join(root, ".counterlane");
  await writeFile(blockedDirectory, "not a directory\n", "utf8");
  await assert.rejects(store.append("test.failure", { expected: true }));
  await rm(blockedDirectory, { force: true });
  await store.append("test.recovered", { recovered: true });
  const events = await store.readAll();
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["test.failure", "test.recovered"]);
  assert.equal(events.at(-1)?.type, "test.recovered");
  assert.equal(events.at(-1)?.payload["recovered"], true);
});

void test("telemetry I/O corruption is reported instead of masquerading as empty history", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "counterlane-telemetry-read-error-"));
  const store = new TelemetryStore(root, testConfig({ dataDirectory: ".counterlane" }));
  await mkdir(store.trustedPath, { recursive: true });
  await assert.rejects(store.readAll());
});

void test("telemetry rejects an escaping data-directory symlink or junction", async () => {
  const root = await mkdtemp(join(tmpdir(), "counterlane-telemetry-root-"));
  const outside = await mkdtemp(join(tmpdir(), "counterlane-telemetry-outside-"));
  await symlink(outside, join(root, ".counterlane"), process.platform === "win32" ? "junction" : "dir");
  const store = new TelemetryStore(root, testConfig({ dataDirectory: ".counterlane" }));

  await assert.rejects(
    store.append("test.escape", { escaped: true }),
    /outside (?:the )?repository/u,
  );
  assert.deepEqual(await readdir(outside), []);
});

void test("telemetry rejects an escaping nested file-parent symlink or junction", async () => {
  const root = await mkdtemp(join(tmpdir(), "counterlane-telemetry-root-"));
  const outside = await mkdtemp(join(tmpdir(), "counterlane-telemetry-outside-"));
  const outsideTelemetryPath = join(outside, "events.jsonl");
  const outsideTelemetry = `${JSON.stringify({
    id: "outside-event",
    type: "test.outside",
    timestamp: new Date().toISOString(),
    payload: { outside: true },
  })}\n`;
  await writeFile(outsideTelemetryPath, outsideTelemetry, "utf8");
  await mkdir(join(root, ".counterlane"));
  await symlink(outside, join(root, ".counterlane", "logs"), process.platform === "win32" ? "junction" : "dir");
  const store = new TelemetryStore(root, testConfig({
    dataDirectory: ".counterlane",
    telemetry: {
      ...testConfig().telemetry,
      file: "logs/events.jsonl",
    },
  }));

  await assert.rejects(
    store.append("test.escape", { escaped: true }),
    /outside (?:the )?(?:repository|configured data directory)/u,
  );
  assert.equal(await readFile(outsideTelemetryPath, "utf8"), outsideTelemetry);
});
