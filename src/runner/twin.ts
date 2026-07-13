import type { CounterlaneConfig } from "../config/types.js";
import { managedStatePrefixes } from "../config/managed-state.js";
import type { Logger } from "../core/logger.js";
import type { ArmPolicy, ExperimentResult, RouteConstraints, VerificationReport } from "../core/types.js";
import type { JsonObject } from "../core/json.js";
import { newId, sha256, withTimeout } from "../core/utils.js";
import { errorMessage, MetaPlanInvalidatedError, SafetyError } from "../core/errors.js";
import { createLinkedAbortScope, throwIfAborted } from "../core/abort.js";
import { CodexAppServer } from "../codex/app-server.js";
import { GitRepository } from "../git/repository.js";
import { captureSnapshot, currentContentHash, currentWorkingStateHash } from "../git/snapshot.js";
import { WorktreeManager } from "../git/worktree.js";
import { writeExperimentArtifacts } from "../report/certificate.js";
import { buildCalibrationIndex, routeCalibrationContext, routeObservationPayload } from "../routing/calibration.js";
import { AutoRouter, requireAdmissibleRoute } from "../routing/router.js";
import { deriveQuotaState } from "../routing/quota.js";
import { buildMetaContext, routeInterventionSignature } from "../meta/context.js";
import { TelemetryStore } from "../telemetry/store.js";
import { inspectVerificationCapabilities } from "../verification/detect.js";
import { BlindVerifier } from "../verification/verifier.js";
import { executeArm } from "./arm.js";
import { selectWinner } from "./utility.js";
import { revalidateControlPolicy, revalidateTreatmentPolicy } from "./policy.js";
import { metaEvidenceHash, parsePairedObservations } from "../meta/evidence.js";
import { ensureContainedDirectory, resolveContainedPath } from "../core/path-safety.js";
import { validateThreadProvenance } from "../core/thread-provenance.js";
import { normalizeUserPrompt } from "./prompt.js";

export interface TwinRunOptions {
  prompt: string;
  applyWinner?: boolean;
  parentThreadId?: string;
  lastTurnId?: string;
  controlPolicyOverride?: ArmPolicy;
  treatmentPolicyOverride?: ArmPolicy;
  constraints?: RouteConstraints;
  signal?: AbortSignal;
  expectedRepositoryProfileHash?: string;
  expectedMetaEvidenceHash?: string;
  expectedMetaContextKey?: string;
  requireMetaTwinQuota?: boolean;
}

export class TwinRunner {
  readonly #repository: GitRepository;
  readonly #config: CounterlaneConfig;
  readonly #logger: Logger;
  readonly #telemetry: TelemetryStore;
  readonly #writeArtifacts: typeof writeExperimentArtifacts;

  public constructor(options: {
    repository: GitRepository;
    config: CounterlaneConfig;
    logger: Logger;
    telemetry: TelemetryStore;
    artifactWriter?: typeof writeExperimentArtifacts;
  }) {
    this.#repository = options.repository;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#telemetry = options.telemetry;
    this.#writeArtifacts = options.artifactWriter ?? writeExperimentArtifacts;
  }

