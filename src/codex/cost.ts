import type { CostEstimate, ModelFamily, ThreadTokenUsage } from "../core/types.js";
import type { CounterlaneConfig } from "../config/types.js";

export function estimateCost(
  usage: ThreadTokenUsage | undefined,
  family: ModelFamily,
  config: CounterlaneConfig,
  fallbackDurationMs = 0,
  serviceTier: string | null = null,
  speedCostMultiplier = 1,
): CostEstimate {
  const modelWeight = config.routing.costModel.familyWeights[family];
  if (usage === undefined || !validBreakdown(usage.last)) {
    const fallback = Math.max(0.1, fallbackDurationMs / 60_000) * modelWeight * speedCostMultiplier;
    return {
      normalizedCredits: fallback,
      modelWeight,
      serviceTier,
      speedCostMultiplier,
      inputComponent: 0,
      cachedInputComponent: 0,
      outputComponent: 0,
      source: "fallback",
    };
  }

  const tokens = usage.last;
  const uncachedInput = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens);
  const inputComponent =
    (uncachedInput / 1_000_000) *
    config.routing.costModel.inputCreditsPerMillionAtLuna *
    modelWeight *
    speedCostMultiplier;
  const cachedInputComponent =
    (tokens.cachedInputTokens / 1_000_000) *
    config.routing.costModel.cachedInputCreditsPerMillionAtLuna *
    modelWeight *
    speedCostMultiplier;
  const outputComponent =
    (tokens.outputTokens / 1_000_000) *
    config.routing.costModel.outputCreditsPerMillionAtLuna *
    modelWeight *
    speedCostMultiplier;

  return {
    normalizedCredits: inputComponent + cachedInputComponent + outputComponent,
    modelWeight,
    serviceTier,
    speedCostMultiplier,
    inputComponent,
    cachedInputComponent,
    outputComponent,
    source: "token_usage",
  };
}

function validBreakdown(tokens: ThreadTokenUsage["last"]): boolean {
  return [
    tokens.totalTokens,
    tokens.inputTokens,
    tokens.cachedInputTokens,
    tokens.outputTokens,
    tokens.reasoningOutputTokens,
  ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    tokens.cachedInputTokens <= tokens.inputTokens &&
    tokens.reasoningOutputTokens <= tokens.outputTokens &&
    tokens.totalTokens === tokens.inputTokens + tokens.outputTokens;
}
