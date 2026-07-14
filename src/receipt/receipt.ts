import type { JsonObject, JsonValue } from "../core/json.js";
import type { SingleRunResult } from "../core/types.js";
import type { VgclExecutionResult } from "../runner/vgcl.js";
import { sha256, stableStringify } from "../core/utils.js";

export type ReceiptEvidenceKind = "runtime" | "simulated" | "unverified";

interface ReceiptTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  normalizedTokenCostProxy: number;
  modelDurationMs: number;
  verifierDurationMs: number;
  attemptDurationMs: number;
  isolationAndMaterializationMs: number;
  discoveryMs: number;
  routingAndPolicyMs: number;
  delegationSetupMs: number;
  attemptLocalOverheadMs: number;
  cleanupAndReconciliationMs: number;
}

/** Build the compact, no-prompt product receipt from observed run artifacts. */
export function buildProductReceipt(options: {
  execution: VgclExecutionResult;
  envelopeHash: string;
  nonApplying: boolean;
  evidenceKind: ReceiptEvidenceKind;
  timing?: {
    preflightAndDiscoveryMs: number;
    endToEndMs: number;
  };
}): JsonObject {
  const attempts: JsonObject[] = options.execution.attempts.map((attempt, index): JsonObject => ({
    ...summarizeAttempt(attempt),
    ordinal: index + 1,
  }));
  const totals = attempts.reduce<ReceiptTotals>((total, attempt) => ({
    inputTokens: total.inputTokens + numeric(attempt["usage"], "inputTokens"),
    cachedInputTokens: total.cachedInputTokens + numeric(attempt["usage"], "cachedInputTokens"),
    outputTokens: total.outputTokens + numeric(attempt["usage"], "outputTokens"),
    reasoningOutputTokens: total.reasoningOutputTokens + numeric(attempt["usage"], "reasoningOutputTokens"),
    totalTokens: total.totalTokens + numeric(attempt["usage"], "totalTokens"),
    normalizedTokenCostProxy: total.normalizedTokenCostProxy + numeric(attempt["accounting"], "normalizedTokenCostProxy"),
    modelDurationMs: total.modelDurationMs + numeric(attempt["duration"], "modelDurationMs"),
    verifierDurationMs: total.verifierDurationMs + numeric(attempt["duration"], "verifierDurationMs"),
    attemptDurationMs: total.attemptDurationMs + numeric(attempt["duration"], "attemptDurationMs"),
    isolationAndMaterializationMs: total.isolationAndMaterializationMs + numeric(attempt["timing"], "isolationAndMaterializationMs"),
    discoveryMs: total.discoveryMs + numeric(attempt["timing"], "discoveryMs"),
    routingAndPolicyMs: total.routingAndPolicyMs + numeric(attempt["timing"], "routingAndPolicyMs"),
    delegationSetupMs: total.delegationSetupMs + numeric(attempt["timing"], "delegationSetupMs"),
    attemptLocalOverheadMs: total.attemptLocalOverheadMs + numeric(attempt["timing"], "attemptLocalOverheadMs"),
    cleanupAndReconciliationMs: total.cleanupAndReconciliationMs + numeric(attempt["timing"], "cleanupAndReconciliationMs"),
  }), {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    normalizedTokenCostProxy: 0,
    modelDurationMs: 0,
    verifierDurationMs: 0,
    attemptDurationMs: 0,
    isolationAndMaterializationMs: 0,
    discoveryMs: 0,
    routingAndPolicyMs: 0,
    delegationSetupMs: 0,
    attemptLocalOverheadMs: 0,
    cleanupAndReconciliationMs: 0,
  });
  const preflightAndDiscoveryMs = finite(options.timing?.preflightAndDiscoveryMs);
  const endToEndMs = Math.max(
    finite(options.timing?.endToEndMs),
    preflightAndDiscoveryMs + totals.attemptDurationMs,
  );
  const knownPhasesMs = preflightAndDiscoveryMs +
    totals.isolationAndMaterializationMs +
    totals.discoveryMs +
    totals.routingAndPolicyMs +
    totals.delegationSetupMs +
    totals.modelDurationMs +
    totals.verifierDurationMs +
    totals.attemptLocalOverheadMs +
    totals.cleanupAndReconciliationMs;
  const controllerUnattributedMs = Math.max(0, endToEndMs - knownPhasesMs);
  const nestedMcp = options.execution.attempts.some((attempt) => attempt.accountingBoundary?.scope === "nested-mcp");
  const base: JsonObject = {
    schemaVersion: 1,
    evidence: {
      kind: options.evidenceKind,
      externalAdjudication: "not-performed",
      actualEconomics: "unavailable",
      actualRouteAttestation: "requested-route-with-reroute-observation",
    } as unknown as JsonValue,
    terminal: {
      runId: options.execution.runId,
      state: options.execution.terminalState,
      failureCause: options.execution.failureCause ?? null,
      envelopeHash: options.envelopeHash,
      nonApplying: options.nonApplying,
    } as unknown as JsonValue,
    attempts: attempts as unknown as JsonValue,
    attemptAccounting: {
      maximumExpensiveTurns: options.execution.accounting.maximumAttempts,
      reserved: options.execution.accounting.reserved,
      completed: options.execution.accounting.completed,
      unresolved: options.execution.accounting.unresolved,
      transportRequests: options.execution.accounting.transportRequests,
      transportRequestRetries: 0,
      modelAttempts: options.execution.accounting.modelAttempts,
      verifierRuns: options.execution.accounting.verifierRuns,
      sequentialEscalations: options.execution.accounting.sequentialEscalations,
      mutatingReplayPolicy: "not-replayed-without-advertised-idempotency-contract",
    } as unknown as JsonValue,
    cumulative: {
      ...totals,
      normalizedTokenCostProxyLabel: "normalized-token-cost-proxy",
      actualEconomics: "unavailable",
      controllerOverheadMs: Math.max(0, endToEndMs - totals.modelDurationMs - totals.verifierDurationMs),
    } as unknown as JsonValue,
    timing: {
      clock: "monotonic-local-elapsed",
      phasesOverlap: false,
      endToEndMs,
      preflightAndDiscoveryMs,
      isolationAndMaterializationMs: totals.isolationAndMaterializationMs,
      discoveryMs: totals.discoveryMs,
      routingAndPolicyMs: totals.routingAndPolicyMs,
      delegationSetupMs: totals.delegationSetupMs,
      modelMs: totals.modelDurationMs,
      verifierMs: totals.verifierDurationMs,
      attemptLocalOverheadMs: totals.attemptLocalOverheadMs,
      cleanupAndReconciliationMs: totals.cleanupAndReconciliationMs,
      controllerUnattributedMs,
    } as unknown as JsonValue,
    accountingBoundary: {
      scope: nestedMcp ? "nested-mcp" : "root-pre-turn",
      parentOrCallerUsage: nestedMcp ? "unknown-and-excluded" : "not-applicable",
      nestedDelegationUsage: nestedMcp ? "unknown-and-excluded" : "none-observed",
      fullSystemSavingsClaimEligible: false,
    } as unknown as JsonValue,
    contamination: {
      backendRerouteObserved: attempts.some((attempt) => {
        const actualRoute = attempt["actualRoute"];
        return typeof actualRoute === "object" && actualRoute !== null && !Array.isArray(actualRoute)
          && actualRoute["rerouteObserved"] === true;
      }),
      parentCheckoutChanged: false,
      candidateApplied: false,
    } as unknown as JsonValue,
  };
  return { ...base, receiptHash: sha256(stableStringify(base)) };
}

