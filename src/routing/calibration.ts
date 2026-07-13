import type { JsonObject } from "../core/json.js";
import type {
  ArmOutcome,
  ProofTier,
  RepoProfile,
  RiskTier,
  RouteCalibration,
  RouteCalibrationIndex,
  ScopeTier,
  TaskFeatures,
  TelemetryEvent,
  Topology,
} from "../core/types.js";
import { stableStringify } from "../core/utils.js";
import { classifyRisk, classifyScope } from "../meta/context.js";

export interface RouteCalibrationContext {
  taskKind: TaskFeatures["taskKind"];
  riskTier: RiskTier;
  scopeTier: ScopeTier;
}

interface RouteIdentity extends RouteCalibrationContext {
  modelId: string;
  effort: string;
  speedId: string;
  topology: Topology;
  proofTier: ProofTier;
}

interface RouteObservation extends RouteIdentity {
  outcome: ArmOutcome;
  durationMs: number;
  normalizedCredits: number;
  timestamp: string;
}

export function routeCalibrationKey(identity: RouteIdentity): string {
  return [
    identity.modelId,
    identity.effort,
    identity.speedId,
    identity.topology,
    identity.proofTier,
    identity.taskKind,
    identity.riskTier,
    identity.scopeTier,
  ].map(encodeURIComponent).join("|");
}

export function buildCalibrationIndex(events: readonly TelemetryEvent[]): RouteCalibrationIndex {
  const groups = new Map<string, RouteObservation[]>();
  let ignoredObservationCount = 0;
  const uniqueEvents = new Map<string, { event: TelemetryEvent; signature: string }>();
  const conflictedIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "route.observed") continue;
    const signature = safeStableStringify(event);
    if (signature === null) {
      ignoredObservationCount += 1;
      continue;
    }
    const current = uniqueEvents.get(event.id);
    if (current === undefined) uniqueEvents.set(event.id, { event, signature });
    else if (current.signature !== signature) conflictedIds.add(event.id);
    else ignoredObservationCount += 1;
  }
  ignoredObservationCount += conflictedIds.size;
  for (const { event } of uniqueEvents.values()) {
    if (conflictedIds.has(event.id)) continue;
    if (event.type !== "route.observed") continue;
    const observation = parseObservation(event.payload, event.timestamp);
    if (observation === null) continue;
    // A user cancellation is not evidence that the route lacked capability or
    // would have missed its latency target. Keep the raw event for audit, but
    // exclude it from learned quality, cost, and latency priors.
    if (observation.outcome === "cancelled") {
      ignoredObservationCount += 1;
      continue;
    }
    const key = routeCalibrationKey(observation);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  const byRouteKey: Record<string, RouteCalibration> = {};
  let sampleCount = 0;
  for (const [routeKey, observations] of groups) {
    const durations = observations.map((value) => value.durationMs).sort((left, right) => left - right);
    const credits = observations.map((value) => value.normalizedCredits);
    const meanDurationMs = mean(durations);
    const successCount = observations.filter((value) => value.outcome === "success").length;
    const timeoutCount = observations.filter((value) => value.outcome === "timeout").length;
    const failureCount = observations.length - successCount - timeoutCount;
    const calibration: RouteCalibration = {
      routeKey,
      sampleCount: observations.length,
      successCount,
      failureCount,
      timeoutCount,
      successRate: successCount / observations.length,
      meanDurationMs,
      standardDeviationDurationMs: sampleStandardDeviation(durations, meanDurationMs),
      p90DurationMs: percentile(durations, 0.9),
      meanNormalizedCredits: mean(credits),
      updatedAt: observations
        .map((value) => value.timestamp)
        .sort((left, right) => left.localeCompare(right))
        .at(-1) ?? new Date(0).toISOString(),
    };
    byRouteKey[routeKey] = calibration;
    sampleCount += observations.length;
  }

  return {
    byRouteKey,
    sampleCount,
    ignoredObservationCount,
    builtAt: new Date().toISOString(),
  };
}

