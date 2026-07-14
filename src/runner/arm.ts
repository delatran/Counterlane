import type { CounterlaneConfig } from "../config/types.js";
import { managedStatePrefixes } from "../config/managed-state.js";
import type { Logger } from "../core/logger.js";
import type {
  ArmOutcome,
  ArmPolicy,
  ArmResult,
  DiffSummary,
  TurnRunResult,
  VerificationPlan,
  VerificationReport,
} from "../core/types.js";
import { errorToJson, SafetyError } from "../core/errors.js";
import { newId, sha256 } from "../core/utils.js";
import type { CodexAppServer } from "../codex/app-server.js";
import { estimateCost } from "../codex/cost.js";
import { WorktreeManager, type WorktreeHandle } from "../git/worktree.js";
import { currentWorkingStateHash } from "../git/snapshot.js";
import { BlindVerifier } from "../verification/verifier.js";
import { verifyFrozenPlanIntegrity } from "../verification/plan.js";
import { calculateUtility } from "./utility.js";
import { buildControlledPrompt } from "./prompt.js";

export interface ExecuteArmOptions {
  experimentId: string;
  policy: ArmPolicy;
  worktree: WorktreeHandle;
  threadId: string;
  prompt: string;
  appServer: CodexAppServer;
  worktrees: WorktreeManager;
  config: CounterlaneConfig;
  logger: Logger;
  /** Product execution freezes verifier identity before the model turn. */
  verificationPlan?: VerificationPlan;
  /** Product journal hook persisted immediately before the App Server send. */
  beforeTurnStart?: () => Promise<void>;
  signal?: AbortSignal;
}

interface CapturedPatch {
  patch: string;
  patchHash: string;
  summary: DiffSummary;
}