/** Deterministic public projection; the authoritative local receipt is never mutated. */
export function redactPublicReceipt(receipt: JsonObject): JsonObject {
  const redacted = redact(receipt) as JsonObject;
  const base: JsonObject = {
    ...redacted,
    publicRedaction: {
      schemaVersion: 1,
      rawPrompt: "removed",
      verifierOutput: "removed",
      hostIdentifiers: "removed",
    } as unknown as JsonValue,
  };
  return { ...base, publicReceiptHash: sha256(stableStringify(base)) };
}

function summarizeAttempt(result: SingleRunResult): JsonObject {
  const usage = result.arm.turn.tokenUsage?.last;
  const verification = result.arm.verification;
  const timing = result.timing ?? fallbackTiming(result);
  const accountingBoundary = result.accountingBoundary ?? {
    scope: "root-pre-turn",
    parentOrCallerUsage: "not-applicable",
  };
  return {
    outcome: result.arm.outcome,
    actualRoute: {
      requestedRoute: "recorded-below",
      backendAttestation: "unavailable",
      rerouteObserved: result.arm.turn.reroutes.length > 0,
      compliance: result.arm.turn.reroutes.length === 0 ? "not-attested" : "backend-reroute-observed",
    } as unknown as JsonValue,
    route: {
      modelId: result.arm.policy.modelId,
      effort: result.arm.policy.effort,
      speedId: result.arm.policy.speedId,
      serviceTier: result.arm.policy.serviceTier,
      topology: result.arm.policy.topology,
      proofTier: result.arm.policy.proofTier,
    } as unknown as JsonValue,
    verification: {
      passed: verification.passed,
      adequate: verification.adequate,
      integrity: verification.integrity ?? "unavailable",
      taskSpecificPassed: verification.taskSpecificPassed,
      taskSpecificTotal: verification.taskSpecificTotal,
      externalAdjudication: "not-performed",
      containment: verification.containment ?? {
        filesystem: "unverified",
        network: "unverified",
        environment: "inherited",
        processLimits: "unverified",
      },
      checks: verification.checks.map((check) => ({ name: check.name, passed: check.passed })),
    } as unknown as JsonValue,
    usage: {
      source: usage === undefined ? "unavailable" : "reported-last-turn",
      inputTokens: usage?.inputTokens ?? 0,
      cachedInputTokens: usage?.cachedInputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      reasoningOutputTokens: usage?.reasoningOutputTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
    } as unknown as JsonValue,
    accounting: {
      normalizedTokenCostProxy: result.arm.cost.normalizedCredits,
      normalizedTokenCostProxySource: result.arm.cost.source,
      actualEconomics: "unavailable",
    } as unknown as JsonValue,
    duration: {
      modelDurationMs: result.arm.turn.durationMs,
      verifierDurationMs: verification.durationMs,
      attemptDurationMs: result.durationMs,
    } as unknown as JsonValue,
    timing: timing as unknown as JsonValue,
    accountingBoundary: accountingBoundary as unknown as JsonValue,
  };
}

