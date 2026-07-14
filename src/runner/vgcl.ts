import { open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArmPolicy,
  CapabilityGraph,
  RouteCandidate,
  RouteDecision,
  SingleRunResult,
} from "../core/types.js";
import { newId, writeJsonAtomic } from "../core/utils.js";
import { sha256, stableStringify } from "../core/utils.js";
import { capabilityNodeKey } from "../routing/capability-graph.js";
import { proofTierRank } from "../verification/detect.js";

export type VgclFailureCause =
  | "candidate_defect"
  | "task_or_verifier_configuration"
  | "infrastructure_or_protocol"
  | "policy_or_external_state"
  | "user_stop";

export type VgclTerminalState = "verified" | "failed" | "cancelled" | "reconciliation_required";

type JournalAttemptState =
  | "attempt_reserved"
  | "pre_send_failed"
  | "request_sent"
  | "remote_identity_known"
  | "acknowledgement_unknown"
  | "turn_terminal"
  | "verification_terminal";

interface JournalAttempt {
  ordinal: number;
  policy: Pick<ArmPolicy, "modelId" | "modelFamily" | "effort" | "speedId" | "serviceTier" | "topology" | "proofTier">;
  state: JournalAttemptState;
  /** Canonical policy-only request identity; prompts and verifier output are never journaled. */
  requestHash: string;
  transportRequestCount: number;
  modelAttemptCount: number;
  reservedAt: string;
  requestSentAt?: string;
  completedAt?: string;
  threadId?: string;
  turnId?: string;
  failureCause?: VgclFailureCause;
  detail?: string;
}