export async function executeArm(options: ExecuteArmOptions): Promise<ArmResult> {
  const armId = newId("arm");
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const logger = options.logger.child({ armId, policy: options.policy.name });
  const verifier = new BlindVerifier(options.config, logger.child({ component: "verifier" }));
  let turn: TurnRunResult | undefined;
  let captured: CapturedPatch | undefined;
  let verification: VerificationReport | undefined;

  try {
    logger.info("Starting Codex arm", {
      model: options.policy.modelId,
      effort: options.policy.effort,
      speed: options.policy.speedId,
      serviceTier: options.policy.serviceTier,
      topology: options.policy.topology,
      proofTier: options.policy.proofTier,
    });
    if (options.verificationPlan !== undefined) {
      const baselineIntegrity = await verifyFrozenPlanIntegrity(options.worktree.path, options.verificationPlan);
      if (baselineIntegrity.integrity !== "intact") {
        throw new SafetyError("Frozen verifier assets changed before the model turn; refusing to start a delegated turn.", {
          integrity: baselineIntegrity.integrity,
          reasons: baselineIntegrity.reasons,
        });
      }
    }
    turn = await options.appServer.runTurn({
      threadId: options.threadId,
      prompt: buildControlledPrompt(options.prompt),
      cwd: options.worktree.path,
      modelId: options.policy.modelId,
      effort: options.policy.effort,
      serviceTier: options.policy.serviceTier,
      approvalPolicy: options.config.codex.approvalPolicy,
      sandboxPolicy:
        options.config.codex.sandbox.type === "readOnly"
          ? { type: "readOnly", networkAccess: options.config.codex.sandbox.networkAccess }
          : {
              type: "workspaceWrite",
              writableRoots: [options.worktree.path],
              networkAccess: options.config.codex.sandbox.networkAccess,
            },
      extraParams: options.config.codex.extraTurnParams,
      ...(options.beforeTurnStart === undefined ? {} : { beforeTurnStart: options.beforeTurnStart }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (turn.reroutes.length > 0) {
      throw new SafetyError("The backend rerouted this arm away from its certified policy; the result is retained as noncompliant evidence only.", {
        requestedModel: options.policy.modelId,
        reroutes: turn.reroutes.map((reroute) => ({
          fromModel: reroute.fromModel,
          toModel: reroute.toModel,
          ...(reroute.reason === undefined ? {} : { reason: reroute.reason }),
        })),
      });
    }

    captured = await options.worktrees.capturePatch(options.worktree);
    const preVerificationState = await currentWorkingStateHash(
      options.worktrees.repository,
      managedStatePrefixes(options.config),
      options.worktree.path,
    );
    verification = await verifier.verify(
      options.worktree.path,
      options.policy.proofTier,
      options.signal,
      options.verificationPlan,
    );
    await options.worktrees.assertCandidateControlState(options.worktree);
    const postVerificationState = await currentWorkingStateHash(
      options.worktrees.repository,
      managedStatePrefixes(options.config),
      options.worktree.path,
    );
    if (postVerificationState !== preVerificationState) {
      throw new SafetyError("Verifier commands mutated the candidate worktree; the captured patch does not represent the verified state.");
    }
    const cost = estimateCost(
      turn.tokenUsage,
      options.policy.modelFamily,
      options.config,
      turn.durationMs,
      options.policy.serviceTier,
      options.policy.speedCostMultiplier,
    );
    const utility = calculateUtility({ turn, verification, cost, config: options.config });
    const completedAtMs = Date.now();
    const outcome = classifyArmOutcome(turn, verification, options.signal);
    const successful = outcome === "success";
    logger.info("Codex arm completed", {
      successful,
      outcome,
      utility,
      proofTier: verification.proofTier,
      proofAdequate: verification.adequate,
      verificationScore: verification.score,
      normalizedCredits: cost.normalizedCredits,
    });

    return {
      armId,
      experimentId: options.experimentId,
      policy: options.policy,
      worktreePath: options.worktree.path,
      baselineCommit: options.worktree.baselineCommit,
      turn,
      patch: captured.patch,
      patchHash: captured.patchHash,
      diffSummary: captured.summary,
      verification,
      cost,
      utility,
      successful,
      outcome,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
    };
  } catch (error) {
    captured ??= await capturePatchOrEmpty(options);
    const now = Date.now();
    const elapsedMs = now - startedAtMs;
    verification ??= failedVerification(options, now);
    const failureTurn = turn === undefined
      ? syntheticFailedTurn(options, captured, error, startedAt, now, elapsedMs)
      : {
          ...turn,
          warnings: [...turn.warnings, `Counterlane post-turn processing failed: ${errorMessage(error)}`],
        };
    const cost = estimateCost(
      failureTurn.tokenUsage,
      options.policy.modelFamily,
      options.config,
      failureTurn.durationMs > 0 ? failureTurn.durationMs : elapsedMs,
      options.policy.serviceTier,
      options.policy.speedCostMultiplier,
    );
    const classifiedOutcome = turn === undefined
      ? classifyFailureOutcome(options.signal)
      : classifyArmOutcome(failureTurn, verification, options.signal);
    const outcome = classifiedOutcome === "success" ? "failure" : classifiedOutcome;
    logger.error("Codex arm failed", {
      error: errorMessage(error),
      outcome,
      partialTokenUsagePreserved: turn?.tokenUsage !== undefined,
      fallbackCredits: cost.normalizedCredits,
    });
    return {
      armId,
      experimentId: options.experimentId,
      policy: options.policy,
      worktreePath: options.worktree.path,
      baselineCommit: options.worktree.baselineCommit,
      turn: failureTurn,
      patch: captured.patch,
      patchHash: captured.patchHash,
      diffSummary: captured.summary,
      verification,
      cost,
      utility: calculateUtility({ turn: failureTurn, verification, cost, config: options.config, forcedFailure: true }),
      successful: false,
      outcome,
      startedAt,
      completedAt: new Date(now).toISOString(),
      durationMs: elapsedMs,
      error: errorToJson(error),
    };
  }
}

async function capturePatchOrEmpty(options: ExecuteArmOptions): Promise<CapturedPatch> {
  return options.worktrees.capturePatch(options.worktree).catch(() => ({
    patch: "",
    patchHash: sha256(""),
    summary: { filesChanged: 0, insertions: 0, deletions: 0, newFiles: 0, deletedFiles: 0, binaryFiles: 0 },
  }));
}

function failedVerification(options: ExecuteArmOptions, now: number): VerificationReport {
  return {
    proofTier: options.policy.proofTier,
    adequate: false,
    minimumIndependentChecks: options.config.verification.routing.minimumIndependentChecks[options.policy.proofTier],
    taskSpecificRequired: options.config.verification.requireTaskSpecificCheck,
    taskSpecificPassed: 0,
    taskSpecificTotal: 0,
    passed: false,
    score: 0,
    requiredPassed: 0,
    requiredTotal: 0,
    optionalPassed: 0,
    optionalTotal: 0,
    checks: [],
    startedAt: new Date(now).toISOString(),
    completedAt: new Date(now).toISOString(),
    durationMs: 0,
    verifierHash: sha256(`arm-error:${options.policy.proofTier}`),
    integrity: "unavailable",
    containment: {
      filesystem: "unverified",
      network: "unverified",
      environment: "inherited",
      processLimits: "unverified",
    },
  };
}

function syntheticFailedTurn(
  options: ExecuteArmOptions,
  captured: CapturedPatch,
  error: unknown,
  startedAt: string,
  now: number,
  elapsedMs: number,
): TurnRunResult {
  return {
    threadId: options.threadId,
    turnId: "unknown",
    status: options.signal?.aborted === true ? "interrupted" : "failed",
    finalMessage: "",
    diff: captured.patch,
    reroutes: [],
    warnings: [],
    error: errorToJson(error),
    startedAt,
    completedAt: new Date(now).toISOString(),
    durationMs: elapsedMs,
    rawEventCount: 0,
  };
}

function classifyArmOutcome(
  turn: TurnRunResult,
  verification: VerificationReport,
  signal?: AbortSignal,
): ArmOutcome {
  if (turn.status === "completed" && verification.passed) return "success";
  if (isTimeoutReason(signal?.reason) || turn.error?.["name"] === "TurnTimeoutError") return "timeout";
  if (verification.checks.some((check) => check.result.timedOut)) return "timeout";
  if (turn.status === "interrupted" || turn.status === "cancelled" || signal?.aborted === true) return "cancelled";
  return "failure";
}

function classifyFailureOutcome(signal?: AbortSignal): ArmOutcome {
  if (isTimeoutReason(signal?.reason)) return "timeout";
  return signal?.aborted === true ? "cancelled" : "failure";
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
