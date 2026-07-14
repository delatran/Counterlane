import { strict as assert } from "node:assert";
import { test } from "node:test";
import type {
  ModelCatalog,
  QuotaState,
  RepoProfile,
  RouteCandidate,
  RouteDecision,
  VerificationPlan,
} from "../../src/core/types.js";
import { assertExecutionEnvelopeCurrent, createExecutionEnvelope } from "../../src/runner/envelope.js";

void test("execution envelope ignores observation timestamps but rejects source, quota, and route-graph drift", () => {
  const first = candidate({ modelId: "gpt-5.6-terra", effort: "medium", capabilityScore: 0.7 });
  const second = candidate({ modelId: "gpt-5.6-sol", effort: "high", capabilityScore: 0.9 });
  const decision = routeDecision(first, [first, second]);
  const envelope = createExecutionEnvelope({ repo, catalog, quota, decision, verificationPlan });

  assert.doesNotThrow(() => assertExecutionEnvelopeCurrent({
    expected: envelope,
    repo,
    catalog: { ...catalog, fetchedAt: "2030-01-01T00:00:00.000Z" },
    quota,
    decision: routeDecision(first, [second, first]),
    verificationPlan,
  }));
  assert.throws(() => assertExecutionEnvelopeCurrent({
    expected: envelope,
    repo,
    catalog,
    quota: { ...quota, usedPercent: 11, remainingPercent: 89 },
    decision,
    verificationPlan,
  }), /frozen product execution envelope changed/u);
  assert.throws(() => assertExecutionEnvelopeCurrent({
    expected: envelope,
    repo: { ...repo, profileHash: "source-drift" },
    catalog,
    quota,
    decision,
    verificationPlan,
  }), /frozen product execution envelope changed/u);
});

const repo: RepoProfile = {
  root: "/repo",
  headCommit: "abc",
  branch: "main",
  dirty: false,
  trackedFileCount: 1,
  untrackedFileCount: 0,
  changedFileCount: 0,
  packageCount: 1,
  testFileCount: 1,
  languages: { TypeScript: 1 },
  sensitivePathHits: [],
  manifests: ["package.json"],
  verifierHints: ["node"],
  profileHash: "source",
};

const catalog: ModelCatalog = {
  models: [
    {
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      displayName: "Terra",
      hidden: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: true,
      raw: {},
    },
  ],
  fetchedAt: "2026-07-14T00:00:00.000Z",
};

const quota: QuotaState = {
  known: true,
  exhausted: false,
  rateLimitReachedType: null,
  usedPercent: 10,
  remainingPercent: 90,
  resetAt: "2026-07-14T03:00:00.000Z",
  minutesUntilReset: 180,
  pressure: 0.1,
  healthy: true,
  sourceLimitId: "codex",
};

const verificationPlan: VerificationPlan = {
  schemaVersion: 1,
  proofTier: "standard",
  adequate: true,
  certifying: true,
  minimumIndependentChecks: 1,
  taskSpecificRequired: true,
  commands: [],
  protectedAssets: [],
  containment: {
    filesystem: "isolated-worktree",
    network: "unverified",
    environment: "minimal-allowlist",
    processLimits: "best-effort",
  },
  planHash: "verification-plan",
};

function candidate(overrides: Partial<RouteCandidate>): RouteCandidate {
  return {
    modelId: "gpt-5.6-terra",
    modelFamily: "terra",
    effort: "medium",
    serviceTier: null,
    speedId: "standard",
    speedName: "Standard",
    speedCostMultiplier: 1,
    speedLatencyMultiplier: 1,
    topology: "single",
    proofTier: "standard",
    proofCostWeight: 1,
    detectionEstimate: 0.7,
    predictedDurationMs: 1,
    predictedP90DurationMs: 1,
    predictedNormalizedCredits: 1,
    calibrationSamples: 0,
    capabilityScore: 0.7,
    costWeight: 1,
    latencyWeight: 1,
    successEstimate: 0.8,
    uncertainty: 0.1,
    badEscapeEstimate: 0.1,
    quotaPenalty: 0,
    switchPenalty: 0,
    objective: 1,
    admissible: true,
    rejectionReasons: [],
    ...overrides,
  };
}

function routeDecision(selected: RouteCandidate, candidates: RouteCandidate[]): RouteDecision {
  return {
    selected,
    candidates,
    repo,
  } as RouteDecision;
}