interface JournalRecord {
  schemaVersion: 1;
  runId: string;
  state: "planned" | "attempt_reserved" | "request_sent" | "reconciliation_required" | "run_terminal";
  maximumAttempts: 2;
  envelopeHash?: string;
  attempts: JournalAttempt[];
  terminalState?: VgclTerminalState;
  terminalReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VgclExecutionResult {
  runId: string;
  journalPath: string;
  terminalState: VgclTerminalState;
  attempts: SingleRunResult[];
  accounting: VgclAttemptAccounting;
  failureCause?: VgclFailureCause;
  failureCapsule?: {
    kind: "candidate_defect";
    verifierChecks: Array<{ name: string; passed: boolean }>;
  };
}

export interface VgclAttemptAccounting {
  maximumAttempts: 2;
  reserved: number;
  completed: number;
  unresolved: number;
  transportRequests: number;
  modelAttempts: number;
  verifierRuns: number;
  sequentialEscalations: number;
}

export interface VgclAttemptLifecycle {
  beforeTurnStart(): Promise<void>;
}

/**
 * A small, host-owned, sequential controller. It intentionally accepts an
 * already-frozen route decision and an injected attempt executor so the policy
 * and journal can be tested without a model turn. It never acquires a Twin.
 */
export async function executeVgcl(options: {
  journalRoot: string;
  decision: RouteDecision;
  envelopeHash?: string;
  executeAttempt: (policy: ArmPolicy, lifecycle: VgclAttemptLifecycle) => Promise<SingleRunResult>;
}): Promise<VgclExecutionResult> {
  const pending = await AttemptJournal.findPending(options.journalRoot);
  if (pending !== undefined) {
    return {
      runId: pending.runId,
      journalPath: pending.path,
      terminalState: "reconciliation_required",
      attempts: [],
      accounting: pending.accounting,
      failureCause: "infrastructure_or_protocol",
    };
  }
  const runId = newId("vgcl");
  const journal = await AttemptJournal.create(options.journalRoot, runId, options.envelopeHash);
  const attempts: SingleRunResult[] = [];
  try {
    const firstPolicy = policyFromCandidate(options.decision.selected, "counterlane-vgcl-attempt-1", options.decision);
    const first = await runReservedAttempt(journal, firstPolicy, options.executeAttempt);
    if (first.result === undefined) {
      return withAccounting(journal, {
        runId,
        journalPath: journal.path,
        terminalState: first.terminalState,
        attempts,
        failureCause: "infrastructure_or_protocol",
      });
    }
    attempts.push(first.result);
    const firstCause = classifyAttempt(first.result);
    if (firstCause === undefined) {
      await journal.finish("verified", "The first attempt passed the frozen verifier.");
      return withAccounting(journal, { runId, journalPath: journal.path, terminalState: "verified", attempts });
    }
    if (firstCause !== "candidate_defect") {
      const terminalState = firstCause === "user_stop" ? "cancelled" : "failed";
      await journal.finish(terminalState, `The first attempt stopped with ${firstCause}; no escalation is authorized.`);
      return withAccounting(journal, { runId, journalPath: journal.path, terminalState, attempts, failureCause: firstCause });
    }

    const successor = selectStrictSuccessor(
      options.decision.selected,
      options.decision.candidates,
      options.decision.capabilityGraph,
    );
    const capsule = failureCapsule(first.result);
    if (successor === undefined) {
      await journal.finish("failed", "The first verifier failure had no strictly stronger admissible successor.");
      return withAccounting(journal, {
        runId,
        journalPath: journal.path,
        terminalState: "failed",
        attempts,
        failureCause: firstCause,
        failureCapsule: capsule,
      });
    }

    const secondPolicy = policyFromCandidate(successor, "counterlane-vgcl-attempt-2");
    const second = await runReservedAttempt(journal, secondPolicy, options.executeAttempt);
    if (second.result === undefined) {
      return withAccounting(journal, {
        runId,
        journalPath: journal.path,
        terminalState: second.terminalState,
        attempts,
        failureCause: "infrastructure_or_protocol",
        failureCapsule: capsule,
      });
    }
    attempts.push(second.result);
    const secondCause = classifyAttempt(second.result);
    if (secondCause === undefined) {
      await journal.finish("verified", "The verifier-triggered strict successor passed the frozen verifier.");
      return withAccounting(journal, { runId, journalPath: journal.path, terminalState: "verified", attempts, failureCapsule: capsule });
    }
    const terminalState = secondCause === "user_stop" ? "cancelled" : "failed";
    await journal.finish(terminalState, `The second and final attempt stopped with ${secondCause}.`);
    return withAccounting(journal, {
      runId,
      journalPath: journal.path,
      terminalState,
      attempts,
      failureCause: secondCause,
      failureCapsule: capsule,
    });
  } finally {
    await journal.close();
  }
}

/** A successor must gain model/effort/topology capability; speed/proof alone is never enough. */
export function selectStrictSuccessor(
  current: RouteCandidate,
  candidates: readonly RouteCandidate[],
  graph: CapabilityGraph,
): RouteCandidate | undefined {
  const targetNodes = new Set(
    graph.edges
      .filter((edge) => edge.from === capabilityNodeKey(current))
      .map((edge) => edge.to),
  );
  return candidates
    .filter((candidate) =>
      candidate.admissible &&
      targetNodes.has(capabilityNodeKey(candidate)) &&
      candidate.speedId === current.speedId &&
      candidate.serviceTier === current.serviceTier &&
      proofTierRank(candidate.proofTier) >= proofTierRank(current.proofTier)
    )
    .slice()
    .sort((left, right) =>
      left.predictedNormalizedCredits - right.predictedNormalizedCredits ||
      left.capabilityScore - right.capabilityScore ||
      compareStableKey(routeCandidateKey(left), routeCandidateKey(right))
    )[0];
}

function compareStableKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function routeCandidateKey(candidate: Pick<RouteCandidate, "modelId" | "effort" | "topology" | "speedId" | "proofTier">): string {
  return [capabilityNodeKey(candidate), candidate.speedId, candidate.proofTier].join("\0");
}

function policyFromCandidate(candidate: RouteCandidate, name: string, routeDecision?: RouteDecision): ArmPolicy {
  return {
    kind: "treatment",
    name,
    modelId: candidate.modelId,
    modelFamily: candidate.modelFamily,
    effort: candidate.effort,
    serviceTier: candidate.serviceTier,
    speedId: candidate.speedId,
    speedCostMultiplier: candidate.speedCostMultiplier,
    speedLatencyMultiplier: candidate.speedLatencyMultiplier,
    topology: candidate.topology,
    proofTier: candidate.proofTier,
    ...(routeDecision === undefined ? {} : { routeDecision }),
  };
}

async function runReservedAttempt(
  journal: AttemptJournal,
  policy: ArmPolicy,
  executeAttempt: (policy: ArmPolicy, lifecycle: VgclAttemptLifecycle) => Promise<SingleRunResult>,
): Promise<{ result?: SingleRunResult; terminalState: "failed" | "reconciliation_required" }> {
  const ordinal = await journal.reserve(policy);
  let sendBoundaryCrossed = false;
  const lifecycle: VgclAttemptLifecycle = {
    beforeTurnStart: async () => {
      if (sendBoundaryCrossed) throw new Error("The turn/start accounting boundary was invoked more than once.");
      await journal.markRequestSent(ordinal);
      sendBoundaryCrossed = true;
    },
  };
  try {
    const result = await executeAttempt(policy, lifecycle);
    if (!sendBoundaryCrossed) {
      throw new Error("The attempt executor returned without crossing the turn/start accounting boundary.");
    }
    await journal.markTerminal(ordinal, result);
    return { result, terminalState: "failed" };
  } catch (error) {
    if (!sendBoundaryCrossed) {
      await journal.markPreSendFailure(ordinal, error);
      await journal.finish("failed", "The reserved attempt failed before turn/start; no model attempt was counted.");
      return { terminalState: "failed" };
    }
    await journal.markAcknowledgementUnknown(ordinal, error);
    await journal.finish("reconciliation_required", "A reserved attempt may have reached the App Server without a durable terminal result.");
    return { terminalState: "reconciliation_required" };
  }
}

function classifyAttempt(result: SingleRunResult): VgclFailureCause | undefined {
  if (result.arm.verification.passed && result.arm.verification.adequate && result.arm.outcome === "success") {
    return undefined;
  }
  if (result.arm.outcome === "cancelled" || result.arm.turn.status === "interrupted") return "user_stop";
  if (result.arm.turn.status !== "completed" || result.arm.outcome === "timeout") return "infrastructure_or_protocol";
  if (result.arm.verification.integrity !== undefined && result.arm.verification.integrity !== "intact") {
    return "policy_or_external_state";
  }
  if (!result.arm.verification.adequate) return "task_or_verifier_configuration";
  return "candidate_defect";
}

function failureCapsule(result: SingleRunResult): {
  kind: "candidate_defect";
  verifierChecks: Array<{ name: string; passed: boolean }>;
} {
  return {
    kind: "candidate_defect",
    verifierChecks: result.arm.verification.checks.slice(0, 16).map((check) => ({ name: check.name, passed: check.passed })),
  };
}

function withAccounting(
  journal: AttemptJournal,
  result: Omit<VgclExecutionResult, "accounting">,
): VgclExecutionResult {
  return { ...result, accounting: journal.accounting() };
}

export class AttemptJournal {
  readonly #lock: Awaited<ReturnType<typeof open>>;
  readonly #lockPath: string;
  readonly #record: JournalRecord;
  #closed = false;

