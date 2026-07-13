import type { ArmResult, CostEstimate, TurnRunResult, VerificationReport } from "../core/types.js";
import type { CounterlaneConfig } from "../config/types.js";
import { clamp } from "../core/utils.js";

export function calculateUtility(options: {
  turn: TurnRunResult;
  verification: VerificationReport;
  cost: CostEstimate;
  config: CounterlaneConfig;
  forcedFailure?: boolean;
}): number {
  const successfulTurn = options.turn.status === "completed" && options.forcedFailure !== true;
  const verifiedSuccess = successfulTurn && options.verification.passed;
  const badEscape = successfulTurn && !options.verification.passed;
  const latencyMinutes = (options.turn.durationMs + options.verification.durationMs) / 60_000;

  return (
    (verifiedSuccess ? options.config.utility.verifiedSuccessValue : 0) +
    options.verification.score * options.config.utility.verificationScoreValue -
    options.cost.normalizedCredits * options.config.utility.normalizedCreditPenalty -
    latencyMinutes * options.config.utility.latencyPenaltyPerMinute -
    (successfulTurn ? 0 : options.config.utility.failedTurnPenalty) -
    (badEscape ? options.config.utility.badEscapePenalty : 0)
  );
}

export function selectWinner(
  control: ArmResult,
  treatment: ArmResult,
  practicalEquivalenceMargin = 0.05,
): {
  winner: "control" | "treatment" | "tie" | "none";
  reason: string;
  controlUtility: number;
  treatmentUtility: number;
  utilityDelta: number;
  verifiedSuccessDelta: number;
  confidence: number;
} {
  const utilityDelta = treatment.utility - control.utility;
  const verifiedSuccessDelta = Number(treatment.successful) - Number(control.successful);

  if (control.successful && !treatment.successful) {
    return {
      winner: "control",
      reason: "Only the control arm reached verified completion.",
      controlUtility: control.utility,
      treatmentUtility: treatment.utility,
      utilityDelta,
      verifiedSuccessDelta,
      confidence: 0.98,
    };
  }
  if (treatment.successful && !control.successful) {
    return {
      winner: "treatment",
      reason: "Only the treatment arm reached verified completion.",
      controlUtility: control.utility,
      treatmentUtility: treatment.utility,
      utilityDelta,
      verifiedSuccessDelta,
      confidence: 0.98,
    };
  }
  if (!control.successful && !treatment.successful) {
    const scoreDelta = treatment.verification.score - control.verification.score;
    if (Math.abs(scoreDelta) < 0.05) {
      return {
        winner: "none",
        reason: "Neither arm reached verified completion.",
        controlUtility: control.utility,
        treatmentUtility: treatment.utility,
        utilityDelta,
        verifiedSuccessDelta,
        confidence: 0.4,
      };
    }
    const winner = scoreDelta > 0 ? "treatment" : "control";
    return {
      winner,
      reason: `Neither arm passed all required checks; ${winner} had the stronger partial verification score.`,
      controlUtility: control.utility,
      treatmentUtility: treatment.utility,
      utilityDelta,
      verifiedSuccessDelta,
      confidence: clamp(0.45 + Math.abs(scoreDelta) * 0.4),
    };
  }

  if (Math.abs(utilityDelta) < practicalEquivalenceMargin) {
    return {
      winner: "tie",
      reason: "Both arms reached verified completion with materially equivalent utility.",
      controlUtility: control.utility,
      treatmentUtility: treatment.utility,
      utilityDelta,
      verifiedSuccessDelta,
      confidence: 0.7,
    };
  }

  const winner = utilityDelta > 0 ? "treatment" : "control";
  return {
    winner,
    reason: `Both arms reached verified completion; ${winner} had higher verified utility after cost and latency penalties.`,
    controlUtility: control.utility,
    treatmentUtility: treatment.utility,
    utilityDelta,
    verifiedSuccessDelta,
    confidence: clamp(0.72 + Math.min(0.25, Math.abs(utilityDelta) / 50)),
  };
}
