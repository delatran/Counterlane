import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseModelCatalog } from "../../src/codex/catalog.js";
import type { ArmPolicy, QuotaState, RepoProfile, VerificationCapabilitySummary } from "../../src/core/types.js";
import { buildCalibrationIndex } from "../../src/routing/calibration.js";
import { revalidateControlPolicy, revalidateTreatmentPolicy } from "../../src/runner/policy.js";
import { testConfig } from "../helpers.js";

void test("planned treatment routes are rejected when live quota invalidates premium speed", () => {
  const config = testConfig();
  const catalog = parseModelCatalog({ data: [{
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "Sol",
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    serviceTiers: [{ id: "fast", name: "Fast", description: "fast" }],
    isDefault: true,
  }] });
  const policy: ArmPolicy = {
    kind: "treatment",
    name: "planned-auto",
    modelId: "gpt-5.6-sol",
    modelFamily: "sol",
    effort: "medium",
    serviceTier: "fast",
    speedId: "fast",
    speedCostMultiplier: 2.5,
    speedLatencyMultiplier: 2 / 3,
    topology: "single",
    proofTier: "standard",
  };
  assert.throws(() => revalidateTreatmentPolicy({
    policy,
    prompt: "Urgent interactive task: fix the exact typo and run tests.",
    config,
    catalog,
    quota: quotaAt(config.routing.speed.maxUsagePercentForPremium),
    repo,
    verificationCapabilities: {
      availableTiers: ["basic", "standard", "strong", "adversarial"],
      commandCountByTier: { basic: 1, standard: 1, strong: 2, adversarial: 3 },
      taskSpecificCommandCountByTier: { basic: 0, standard: 0, strong: 0, adversarial: 0 },
      taskSpecificRequired: false,
      requiredCountByTier: { basic: 1, standard: 1, strong: 2, adversarial: 3 },
      estimatedCostWeightByTier: { basic: 0.2, standard: 0.55, strong: 1, adversarial: 1.8 },
      fingerprint: "live",
    },
    calibration: buildCalibrationIndex([]),
  }), /safety and quota gates|no admissible execution route/u);
});

void test("planned controls fail closed when their live proof tier disappears", () => {
  const config = testConfig();
  const catalog = parseModelCatalog({ data: [{
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "Sol",
    hidden: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    isDefault: true,
  }] });
  const policy: ArmPolicy = {
    kind: "control",
    name: "static-no-auto",
    modelId: "gpt-5.6-sol",
    modelFamily: "sol",
    effort: "high",
    serviceTier: null,
    speedId: "standard",
    speedCostMultiplier: 1,
    speedLatencyMultiplier: 1,
    topology: "single",
    proofTier: "standard",
  };
  assert.throws(() => revalidateControlPolicy({
    policy,
    prompt: "Apply the exact deterministic edit and run tests.",
    config,
    catalog,
    quota: quotaAt(10),
    repo,
    verificationCapabilities: {
      availableTiers: [],
      commandCountByTier: { basic: 0, standard: 0, strong: 0, adversarial: 0 },
      taskSpecificCommandCountByTier: { basic: 0, standard: 0, strong: 0, adversarial: 0 },
      taskSpecificRequired: false,
      requiredCountByTier: { basic: 1, standard: 1, strong: 2, adversarial: 3 },
      estimatedCostWeightByTier: { basic: 0.2, standard: 0.55, strong: 1, adversarial: 1.8 },
      fingerprint: "missing",
    },
    calibration: buildCalibrationIndex([]),
  }), /proof tier standard is no longer available/u);
});

void test("planned static controls cannot bypass premium quota gates", () => {
  const config = testConfig({
    routing: {
      ...testConfig().routing,
      static: { family: "sol", effort: "medium", speed: "fast" },
    },
  });
  const catalog = parseModelCatalog({ data: [{
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "Sol",
    hidden: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    serviceTiers: [{ id: "fast", name: "Fast", description: "fast" }],
    isDefault: true,
  }] });
  const policy: ArmPolicy = {
    kind: "control",
    name: "static-no-auto",
    modelId: "gpt-5.6-sol",
    modelFamily: "sol",
    effort: "medium",
    serviceTier: "fast",
    speedId: "fast",
    speedCostMultiplier: 2.5,
    speedLatencyMultiplier: 2 / 3,
    topology: "single",
    proofTier: "standard",
  };

  assert.throws(() => revalidateControlPolicy({
    policy,
    prompt: "Urgent exact edit with tests.",
    config,
    catalog,
    quota: quotaAt(config.routing.speed.maxUsagePercentForPremium),
    repo,
    verificationCapabilities: liveVerificationCapabilities(),
    calibration: buildCalibrationIndex([]),
  }), /static policy violates current task safety or quota gates/u);
});

void test("planned static controls cannot bypass critical task family floors", () => {
  const config = testConfig({
    routing: {
      ...testConfig().routing,
      static: { family: "luna", effort: "high", speed: "standard" },
    },
  });
  const catalog = parseModelCatalog({ data: [{
    id: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    displayName: "Luna",
    hidden: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    isDefault: true,
  }] });
  const policy: ArmPolicy = {
    kind: "control",
    name: "static-no-auto",
    modelId: "gpt-5.6-luna",
    modelFamily: "luna",
    effort: "high",
    serviceTier: null,
    speedId: "standard",
    speedCostMultiplier: 1,
    speedLatencyMultiplier: 1,
    topology: "single",
    proofTier: "standard",
  };

  assert.throws(() => revalidateControlPolicy({
    policy,
    prompt: "Fix a production OAuth authorization bypass and verify every permission boundary.",
    config,
    catalog,
    quota: quotaAt(10),
    repo: { ...repo, sensitivePathHits: ["auth/permissions.ts"] },
    verificationCapabilities: liveVerificationCapabilities(),
    calibration: buildCalibrationIndex([]),
  }), /static policy violates current task safety or quota gates/u);
});

const repo: RepoProfile = {
  root: "/repo",
  headCommit: "abc",
  branch: "main",
  dirty: false,
  trackedFileCount: 10,
  untrackedFileCount: 0,
  changedFileCount: 0,
  packageCount: 1,
  testFileCount: 2,
  languages: { TypeScript: 8 },
  sensitivePathHits: [],
  manifests: ["package.json"],
  verifierHints: ["npm test"],
  profileHash: "hash",
};

function quotaAt(usedPercent: number): QuotaState {
  return {
    known: true,
    exhausted: usedPercent >= 100,
    rateLimitReachedType: usedPercent >= 100 ? "rate_limit_reached" : null,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt: null,
    minutesUntilReset: null,
    pressure: usedPercent / 100,
    healthy: true,
    sourceLimitId: "codex",
  };
}

function liveVerificationCapabilities(): VerificationCapabilitySummary {
  return {
    availableTiers: ["basic", "standard", "strong", "adversarial"],
    commandCountByTier: { basic: 1, standard: 1, strong: 2, adversarial: 3 },
    taskSpecificCommandCountByTier: { basic: 0, standard: 0, strong: 0, adversarial: 0 },
    taskSpecificRequired: false,
    requiredCountByTier: { basic: 1, standard: 1, strong: 2, adversarial: 3 },
    estimatedCostWeightByTier: { basic: 0.2, standard: 0.55, strong: 1, adversarial: 1.8 },
    fingerprint: "live",
  };
}
