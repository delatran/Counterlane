import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { VerificationCommandConfig } from "../../src/config/types.js";
import { Logger } from "../../src/core/logger.js";
import { inspectVerificationCapabilities } from "../../src/verification/detect.js";
import { BlindVerifier } from "../../src/verification/verifier.js";
import { testConfig } from "../helpers.js";

void test("basic-only checks cannot masquerade as strong proof", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-proof-"));
  const config = configWithCommands([
    check("typecheck", "basic"),
    check("lint", "basic"),
  ]);
  const capabilities = await inspectVerificationCapabilities(cwd, config);
  assert.deepEqual(capabilities.availableTiers, ["basic"]);
});

void test("strong proof can combine an executable standard check with an independent basic check", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-proof-"));
  const config = configWithCommands([
    check("typecheck", "basic"),
    check("unit", "standard"),
  ]);
  const capabilities = await inspectVerificationCapabilities(cwd, config);
  assert.deepEqual(capabilities.availableTiers, ["basic", "standard", "strong"]);
  assert.equal(capabilities.availableTiers.includes("adversarial"), false);
});

void test("a generic host check cannot earn task-specific proof credit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-task-proof-"));
  const genericBase = configWithCommands([check("task-contract-check", "standard")]);
  const generic = testConfig({
    verification: {
      ...genericBase.verification,
      requireTaskSpecificCheck: true,
    },
  });
  const declaredBase = configWithCommands([check("task-contract-check", "standard", true)]);
  const declared = testConfig({
    verification: {
      ...declaredBase.verification,
      requireTaskSpecificCheck: true,
    },
  });

  const [genericCapabilities, declaredCapabilities] = await Promise.all([
    inspectVerificationCapabilities(cwd, generic),
    inspectVerificationCapabilities(cwd, declared),
  ]);
  assert.deepEqual(genericCapabilities.availableTiers, []);
  assert.equal(genericCapabilities.taskSpecificCommandCountByTier.standard, 0);
  assert.deepEqual(declaredCapabilities.availableTiers, ["standard"]);
  assert.equal(declaredCapabilities.taskSpecificCommandCountByTier.standard, 1);
  assert.notEqual(genericCapabilities.fingerprint, declaredCapabilities.fingerprint);

  const logger = new Logger({ level: "silent", json: true });
  const [genericReport, declaredReport] = await Promise.all([
    new BlindVerifier(generic, logger).verify(cwd, "standard"),
    new BlindVerifier(declared, logger).verify(cwd, "standard"),
  ]);
  assert.equal(genericReport.checks.length, 1, "generic checks remain executable evidence");
  assert.equal(genericReport.adequate, false);
  assert.equal(genericReport.passed, false);
  assert.equal(genericReport.taskSpecificRequired, true);
  assert.equal(genericReport.taskSpecificTotal, 0);
  assert.equal(declaredReport.adequate, true);
  assert.equal(declaredReport.passed, true);
  assert.equal(declaredReport.taskSpecificPassed, 1);
  assert.equal(declaredReport.taskSpecificTotal, 1);
});

void test("a failing task-specific check blocks proof even when configured optional", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-task-proof-fail-"));
  const base = configWithCommands([{
    name: "task-contract-check",
    command: [process.execPath, "-e", "process.exit(1)"],
    required: false,
    taskSpecific: true,
    minimumTier: "standard",
  }]);
  const config = testConfig({
    verification: {
      ...base.verification,
      requireTaskSpecificCheck: true,
    },
  });

  const report = await new BlindVerifier(config, new Logger({ level: "silent", json: true }))
    .verify(cwd, "standard");
  assert.equal(report.adequate, true);
  assert.equal(report.requiredTotal, 0);
  assert.equal(report.taskSpecificPassed, 0);
  assert.equal(report.taskSpecificTotal, 1);
  assert.equal(report.passed, false);
});

void test("a higher-tier command cannot make a lower tier available when it would not execute", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-proof-"));
  const config = configWithCommands([
    check("typecheck", "basic"),
    check("mutation", "adversarial"),
  ]);
  const capabilities = await inspectVerificationCapabilities(cwd, config);
  assert.deepEqual(capabilities.availableTiers, ["basic", "adversarial"]);

  const report = await new BlindVerifier(config, new Logger({ level: "silent", json: true }))
    .verify(cwd, "standard");
  assert.equal(report.adequate, false);
  assert.deepEqual(report.checks.map((entry) => entry.name), ["typecheck"]);
});

