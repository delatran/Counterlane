import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../../src/core/json.js";
import { parseModelCatalog } from "../../src/codex/catalog.js";
import type { QuotaState, RepoProfile, TelemetryEvent } from "../../src/core/types.js";
import {
  buildCalibrationIndex,
  calibrationFor,
  routeCalibrationContext,
  routeCalibrationKey,
  type RouteCalibrationContext,
} from "../../src/routing/calibration.js";
import { extractTaskFeatures } from "../../src/routing/features.js";
import { AutoRouter } from "../../src/routing/router.js";
import { testConfig } from "../helpers.js";

const repo: RepoProfile = {
  root: "/repo",
  headCommit: "abc",
  branch: "main",
  dirty: false,
  trackedFileCount: 100,
  untrackedFileCount: 0,
  changedFileCount: 0,
  packageCount: 1,
  testFileCount: 20,
  languages: { TypeScript: 90 },
  sensitivePathHits: [],
  manifests: ["package.json"],
  verifierHints: ["node"],
  profileHash: "hash",
};

const quota: QuotaState = {
  known: true,
  exhausted: false,
  rateLimitReachedType: null,
  usedPercent: 5,
  remainingPercent: 95,
  resetAt: null,
  minutesUntilReset: null,
  pressure: 0.05,
  healthy: true,
  sourceLimitId: "codex",
};
const defaultContext: RouteCalibrationContext = {
  taskKind: "mechanical_edit",
  riskTier: "normal",
  scopeTier: "narrow",
};

void test("calibration index summarizes route-conditioned outcomes", () => {
  const events = [
    observation("a", true, 10_000, 4),
    observation("b", false, 30_000, 8),
    observation("c", true, 20_000, 6),
    malformed(),
  ];
  const index = buildCalibrationIndex(events);
  const key = routeCalibrationKey({
    modelId: "gpt-5.6-terra",
    effort: "medium",
    speedId: "standard",
    topology: "single",
    proofTier: "standard",
    ...defaultContext,
  });
  const calibration = index.byRouteKey[key];
  assert.ok(calibration);
  assert.equal(index.sampleCount, 3);
  assert.equal(index.ignoredObservationCount, 0);
  assert.equal(calibration?.sampleCount, 3);
  assert.equal(calibration?.successCount, 2);
  assert.equal(calibration?.failureCount, 1);
  assert.equal(calibration?.timeoutCount, 0);
  assert.equal(calibration?.successRate, 2 / 3);
  assert.equal(calibration?.meanDurationMs, 20_000);
  assert.equal(calibration?.p90DurationMs, 30_000);
  assert.equal(calibration?.meanNormalizedCredits, 6);
});

void test("extreme finite telemetry values are excluded before calibration arithmetic", () => {
  const index = buildCalibrationIndex([
    observation("valid", true, 10_000, 4),
    observation("huge-duration", true, Number.MAX_VALUE, 4),
    observation("huge-cost", true, 10_000, Number.MAX_VALUE),
  ]);
  assert.equal(index.sampleCount, 1);
  assert.ok(Object.values(index.byRouteKey).every((entry) =>
    Number.isFinite(entry.meanDurationMs) && Number.isFinite(entry.meanNormalizedCredits)
  ));
});

void test("overly deep telemetry is ignored instead of denying routing", () => {
  const event = observation("deep", true, 10_000, 4);
  let cursor: JsonObject = {};
  event.payload["untrusted"] = cursor;
  for (let depth = 0; depth < 140; depth += 1) {
    const next: JsonObject = {};
    cursor["next"] = next;
    cursor = next;
  }
  const index = buildCalibrationIndex([event]);
  assert.equal(index.sampleCount, 0);
  assert.equal(index.ignoredObservationCount, 1);
});

void test("user-cancelled observations remain auditable but do not poison route calibration", () => {
  const events = [
    observation("success", true, 10_000, 4),
    observation("cancelled", false, 200, 0.2, "standard", "cancelled"),
    observation("timeout", false, 60_000, 9, "standard", "timeout"),
  ];
  const index = buildCalibrationIndex(events);
  const key = routeCalibrationKey({
    modelId: "gpt-5.6-terra",
    effort: "medium",
    speedId: "standard",
    topology: "single",
    proofTier: "standard",
    ...defaultContext,
  });
  const calibration = index.byRouteKey[key];
  assert.ok(calibration);
  assert.equal(index.sampleCount, 2);
  assert.equal(index.ignoredObservationCount, 1);
  assert.equal(calibration?.successCount, 1);
  assert.equal(calibration?.timeoutCount, 1);
  assert.equal(calibration?.failureCount, 0);
  assert.equal(calibration?.successRate, 0.5);
  assert.equal(calibration?.meanDurationMs, 35_000);
});

