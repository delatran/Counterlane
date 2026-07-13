/**
 * Mutation evidence is deliberately an optional probe. Counterlane does not assume
 * that mutation testing is always cheaper than using a stronger solver.
 */
export interface MutationOutcome {
  id: string;
  archetype: string;
  weight: number;
  detected: boolean;
}

export interface MutationAdequacy {
  weightedDetectionRate: number;
  detectedWeight: number;
  totalWeight: number;
  undetectedArchetypes: string[];
}

export function calculateMutationAdequacy(outcomes: readonly MutationOutcome[]): MutationAdequacy {
  const totalWeight = outcomes.reduce((sum, outcome) => sum + Math.max(0, outcome.weight), 0);
  const detectedWeight = outcomes
    .filter((outcome) => outcome.detected)
    .reduce((sum, outcome) => sum + Math.max(0, outcome.weight), 0);
  return {
    weightedDetectionRate: totalWeight === 0 ? 0 : detectedWeight / totalWeight,
    detectedWeight,
    totalWeight,
    undetectedArchetypes: [...new Set(outcomes.filter((outcome) => !outcome.detected).map((outcome) => outcome.archetype))],
  };
}

export function minimumDetectionRate(correctnessEstimate: number, maximumEscapeRisk: number): number {
  const failureProbability = Math.max(0, 1 - correctnessEstimate);
  if (failureProbability === 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, 1 - maximumEscapeRisk / failureProbability));
}