function fallbackTiming(result: SingleRunResult): {
  isolationAndMaterializationMs: number;
  discoveryMs: number;
  routingAndPolicyMs: number;
  delegationSetupMs: number;
  modelMs: number;
  verifierMs: number;
  attemptLocalOverheadMs: number;
  cleanupAndReconciliationMs: number;
} {
  const modelMs = finite(result.arm.turn.durationMs);
  const verifierMs = finite(result.arm.verification.durationMs);
  return {
    isolationAndMaterializationMs: 0,
    discoveryMs: 0,
    routingAndPolicyMs: 0,
    delegationSetupMs: 0,
    modelMs,
    verifierMs,
    attemptLocalOverheadMs: Math.max(0, finite(result.durationMs) - modelMs - verifierMs),
    cleanupAndReconciliationMs: 0,
  };
}

function numeric(value: JsonValue | undefined, key: string): number {
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) return 0;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return typeof value === "string" ? redactString(value) : value;
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    result[key] = redact(entry);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();
  if (normalized.endsWith("path") || normalized.endsWith("directory")) return true;
  if (normalized.startsWith("raw") || normalized.includes("secret") || normalized.includes("password")) return true;
  if (normalized.endsWith("token") || normalized.endsWith("credential") || normalized.endsWith("bearer")) return true;
  return new Set([
    "prompt",
    "stdout",
    "stderr",
    "verifieroutput",
    "threadid",
    "turnid",
    "sessionid",
    "accountid",
    "quotaid",
    "apikey",
    "authorization",
    "environment",
    "env",
    "hostidentifier",
    "hostidentifiers",
  ]).has(normalized);
}

function redactString(value: string): string {
  return value
    .replace(/\b[A-Za-z]:\\[^\r\n,;|"'<>]+/gu, "[redacted-host-path]")
    .replace(/\/(?:home|Users|tmp|var\/tmp)\/[^\s,;|"'<>]+(?:\/[^\s,;|"'<>]+)*/gu, "[redacted-host-path]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+={0,2}/giu, "Bearer [redacted-credential]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[redacted-credential]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/gu, "[redacted-credential]")
    .replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/gu, "[redacted-credential]");
}