  private constructor(path: string, lockPath: string, lock: Awaited<ReturnType<typeof open>>, record: JournalRecord) {
    this.path = path;
    this.#lockPath = lockPath;
    this.#lock = lock;
    this.#record = record;
  }

  public readonly path: string;

  public static async create(root: string, runId: string, envelopeHash?: string): Promise<AttemptJournal> {
    const path = join(root, `${runId}.json`);
    const lockPath = join(root, `${runId}.lock`);
    const lock = await open(lockPath, "wx");
    try {
      await lock.writeFile(`${JSON.stringify({ runId, pid: process.pid })}\n`, "utf8");
      await lock.sync();
      const now = new Date().toISOString();
      const record: JournalRecord = {
        schemaVersion: 1,
        runId,
        state: "planned",
        maximumAttempts: 2,
        ...(envelopeHash === undefined ? {} : { envelopeHash }),
        attempts: [],
        createdAt: now,
        updatedAt: now,
      };
      const journal = new AttemptJournal(path, lockPath, lock, record);
      await journal.#persist();
      return journal;
    } catch (error) {
      await lock.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * A stale sent/unknown record has no safe implicit replay contract. Refuse a
   * new product execution until an operator has reconciled that durable record.
   * This is deliberately global to the configured host journal root: lacking a
   * server operation identity, guessing that a different invocation is safe
   * would weaken the at-most-budgeted-send guarantee.
   */
  public static async findPending(root: string): Promise<{
    runId: string;
    path: string;
    accounting: VgclAttemptAccounting;
  } | undefined> {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (isMissingDirectory(error)) return [];
      throw error;
    });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(root, entry.name))
      .sort(compareStableKey);
    for (const path of candidates) {
      const parsed = await readJournalRecord(path);
      if (parsed === undefined || parsed.state === "run_terminal") continue;
      return { runId: parsed.runId, path, accounting: parsed.accounting };
    }
    return undefined;
  }

