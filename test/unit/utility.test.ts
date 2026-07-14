import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ArmKind, ArmResult, CostEstimate, TurnRunResult, VerificationReport } from "../../src/core/types.js";
import { calculateUtility, selectWinner } from "../../src/runner/utility.js";
import { testConfig } from "../helpers.js";

void test("visible verifier failure is a detected failure, not a bad escape", () => {
  const base = testConfig();
  const config = testConfig({
    utility: {
      ...base.utility,
      detectedVerificationFailurePenalty: 17,
      failedTurnPenalty: 0,
      verificationScoreValue: 0,
      normalizedCreditPenalty: 0,
      latencyPenaltyPerMinute: 0,
    },
  });
  const turn = { status: "completed", durationMs: 0 } as TurnRunResult;
  const verification = { passed: false, adequate: true, durationMs: 0, score: 0 } as VerificationReport;
  const cost = { normalizedCredits: 0 } as CostEstimate;

  assert.equal(calculateUtility({ turn, verification, cost, config }), -17);
});

void test("neither verified arm has no winner and a partial leader remains non-applicable", () => {
  const decision = selectWinner(
    arm("control", { successful: false, outcome: "failure", verificationScore: 0.2 }),
    arm("treatment", { successful: false, outcome: "failure", verificationScore: 0.8 }),
  );

  assert.equal(decision.winner, "none");
  assert.equal(decision.partialLeader, "treatment");
  assert.equal(decision.decisionStrength, "non-applicable-partial-verification");
  assert.equal(decision.confidence, null);
  assert.equal(decision.confidenceStatus, "not-produced");
});

void test("verified cost and latency leaders remain distinct rather than becoming a scalar confidence claim", () => {
  const decision = selectWinner(
    arm("control", { normalizedCredits: 4, durationMs: 10 }),
    arm("treatment", { normalizedCredits: 2, durationMs: 20 }),
  );

  assert.equal(decision.winner, "treatment");
  assert.equal(decision.costLeader, "treatment");
  assert.equal(decision.latencyLeader, "control");
  assert.equal(decision.decisionStrength, "normalized-token-cost-proxy");
});

void test("duration fallback cannot select a verified economic winner", () => {
  const decision = selectWinner(
    arm("control", { costSource: "fallback" }),
    arm("treatment", { costSource: "token_usage" }),
  );

  assert.equal(decision.winner, "none");
  assert.equal(decision.costComparison, "incomparable");
  assert.equal(decision.costLeader, "unavailable");
});

function arm(kind: ArmKind, options: {
  successful?: boolean;
  outcome?: ArmResult["outcome"];
  verificationScore?: number;
  normalizedCredits?: number;
  durationMs?: number;
  costSource?: CostEstimate["source"];
} = {}): ArmResult {
  return {
    successful: options.successful ?? true,
    outcome: options.outcome ?? "success",
    durationMs: options.durationMs ?? 10,
    utility: kind === "control" ? 2 : 1,
    turn: { status: "completed" },
    verification: {
      passed: options.successful ?? true,
      adequate: true,
      score: options.verificationScore ?? 1,
    },
    cost: {
      normalizedCredits: options.normalizedCredits ?? 1,
      source: options.costSource ?? "token_usage",
    },
  } as unknown as ArmResult;
}
