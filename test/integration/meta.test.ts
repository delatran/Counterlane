import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { GitRepository } from "../../src/git/repository.js";
import { Logger } from "../../src/core/logger.js";
import { MetaExecutionRunner } from "../../src/runner/meta.js";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { createTestRepository, mockAppServerPath, testConfig } from "../helpers.js";

void test("meta scores a supported static effort even when Auto candidateEfforts omit it", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    routing: {
      ...base.routing,
      static: { family: "sol", effort: "low", speed: "standard" },
      candidateEfforts: ["medium", "high"],
    },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const runner = new MetaExecutionRunner({
    repository,
    config,
    telemetry: new TelemetryStore(root, config),
    logger: new Logger({ level: "error", json: false }),
  });

  const plan = await runner.plan("Replace the exact typo in answer.txt with correct and run the existing test.");
  assert.equal(plan.controlPolicy.effort, "low");
  assert.equal(plan.staticAdmissible, true);
  assert.notEqual(plan.decision.action, "auto");
});

void test("MetaExecutionRunner learns from paired evidence and executes the earned policy", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: true, includePrompt: false, allowHostLedgerLearning: true },
  });
  const repository = await GitRepository.discover(root);
  const telemetry = new TelemetryStore(root, config);
  const runner = new MetaExecutionRunner({
    repository,
    config,
    telemetry,
    logger: new Logger({ level: "error", json: false }),
  });
  const prompt = "Replace the exact typo in answer.txt with correct and run the existing test.";
  const initial = await runner.plan(prompt);
  assert.equal(initial.decision.action, "twin");

  for (let index = 0; index < 8; index += 1) {
    await telemetry.append("experiment.completed", {
      contextKeys: initial.context.fallbackKeys,
      utilityDelta: 24,
      verifiedSuccessDelta: 1,
      controlSuccessful: false,
      treatmentSuccessful: true,
      controlRouteCompliant: true,
      treatmentRouteCompliant: true,
    }, `seed-${index}`);
  }

  const result = await runner.run({ prompt });
  assert.equal(result.decision.action, "auto");
  assert.equal(result.execution, "single");
  assert.equal(result.single?.mode, "auto");
  assert.equal(result.single?.arm.successful, true);
  assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "wrong\n");
  assert.match(await readFile(result.artifactPath, "utf8"), /"action": "auto"/u);
});

void test("MetaExecutionRunner falls back to Static when live quota invalidates a planned Twin", async () => {
  const root = await createTestRepository();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "counterlane-quota-sequence-"));
  const sequencePath = join(fixtureDirectory, "quota.json");
  const wrapperPath = join(fixtureDirectory, "mock-wrapper.mjs");
  await writeFile(sequencePath, JSON.stringify([10, 90, 90]), "utf8");
  await writeFile(
    wrapperPath,
    `process.env.MOCK_USED_PERCENT_SEQUENCE_FILE = ${JSON.stringify(sequencePath)};\n` +
      `await import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [wrapperPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: true, includePrompt: false },
  });
  const repository = await GitRepository.discover(root);
  const telemetry = new TelemetryStore(root, config);
  const result = await new MetaExecutionRunner({
    repository,
    config,
    telemetry,
    logger: new Logger({ level: "error", json: false }),
  }).run({ prompt: "Replace the exact typo in answer.txt with correct and run the existing test." });

  assert.equal(result.decision.action, "static");
  assert.equal(result.execution, "single");
  assert.equal(result.single?.mode, "static");
  assert.match(result.decision.reasons.at(-1) ?? "", /quota no longer authorizes/u);
  assert.ok((await telemetry.readAll()).some((event) => event.type === "meta.revalidated"));
});
