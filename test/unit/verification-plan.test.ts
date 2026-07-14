import { strict as assert } from "node:assert";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Logger } from "../../src/core/logger.js";
import { freezeVerificationPlan, verifyFrozenPlanIntegrity } from "../../src/verification/plan.js";
import { BlindVerifier } from "../../src/verification/verifier.js";
import { testConfig } from "../helpers.js";

void test("a frozen verifier plan fails closed when its baseline verifier entrypoint changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-verification-plan-"));
  const marker = join(cwd, "poisoned.txt");
  const entrypoint = join(cwd, "verify.mjs");
  const config = frozenConfig([{
    name: "baseline-task-contract",
    command: [process.execPath, "verify.mjs"],
    required: true,
    taskSpecific: true,
    minimumTier: "standard",
  }]);
  try {
    await writeFile(entrypoint, "process.exit(0);\n", "utf8");
    const plan = await freezeVerificationPlan(cwd, config, "standard");
    assert.equal(plan.commands[0]?.codeOwnership, "baseline-frozen");
    assert.deepEqual(
      plan.protectedAssets.filter((asset) => asset.scope === "candidate-repository").map((asset) => asset.path),
      ["verify.mjs"],
    );

    await writeFile(entrypoint, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(0);\n`, "utf8");
    const report = await new BlindVerifier(config, new Logger({ level: "silent", json: true }))
      .verify(cwd, "standard", undefined, plan);
    assert.equal(report.integrity, "compromised");
    assert.equal(report.passed, false);
    assert.equal(report.checks.length, 0);
    await assert.rejects(access(marker), isMissingPath);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("frozen product verification receives an explicit minimal environment, not ambient secrets", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-verification-environment-"));
  const hostDirectory = await mkdtemp(join(tmpdir(), "counterlane-host-verifier-"));
  const hostVerifier = join(hostDirectory, "verify-environment.mjs");
  const secretKey = "COUNTERLANE_TEST_AMBIENT_SECRET";
  const prior = process.env[secretKey];
  process.env[secretKey] = "ambient-canary";
  const config = frozenConfig([{
    name: "host-owned-environment-contract",
    command: [process.execPath, hostVerifier],
    required: true,
    taskSpecific: true,
    candidateCodePolicy: "data-only",
    minimumTier: "standard",
    environment: { EXPLICIT_VALUE: "allowed" },
  }]);
  try {
    await writeFile(
      hostVerifier,
      `process.exit(process.env.${secretKey} === undefined && process.env.EXPLICIT_VALUE === 'allowed' && process.env.HOME !== ${JSON.stringify(process.env["HOME"] ?? "")} ? 0 : 1);\n`,
      "utf8",
    );
    const plan = await freezeVerificationPlan(cwd, config, "standard", { authority: "host" });
    assert.equal(plan.commands[0]?.codeOwnership, "host-owned-immutable");
    assert.equal(plan.commands[0]?.candidateCodePolicy, "data-only");
    assert.equal(plan.certifying, true);
    const report = await new BlindVerifier(config, new Logger({ level: "silent", json: true }))
      .verify(cwd, "standard", undefined, plan);
    assert.equal(report.passed, true);
    assert.equal(report.integrity, "intact");
    assert.equal(report.containment?.environment, "minimal-allowlist");
    assert.equal(report.containment?.network, "unverified");
  } finally {
    if (prior === undefined) delete process.env[secretKey];
    else process.env[secretKey] = prior;
    await rm(cwd, { recursive: true, force: true });
    await rm(hostDirectory, { recursive: true, force: true });
  }
});

void test("host authority cannot certify an inline interpreter program", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-inline-verifier-"));
  try {
    await writeFile(join(cwd, "candidate.mjs"), "export const candidate = true;\n", "utf8");
    const config = frozenConfig([{
      name: "inline-wrapper",
      command: [process.execPath, "-e", "import('./candidate.mjs').then(() => process.exit(0))"],
      required: true,
      taskSpecific: true,
      candidateCodePolicy: "data-only",
      minimumTier: "standard",
    }]);
    const plan = await freezeVerificationPlan(cwd, config, "standard", { authority: "host" });
    assert.equal(plan.commands[0]?.codeOwnership, "unknown");
    assert.equal(plan.certifying, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("interpreter preload options are frozen but remain non-certifying", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-preload-verifier-"));
  const hostDirectory = await mkdtemp(join(tmpdir(), "counterlane-preload-host-"));
  const bootstrap = join(hostDirectory, "bootstrap.mjs");
  const verifier = join(hostDirectory, "verify.mjs");
  try {
    await writeFile(bootstrap, "export const bootstrap = true;\n", "utf8");
    await writeFile(verifier, "process.exit(0);\n", "utf8");
    const config = frozenConfig([{
      name: "preloaded-host-verifier",
      command: [process.execPath, `--import=${bootstrap}`, verifier],
      required: true,
      taskSpecific: true,
      candidateCodePolicy: "data-only",
      minimumTier: "standard",
    }]);
    const plan = await freezeVerificationPlan(cwd, config, "standard", { authority: "host" });
    const canonicalBootstrap = await realpath(bootstrap);
    assert.equal(plan.commands[0]?.codeOwnership, "unknown");
    assert.equal(plan.certifying, false);
    assert.equal(
      plan.protectedAssets.some((asset) => asset.scope === "host" && asset.path === canonicalBootstrap),
      true,
    );

    await writeFile(bootstrap, "export const bootstrap = false;\n", "utf8");
    const integrity = await verifyFrozenPlanIntegrity(cwd, plan);
    assert.equal(integrity.integrity, "compromised");
    assert.match(integrity.reasons.join("\n"), /bootstrap\.mjs/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(hostDirectory, { recursive: true, force: true });
  }
});

void test("a repository wrapper remains baseline-frozen and non-certifying even under host policy authority", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-repository-wrapper-"));
  try {
    await writeFile(join(cwd, "verify.mjs"), "await import('./candidate.mjs');\n", "utf8");
    await writeFile(join(cwd, "candidate.mjs"), "export const candidate = true;\n", "utf8");
    const config = frozenConfig([{
      name: "repository-wrapper",
      command: [process.execPath, "verify.mjs"],
      required: true,
      taskSpecific: true,
      candidateCodePolicy: "data-only",
      minimumTier: "standard",
    }]);
    const plan = await freezeVerificationPlan(cwd, config, "standard", { authority: "host" });
    assert.equal(plan.commands[0]?.codeOwnership, "baseline-frozen");
    assert.equal(plan.certifying, false);
    assert.deepEqual(
      plan.protectedAssets.filter((asset) => asset.scope === "candidate-repository").map((asset) => asset.path),
      ["verify.mjs"],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("an external verifier needs both host authority and an explicit data-only contract", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "counterlane-verifier-authority-"));
  const hostDirectory = await mkdtemp(join(tmpdir(), "counterlane-verifier-authority-host-"));
  const hostVerifier = join(hostDirectory, "verify.mjs");
  try {
    await writeFile(hostVerifier, "process.exit(0);\n", "utf8");
    const baseCommand = {
      name: "external-verifier",
      command: [process.execPath, hostVerifier],
      required: true,
      taskSpecific: true,
      minimumTier: "standard" as const,
    };
    const repositoryAuthority = await freezeVerificationPlan(
      cwd,
      frozenConfig([{ ...baseCommand, candidateCodePolicy: "data-only" }]),
      "standard",
    );
    const undeclaredCandidatePolicy = await freezeVerificationPlan(
      cwd,
      frozenConfig([baseCommand]),
      "standard",
      { authority: "host" },
    );
    assert.equal(repositoryAuthority.certifying, false);
    assert.equal(repositoryAuthority.commands[0]?.codeOwnership, "unknown");
    assert.equal(undeclaredCandidatePolicy.certifying, false);
    assert.equal(undeclaredCandidatePolicy.commands[0]?.candidateCodePolicy, "undeclared");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(hostDirectory, { recursive: true, force: true });
  }
});

function frozenConfig(commands: ReturnType<typeof testConfig>["verification"]["commands"]) {
  const base = testConfig();
  return testConfig({
    verification: {
      ...base.verification,
      autoDetect: false,
      requireAtLeastOne: true,
      failOnNoVerifier: true,
      requireTaskSpecificCheck: true,
      commands,
    },
  });
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