  public async reserve(policy: ArmPolicy): Promise<number> {
    if (this.#record.attempts.length >= this.#record.maximumAttempts) {
      throw new Error("The VGCL attempt journal has exhausted its maximum of two reserved attempts.");
    }
    if (this.#record.state === "reconciliation_required" || this.#record.state === "run_terminal") {
      throw new Error(`The VGCL attempt journal is ${this.#record.state} and cannot reserve another attempt.`);
    }
    const ordinal = this.#record.attempts.length + 1;
    this.#record.attempts.push({
      ordinal,
      policy: {
        modelId: policy.modelId,
        modelFamily: policy.modelFamily,
        effort: policy.effort,
        speedId: policy.speedId,
        serviceTier: policy.serviceTier,
        topology: policy.topology,
        proofTier: policy.proofTier,
      },
      state: "attempt_reserved",
      requestHash: sha256(stableStringify({
        modelId: policy.modelId,
        effort: policy.effort,
        serviceTier: policy.serviceTier,
        speedId: policy.speedId,
        topology: policy.topology,
        proofTier: policy.proofTier,
      })),
      transportRequestCount: 0,
      modelAttemptCount: 0,
      reservedAt: new Date().toISOString(),
    });
    this.#record.state = "attempt_reserved";
    await this.#persist();
    return ordinal;
  }

  public async markRequestSent(ordinal: number): Promise<void> {
    const attempt = this.#attempt(ordinal);
    attempt.state = "request_sent";
    attempt.requestSentAt = new Date().toISOString();
    attempt.transportRequestCount += 1;
    attempt.modelAttemptCount += 1;
    this.#record.state = "request_sent";
    await this.#persist();
  }

  public async markPreSendFailure(ordinal: number, error: unknown): Promise<void> {
    const attempt = this.#attempt(ordinal);
    attempt.state = "pre_send_failed";
    delete attempt.requestSentAt;
    attempt.transportRequestCount = 0;
    attempt.modelAttemptCount = 0;
    attempt.completedAt = new Date().toISOString();
    attempt.failureCause = "infrastructure_or_protocol";
    attempt.detail = boundedDetail(error instanceof Error ? error.message : String(error));
    await this.#persist();
  }

  public async markTerminal(ordinal: number, result: SingleRunResult): Promise<void> {
    const attempt = this.#attempt(ordinal);
    attempt.completedAt = new Date().toISOString();
    if (result.arm.turn.threadId.length > 0) {
      attempt.threadId = result.arm.turn.threadId;
      attempt.turnId = result.arm.turn.turnId;
      attempt.state = "remote_identity_known";
      await this.#persist();
    }
    attempt.state = "turn_terminal";
    await this.#persist();
    const failureCause = classifyAttempt(result);
    if (failureCause !== undefined) attempt.failureCause = failureCause;
    attempt.detail = boundedDetail(`outcome=${result.arm.outcome}; verifier=${result.arm.verification.passed ? "passed" : "failed"}`);
    attempt.state = "verification_terminal";
    await this.#persist();
  }

  public async markAcknowledgementUnknown(ordinal: number, error: unknown): Promise<void> {
    const attempt = this.#attempt(ordinal);
    attempt.state = "acknowledgement_unknown";
    attempt.completedAt = new Date().toISOString();
    attempt.failureCause = "infrastructure_or_protocol";
    attempt.detail = boundedDetail(error instanceof Error ? error.message : String(error));
    this.#record.state = "reconciliation_required";
    await this.#persist();
  }

  public async finish(state: VgclTerminalState, reason: string): Promise<void> {
    this.#record.state = state === "reconciliation_required" ? "reconciliation_required" : "run_terminal";
    this.#record.terminalState = state;
    this.#record.terminalReason = boundedDetail(reason);
    await this.#persist();
  }

  public accounting(): VgclAttemptAccounting {
    return accountingFromAttempts(this.#record.attempts);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#lock.close();
    await rm(this.#lockPath, { force: true });
  }

  #attempt(ordinal: number): JournalAttempt {
    const attempt = this.#record.attempts.find((candidate) => candidate.ordinal === ordinal);
    if (attempt === undefined) throw new Error(`Attempt journal entry ${ordinal} does not exist.`);
    return attempt;
  }

  async #persist(): Promise<void> {
    this.#record.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.path, this.#record);
    const handle = await open(this.path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function boundedDetail(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").slice(0, 1_000);
}

function isMissingDirectory(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readJournalRecord(path: string): Promise<{
  runId: string;
  state: JournalRecord["state"];
  accounting: VgclAttemptAccounting;
} | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record["runId"] !== "string" || typeof record["state"] !== "string") return undefined;
    if (!["planned", "attempt_reserved", "request_sent", "reconciliation_required", "run_terminal"].includes(record["state"])) {
      return undefined;
    }
    const attempts = Array.isArray(record["attempts"])
      ? record["attempts"].filter((attempt): attempt is Record<string, unknown> =>
          typeof attempt === "object" && attempt !== null && !Array.isArray(attempt))
      : [];
    return {
      runId: record["runId"],
      state: record["state"] as JournalRecord["state"],
      accounting: accountingFromUnknownAttempts(attempts),
    };
  } catch {
    // A torn or unreadable artifact is an unresolved execution boundary too.
    return {
      runId: "unknown",
      state: "reconciliation_required",
      accounting: { ...emptyAccounting(), unresolved: 1 },
    };
  }
}

