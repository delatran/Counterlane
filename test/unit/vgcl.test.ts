import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CapabilityGraphEdge, RouteCandidate, RouteDecision, SingleRunResult } from "../../src/core/types.js";
import { capabilityNodeKey } from "../../src/routing/capability-graph.js";
import { AttemptJournal, executeVgcl, selectStrictSuccessor } from "../../src/runner/vgcl.js";

void test("VGCL escalates exactly once after a frozen verifier candidate defect", async () => {
  const journalRoot = await mkdtemp(join(tmpdir(), "counterlane-vgcl-"));
  const first = candidate({ modelId: "gpt-5.6-terra", effort: "medium", capabilityScore: 0.7 });
  const second = candidate({ modelId: "gpt-5.6-sol", modelFamily: "sol", effort: "high", capabilityScore: 0.9, predictedNormalizedCredits: 2 });
  const policies: string[] = [];
  try {
    const result = await executeVgcl({
      journalRoot,
      decision: routeDecision(first, [first, second]),
      envelopeHash: "frozen-envelope",
      executeAttempt: async (policy, lifecycle) => {
        await lifecycle.beforeTurnStart();
        policies.push(policy.modelId);
        return policies.length === 1 ? fakeResult({ passed: false }) : fakeResult({ passed: true });
      },
    });
    assert.equal(result.terminalState, "verified");
    assert.deepEqual(policies, ["gpt-5.6-terra", "gpt-5.6-sol"]);
    assert.equal(result.attempts.length, 2);
    assert.deepEqual(result.accounting, {
      maximumAttempts: 2,
      reserved: 2,
      completed: 2,
      unresolved: 0,
      transportRequests: 2,
      modelAttempts: 2,
      verifierRuns: 2,
      sequentialEscalations: 1,
    });
    assert.deepEqual(result.failureCapsule, {
      kind: "candidate_defect",
      verifierChecks: [{ name: "task-contract", passed: false }],
    });
    const journal = JSON.parse(await readFile(result.journalPath, "utf8")) as {
      state: string;
      attempts: Array<{ state: string }>;
      terminalState: string;
      envelopeHash?: string;
    };
    assert.equal(journal.state, "run_terminal");
    assert.equal(journal.terminalState, "verified");
    assert.equal(journal.envelopeHash, "frozen-envelope");
    assert.deepEqual(journal.attempts.map((attempt) => attempt.state), ["verification_terminal", "verification_terminal"]);
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
  }
});

void test("VGCL never escalates after an ambiguous attempt acknowledgement", async () => {
  const journalRoot = await mkdtemp(join(tmpdir(), "counterlane-vgcl-unknown-"));
  const first = candidate({ capabilityScore: 0.7 });
  const stronger = candidate({ modelId: "gpt-5.6-sol", modelFamily: "sol", effort: "high", capabilityScore: 0.9 });
  let calls = 0;
  try {
    const result = await executeVgcl({
      journalRoot,
      decision: routeDecision(first, [first, stronger]),
      executeAttempt: async (_policy, lifecycle) => {
        calls += 1;
        await lifecycle.beforeTurnStart();
        throw new Error("connection closed after turn/start send");
      },
    });
    assert.equal(result.terminalState, "reconciliation_required");
    assert.equal(result.failureCause, "infrastructure_or_protocol");
    assert.equal(result.accounting.modelAttempts, 1);
    assert.equal(result.accounting.unresolved, 1);
    assert.equal(calls, 1);
    const journal = JSON.parse(await readFile(result.journalPath, "utf8")) as {
      state: string;
      attempts: Array<{ state: string }>;
    };
    assert.equal(journal.state, "reconciliation_required");
    assert.deepEqual(journal.attempts.map((attempt) => attempt.state), ["acknowledgement_unknown"]);
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
  }
});

