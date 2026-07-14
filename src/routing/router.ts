import type { CounterlaneConfig, SpeedProfileConfig } from "../config/types.js";
import type {
  ModelCatalog,
  ModelCatalogEntry,
  ModelFamily,
  ProofTier,
  QuotaState,
  RepoProfile,
  RouteCalibrationIndex,
  RouteCandidate,
  RouteConstraints,
  RouteDecision,
  RoutingProfile,
  TaskFeatures,
  VerificationCapabilitySummary,
} from "../core/types.js";
import { clamp, MAX_TIMER_DELAY_MS, round } from "../core/utils.js";
import {
  closestSupportedEffort,
  closestSupportedSpeed,
  modelFamily,
  selectFamilyModel,
  serviceTierForSpeed,
  speedDisplayName,
  supportedEfforts,
} from "../codex/catalog.js";
import { extractTaskFeatures } from "./features.js";
import { buildCapabilityGraph } from "./capability-graph.js";
import { calibrationFor, routeCalibrationContext, type RouteCalibrationContext } from "./calibration.js";
import { commandMinimumTier, proofTierRank } from "../verification/detect.js";

const BASE_CAPABILITY: Record<ModelFamily, number> = {
  luna: 0.6,
  terra: 0.77,
  sol: 0.91,
  unknown: 0.74,
};

const FAMILY_LATENCY: Record<ModelFamily, number> = {
  luna: 0.62,
  terra: 0.84,
  sol: 1.08,
  unknown: 0.9,
};

const EFFORT_DELTA: Record<string, number> = {
  none: -0.1,
  minimal: -0.08,
  low: -0.055,
  light: -0.055,
  medium: 0,
  high: 0.045,
  xhigh: 0.075,
  max: 0.1,
  ultra: 0.13,
};

const EFFORT_COST: Record<string, number> = {
  none: 0.65,
  minimal: 0.7,
  low: 0.78,
  light: 0.78,
  medium: 1,
  high: 1.35,
  xhigh: 1.72,
  max: 2.25,
  ultra: 4.2,
};

const EFFORT_LATENCY: Record<string, number> = {
  none: 0.62,
  minimal: 0.68,
  low: 0.78,
  light: 0.78,
  medium: 1,
  high: 1.34,
  xhigh: 1.72,
  max: 2.3,
  ultra: 1.45,
};

export interface StaticRoute {
  model: ModelCatalogEntry;
  family: ModelFamily;
  effort: string;
  serviceTier: string | null;
  speedId: string;
  speedName: string;
  speedCostMultiplier: number;
  speedLatencyMultiplier: number;
  topology: "single" | "ultra";
  proofTier: ProofTier;
}

export class AutoRouter {
  readonly #config: CounterlaneConfig;

  public constructor(config: CounterlaneConfig) {
    this.#config = config;
  }