export function calibrationFor(
  index: RouteCalibrationIndex | undefined,
  identity: RouteIdentity,
): RouteCalibration | undefined {
  return index?.byRouteKey[routeCalibrationKey(identity)];
}

function safeStableStringify(value: unknown): string | null {
  try {
    return stableStringify(value);
  } catch {
    return null;
  }
}

export function routeObservationPayload(options: Omit<RouteIdentity, keyof RouteCalibrationContext> & {
  context?: RouteCalibrationContext;
  outcome: ArmOutcome;
  successful: boolean;
  durationMs: number;
  normalizedCredits: number;
  turnDurationMs: number;
  verificationDurationMs: number;
}): JsonObject {
  return {
    modelId: options.modelId,
    effort: options.effort,
    speedId: options.speedId,
    topology: options.topology,
    proofTier: options.proofTier,
    ...(options.context ?? {}),
    outcome: options.outcome,
    // Retain this derived field for backward-compatible analysis queries.
    successful: options.successful,
    durationMs: options.durationMs,
    turnDurationMs: options.turnDurationMs,
    verificationDurationMs: options.verificationDurationMs,
    normalizedCredits: options.normalizedCredits,
  };
}

export function routeCalibrationContext(features: TaskFeatures, repo: RepoProfile): RouteCalibrationContext {
  return {
    taskKind: features.taskKind,
    riskTier: classifyRisk(features),
    scopeTier: classifyScope(features, repo),
  };
}

function parseObservation(payload: JsonObject, timestamp: string): RouteObservation | null {
  const modelId = stringValue(payload["modelId"]);
  const effort = stringValue(payload["effort"]);
  const speedId = stringValue(payload["speedId"]);
  const topology = topologyValue(payload["topology"]);
  const proofTier = proofTierValue(payload["proofTier"]);
  const taskKind = taskKindValue(payload["taskKind"]);
  const riskTier = riskTierValue(payload["riskTier"]);
  const scopeTier = scopeTierValue(payload["scopeTier"]);
  const successful = payload["successful"];
  const outcome = armOutcomeValue(payload["outcome"])
    ?? (typeof successful === "boolean" ? (successful ? "success" : "failure") : null);
  const durationMs = finiteNonNegative(payload["durationMs"]);
  const normalizedCredits = finiteNonNegative(payload["normalizedCredits"]);
  if (
    modelId === null ||
    effort === null ||
    speedId === null ||
    topology === null ||
    proofTier === null ||
    taskKind === null ||
    riskTier === null ||
    scopeTier === null ||
    outcome === null ||
    durationMs === null ||
    normalizedCredits === null
  ) {
    return null;
  }
  return {
    modelId,
    effort,
    speedId,
    topology,
    proofTier,
    taskKind,
    riskTier,
    scopeTier,
    outcome,
    durationMs,
    normalizedCredits,
    timestamp,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function topologyValue(value: unknown): Topology | null {
  return value === "single" || value === "ultra" ? value : null;
}

function proofTierValue(value: unknown): ProofTier | null {
  return value === "basic" || value === "standard" || value === "strong" || value === "adversarial"
    ? value
    : null;
}

function taskKindValue(value: unknown): TaskFeatures["taskKind"] | null {
  return value === "mechanical_edit" || value === "bugfix" || value === "feature" || value === "refactor" ||
    value === "review" || value === "research" || value === "security" || value === "migration" || value === "unknown"
    ? value
    : null;
}

function riskTierValue(value: unknown): RiskTier | null {
  return value === "normal" || value === "elevated" || value === "critical" ? value : null;
}

function scopeTierValue(value: unknown): ScopeTier | null {
  return value === "narrow" || value === "medium" || value === "broad" ? value : null;
}

function armOutcomeValue(value: unknown): ArmOutcome | null {
  return value === "success" || value === "failure" || value === "timeout" || value === "cancelled"
    ? value
    : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values: readonly number[], average: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(quantile * sortedValues.length) - 1));
  return sortedValues[index] ?? 0;
}
