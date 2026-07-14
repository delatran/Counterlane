import type { ArmKind, ArmResult, CostEstimate, TurnRunResult, VerificationReport, WinnerDecision } from "../core/types.js";
import type { CounterlaneConfig } from "../config/types.js";

export function calculateUtility(options: {
  turn: TurnRunResult;
  verification: VerificationReport;
  cost: CostEstimate;
  config: CounterlaneConfig;
  forcedFailure?: boolean;
}): number {
  const successfulTurn = options.turn.status === "completed" && options.forcedFailure !== true;
  const verifiedSuccess = successfulTurn && options.verification.passed && options.verification.adequate;
  const detectedVerificationFailure = successfulTurn && !options.verification.passed;
  const latencyMinutes = (options.turn.durationMs + options.verification.durationMs) / 60_000;

  return (
    (verifiedSuccess ? options.config.utility.verifiedSuccessValue : 0) +
    options.verification.score * options.config.utility.verificationScoreValue -
    options.cost.normalizedCredits * options.config.utility.normalizedCreditPenalty -
    latencyMinutes * options.config.utility.latencyPenaltyPerMinute -
    (successfulTurn ? 0 : options.config.utility.failedTurnPenalty) -
    (detectedVerificationFailure ? options.config.utility.detectedVerificationFailurePenalty : 0)
  );
}

export function selectWinner(
  control: ArmResult,
  treatment: ArmResult,
  practicalEquivalenceMargin = 0.05,
): WinnerDecision {
  const utilityDelta = treatment.utility - control.utility;
  const controlVerified = isVerifiedCompletion(control);
  const treatmentVerified = isVerifiedCompletion(treatment);
  const verifiedSuccessDelta = Number(treatmentVerified) - Number(controlVerified);
  const latencyLeader = compareMetric(control.durationMs, treatment.durationMs, 0);
  const costComparison: WinnerDecision["costComparison"] = control.cost.source === "token_usage" && treatment.cost.source === "token_usage"
    ? "normalized-token-cost-proxy"
    : "incomparable";
  const costLeader: WinnerDecision["costLeader"] = costComparison === "normalized-token-cost-proxy"
    ? compareMetric(control.cost.normalizedCredits, treatment.cost.normalizedCredits, practicalEquivalenceMargin)
    : "unavailable";
  const base = {
    controlUtility: control.utility,
    treatmentUtility: treatment.utility,
    utilityDelta,
    verifiedSuccessDelta,
    costLeader,
    latencyLeader,
    costComparison,
    confidence: null,
    confidenceStatus: "not-produced" as const,
  };

  if (controlVerified && !treatmentVerified) {
    return {
      winner: "control",
      reason: "Only the control arm reached verified completion.",
      decisionStrength: "single-verified-completion",
      ...base,
    };
  }
  if (treatmentVerified && !controlVerified) {
    return {
      winner: "treatment",
      reason: "Only the treatment arm reached verified completion.",
      decisionStrength: "single-verified-completion",
      ...base,
    };
  }
  if (!controlVerified && !treatmentVerified) {
    const scoreDelta = treatment.verification.score - control.verification.score;
    if (scoreDelta === 0) {
      return {
        winner: "none",
        reason: "Neither arm reached verified completion.",
        decisionStrength: "no-verified-completion",
        ...base,
      };
    }
    const partialLeader = scoreDelta > 0 ? "treatment" : "control";
    return {
      winner: "none",
      partialLeader,
      reason: `Neither arm reached verified completion; ${partialLeader} has a diagnostic partial verification lead that is non-applicable.`,
      decisionStrength: "non-applicable-partial-verification",
      ...base,
    };
  }

  if (costComparison === "incomparable") {
    return {
      winner: "none",
      reason: "Both arms reached verified completion, but normalized token-cost proxy comparison is unavailable because at least one cost is a duration fallback.",
      decisionStrength: "incomparable-verified-outcomes",
      ...base,
    };
  }

  if (costLeader === "control" || costLeader === "treatment") {
    return {
      winner: costLeader,
      reason: `Both arms reached verified completion; ${costLeader} has the lower normalized token-cost proxy. Latency remains a separate recorded metric.`,
      decisionStrength: "normalized-token-cost-proxy",
      ...base,
    };
  }
  if (latencyLeader === "control" || latencyLeader === "treatment") {
    return {
      winner: latencyLeader,
      reason: `Both arms reached verified completion with equivalent normalized token-cost proxy; ${latencyLeader} has the lower observed end-to-end duration.`,
      decisionStrength: "latency-after-cost-equivalence",
      ...base,
    };
  }
  return {
    winner: "tie",
    reason: "Both arms reached verified completion with equivalent normalized token-cost proxy and observed duration.",
    decisionStrength: "verified-completion-equivalence",
    ...base,
  };
}

function isVerifiedCompletion(arm: ArmResult): boolean {
  return arm.successful &&
    arm.outcome === "success" &&
    arm.turn.status === "completed" &&
    arm.verification.passed &&
    arm.verification.adequate;
}

function compareMetric(control: number, treatment: number, equivalenceMargin: number): ArmKind | "tie" {
  if (Math.abs(control - treatment) <= equivalenceMargin) return "tie";
  return control < treatment ? "control" : "treatment";
}