  public async run(options: TwinRunOptions): Promise<ExperimentResult> {
    validateThreadProvenance(options);
    const prompt = normalizeUserPrompt(options.prompt);
    const experimentId = newId("exp");
    const startedAtMs = Date.now();
    const logger = this.#logger.child({ experimentId });
    const promptHash = sha256(prompt);
    const experimentAbort = new AbortController();
    const unlinkParentAbort = forwardAbort(options.signal, experimentAbort);
    const maximumTimer = setTimeout(() => {
      const error = new Error(`Twin experiment exceeded ${this.#config.twin.maximumDurationMs} ms.`);
      error.name = "TimeoutError";
      experimentAbort.abort(error);
    }, this.#config.twin.maximumDurationMs);
    maximumTimer.unref();
    const worktrees = new WorktreeManager(this.#repository, this.#config, experimentId);
    const managedPrefixes = managedStatePrefixes(this.#config);
    let appServer: CodexAppServer | null = null;
    let controlThreadId: string | null = null;
    let treatmentThreadId: string | null = null;
    let experimentSucceeded = false;
    let primaryError: unknown;
    let applicationCommitted = false;
    let returnedResult: ExperimentResult | undefined;

    try {
      throwIfAborted(experimentAbort.signal);
      await ensureContainedDirectory(
        this.#repository.root,
        resolveContainedPath(this.#repository.root, this.#config.dataDirectory, {
          target: "Counterlane data directory",
          boundary: "repository",
        }),
        { target: "Counterlane data directory", boundary: "repository" },
      );
      logger.info("Capturing paired experiment snapshot");
      const [snapshot, repoProfile] = await Promise.all([
        captureSnapshot(this.#repository, managedPrefixes),
        this.#repository.profile(managedPrefixes),
      ]);
      if (options.expectedRepositoryProfileHash !== undefined && repoProfile.profileHash !== options.expectedRepositoryProfileHash) {
        throw new MetaPlanInvalidatedError("Repository profile changed after the meta decision.", {
          expected: options.expectedRepositoryProfileHash,
          actual: repoProfile.profileHash,
        });
      }
      throwIfAborted(experimentAbort.signal);
      await this.#telemetry.append("experiment.started", {
        promptHash,
        repositoryProfileHash: repoProfile.profileHash,
        snapshotHash: snapshot.manifest.workingStateHash,
      }, experimentId);
      const [controlWorktree, treatmentWorktree] = await worktrees.createPair(
        newId("blind_a"),
        newId("blind_b"),
        snapshot,
      );
      throwIfAborted(experimentAbort.signal);

      appServer = await CodexAppServer.connect({
        config: this.#config,
        cwd: this.#repository.root,
        logger: logger.child({ component: "app-server" }),
        signal: experimentAbort.signal,
      });
      throwIfAborted(experimentAbort.signal);
      const [catalog, rateLimits, events, verificationCapabilities] = await Promise.all([
        appServer.listModels(experimentAbort.signal),
        appServer.readRateLimits(experimentAbort.signal),
        this.#telemetry.readLearningEvents(),
        inspectVerificationCapabilities(controlWorktree.path, this.#config),
      ]);
      throwIfAborted(experimentAbort.signal);
      const quota = deriveQuotaState(rateLimits, this.#config.routing.reservePercent);
      if (options.requireMetaTwinQuota === true && (
        !quota.known ||
        quota.exhausted ||
        quota.pressure > this.#config.meta.maximumQuotaPressureForTwin ||
        quota.usedPercent === null ||
        quota.usedPercent > this.#config.meta.maximumUsedPercentForTwin
      )) {
        throw new MetaPlanInvalidatedError("Live quota no longer authorizes a paired Twin experiment.", {
          pressure: quota.pressure,
          quotaKnown: quota.known,
          usedPercent: quota.usedPercent,
        });
      }
      const router = new AutoRouter(this.#config);
      const calibration = buildCalibrationIndex(events);
      if (options.expectedMetaEvidenceHash !== undefined) {
        const actualEvidenceHash = metaEvidenceHash(parsePairedObservations(events), calibration);
        if (actualEvidenceHash !== options.expectedMetaEvidenceHash) {
          throw new MetaPlanInvalidatedError("Routing or paired evidence changed after the meta decision.", {
            expected: options.expectedMetaEvidenceHash,
            actual: actualEvidenceHash,
          });
        }
      }
      const route = router.decide({
        prompt,
        repo: repoProfile,
        catalog,
        quota,
        verificationCapabilities,
        calibration,
        ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
      });
      const staticRoute = router.staticPolicy(catalog, verificationCapabilities);
      const executableRoute = options.treatmentPolicyOverride === undefined
        ? requireAdmissibleRoute(route)
        : route;

      const configuredControlPolicy: ArmPolicy = {
            kind: "control",
            name: "static-no-auto",
            modelId: staticRoute.model.id,
            modelFamily: staticRoute.family,
            effort: staticRoute.effort,
            serviceTier: staticRoute.serviceTier,
            speedId: staticRoute.speedId,
            speedCostMultiplier: staticRoute.speedCostMultiplier,
            speedLatencyMultiplier: staticRoute.speedLatencyMultiplier,
            topology: staticRoute.topology,
            proofTier: staticRoute.proofTier,
          };
      const controlPolicy = revalidateControlPolicy({
        policy: options.controlPolicyOverride ?? configuredControlPolicy,
        prompt,
        config: this.#config,
        catalog,
        quota,
        repo: repoProfile,
        verificationCapabilities,
        calibration,
      });
      const treatmentPolicy: ArmPolicy = options.treatmentPolicyOverride === undefined
        ? {
            kind: "treatment",
            name: "counterlane-auto",
            modelId: executableRoute.selected.modelId,
            modelFamily: executableRoute.selected.modelFamily,
            effort: executableRoute.selected.effort,
            serviceTier: executableRoute.selected.serviceTier,
            speedId: executableRoute.selected.speedId,
            speedCostMultiplier: executableRoute.selected.speedCostMultiplier,
            speedLatencyMultiplier: executableRoute.selected.speedLatencyMultiplier,
            topology: executableRoute.selected.topology,
            proofTier: executableRoute.selected.proofTier,
            routeDecision: executableRoute,
          }
        : revalidateTreatmentPolicy({
            policy: options.treatmentPolicyOverride,
            prompt,
            config: this.#config,
            catalog,
            quota,
            repo: repoProfile,
            verificationCapabilities,
            calibration,
            ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
          });
      const effectiveRoute = treatmentPolicy.routeDecision ?? route;
      const metaContext = buildMetaContext(
        effectiveRoute.features,
        repoProfile,
        effectiveRoute.selected.detectionEstimate,
        routeInterventionSignature(controlPolicy, treatmentPolicy),
      );
      if (options.expectedMetaContextKey !== undefined && metaContext.key !== options.expectedMetaContextKey) {
        throw new MetaPlanInvalidatedError("Meta context changed after the meta decision.", {
          expected: options.expectedMetaContextKey,
          actual: metaContext.key,
        });
      }

      if (options.parentThreadId !== undefined) {
        await appServer.resumeThread(options.parentThreadId);
        throwIfAborted(experimentAbort.signal);
        [controlThreadId, treatmentThreadId] = await settlePairedOperation(
          "ephemeral thread fork",
          appServer.forkThread({
            threadId: options.parentThreadId,
            ...(options.lastTurnId === undefined ? {} : { lastTurnId: options.lastTurnId }),
            cwd: controlWorktree.path,
            modelId: controlPolicy.modelId,
            serviceTier: controlPolicy.serviceTier,
          }),
          appServer.forkThread({
            threadId: options.parentThreadId,
            ...(options.lastTurnId === undefined ? {} : { lastTurnId: options.lastTurnId }),
            cwd: treatmentWorktree.path,
            modelId: treatmentPolicy.modelId,
            serviceTier: treatmentPolicy.serviceTier,
          }),
          (arm, threadId) => {
            if (arm === "control") controlThreadId = threadId;
            else treatmentThreadId = threadId;
          },
        );
      } else {
        [controlThreadId, treatmentThreadId] = await settlePairedOperation(
          "ephemeral thread start",
          appServer.startThread({
            cwd: controlWorktree.path,
            modelId: controlPolicy.modelId,
            serviceTier: controlPolicy.serviceTier,
          }),
          appServer.startThread({
            cwd: treatmentWorktree.path,
            modelId: treatmentPolicy.modelId,
            serviceTier: treatmentPolicy.serviceTier,
          }),
          (arm, threadId) => {
            if (arm === "control") controlThreadId = threadId;
            else treatmentThreadId = threadId;
          },
        );
      }
      throwIfAborted(experimentAbort.signal);

      logger.info("Paired routes selected", {
        control: policyLabel(controlPolicy),
        treatment: policyLabel(treatmentPolicy),
        quotaPressure: quota.pressure,
      });
      await this.#telemetry.append("experiment.routed", {
        control: policyTelemetry(controlPolicy),
        treatment: policyTelemetry(treatmentPolicy),
        quota: quota as unknown as JsonObject,
        verificationCapabilities: verificationCapabilities as unknown as JsonObject,
      }, experimentId);

      const runControl = () => runArmWithDeadline({
        experimentId,
        policy: controlPolicy,
        worktree: controlWorktree,
        threadId: controlThreadId as string,
        prompt,
        appServer: appServer as CodexAppServer,
        worktrees,
        config: this.#config,
        logger,
        parentSignal: experimentAbort.signal,
        ...(options.constraints?.deadlineMs === undefined ? {} : { deadlineMs: options.constraints.deadlineMs }),
      });
      const runTreatment = () => runArmWithDeadline({
        experimentId,
        policy: treatmentPolicy,
        worktree: treatmentWorktree,
        threadId: treatmentThreadId as string,
        prompt,
        appServer: appServer as CodexAppServer,
        worktrees,
        config: this.#config,
        logger,
        parentSignal: experimentAbort.signal,
        ...(options.constraints?.deadlineMs === undefined ? {} : { deadlineMs: options.constraints.deadlineMs }),
      });

      const armExecution = this.#config.twin.execution === "parallel"
        ? settlePairedOperation("arm execution", runControl(), runTreatment())
        : (async () => [await runControl(), await runTreatment()] as const)();
      const cancellationGraceDeadline = startedAtMs +
        this.#config.twin.maximumDurationMs +
        this.#config.codex.shutdownTimeoutMs;
      let control: Awaited<typeof armExecution>[0];
      let treatment: Awaited<typeof armExecution>[1];
      const guardedArmExecution = rejectWhenAborted(armExecution, experimentAbort.signal);
      try {
        [control, treatment] = await withTimeout(
          guardedArmExecution,
          Math.max(1, cancellationGraceDeadline - Date.now()),
          `Twin experiment did not settle within the cancellation grace period.`,
          () => {
            experimentAbort.abort(new Error("Twin cancellation grace period expired."));
          },
        );
      } catch (error) {
        logger.warn("Twin arm execution failed or was aborted; entering bounded containment", {
          error: error instanceof Error ? error.message : String(error),
        });
        experimentAbort.abort(error);
        await appServer.close().catch(() => undefined);
        // The transport is terminal after containment. Do not let the outer
        // cleanup issue thread/delete requests against a closed client and
        // overwrite the primary containment error.
        appServer = null;
        const settled = await settlesWithin(armExecution, this.#config.codex.shutdownTimeoutMs);
        if (!settled) {
          worktrees.forcePreserveForRecovery();
          throw new SafetyError("Twin arms remained live after cancellation containment; preserving isolated worktrees for recovery.", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
      await worktrees.assertExperimentControlState([controlWorktree, treatmentWorktree]);
      const winner = selectWinner(control, treatment, this.#config.utility.practicalEquivalenceMargin);
      const originalStateHash = await currentWorkingStateHash(this.#repository, managedPrefixes);
      const originalStateUnchanged = originalStateHash === snapshot.manifest.workingStateHash;
      if (!originalStateUnchanged) {
        throw new SafetyError("Original repository changed while the twin experiment was running; refusing to certify or apply a result.");
      }
      let appliedWinner = false;
      let postApplyVerification: VerificationReport | undefined;
      const shouldApply = options.applyWinner ?? this.#config.twin.applyWinnerByDefault;
      const winnerArm = winner.winner === "control" ? control : winner.winner === "treatment" ? treatment : null;

      if (shouldApply) {
        if (winnerArm === null || !winnerArm.successful) {
          throw new SafetyError("No uniquely verified winner is available to apply.");
        }
      }

      let completedAtMs = Date.now();
      let artifactResult: Omit<ExperimentResult, "certificatePath"> = {
        experimentId,
        promptHash,
        ...(this.#config.telemetry.includePrompt ? { prompt } : {}),
        repositoryRoot: this.#repository.root,
        snapshot: snapshot.manifest,
        control,
        treatment,
        winner,
        originalStateUnchanged,
        appliedWinner: false,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
      };
      const preliminaryArtifactResult = artifactResult;
      let certificatePath = await this.#writeArtifacts(preliminaryArtifactResult, this.#config);
      let result: ExperimentResult = { ...artifactResult, certificatePath };

      if (shouldApply && winnerArm !== null) {
        const originalContentHash = await currentContentHash(this.#repository, managedPrefixes);
        await worktrees.applyPatchToOriginal(winnerArm.patch, async () => {
          const [candidateContent, appliedContent] = await Promise.all([
            currentContentHash(this.#repository, managedPrefixes, winnerArm.worktreePath),
            currentContentHash(this.#repository, managedPrefixes),
          ]);
          if (candidateContent !== appliedContent) {
            throw new SafetyError("Applied checkout content does not match the certified Twin winner.", {
              candidateContent,
              appliedContent,
            });
          }
          return worktrees.verifyOriginalWithoutMutation(async () => {
            postApplyVerification = await new BlindVerifier(
              this.#config,
              logger.child({ component: "post-apply-verifier" }),
            ).verify(this.#repository.root, winnerArm.policy.proofTier, experimentAbort.signal);
            return postApplyVerification.passed;
          });
        });
        appliedWinner = true;
        completedAtMs = Date.now();
        artifactResult = {
          ...artifactResult,
          appliedWinner: true,
          ...(postApplyVerification === undefined ? {} : { postApplyVerification }),
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs: completedAtMs - startedAtMs,
        };
        try {
          certificatePath = await this.#writeArtifacts(artifactResult, this.#config);
        } catch (artifactError) {
          try {
            await worktrees.rollbackPatchFromOriginal(
              winnerArm.patch,
              async () => {
                const [workingStateHash, contentHash] = await Promise.all([
                  currentWorkingStateHash(this.#repository, managedPrefixes),
                  currentContentHash(this.#repository, managedPrefixes),
                ]);
                return workingStateHash === snapshot.manifest.workingStateHash && contentHash === originalContentHash;
              },
            );
          } catch (rollbackError) {
            worktrees.forcePreserveForRecovery();
            throw new SafetyError("The applied Twin winner artifact failed to commit and exact rollback also failed; recovery state was preserved.", {
              artifactError: errorMessage(artifactError),
              rollbackError: errorMessage(rollbackError),
            });
          }
          try {
            await this.#writeArtifacts(preliminaryArtifactResult, this.#config);
          } catch (repairError) {
            worktrees.forcePreserveForRecovery();
            throw new SafetyError("The applied Twin winner was rolled back, but the preliminary non-applied artifact set could not be restored; recovery state was preserved.", {
              artifactError: errorMessage(artifactError),
              repairError: errorMessage(repairError),
            });
          }
          throw new SafetyError("The applied Twin winner was rolled back because its durable result artifact could not be committed.", {
            artifactError: errorMessage(artifactError),
          });
        }
        result = { ...artifactResult, certificatePath };
        applicationCommitted = true;
      }
      experimentSucceeded = control.successful || treatment.successful;
      returnedResult = result;

      const telemetryWrites: Array<Promise<unknown>> = [];
      if (control.turn.reroutes.length === 0) {
        telemetryWrites.push(this.#telemetry.append("route.observed", armObservation(control), experimentId));
      }
      if (treatment.turn.reroutes.length === 0) {
        telemetryWrites.push(this.#telemetry.append("route.observed", armObservation(treatment), experimentId));
      }
      telemetryWrites.push(this.#telemetry.append("experiment.completed", {
        winner: winner.winner,
        utilityDelta: winner.utilityDelta,
        verifiedSuccessDelta: winner.verifiedSuccessDelta,
        controlUtility: control.utility,
        treatmentUtility: treatment.utility,
        controlSuccessful: control.successful,
        treatmentSuccessful: treatment.successful,
        controlOutcome: control.outcome,
        treatmentOutcome: treatment.outcome,
        controlTurnStatus: control.turn.status,
        treatmentTurnStatus: treatment.turn.status,
        controlCredits: control.cost.normalizedCredits,
        treatmentCredits: treatment.cost.normalizedCredits,
        controlDurationMs: control.durationMs,
        treatmentDurationMs: treatment.durationMs,
        contextKey: metaContext.key,
        contextKeys: metaContext.fallbackKeys,
        taskKind: metaContext.taskKind,
        riskTier: metaContext.riskTier,
        verifierTier: metaContext.verifierTier,
        scopeTier: metaContext.scopeTier,
        verifierStrength: metaContext.verifierStrength,
        routeSignature: metaContext.routeSignature,
        controlModelId: control.policy.modelId,
        controlEffort: control.policy.effort,
        controlSpeedId: control.policy.speedId,
        controlServiceTier: control.policy.serviceTier,
        controlProofTier: control.policy.proofTier,
        treatmentModelId: treatment.policy.modelId,
        treatmentEffort: treatment.policy.effort,
        treatmentSpeedId: treatment.policy.speedId,
        treatmentServiceTier: treatment.policy.serviceTier,
        treatmentProofTier: treatment.policy.proofTier,
        controlRouteCompliant: control.turn.reroutes.length === 0,
        treatmentRouteCompliant: treatment.turn.reroutes.length === 0,
        originalStateUnchanged,
        appliedWinner,
        postApplyVerified: postApplyVerification?.passed ?? null,
        certificatePath,
      }, experimentId));
      for (const telemetryResult of await Promise.allSettled(telemetryWrites)) {
        if (telemetryResult.status === "rejected") {
          addTwinBookkeepingWarning(result, logger, "A Twin telemetry event could not be persisted.", telemetryResult.reason);
        }
      }
      if (result.bookkeepingWarnings !== undefined) {
        const withWarnings = { ...artifactResult, bookkeepingWarnings: result.bookkeepingWarnings };
        await this.#writeArtifacts(withWarnings, this.#config).catch((error: unknown) => {
          addTwinBookkeepingWarning(result, logger, "Twin artifacts could not be updated with bookkeeping warnings.", error);
        });
      }
      return result;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      clearTimeout(maximumTimer);
      unlinkParentAbort();
      const cleanupErrors: unknown[] = [];
      if (appServer !== null) {
        const server = appServer;
        const threadIds = [...new Set([controlThreadId, treatmentThreadId].filter((id): id is string => id !== null))];
        const deletions = await Promise.allSettled(threadIds.map((threadId) => server.deleteThread(threadId)));
        cleanupErrors.push(...deletions
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason as unknown));
        try {
          await server.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await worktrees.cleanup(experimentSucceeded);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0 && applicationCommitted && returnedResult !== undefined) {
        for (const error of cleanupErrors) {
          addTwinBookkeepingWarning(
            returnedResult,
            logger,
            "Post-commit Twin cleanup failed; the applied result remains authoritative.",
            error,
          );
        }
        const { certificatePath: _certificatePath, ...artifactWithCleanupWarnings } = returnedResult;
        await this.#writeArtifacts(artifactWithCleanupWarnings, this.#config).catch((error: unknown) => {
          addTwinBookkeepingWarning(
            returnedResult as ExperimentResult,
            logger,
            "Twin artifacts could not be updated with post-commit cleanup warnings.",
            error,
          );
        });
      } else if (cleanupErrors.length > 0 && primaryError !== undefined) {
        logger.warn("Twin cleanup encountered errors while preserving the primary failure", {
          cleanupErrors: cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)),
        });
      } else if (cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      } else if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "Twin resource cleanup encountered multiple failures.");
      }
    }
  }
}

function addTwinBookkeepingWarning(
  result: ExperimentResult,
  logger: Logger,
  message: string,
  error: unknown,
): void {
  result.bookkeepingWarnings ??= [];
  result.bookkeepingWarnings.push(`${message} ${errorMessage(error)}`);
  logger.warn(message, { error: errorMessage(error) });
}

async function settlePairedOperation<T>(
  operation: string,
  controlPromise: Promise<T>,
  treatmentPromise: Promise<T>,
  capture?: (arm: "control" | "treatment", value: T) => void,
): Promise<readonly [T, T]> {
  const [control, treatment] = await Promise.allSettled([controlPromise, treatmentPromise]);
  if (control.status === "fulfilled") capture?.("control", control.value);
  if (treatment.status === "fulfilled") capture?.("treatment", treatment.value);

  const failures = [control, treatment]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `Both paired arms failed during ${operation}.`);
  }
  if (control.status !== "fulfilled" || treatment.status !== "fulfilled") {
    throw new SafetyError(`Paired ${operation} settled without two results.`);
  }
  return [control.value, treatment.value];
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), Math.max(1, milliseconds));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function rejectWhenAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : "Twin execution was aborted.");
  error.name = "AbortError";
  return error;
}

async function runArmWithDeadline(
  options: Omit<Parameters<typeof executeArm>[0], "signal"> & {
    parentSignal: AbortSignal;
    deadlineMs?: number;
  },
): ReturnType<typeof executeArm> {
  const scope = createLinkedAbortScope({
    parent: options.parentSignal,
    ...(options.deadlineMs === undefined ? {} : {
      timeoutMs: options.deadlineMs,
      timeoutMessage: `Counterlane arm exceeded the ${options.deadlineMs} ms hard deadline.`,
    }),
  });
  try {
    const { parentSignal: _parentSignal, deadlineMs: _deadlineMs, ...armOptions } = options;
    return await executeArm({ ...armOptions, signal: scope.signal });
  } finally {
    scope.dispose();
  }
}

function policyTelemetry(policy: ArmPolicy): JsonObject {
  return {
    kind: policy.kind,
    name: policy.name,
    modelId: policy.modelId,
    modelFamily: policy.modelFamily,
    effort: policy.effort,
    speedId: policy.speedId,
    serviceTier: policy.serviceTier,
    speedCostMultiplier: policy.speedCostMultiplier,
    speedLatencyMultiplier: policy.speedLatencyMultiplier,
    topology: policy.topology,
    proofTier: policy.proofTier,
  };
}

function armObservation(arm: ExperimentResult["control"]): JsonObject {
  return routeObservationPayload({
    modelId: arm.policy.modelId,
    effort: arm.policy.effort,
    speedId: arm.policy.speedId,
    topology: arm.policy.topology,
    proofTier: arm.policy.proofTier,
    ...(arm.policy.routeDecision === undefined ? {} : {
      context: routeCalibrationContext(arm.policy.routeDecision.features, arm.policy.routeDecision.repo),
    }),
    outcome: arm.outcome,
    successful: arm.successful,
    durationMs: arm.durationMs,
    turnDurationMs: arm.turn.durationMs,
    verificationDurationMs: arm.verification.durationMs,
    normalizedCredits: arm.cost.normalizedCredits,
  });
}

function policyLabel(policy: ArmPolicy): string {
  return `${policy.modelFamily}/${policy.effort}/${policy.speedId}/${policy.proofTier}`;
}

function forwardAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (parent === undefined) return () => undefined;
  const onAbort = (): void => child.abort(parent.reason);
  if (parent.aborted) child.abort(parent.reason);
  else parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}