void test("duplicate and conflicting telemetry event ids cannot inflate calibration", () => {
  const first = observation("same", true, 10_000, 4);
  const duplicate = structuredClone(first);
  const duplicateIndex = buildCalibrationIndex([first, duplicate]);
  assert.equal(duplicateIndex.sampleCount, 1);
  assert.equal(duplicateIndex.ignoredObservationCount, 1);

  const conflict = observation("same", false, 50_000, 20);
  const conflictIndex = buildCalibrationIndex([first, conflict]);
  assert.equal(conflictIndex.sampleCount, 0);
  assert.equal(conflictIndex.ignoredObservationCount, 1);
});

void test("route calibration does not pool observations across unlike task contexts", () => {
  const index = buildCalibrationIndex([observation("context", true, 10_000, 4)]);
  const identity = {
    modelId: "gpt-5.6-terra",
    effort: "medium",
    speedId: "standard",
    topology: "single" as const,
    proofTier: "standard" as const,
  };
  assert.equal(calibrationFor(index, { ...identity, ...defaultContext })?.sampleCount, 1);
  assert.equal(calibrationFor(index, {
    ...identity,
    taskKind: "security",
    riskTier: "elevated",
    scopeTier: "narrow",
  }), undefined);
});

void test("empirical latency and success can overrule a stale Fast prior", () => {
  const catalog = parseModelCatalog({
    data: [{
      id: "gpt-5.6-terra",
      model: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      description: "test",
      hidden: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
      serviceTiers: [{ id: "fast", name: "Fast", description: "premium" }],
      defaultServiceTier: null,
      isDefault: true,
    }],
  });
  const prompt = "Urgent deterministic edit with strong existing tests.";
  const context = routeCalibrationContext(extractTaskFeatures(prompt, repo), repo);
  const events: TelemetryEvent[] = [];
  for (let index = 0; index < 8; index += 1) {
    events.push(observation(`standard-${index}`, true, 18_000 + index * 100, 5, "standard", undefined, context));
    events.push(observation(`fast-${index}`, false, 95_000 + index * 100, 24, "fast", undefined, context));
  }
  const decision = new AutoRouter(testConfig()).decide({
    prompt,
    repo,
    catalog,
    quota,
    calibration: buildCalibrationIndex(events),
    constraints: {
      modelFamily: "terra",
      effort: "medium",
      proofTier: "standard",
      latencyPriority: "urgent",
    },
  });
  assert.equal(decision.selected.speedId, "standard");
  assert.equal(decision.selected.calibrationSamples, 8);
  const fast = decision.candidates.find((candidate) => candidate.speedId === "fast");
  assert.ok(fast);
  assert.ok((fast?.predictedDurationMs ?? 0) > decision.selected.predictedDurationMs);
  assert.ok((fast?.successEstimate ?? 1) < decision.selected.successEstimate);
});

function observation(
  id: string,
  successful: boolean,
  durationMs: number,
  normalizedCredits: number,
  speedId = "standard",
  outcome?: "success" | "failure" | "timeout" | "cancelled",
  context: RouteCalibrationContext = defaultContext,
): TelemetryEvent {
  return {
    id,
    type: "route.observed",
    timestamp: new Date(1_700_000_000_000 + Number.parseInt(id.replace(/\D/gu, "") || "0", 10)).toISOString(),
    payload: {
      modelId: "gpt-5.6-terra",
      effort: "medium",
      speedId,
      topology: "single",
      proofTier: "standard",
      ...context,
      ...(outcome === undefined ? {} : { outcome }),
      successful,
      durationMs,
      normalizedCredits,
    },
  };
}

function malformed(): TelemetryEvent {
  return {
    id: "bad",
    type: "route.observed",
    timestamp: new Date().toISOString(),
    payload: { modelId: "gpt-5.6-terra" },
  };
}