  public decide(options: {
    prompt: string;
    repo: RepoProfile;
    catalog: ModelCatalog;
    quota: QuotaState;
    constraints?: RouteConstraints;
    verificationCapabilities?: VerificationCapabilitySummary;
    calibration?: RouteCalibrationIndex;
  }): RouteDecision {
    const constraints = normalizeRouteConstraints(options.constraints);
    const features = applyLatencyPriority(extractTaskFeatures(options.prompt, options.repo), constraints);
    const verificationCapabilities = options.verificationCapabilities ?? assumedVerificationCapabilities(this.#config);
    const candidates = this.#enumerate(
      options.catalog,
      features,
      routeCalibrationContext(features, options.repo),
      options.quota,
      constraints,
      verificationCapabilities,
      options.calibration,
    );
    if (candidates.length === 0) {
      throw new Error(`No Codex route matches the requested constraints: ${formatConstraints(constraints)}.`);
    }
    const admissible = candidates.filter((candidate) => candidate.admissible);
    const rankedCandidates = candidates.slice().sort((left, right) => {
      if (left.admissible !== right.admissible) return left.admissible ? -1 : 1;
      if (left.admissible) return compareExecutableCandidates(left, right, constraints);
      return compareDiagnosticCandidates(left, right);
    });
    const selected = rankedCandidates[0];

    if (selected === undefined) {
      throw new Error("No visible Codex model matched the configured families.");
    }
    if (admissible.length === 0 && (hasHardConstraints(constraints) || isCritical(features))) {
      const reasons = [...new Set(candidates.flatMap((candidate) => candidate.rejectionReasons))].slice(0, 8);
      throw new Error(
        `The requested route constraints do not satisfy Counterlane safety and quota gates (including proof/deadline): ${reasons.join("; ") || "no admissible candidate"}.`,
      );
    }

    return {
      profile: this.#config.routing.profile,
      constraints,
      selected,
      candidates: rankedCandidates,
      capabilityGraph: buildCapabilityGraph(rankedCandidates, features),
      features,
      repo: options.repo,
      quota: options.quota,
      verificationCapabilities,
      rationale: buildRationale(
        selected,
        features,
        options.quota,
        this.#config.routing.profile,
        constraints,
        requiredCompletion(features, this.#config.routing.minimumCompletion),
      ),
      decidedAt: new Date().toISOString(),
    };
  }

  public staticPolicy(
    catalog: ModelCatalog,
    verificationCapabilities: VerificationCapabilitySummary = assumedVerificationCapabilities(this.#config),
  ): StaticRoute {
    const requestedFamily = this.#config.routing.static.family;
    const familyModel = selectFamilyModel(catalog, requestedFamily, this.#config);
    const model = familyModel ?? catalog.models.find((entry) => entry.isDefault && !entry.hidden) ?? catalog.models.find((entry) => !entry.hidden);
    if (model === undefined) {
      throw new Error("Codex model catalog is empty.");
    }
    const speedId = closestSupportedSpeed(model, this.#config.routing.static.speed, this.#config);
    const speedProfile = this.#speedProfile(model, speedId);
    const defaultProofTier = this.#config.verification.routing.defaultTier;
    const proofTier = verificationCapabilities.availableTiers.includes(defaultProofTier)
      ? defaultProofTier
      : verificationCapabilities.availableTiers.at(-1) ?? defaultProofTier;
    const effort = closestSupportedEffort(model, this.#config.routing.static.effort, this.#config.routing.candidateEfforts);
    return {
      model,
      family: modelFamily(model, this.#config),
      effort,
      serviceTier: serviceTierForSpeed(speedId),
      speedId,
      speedName: speedDisplayName(model, speedId),
      speedCostMultiplier: speedProfile.costMultiplier,
      speedLatencyMultiplier: speedProfile.latencyMultiplier,
      topology: effort === "ultra" ? "ultra" : "single",
      proofTier,
    };
  }

  #enumerate(
    catalog: ModelCatalog,
    features: TaskFeatures,
    calibrationContext: RouteCalibrationContext,
    quota: QuotaState,
    constraints: RouteConstraints,
    verificationCapabilities: VerificationCapabilitySummary,
    calibration?: RouteCalibrationIndex,
  ): RouteCandidate[] {
    const visibleModels = catalog.models.filter((model) => !model.hidden);
    const models = visibleModels.filter((model) => {
      const family = modelFamily(model, this.#config);
      if (constraints.modelId !== undefined && model.id !== constraints.modelId && model.model !== constraints.modelId) {
        return false;
      }
      if (constraints.modelFamily !== undefined && family !== constraints.modelFamily) {
        return false;
      }
      return true;
    });
    const proofTiers = constraints.proofTier === undefined
      ? (this.#config.verification.routing.enabled
          ? this.#config.verification.routing.candidateTiers
          : [this.#config.verification.routing.defaultTier])
      : [constraints.proofTier];
    const candidates: RouteCandidate[] = [];
    for (const model of models) {
      const family = modelFamily(model, this.#config);
      const supported = supportedEfforts(model);
      const configuredEfforts = supported.filter((effort) => this.#config.routing.candidateEfforts.includes(effort));
      const baseEfforts = configuredEfforts.length > 0 ? configuredEfforts : [model.defaultReasoningEffort];
      const consideredEfforts = constraints.effort === undefined
        ? baseEfforts
        : supported.includes(constraints.effort) ? [constraints.effort] : [];
      const speeds = this.#candidateSpeeds(model, constraints);
      for (const effort of consideredEfforts) {
        const topology = effort === "ultra" ? "ultra" : "single";
        if (constraints.topology !== undefined && topology !== constraints.topology) {
          continue;
        }
        for (const speedId of speeds) {
          for (const proofTier of proofTiers) {
            candidates.push(this.#scoreCandidate(
              model,
              family,
              effort,
              speedId,
              proofTier,
              features,
              calibrationContext,
              quota,
              constraints,
              verificationCapabilities,
              calibration,
            ));
          }
        }
      }
    }
    return deduplicateCandidates(candidates);
  }

  #candidateSpeeds(model: ModelCatalogEntry, constraints: RouteConstraints): string[] {
    const advertised = new Set(model.serviceTiers.map((tier) => tier.id));
    if (constraints.speedMode === "off") return ["standard"];
    if (constraints.speedMode === "fast") {
      // Product Fast is an explicit request for a configured, advertised
      // premium tier. It is never silently substituted with Standard or an
      // unadvertised service-tier id.
      return this.#config.routing.speed.candidateTiers.filter((speedId) =>
        speedId !== "standard" && advertised.has(speedId) && this.#speedProfile(model, speedId).premium
      );
    }
    if (constraints.speedId !== undefined) {
      if (constraints.speedId === "standard") return ["standard"];
      return advertised.has(constraints.speedId) || this.#config.routing.speed.allowUnadvertisedTiers
        ? [constraints.speedId]
        : [];
    }
    if (constraints.speedMode === "auto" && !this.#config.routing.speed.enabled) return ["standard"];
    if (!this.#config.routing.speed.enabled) {
      return [closestSupportedSpeed(model, this.#config.routing.speed.defaultTier, this.#config)];
    }
    return this.#config.routing.speed.candidateTiers.filter((speedId) =>
      speedId === "standard" || advertised.has(speedId) || this.#config.routing.speed.allowUnadvertisedTiers
    );
  }

  #speedProfile(model: ModelCatalogEntry, speedId: string): SpeedProfileConfig {
    const base = this.#config.routing.speed.profiles[speedId] ?? {
      costMultiplier: 1.5,
      latencyMultiplier: 0.8,
      premium: speedId !== "standard",
    };
    const haystack = `${model.id} ${model.model} ${model.displayName}`.toLowerCase();
    const override = base.modelOverrides?.find((candidate) => matchesModel(haystack, candidate.matcher));
    return {
      costMultiplier: override?.costMultiplier ?? base.costMultiplier,
      latencyMultiplier: override?.latencyMultiplier ?? base.latencyMultiplier,
      premium: base.premium,
      ...(base.modelOverrides === undefined ? {} : { modelOverrides: base.modelOverrides }),
    };
  }

  #scoreCandidate(
    model: ModelCatalogEntry,
    family: ModelFamily,
    effort: string,
    speedId: string,
    proofTier: ProofTier,
    features: TaskFeatures,
    calibrationContext: RouteCalibrationContext,
    quota: QuotaState,
    constraints: RouteConstraints,
    verificationCapabilities: VerificationCapabilitySummary,
    calibrationIndex?: RouteCalibrationIndex,
  ): RouteCandidate {
    const rejectionReasons: string[] = [];
    const effortDelta = EFFORT_DELTA[effort] ?? 0;
    const topology = effort === "ultra" ? "ultra" : "single";
    const speedProfile = this.#speedProfile(model, speedId);
    const ultraFit = topology === "ultra"
      ? features.parallelizability * 0.12 + features.breadth * 0.06 - features.depth * 0.035
      : 0;

    // Speed is deliberately excluded from capability: it changes latency and
    // economics, not intelligence.
    const capabilityScore = clamp(BASE_CAPABILITY[family] + effortDelta + familyTaskFit(family, features) + ultraFit);
    const feedbackBenefit = features.verifiability * (0.04 + features.mechanicalness * 0.035);
    const heuristicSuccess = clamp(capabilityScore + feedbackBenefit - features.novelty * 0.04);
    const heuristicUncertainty = clamp(
      0.08 + features.ambiguity * 0.28 + features.novelty * 0.25 + (family === "unknown" ? 0.2 : 0),
    );
    const proofCostWeight = verificationCapabilities.estimatedCostWeightByTier[proofTier] ??
      this.#config.verification.routing.costWeights[proofTier];
    const baseDetection = 0.16 + features.verifiability * 0.58 + features.mechanicalness * 0.06;
    const detectionEstimate = Math.max(
      this.#config.verification.routing.detectionFloors[proofTier],
      clamp(baseDetection + this.#config.verification.routing.detectionBoosts[proofTier]),
    );
    const solverCostWeight = estimateRouteCostWeight(this.#config, family, effort, speedProfile.costMultiplier);
    const costWeight = solverCostWeight + proofCostWeight;
    const solverLatencyWeight = estimateRouteLatencyWeight(family, effort, speedProfile.latencyMultiplier);
    const latencyWeight = solverLatencyWeight + proofCostWeight * 0.28;

    const calibration = calibrationFor(calibrationIndex, {
      modelId: model.id,
      effort,
      speedId,
      topology,
      proofTier,
      ...calibrationContext,
    });
    const calibrationWeight = empiricalWeight(
      calibration?.sampleCount ?? 0,
      this.#config.routing.prediction.minimumCalibrationSamples,
      this.#config.routing.prediction.shrinkageSamples,
    );
    const successEstimate = calibration === undefined
      ? heuristicSuccess
      : blend(heuristicSuccess, calibration.successRate, calibrationWeight);
    const uncertainty = clamp(heuristicUncertainty * (1 - calibrationWeight * 0.62));
    const generationLowerBound = clamp(successEstimate - uncertainty * uncertaintyMultiplier(features));
    const badEscapeEstimate = clamp((1 - generationLowerBound) * (1 - detectionEstimate));
    const verifiedReliability = 1 - badEscapeEstimate;

    const fallbackDurationMs = this.#config.routing.prediction.baselineDurationMs * latencyWeight;
    const fallbackP90DurationMs = fallbackDurationMs * this.#config.routing.prediction.p90Multiplier;
    const fallbackCredits = costWeight * this.#config.routing.prediction.fallbackCreditsPerCostWeight;
    const predictedDurationMs = calibration === undefined
      ? fallbackDurationMs
      : blend(fallbackDurationMs, calibration.meanDurationMs, calibrationWeight);
    const predictedP90DurationMs = calibration === undefined
      ? fallbackP90DurationMs
      : blend(fallbackP90DurationMs, Math.max(calibration.p90DurationMs, calibration.meanDurationMs), calibrationWeight);
    const predictedNormalizedCredits = calibration === undefined
      ? fallbackCredits
      : blend(fallbackCredits, calibration.meanNormalizedCredits, calibrationWeight);

    const quotaPenalty = predictedNormalizedCredits * quota.pressure /
      Math.max(1, this.#config.routing.prediction.fallbackCreditsPerCostWeight);
    const switchPenalty = 0;
    const completionThreshold = requiredCompletion(features, this.#config.routing.minimumCompletion);
    const qualityThreshold = requiredQuality(features, this.#config.routing.minimumQuality);
    const minimumProofTier = requiredProofTier(features, this.#config);
    const quotaUsageAvailable = quota.known && quota.usedPercent !== null && quota.remainingPercent !== null;

    if (successEstimate + 1e-9 < completionThreshold) {
      rejectionReasons.push(
        `completion estimate ${round(successEstimate)} is below required ${round(completionThreshold)}`,
      );
    }
    if (verifiedReliability + 1e-9 < qualityThreshold) {
      rejectionReasons.push(
        `verified-reliability lower bound ${round(verifiedReliability)} is below required ${round(qualityThreshold)}`,
      );
    }
    if (!verificationCapabilities.availableTiers.includes(proofTier)) {
      rejectionReasons.push(`proof tier ${proofTier} is unavailable in this repository`);
    }
    if (proofTierRank(proofTier) < proofTierRank(minimumProofTier)) {
      rejectionReasons.push(`risk floor requires proof tier ${minimumProofTier} or stronger`);
    }
    if (isCritical(features) && family !== "sol") {
      rejectionReasons.push("critical-risk tasks require the Sol family");
    }
    if (features.destructivePotential >= 0.7 && family === "luna") {
      rejectionReasons.push("destructive tasks cannot use the Luna family");
    }
    if (
      quota.exhausted ||
      (quota.known && (
        (quota.usedPercent !== null && quota.usedPercent >= 100) ||
        (quota.remainingPercent !== null && quota.remainingPercent <= 0)
      ))
    ) {
      rejectionReasons.push(`quota window ${quota.sourceLimitId ?? "selected"} is exhausted; delegated execution must abstain`);
    }
    if (effort === "max" && !this.#config.routing.enableMax) {
      rejectionReasons.push("Max effort is disabled");
    }
    if (effort === "max" && !quotaUsageAvailable) {
      rejectionReasons.push("quota usage is unavailable; Max fails closed");
    } else if (effort === "max" && quota.usedPercent !== null && quota.usedPercent > this.#config.routing.maxUsagePercentForMax) {
      rejectionReasons.push("quota usage is above the configured Max threshold");
    }
    if (topology === "ultra" && !this.#config.routing.enableUltra) {
      rejectionReasons.push("Ultra topology is disabled");
    }
    if (topology === "ultra" && !quotaUsageAvailable) {
      rejectionReasons.push("quota usage is unavailable; Ultra fails closed");
    } else if (topology === "ultra" && quota.usedPercent !== null && quota.usedPercent > this.#config.routing.maxUsagePercentForUltra) {
      rejectionReasons.push("quota usage is above the configured Ultra threshold");
    }
    if (topology === "ultra" && features.parallelizability < 0.62) {
      rejectionReasons.push("task lacks enough independent workstreams for Ultra");
    }
    if (topology === "ultra" && features.breadth < 0.48) {
      rejectionReasons.push("task scope is too narrow for Ultra");
    }
    if (topology === "ultra" && proofTierRank(proofTier) < proofTierRank("strong")) {
      rejectionReasons.push("Ultra requires separable strong verification");
    }
    if (speedProfile.premium && !quotaUsageAvailable) {
      rejectionReasons.push("quota usage is unavailable; premium speed fails closed");
    } else if (
      speedProfile.premium &&
      quota.usedPercent !== null &&
      quota.usedPercent >= this.#config.routing.speed.maxUsagePercentForPremium
    ) {
      rejectionReasons.push("quota usage is at or above the configured premium-speed threshold");
    }
    if (speedProfile.premium && constraints.speedMode !== undefined && constraints.executionContext !== "foreground") {
      rejectionReasons.push("premium speed requires an explicit foreground execution context");
    }
    if (speedProfile.premium && constraints.speedMode === "auto" && !hasStructuredLatencyDemand(constraints)) {
      rejectionReasons.push("Auto premium speed requires an explicit structured deadline or urgent latency priority");
    } else if (
      speedProfile.premium &&
      constraints.speedMode === undefined &&
      constraints.speedId === undefined &&
      features.latencySensitivity < this.#config.routing.speed.minimumLatencySensitivityForPremium
    ) {
      // Advanced/raw routing remains backward compatible, but the product
      // `speedMode: auto` path above never lets prompt wording unlock premium.
      rejectionReasons.push("task latency sensitivity is too low for premium speed");
    }
    if (constraints.deadlineMs !== undefined && predictedP90DurationMs > constraints.deadlineMs) {
      rejectionReasons.push(
        `predicted p90 ${Math.round(predictedP90DurationMs)} ms exceeds deadline ${Math.round(constraints.deadlineMs)} ms`,
      );
    }
    if (
      constraints.maxNormalizedCredits !== undefined &&
      predictedNormalizedCredits > constraints.maxNormalizedCredits
    ) {
      rejectionReasons.push(
        `predicted credits ${round(predictedNormalizedCredits)} exceed ceiling ${round(constraints.maxNormalizedCredits)}`,
      );
    }

    const profileCostFactor = profileFactor(this.#config.routing.profile);
    // Value-of-time is intentionally convex: ordinary work should not pay a
    // premium for a small latency gain, while an explicit urgent/deadline
    // signal can rationally dominate cost. Because it operates on predicted
    // duration rather than a fixed Fast bonus, empirical calibration can prove
    // that a nominally premium tier is slower and reverse the decision.
    const latencyUrgency = (0.5 + 59.5 * features.latencySensitivity ** 3) *
      speedBenefitFactor(this.#config.routing.profile);
    const qualityShortfall = Math.max(0, qualityThreshold - verifiedReliability);
    const normalizedCostUnit = predictedNormalizedCredits /
      Math.max(1, this.#config.routing.prediction.fallbackCreditsPerCostWeight);
    const normalizedLatencyUnit = predictedDurationMs /
      Math.max(1, this.#config.routing.prediction.baselineDurationMs);
    const objective =
      this.#config.routing.weights.cost * (normalizedCostUnit + proofCostWeight * 0.35) * profileCostFactor +
      this.#config.routing.weights.latency * normalizedLatencyUnit * latencyUrgency +
      this.#config.routing.weights.quota * quotaPenalty +
      this.#config.routing.weights.failure * qualityShortfall * impactMultiplier(features) * 40 +
      this.#config.routing.weights.failure * badEscapeEstimate * impactMultiplier(features) * 0.75 +
      this.#config.routing.weights.uncertainty * uncertainty * 5 +
      this.#config.routing.weights.switching * switchPenalty;

    return {
      modelId: model.id,
      modelFamily: family,
      effort,
      serviceTier: serviceTierForSpeed(speedId),
      speedId,
      speedName: speedDisplayName(model, speedId),
      speedCostMultiplier: speedProfile.costMultiplier,
      speedLatencyMultiplier: speedProfile.latencyMultiplier,
      topology,
      proofTier,
      proofCostWeight,
      detectionEstimate,
      predictedDurationMs,
      predictedP90DurationMs,
      predictedNormalizedCredits,
      calibrationSamples: calibration?.sampleCount ?? 0,
      capabilityScore,
      costWeight,
      latencyWeight,
      successEstimate,
      uncertainty,
      badEscapeEstimate,
      quotaPenalty,
      switchPenalty,
      objective,
      admissible: rejectionReasons.length === 0,
      rejectionReasons,
    };
  }
}

/**
 * Route previews and the meta-controller may inspect the least-bad candidate
 * when every candidate is rejected. Execution paths must call this guard so a
 * diagnostic fallback can never become an unattended Codex policy.
 */
export function requireAdmissibleRoute(decision: RouteDecision): RouteDecision {
  if (decision.selected.admissible) return decision;
  const reasons = decision.selected.rejectionReasons.length === 0
    ? "no admissible candidate"
    : decision.selected.rejectionReasons.join("; ");
  throw new Error(
    `Counterlane Auto found no admissible execution route; selected diagnostic candidate ` +
    `${decision.selected.modelFamily}/${decision.selected.effort}/${decision.selected.speedId}/` +
    `${decision.selected.proofTier} was rejected: ${reasons}.`,
  );
}

export function estimateRouteCostWeight(
  config: CounterlaneConfig,
  family: ModelFamily,
  effort: string,
  speedCostMultiplier = 1,
): number {
  return config.routing.costModel.familyWeights[family] * (EFFORT_COST[effort] ?? 1) * speedCostMultiplier;
}

export function estimateRouteLatencyWeight(
  family: ModelFamily,
  effort: string,
  speedLatencyMultiplier = 1,
): number {
  return FAMILY_LATENCY[family] * (EFFORT_LATENCY[effort] ?? 1) * speedLatencyMultiplier;
}

function familyTaskFit(family: ModelFamily, features: TaskFeatures): number {
  switch (family) {
    case "luna":
      return (
        features.mechanicalness * 0.11 +
        features.verifiability * 0.06 -
        features.ambiguity * 0.14 -
        features.depth * 0.1 -
        features.risk * 0.12 -
        features.breadth * 0.05
      );
    case "terra":
      return features.mechanicalness * 0.03 + features.verifiability * 0.03 - features.risk * 0.025 - features.novelty * 0.03;
    case "sol":
      return features.ambiguity * 0.035 + features.depth * 0.04 + features.risk * 0.035 + features.novelty * 0.025;
    case "unknown":
      return -features.risk * 0.06;
  }
}

function compareExecutableCandidates(
  left: RouteCandidate,
  right: RouteCandidate,
  constraints: RouteConstraints,
): number {
  if (constraints.latencyPriority === "urgent") {
    return left.objective - right.objective ||
      left.predictedNormalizedCredits - right.predictedNormalizedCredits ||
      right.successEstimate - left.successEstimate ||
      left.badEscapeEstimate - right.badEscapeEstimate;
  }
  return left.predictedNormalizedCredits - right.predictedNormalizedCredits ||
    right.successEstimate - left.successEstimate ||
    left.badEscapeEstimate - right.badEscapeEstimate ||
    left.predictedDurationMs - right.predictedDurationMs ||
    left.objective - right.objective;
}

function compareDiagnosticCandidates(left: RouteCandidate, right: RouteCandidate): number {
  return left.badEscapeEstimate - right.badEscapeEstimate ||
    right.successEstimate - left.successEstimate ||
    left.predictedNormalizedCredits - right.predictedNormalizedCredits ||
    left.objective - right.objective;
}

function requiredQuality(
  features: TaskFeatures,
  thresholds: CounterlaneConfig["routing"]["minimumQuality"],
): number {
  return requiredRiskThreshold(features, thresholds);
}

function requiredCompletion(
  features: TaskFeatures,
  thresholds: CounterlaneConfig["routing"]["minimumCompletion"],
): number {
  return requiredRiskThreshold(features, thresholds);
}

function requiredRiskThreshold(
  features: TaskFeatures,
  thresholds: { normal: number; elevated: number; critical: number },
): number {
  if (isCritical(features)) {
    return thresholds.critical;
  }
  if (features.risk >= 0.4 || features.depth >= 0.72 || features.ambiguity >= 0.72) {
    return thresholds.elevated;
  }
  return thresholds.normal;
}

function requiredProofTier(features: TaskFeatures, config: CounterlaneConfig): ProofTier {
  if (isCritical(features)) return config.verification.routing.minimumTierByRisk.critical;
  if (features.risk >= 0.4 || features.destructivePotential >= 0.4 || features.depth >= 0.72) {
    return config.verification.routing.minimumTierByRisk.elevated;
  }
  return config.verification.routing.minimumTierByRisk.normal;
}

function isCritical(features: TaskFeatures): boolean {
  return features.risk >= 0.72 || features.destructivePotential >= 0.72;
}

function uncertaintyMultiplier(features: TaskFeatures): number {
  return 0.25 + features.risk * 0.25 + features.destructivePotential * 0.25;
}

function impactMultiplier(features: TaskFeatures): number {
  return 1 + features.risk * 3 + features.destructivePotential * 3;
}

function profileFactor(profile: RoutingProfile): number {
  switch (profile) {
    case "economy":
      return 1.35;
    case "balanced":
      return 1;
    case "quality":
      return 0.58;
  }
}

function speedBenefitFactor(profile: RoutingProfile): number {
  switch (profile) {
    case "economy":
      return 0.72;
    case "balanced":
      return 1;
    case "quality":
      return 1.18;
  }
}

function buildRationale(
  selected: RouteCandidate,
  features: TaskFeatures,
  quota: QuotaState,
  profile: RoutingProfile,
  constraints: RouteConstraints,
  completionThreshold: number,
): string[] {
  const rationale = [
    `profile=${profile}`,
    `task=${features.taskKind}`,
    `selected=${selected.modelFamily}/${selected.effort}/${selected.speedId}/${selected.proofTier}`,
    `estimated_completion=${round(selected.successEstimate)}`,
    `required_completion=${round(completionThreshold)}`,
    `estimated_detection=${round(selected.detectionEstimate)}`,
    `estimated_bad_escape=${round(selected.badEscapeEstimate)}`,
    `predicted_p90_ms=${Math.round(selected.predictedP90DurationMs)}`,
    `predicted_credits=${round(selected.predictedNormalizedCredits)}`,
  ];
  if (Object.keys(constraints).length > 0) {
    rationale.push(`constraints=${formatConstraints(constraints)}`);
  }
  if (selected.calibrationSamples > 0) {
    rationale.push(`empirical calibration used ${selected.calibrationSamples} matching route observations`);
  } else {
    rationale.push("completion estimate is a heuristic prior with no matching calibration samples");
  }
  if (features.verifiability >= 0.6) {
    rationale.push("verification evidence reduced the probability of an incorrect artifact escaping detection");
  }
  if (features.risk >= 0.5) {
    rationale.push("risk raised both the capability floor and proof burden");
  }
  if (quota.pressure >= 0.6) {
    rationale.push("quota pressure penalized expensive routes and premium speed");
  }
  if (selected.speedId !== "standard") {
    rationale.push(
      `${selected.speedName} was selected independently of capability because latency value outweighed its ${round(selected.speedCostMultiplier)}x estimated cost`,
    );
  } else if (features.latencySensitivity >= 0.7) {
    rationale.push("standard speed remained optimal because premium speed was unavailable, quota-gated, or not cost-effective");
  }
  if (selected.topology === "ultra") {
    rationale.push("Ultra cleared breadth, separability, quota, and strong-proof gates");
  } else if (features.parallelizability >= 0.7) {
    rationale.push("parallelism signals were present, but single-agent verified-completion economics were better or Ultra was gated");
  }
  return rationale;
}

function normalizeRouteConstraints(value?: RouteConstraints): RouteConstraints {
  if (value === undefined) return {};
  const constraints: RouteConstraints = {};
  if (value.modelId !== undefined) {
    if (typeof value.modelId !== "string" || value.modelId.trim().length === 0) {
      throw new Error("Route constraint modelId must be a non-empty string.");
    }
    constraints.modelId = value.modelId.trim();
  }
  if (value.modelFamily !== undefined) {
    if (!["luna", "terra", "sol", "unknown"].includes(value.modelFamily)) {
      throw new Error("Route constraint modelFamily is unsupported.");
    }
    constraints.modelFamily = value.modelFamily;
  }
  if (value.effort !== undefined) {
    if (typeof value.effort !== "string" || value.effort.trim().length === 0) {
      throw new Error("Route constraint effort must be a non-empty string or auto.");
    }
    if (value.effort !== "auto") constraints.effort = value.effort.trim();
  }
  if (value.speedId !== undefined) {
    if (typeof value.speedId !== "string" || value.speedId.trim().length === 0) {
      throw new Error("Route constraint speedId must be a non-empty string or auto.");
    }
    if (value.speedId !== "auto") constraints.speedId = value.speedId.trim();
  }
  if (value.speedMode !== undefined) {
    if (value.speedMode !== "off" && value.speedMode !== "auto" && value.speedMode !== "fast") {
      throw new Error("Route constraint speedMode must be off, auto, or fast.");
    }
    if (constraints.speedId !== undefined) {
      throw new Error("Route constraints cannot combine raw speedId with product speedMode.");
    }
    constraints.speedMode = value.speedMode;
  }
  if (value.executionContext !== undefined) {
    if (value.executionContext !== "foreground" && value.executionContext !== "background") {
      throw new Error("Route constraint executionContext must be foreground or background.");
    }
    constraints.executionContext = value.executionContext;
  }
  if (value.topology !== undefined) {
    if (value.topology !== "single" && value.topology !== "ultra") {
      throw new Error("Route constraint topology must be single or ultra.");
    }
    constraints.topology = value.topology;
  }
  if (value.latencyPriority !== undefined) {
    if (!["economy", "balanced", "urgent"].includes(value.latencyPriority)) {
      throw new Error("Route constraint latencyPriority must be economy, balanced, or urgent.");
    }
    constraints.latencyPriority = value.latencyPriority;
  }
  if (value.proofTier !== undefined) {
    if (!["basic", "standard", "strong", "adversarial"].includes(value.proofTier)) {
      throw new Error("Route constraint proofTier is unsupported.");
    }
    constraints.proofTier = value.proofTier;
  }
  if (value.deadlineMs !== undefined) {
    if (!Number.isSafeInteger(value.deadlineMs) || value.deadlineMs <= 0 || value.deadlineMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`Route constraint deadlineMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}.`);
    }
    constraints.deadlineMs = value.deadlineMs;
  }
  if (value.maxNormalizedCredits !== undefined) {
    if (!Number.isFinite(value.maxNormalizedCredits) || value.maxNormalizedCredits <= 0) {
      throw new Error("Route constraint maxNormalizedCredits must be a positive finite number.");
    }
    constraints.maxNormalizedCredits = value.maxNormalizedCredits;
  }
  return constraints;
}

function applyLatencyPriority(features: TaskFeatures, constraints: RouteConstraints): TaskFeatures {
  let latencySensitivity = features.latencySensitivity;
  const evidence = [...features.evidence];
  if (constraints.latencyPriority !== undefined) {
    latencySensitivity = { economy: 0.12, balanced: 0.55, urgent: 1 }[constraints.latencyPriority];
    evidence.push(`latency priority explicitly set to ${constraints.latencyPriority}`);
  }
  if (constraints.deadlineMs !== undefined) {
    const baseline = 90_000;
    const deadlinePressure = clamp(baseline / constraints.deadlineMs);
    latencySensitivity = Math.max(latencySensitivity, deadlinePressure);
    evidence.push(`hard deadline set to ${Math.round(constraints.deadlineMs)} ms`);
  }
  return { ...features, latencySensitivity, evidence };
}

function hasHardConstraints(constraints: RouteConstraints): boolean {
  return constraints.modelId !== undefined || constraints.modelFamily !== undefined || constraints.effort !== undefined ||
    constraints.speedId !== undefined || constraints.speedMode !== undefined || constraints.topology !== undefined || constraints.proofTier !== undefined ||
    constraints.deadlineMs !== undefined || constraints.maxNormalizedCredits !== undefined;
}

function hasStructuredLatencyDemand(constraints: RouteConstraints): boolean {
  return constraints.latencyPriority === "urgent" || constraints.deadlineMs !== undefined;
}

function formatConstraints(constraints: RouteConstraints): string {
  const entries = Object.entries(constraints).map(([key, value]) => `${key}=${String(value)}`);
  return entries.length === 0 ? "none" : entries.join(",");
}

function matchesModel(haystack: string, matcher: string): boolean {
  if (matcher.startsWith("re:")) {
    try {
      return new RegExp(matcher.slice(3), "iu").test(haystack);
    } catch {
      return false;
    }
  }
  return haystack.includes(matcher.toLowerCase());
}

function deduplicateCandidates(candidates: RouteCandidate[]): RouteCandidate[] {
  const byKey = new Map<string, RouteCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.modelId}:${candidate.effort}:${candidate.speedId}:${candidate.topology}:${candidate.proofTier}`;
    const existing = byKey.get(key);
    if (existing === undefined || candidate.objective < existing.objective) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function empiricalWeight(sampleCount: number, minimumSamples: number, shrinkageSamples: number): number {
  if (sampleCount <= 0) return 0;
  const base = sampleCount / Math.max(1, sampleCount + shrinkageSamples);
  return sampleCount < minimumSamples ? base * (sampleCount / Math.max(1, minimumSamples)) : base;
}

function blend(prior: number, empirical: number, weight: number): number {
  return prior * (1 - weight) + empirical * weight;
}

function assumedVerificationCapabilities(config: CounterlaneConfig): VerificationCapabilitySummary {
  const configuredTiers = config.verification.routing.enabled
    ? [...config.verification.routing.candidateTiers]
    : [config.verification.routing.defaultTier];
  const taskSpecificCommandCountByTier = {
    basic: configuredTaskSpecificCommands(config, "basic").length,
    standard: configuredTaskSpecificCommands(config, "standard").length,
    strong: configuredTaskSpecificCommands(config, "strong").length,
    adversarial: configuredTaskSpecificCommands(config, "adversarial").length,
  };
  const availableTiers = config.verification.requireTaskSpecificCheck
    ? configuredTiers.filter((tier) => hasConfiguredTaskSpecificCoverage(config, tier))
    : configuredTiers;
  return {
    availableTiers,
    commandCountByTier: {
      basic: 1,
      standard: 1,
      strong: 2,
      adversarial: 2,
    },
    taskSpecificCommandCountByTier,
    taskSpecificRequired: config.verification.requireTaskSpecificCheck,
    requiredCountByTier: { ...config.verification.routing.minimumIndependentChecks },
    estimatedCostWeightByTier: { ...config.verification.routing.costWeights },
    fingerprint: "assumed",
  };
}

function configuredTaskSpecificCommands(config: CounterlaneConfig, tier: ProofTier) {
  return config.verification.commands.filter((command) =>
    command.taskSpecific === true && proofTierRank(commandMinimumTier(command)) <= proofTierRank(tier)
  );
}

function hasConfiguredTaskSpecificCoverage(config: CounterlaneConfig, tier: ProofTier): boolean {
  const commands = configuredTaskSpecificCommands(config, tier);
  if (tier === "adversarial") {
    return commands.some((command) => commandMinimumTier(command) === "adversarial");
  }
  if (tier === "standard" || tier === "strong") {
    return commands.some((command) => proofTierRank(commandMinimumTier(command)) >= proofTierRank("standard"));
  }
  return commands.length > 0;
}