function accountingFromAttempts(attempts: readonly JournalAttempt[]): VgclAttemptAccounting {
  return {
    maximumAttempts: 2,
    reserved: attempts.length,
    completed: attempts.filter((attempt) => attempt.state === "verification_terminal" || attempt.state === "pre_send_failed").length,
    unresolved: attempts.filter((attempt) => attempt.state === "acknowledgement_unknown").length,
    transportRequests: attempts.reduce((total, attempt) => total + attempt.transportRequestCount, 0),
    modelAttempts: attempts.reduce((total, attempt) => total + attempt.modelAttemptCount, 0),
    verifierRuns: attempts.filter((attempt) => attempt.state === "verification_terminal").length,
    sequentialEscalations: Math.max(0, attempts.length - 1),
  };
}

function accountingFromUnknownAttempts(attempts: readonly Record<string, unknown>[]): VgclAttemptAccounting {
  const terminalStates = new Set(["verification_terminal", "pre_send_failed"]);
  const unresolvedStates = new Set(["request_sent", "remote_identity_known", "acknowledgement_unknown", "turn_terminal"]);
  return {
    maximumAttempts: 2,
    reserved: attempts.length,
    completed: attempts.filter((attempt) => terminalStates.has(String(attempt["state"]))).length,
    unresolved: attempts.filter((attempt) => unresolvedStates.has(String(attempt["state"]))).length,
    transportRequests: attempts.reduce((total, attempt) => total + safeCount(attempt["transportRequestCount"]), 0),
    modelAttempts: attempts.reduce((total, attempt) => total + safeCount(attempt["modelAttemptCount"]), 0),
    verifierRuns: attempts.filter((attempt) => attempt["state"] === "verification_terminal").length,
    sequentialEscalations: Math.max(0, attempts.length - 1),
  };
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function emptyAccounting(): VgclAttemptAccounting {
  return {
    maximumAttempts: 2,
    reserved: 0,
    completed: 0,
    unresolved: 0,
    transportRequests: 0,
    modelAttempts: 0,
    verifierRuns: 0,
    sequentialEscalations: 0,
  };
}
