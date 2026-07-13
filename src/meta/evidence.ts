import type {
  MetaContext,
  PairedUpliftObservation,
  RouteCalibrationIndex,
  TelemetryEvent,
  UpliftPosterior,
} from "../core/types.js";
import type { CounterlaneConfig } from "../config/types.js";
import { clamp, sha256, stableStringify } from "../core/utils.js";

export function parsePairedObservations(events: readonly TelemetryEvent[]): PairedUpliftObservation[] {
  const observations: PairedUpliftObservation[] = [];
  for (const event of uniqueExperimentEvents(events)) {
    if (event.type !== "experiment.completed") {
      continue;
    }
    const payload = event.payload;
    const contextKeys = boundedContextKeys(payload["contextKeys"]);
    const utilityDelta = numberField(payload, "utilityDelta", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const verifiedSuccessDelta = numberField(payload, "verifiedSuccessDelta", -1, 1);
    const controlSuccessful = payload["controlSuccessful"];
    const treatmentSuccessful = payload["treatmentSuccessful"];
    const controlOutcome = payload["controlOutcome"];
    const treatmentOutcome = payload["treatmentOutcome"];
    // User cancellations are selection/exposure events, not evidence that one
    // route is better. Keep them in telemetry for auditability but exclude the
    // pair from causal uplift learning. Timeouts remain valid route evidence.
    if (controlOutcome === "cancelled" || treatmentOutcome === "cancelled") continue;
    // Backend reroutes change the treatment actually received while only the
    // requested route is priced. Retain these pairs for audit, never learning.
    if (payload["controlRouteCompliant"] !== true || payload["treatmentRouteCompliant"] !== true) continue;
    if (
      event.experimentId === undefined ||
      contextKeys.length === 0 ||
      utilityDelta === undefined ||
      verifiedSuccessDelta === undefined ||
      typeof controlSuccessful !== "boolean" ||
      typeof treatmentSuccessful !== "boolean"
    ) {
      continue;
    }
    observations.push({
      experimentId: event.experimentId,
      timestamp: event.timestamp,
      contextKeys,
      utilityDelta,
      verifiedSuccessDelta,
      controlSuccessful,
      treatmentSuccessful,
    });
  }
  return observations;
}

export function pairedEvidenceHash(observations: readonly PairedUpliftObservation[]): string {
  return sha256(stableStringify([...observations].sort((left, right) =>
    left.experimentId.localeCompare(right.experimentId) || left.timestamp.localeCompare(right.timestamp)
  )));
}

export function metaEvidenceHash(
  observations: readonly PairedUpliftObservation[],
  calibration: RouteCalibrationIndex,
): string {
  return sha256(stableStringify({
    paired: [...observations].sort((left, right) =>
      left.experimentId.localeCompare(right.experimentId) || left.timestamp.localeCompare(right.timestamp)
    ),
    calibration: {
      byRouteKey: calibration.byRouteKey,
      sampleCount: calibration.sampleCount,
      ignoredObservationCount: calibration.ignoredObservationCount,
    },
  }));
}

function uniqueExperimentEvents(events: readonly TelemetryEvent[]): TelemetryEvent[] {
  const byExperiment = new Map<string, { event: TelemetryEvent; signature: string }>();
  const conflicted = new Set<string>();
  for (const event of events) {
    if (event.type !== "experiment.completed" || event.experimentId === undefined) continue;
    let signature: string;
    try {
      signature = stableStringify(event.payload);
    } catch {
      continue;
    }
    const current = byExperiment.get(event.experimentId);
    if (current === undefined) {
      byExperiment.set(event.experimentId, { event, signature });
    } else if (current.signature !== signature) {
      conflicted.add(event.experimentId);
    }
  }
  return [...byExperiment.entries()]
    .filter(([experimentId]) => !conflicted.has(experimentId))
    .map(([, value]) => value.event);
}

export function estimateUpliftPosterior(options: {
  observations: readonly PairedUpliftObservation[];
  context: MetaContext;
  config: CounterlaneConfig;
}): UpliftPosterior {
  const exact = matching(options.observations, options.context.key);
  let evidenceKey = options.context.key;
  let selected = exact;

  if (exact.length < options.config.meta.minimumExactSamples) {
    for (const fallbackKey of options.context.fallbackKeys.slice(1)) {
      const candidate = matching(options.observations, fallbackKey);
      if (candidate.length >= options.config.meta.minimumFallbackSamples) {
        evidenceKey = fallbackKey;
        selected = candidate;
        break;
      }
    }
  }

  const selectedIds = new Set(selected.map((observation) => observation.experimentId));
  const priorPool = options.observations.filter((observation) => !selectedIds.has(observation.experimentId));
  const priorValues = priorPool.map((observation) => observation.utilityDelta);
  const priorMean = priorValues.length > 0 ? mean(priorValues) : 0;
  const empiricalPriorVariance = priorValues.length >= 2 ? sampleVariance(priorValues) : 0;
  const configuredPriorVariance = options.config.meta.priorStandardDeviation ** 2;
  const priorVariance = Math.max(empiricalPriorVariance, configuredPriorVariance);
  const values = selected.map((observation) => observation.utilityDelta);
  const sampleMean = values.length > 0 ? mean(values) : 0;
  const sampleVar = values.length >= 2 ? sampleVariance(values) : priorVariance;
  const priorStrength = options.config.meta.priorStrength;
  const effectiveN = values.length + priorStrength;
  const posteriorMean = (sampleMean * values.length + priorMean * priorStrength) / effectiveN;
  const pooledVariance = (
    sampleVar * Math.max(1, values.length) +
    priorVariance * priorStrength
  ) / (Math.max(1, values.length) + priorStrength);
  const standardDeviation = Math.sqrt(Math.max(0, pooledVariance));
  const standardError = standardDeviation / Math.sqrt(effectiveN);
  const interval = options.config.meta.confidenceZ * standardError;

  let treatmentWins = 0;
  let controlWins = 0;
  let ties = 0;
  for (const observation of selected) {
    if (observation.utilityDelta > options.config.utility.practicalEquivalenceMargin) {
      treatmentWins += 1;
    } else if (observation.utilityDelta < -options.config.utility.practicalEquivalenceMargin) {
      controlWins += 1;
    } else {
      ties += 1;
    }
  }
  const denominator = Math.max(1, selected.length);

  return {
    evidenceKey,
    sampleCount: selected.length,
    priorSampleCount: priorPool.length,
    mean: posteriorMean,
    standardDeviation,
    standardError,
    lowerBound: posteriorMean - interval,
    upperBound: posteriorMean + interval,
    treatmentWinRate: clamp(treatmentWins / denominator),
    controlWinRate: clamp(controlWins / denominator),
    tieRate: clamp(ties / denominator),
  };
}

function matching(observations: readonly PairedUpliftObservation[], key: string): PairedUpliftObservation[] {
  return observations.filter((observation) => observation.contextKeys.includes(key));
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

function numberField(
  object: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function boundedContextKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return [];
  if (value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 512)) return [];
  return value as string[];
}
