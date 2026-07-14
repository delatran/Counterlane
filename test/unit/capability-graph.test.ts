import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RouteCandidate, TaskFeatures } from "../../src/core/types.js";
import { buildCapabilityGraph, capabilityNodeKey } from "../../src/routing/capability-graph.js";

void test("capability graph uses immediate same-model effort edges and ignores score and enumeration order", () => {
  const low = candidate({ effort: "low", capabilityScore: 0.95 });
  const medium = candidate({ effort: "medium", capabilityScore: 0.2 });
  const high = candidate({ effort: "high", capabilityScore: 0.1 });
  const expected = buildCapabilityGraph([low, medium, high], features());
  const reversed = buildCapabilityGraph([high, medium, low], features());
  assert.deepEqual(reversed, expected);
  assert.deepEqual(expected.edges, [
    { from: capabilityNodeKey(low), to: capabilityNodeKey(medium), reason: "higher-effort" },
    { from: capabilityNodeKey(medium), to: capabilityNodeKey(high), reason: "higher-effort" },
  ].sort(compareEdge));
});

void test("speed and proof variants collapse onto one capability node", () => {
  const standard = candidate();
  const fastStrong = candidate({ speedId: "fast", serviceTier: "fast", proofTier: "strong" });
  const graph = buildCapabilityGraph([standard, fastStrong], features());
  assert.deepEqual(graph.nodes, [capabilityNodeKey(standard)]);
  assert.deepEqual(graph.edges, []);
});

void test("unknown effort labels do not create an arbitrary stronger relation", () => {
  const alpha = candidate({ effort: "vendor-alpha" });
  const beta = candidate({ effort: "vendor-beta" });
  const graph = buildCapabilityGraph([alpha, beta], features());
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges, []);
});

void test("an unknown effort is incomparable with every known effort", () => {
  const high = candidate({ effort: "high" });
  const custom = candidate({ effort: "vendor-custom" });
  const graph = buildCapabilityGraph([high, custom], features());
  assert.deepEqual(graph.edges, []);
});

void test("cross-family routes are incomparable for a simple task", () => {
  const terra = candidate();
  const sol = candidate({ modelId: "gpt-5.6-sol", modelFamily: "sol" });
  const graph = buildCapabilityGraph([terra, sol], features());
  assert.deepEqual(graph.edges, []);
});

void test("a complex task creates only the adjacent task-applicable family edge", () => {
  const luna = candidate({ modelId: "gpt-5.6-luna", modelFamily: "luna" });
  const terra = candidate();
  const sol = candidate({ modelId: "gpt-5.6-sol", modelFamily: "sol" });
  const graph = buildCapabilityGraph([sol, luna, terra], features({ depth: 0.7 }));
  assert.deepEqual(graph.edges, [
    { from: capabilityNodeKey(luna), to: capabilityNodeKey(terra), reason: "task-applicable-family" },
    { from: capabilityNodeKey(terra), to: capabilityNodeKey(sol), reason: "task-applicable-family" },
  ].sort(compareEdge));
});

void test("Ultra topology is comparable only when breadth and parallelism pass both thresholds", () => {
  const single = candidate({ effort: "max" });
  const ultra = candidate({ effort: "ultra", topology: "ultra" });
  const inapplicable = buildCapabilityGraph([single, ultra], features({ breadth: 0.9, parallelizability: 0.61 }));
  const applicable = buildCapabilityGraph([single, ultra], features({ breadth: 0.9, parallelizability: 0.9 }));
  assert.equal(inapplicable.edges.some((edge) => edge.reason === "task-applicable-topology"), false);
  assert.deepEqual(applicable.edges, [{
    from: capabilityNodeKey(single),
    to: capabilityNodeKey(ultra),
    reason: "task-applicable-topology",
  }]);
});

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
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
    proofCostWeight: 0.5,
    detectionEstimate: 0.9,
    predictedDurationMs: 1_000,
    predictedP90DurationMs: 2_000,
    predictedNormalizedCredits: 1,
    calibrationSamples: 0,
    capabilityScore: 0.7,
    costWeight: 1,
    latencyWeight: 1,
    successEstimate: 0.8,
    uncertainty: 0.1,
    badEscapeEstimate: 0.01,
    quotaPenalty: 0,
    switchPenalty: 0,
    objective: 1,
    admissible: true,
    rejectionReasons: [],
    ...overrides,
  };
}

function features(overrides: Partial<TaskFeatures> = {}): TaskFeatures {
  return {
    ambiguity: 0.1,
    breadth: 0.1,
    depth: 0.1,
    risk: 0.1,
    verifiability: 0.8,
    mechanicalness: 0.8,
    novelty: 0.1,
    parallelizability: 0.1,
    latencySensitivity: 0.1,
    destructivePotential: 0,
    taskKind: "bugfix",
    evidence: [],
    ...overrides,
  };
}

function compareEdge(left: { from: string; to: string; reason: string }, right: { from: string; to: string; reason: string }): number {
  return `${left.from}\0${left.to}\0${left.reason}`.localeCompare(`${right.from}\0${right.to}\0${right.reason}`);
}
