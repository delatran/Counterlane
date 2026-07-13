import type { CounterlaneConfig } from "../config/types.js";
import type {
  MetaContext,
  MetaDecision,
  PairedUpliftObservation,
  QuotaState,
  RouteDecision,
  UpliftPosterior,
} from "../core/types.js";
import { round } from "../core/utils.js";
import { estimateUpliftPosterior } from "./evidence.js";

export class MetaController {
  readonly #config: CounterlaneConfig;

  public constructor(config: CounterlaneConfig) {
    this.#config = config;
  }

  public decide(options: {
    context: MetaContext;
    route: RouteDecision;
    staticModelId: string;
    staticEffort: string;
    staticSpeedId: string;
    staticTopology: "single" | "ultra";
    staticProofTier?: string;
    staticCostWeight: number;
    staticAdmissible: boolean;
    observations: readonly PairedUpliftObservation[];
    quota: QuotaState;
  }): MetaDecision {
    const posterior = estimateUpliftPosterior({
      observations: options.observations,
      context: options.context,
      config: this.#config,
    });
    const selected = options.route.selected;
    const routeEquivalentToStatic =
      selected.modelId === options.staticModelId &&
      selected.effort === options.staticEffort &&
      selected.speedId === options.staticSpeedId &&
      selected.topology === options.staticTopology &&
      selected.proofTier === (options.staticProofTier ?? "standard");
    const estimatedTwinCost = (
      options.staticCostWeight + selected.costWeight
    ) * this.#config.meta.twinCostMultiplier * (1 + options.quota.pressure);
    const expectedInformationValue = informationValue(
      posterior,
      this.#config.meta.expectedFutureSimilarTasks,
      this.#config.meta.maximumTwinSamplesPerContext,
      this.#config.meta.informationValueScale,
      this.#config.meta.confidenceZ,
    );
    const reasons: string[] = [
      `context=${options.context.key}`,
      `evidence_key=${posterior.evidenceKey}`,
      `paired_samples=${posterior.sampleCount}`,
      `uplift_mean=${round(posterior.mean)}`,
      `uplift_interval=[${round(posterior.lowerBound)}, ${round(posterior.upperBound)}]`,
      `evsi=${round(expectedInformationValue)}`,
      `estimated_twin_cost=${round(estimatedTwinCost)}`,
    ];

    if (!selected.admissible) {
      reasons.push(
        "the inner Auto router found no admissible execution route",
        ...selected.rejectionReasons.map((reason) => `route_rejection=${reason}`),
      );
      return decision("abstain", options.context, posterior, expectedInformationValue, estimatedTwinCost, routeEquivalentToStatic, reasons);
    }

    if (!this.#config.meta.enabled) {
      reasons.push("meta-controller is disabled; executing the inner Auto policy");
      return decision("auto", options.context, posterior, expectedInformationValue, estimatedTwinCost, routeEquivalentToStatic, reasons);
    }

    if (
      options.context.riskTier === "critical" &&
      options.context.verifierStrength < this.#config.meta.minimumCriticalVerifierStrength
    ) {
      reasons.push("critical-risk task lacks a sufficiently strong verifier for unattended experimentation");
      return decision("abstain", options.context, posterior, expectedInformationValue, estimatedTwinCost, routeEquivalentToStatic, reasons);
    }

    if (!options.staticAdmissible) {
      reasons.push("the incumbent static route fails current safety, proof, or quota gates; using the admissible single Auto route");
      return decision("auto", options.context, posterior, expectedInformationValue, estimatedTwinCost, false, reasons);
    }

    if (routeEquivalentToStatic) {
      reasons.push("Auto and static selected the same model, effort, speed, topology, and proof tier; duplicate execution has no routing value");
      return decision("static", options.context, posterior, expectedInformationValue, estimatedTwinCost, true, reasons);
    }

    const enoughEvidence = posterior.evidenceKey === options.context.key
      ? posterior.sampleCount >= this.#config.meta.minimumExactSamples
      : posterior.sampleCount >= this.#config.meta.minimumFallbackSamples;
    if (enoughEvidence && posterior.lowerBound > this.#config.meta.upliftMargin) {
      reasons.push("the lower confidence bound clears the configured Auto uplift margin");
      return decision("auto", options.context, posterior, expectedInformationValue, estimatedTwinCost, false, reasons);
    }
    if (enoughEvidence && posterior.upperBound < -this.#config.meta.upliftMargin) {
      reasons.push("the upper confidence bound shows the incumbent static policy is superior");
      return decision("static", options.context, posterior, expectedInformationValue, estimatedTwinCost, false, reasons);
    }

    const quotaAllowsTwin =
      options.quota.known &&
      !options.quota.exhausted &&
      options.quota.pressure <= this.#config.meta.maximumQuotaPressureForTwin &&
      options.quota.usedPercent !== null &&
      options.quota.usedPercent <= this.#config.meta.maximumUsedPercentForTwin;
    const sampleCapReached = posterior.sampleCount >= this.#config.meta.maximumTwinSamplesPerContext;
    if (!quotaAllowsTwin) {
      reasons.push(options.quota.known
        ? "live quota pressure blocks counterfactual exploration"
        : "live quota is unavailable; counterfactual exploration fails closed");
      return decision("static", options.context, posterior, expectedInformationValue, estimatedTwinCost, false, reasons);
    }
    if (sampleCapReached) {
      reasons.push("the per-context twin sample cap has been reached without decisive uplift evidence");
      return decision("static", options.context, posterior, expectedInformationValue, estimatedTwinCost, false, reasons);
    }
    if (expectedInformationValue > estimatedTwinCost) {
      reasons.push("the estimated future value of resolving route uncertainty exceeds the paired-run cost");
      return decision("twin", options.context, posterior, expectedInformationValue, estimatedTwinCost, false, reasons);
    }

    reasons.push("uplift remains uncertain, but another paired run is not economical; retaining the incumbent policy");
    return decision("static", options.context, posterior, expectedInformationValue, estimatedTwinCost, false, reasons);
  }
}

function informationValue(
  posterior: UpliftPosterior,
  expectedFutureSimilarTasks: number,
  maximumTwinSamples: number,
  scale: number,
  confidenceZ: number,
): number {
  const unresolvedRegret = Math.max(0, confidenceZ * posterior.standardError - Math.abs(posterior.mean));
  const remainingSamples = Math.max(0, maximumTwinSamples - posterior.sampleCount);
  const reuseHorizon = Math.min(expectedFutureSimilarTasks, remainingSamples);
  return unresolvedRegret * Math.sqrt(reuseHorizon) * scale;
}

function decision(
  action: MetaDecision["action"],
  context: MetaContext,
  posterior: UpliftPosterior,
  expectedInformationValue: number,
  estimatedTwinCost: number,
  routeEquivalentToStatic: boolean,
  reasons: string[],
): MetaDecision {
  return {
    action,
    context,
    posterior,
    expectedInformationValue,
    estimatedTwinCost,
    routeEquivalentToStatic,
    reasons,
    decidedAt: new Date().toISOString(),
  };
}