void test("adversarial proof requires and executes an explicit adversarial check", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-proof-"));
  const config = configWithCommands([
    check("unit", "standard"),
    check("mutation", "adversarial"),
  ]);
  const capabilities = await inspectVerificationCapabilities(cwd, config);
  assert.ok(capabilities.availableTiers.includes("adversarial"));

  const report = await new BlindVerifier(config, new Logger({ level: "silent", json: true }))
    .verify(cwd, "adversarial");
  assert.equal(report.adequate, true);
  assert.equal(report.passed, true);
  assert.deepEqual(report.checks.map((entry) => entry.name), ["unit", "mutation"]);
});

void test("verification failure and timeout are preserved as executable evidence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-proof-"));
  const config = configWithCommands([
    check("unit", "standard"),
    {
      name: "integration-timeout",
      command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      required: true,
      minimumTier: "strong",
      timeoutMs: 50,
    },
  ]);
  const report = await new BlindVerifier(config, new Logger({ level: "silent", json: true }))
    .verify(cwd, "strong");
  assert.equal(report.adequate, true);
  assert.equal(report.passed, false);
  assert.equal(report.checks.at(-1)?.result.timedOut, true);
});

void test("an allowed zero-command posture never becomes vacuous verified success", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-no-verifier-"));
  const base = testConfig();
  const config = testConfig({
    verification: {
      ...base.verification,
      autoDetect: false,
      routing: {
        ...base.verification.routing,
        enabled: false,
        candidateTiers: ["basic"],
        defaultTier: "basic",
        minimumIndependentChecks: {
          ...base.verification.routing.minimumIndependentChecks,
          basic: 0,
        },
      },
      requireAtLeastOne: false,
      failOnNoVerifier: false,
      commands: [],
    },
  });
  const capabilities = await inspectVerificationCapabilities(cwd, config);
  assert.deepEqual(capabilities.availableTiers, ["basic"]);

  const report = await new BlindVerifier(config, new Logger({ level: "silent", json: true }))
    .verify(cwd, "basic");
  assert.equal(report.adequate, false);
  assert.equal(report.passed, false);
  assert.equal(report.score, 0);
  assert.deepEqual(report.checks, []);
});

void test("verifier identity includes explicit environment semantics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-proof-env-"));
  const environmentSensitive = (flag: string): VerificationCommandConfig => ({
    name: "environment-sensitive",
    command: [process.execPath, "-e", "process.exit(process.env.FLAG === 'pass' ? 0 : 1)"],
    required: true,
    minimumTier: "basic",
    environment: { FLAG: flag },
  });
  const passing = configWithCommands([environmentSensitive("pass")]);
  const failing = configWithCommands([environmentSensitive("fail")]);
  const [passingCapabilities, failingCapabilities] = await Promise.all([
    inspectVerificationCapabilities(cwd, passing),
    inspectVerificationCapabilities(cwd, failing),
  ]);
  assert.notEqual(passingCapabilities.fingerprint, failingCapabilities.fingerprint);

  const logger = new Logger({ level: "silent", json: true });
  const [passingReport, failingReport] = await Promise.all([
    new BlindVerifier(passing, logger).verify(cwd, "basic"),
    new BlindVerifier(failing, logger).verify(cwd, "basic"),
  ]);
  assert.equal(passingReport.passed, true);
  assert.equal(failingReport.passed, false);
  assert.notEqual(passingReport.verifierHash, failingReport.verifierHash);
});

function check(
  name: string,
  minimumTier: "basic" | "standard" | "strong" | "adversarial",
  taskSpecific = false,
): VerificationCommandConfig {
  return {
    name,
    command: [process.execPath, "-e", `console.log(${JSON.stringify(name)})`],
    required: true,
    ...(taskSpecific ? { taskSpecific: true } : {}),
    minimumTier,
  };
}

function configWithCommands(commands: VerificationCommandConfig[]) {
  return testConfig({
    verification: {
      ...testConfig().verification,
      autoDetect: false,
      commands,
    },
  });
}
