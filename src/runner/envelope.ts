import type {
  ExecutionEnvelope,
  ModelCatalog,
  QuotaState,
  RepoProfile,
  RouteCandidate,
  RouteDecision,
  VerificationPlan,
} from "../core/types.js";
import { MetaPlanInvalidatedError } from "../core/errors.js";
import { sha256, stableStringify } from "../core/utils.js";

/** Build a stable preflight envelope without raw prompts, timestamps, or account payloads. */
export function createExecutionEnvelope(options: {
  repo: RepoProfile;
  catalog: ModelCatalog;
  quota: QuotaState;
  decision: RouteDecision;
  verificationPlan: VerificationPlan;
}): ExecutionEnvelope {
  const catalogFingerprint = fingerprintCatalog(options.catalog);
  const quotaFingerprint = fingerprintQuota(options.quota);
  const routeGraphFingerprint = sha256(stableStringify({
    capabilityGraph: options.decision.capabilityGraph,
    candidateAdmissibility: options.decision.candidates
      .map(routeGraphEntry)
      .sort((left, right) => compareStable(left.key, right.key)),
  }));
  const selectedRouteKey = routeKey(options.decision.selected);
  const identity = {
    schemaVersion: 1 as const,
    sourceProfileHash: options.repo.profileHash,
    catalogFingerprint,
    quotaFingerprint,
    verificationPlanHash: options.verificationPlan.planHash,
    routeGraphFingerprint,
    selectedRouteKey,
  };
  return { ...identity, envelopeHash: sha256(stableStringify(identity)) };
}

/** Any source/catalog/quota/route-plan change requires a new no-spend preflight. */
export function assertExecutionEnvelopeCurrent(options: {
  expected: ExecutionEnvelope;
  repo: RepoProfile;
  catalog: ModelCatalog;
  quota: QuotaState;
  decision: RouteDecision;
  verificationPlan: VerificationPlan;
}): void {
  const actual = createExecutionEnvelope(options);
  if (actual.envelopeHash === options.expected.envelopeHash) return;
  throw new MetaPlanInvalidatedError("The frozen product execution envelope changed after preflight; start a new no-spend preflight.", {
    expectedEnvelopeHash: options.expected.envelopeHash,
    actualEnvelopeHash: actual.envelopeHash,
    sourceChanged: options.expected.sourceProfileHash !== actual.sourceProfileHash,
    catalogChanged: options.expected.catalogFingerprint !== actual.catalogFingerprint,
    quotaChanged: options.expected.quotaFingerprint !== actual.quotaFingerprint,
    verificationPlanChanged: options.expected.verificationPlanHash !== actual.verificationPlanHash,
    routeGraphChanged: options.expected.routeGraphFingerprint !== actual.routeGraphFingerprint,
    selectedRouteChanged: options.expected.selectedRouteKey !== actual.selectedRouteKey,
  });
}

export function fingerprintCatalog(catalog: ModelCatalog): string {
  return sha256(stableStringify(catalog.models.map((model) => ({
    id: model.id,
    model: model.model,
    hidden: model.hidden,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort).sort(compareStable),
    serviceTiers: model.serviceTiers.map((tier) => tier.id).sort(compareStable),
    defaultServiceTier: model.defaultServiceTier,
    isDefault: model.isDefault,
  })).sort((left, right) => compareStable(left.id, right.id))));
}

export function fingerprintQuota(quota: QuotaState): string {
  return sha256(stableStringify({
    known: quota.known,
    exhausted: quota.exhausted,
    rateLimitReachedType: quota.rateLimitReachedType,
    usedPercent: quota.usedPercent,
    remainingPercent: quota.remainingPercent,
    sourceLimitId: quota.sourceLimitId,
  }));
}

function routeGraphEntry(candidate: RouteCandidate): {
  key: string;
  admissible: boolean;
  capabilityScore: number;
  rejectionReasons: string[];
} {
  return {
    key: routeKey(candidate),
    admissible: candidate.admissible,
    capabilityScore: candidate.capabilityScore,
    rejectionReasons: [...candidate.rejectionReasons].sort(compareStable),
  };
}

function routeKey(candidate: Pick<RouteCandidate, "modelId" | "effort" | "speedId" | "topology" | "proofTier">): string {
  return [candidate.modelId, candidate.effort, candidate.speedId, candidate.topology, candidate.proofTier].join("\0");
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