void test("VGCL refuses a new send while a prior journal requires reconciliation", async () => {
  const journalRoot = await mkdtemp(join(tmpdir(), "counterlane-vgcl-pending-"));
  const first = candidate({ capabilityScore: 0.7 });
  let calls = 0;
  const pendingPath = join(journalRoot, "previous.json");
  try {
    await writeFile(pendingPath, `${JSON.stringify({
      schemaVersion: 1,
      runId: "previous",
      state: "request_sent",
      maximumAttempts: 2,
      attempts: [{ ordinal: 1, state: "request_sent" }],
    })}\n`, "utf8");
    const result = await executeVgcl({
      journalRoot,
      decision: routeDecision(first, [first]),
      executeAttempt: async () => {
        calls += 1;
        return fakeResult({ passed: true });
      },
    });
    assert.equal(result.terminalState, "reconciliation_required");
    assert.equal(result.journalPath, pendingPath);
    assert.equal(calls, 0);
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
  }
});

void test("a pre-turn runner failure is terminal without consuming a model attempt", async () => {
  const journalRoot = await mkdtemp(join(tmpdir(), "counterlane-vgcl-pre-send-"));
  const first = candidate();
  try {
    const result = await executeVgcl({
      journalRoot,
      decision: routeDecision(first, [first]),
      executeAttempt: async () => {
        throw new Error("worktree setup failed before turn/start");
      },
    });
    assert.equal(result.terminalState, "failed");
    assert.deepEqual(result.accounting, {
      maximumAttempts: 2,
      reserved: 1,
      completed: 1,
      unresolved: 0,
      transportRequests: 0,
      modelAttempts: 0,
      verifierRuns: 0,
      sequentialEscalations: 0,
    });
    const journal = JSON.parse(await readFile(result.journalPath, "utf8")) as {
      state: string;
      attempts: Array<{ state: string; requestSentAt?: string }>;
    };
    assert.equal(journal.state, "run_terminal");
    assert.equal(journal.attempts[0]?.state, "pre_send_failed");
    assert.equal(journal.attempts[0]?.requestSentAt, undefined);
  } finally {
    await rm(journalRoot, { recursive: true, force: true });
  }
});

void test("speed-only and proof-only differences are never capability escalation edges", () => {
  const current = candidate({ modelId: "gpt-5.6-terra", effort: "medium", speedId: "standard", proofTier: "standard", capabilityScore: 0.7 });
  const speedOnly = candidate({ modelId: "gpt-5.6-terra", effort: "medium", speedId: "priority", proofTier: "standard", capabilityScore: 0.7 });
  const proofOnly = candidate({ modelId: "gpt-5.6-terra", effort: "medium", speedId: "standard", proofTier: "strong", capabilityScore: 0.7 });
  assert.equal(selectStrictSuccessor(current, [current, speedOnly, proofOnly], {
    schemaVersion: 1,
    nodes: [capabilityNodeKey(current)],
    edges: [],
  }), undefined);
});

void test("a conflicting journal lock fails closed instead of allowing another attempt owner", async () => {
  const journalRoot = await mkdtemp(join(tmpdir(), "counterlane-vgcl-lock-"));
  const first = await AttemptJournal.create(journalRoot, "fixed-run");
  try {
    await assert.rejects(AttemptJournal.create(journalRoot, "fixed-run"), /EEXIST|exists/u);
  } finally {
    await first.close();
    await rm(journalRoot, { recursive: true, force: true });
  }
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

function routeDecision(selected: RouteCandidate, candidates: RouteCandidate[]): RouteDecision {
  const edges: CapabilityGraphEdge[] = candidates
    .filter((candidate) => capabilityNodeKey(candidate) !== capabilityNodeKey(selected))
    .map((candidate) => ({
      from: capabilityNodeKey(selected),
      to: capabilityNodeKey(candidate),
      reason: "task-applicable-family" as const,
    }));
  return {
    selected,
    candidates,
    capabilityGraph: {
      schemaVersion: 1,
      nodes: [...new Set(candidates.map(capabilityNodeKey))].sort(),
      edges,
    },
    repo: { profileHash: "source" },
  } as RouteDecision;
}

function fakeResult(options: { passed: boolean }): SingleRunResult {
  return {
    arm: {
      outcome: "success",
      turn: { status: "completed", threadId: "thread_1" },
      verification: {
        passed: options.passed,
        adequate: true,
        checks: [{ name: "task-contract", passed: options.passed }],
      },
    },
  } as unknown as SingleRunResult;
}
