import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { CounterlaneConfig } from "../config/types.js";
import { managedStatePrefixes } from "../config/managed-state.js";
import type { Logger } from "../core/logger.js";
import type {
  ArmPolicy,
  ExecutionEnvelope,
  RouteConstraints,
  RouteDecision,
  SingleRunResult,
  VerificationPlan,
  VerificationReport,
} from "../core/types.js";
import { newId, sha256, writeJsonAtomic, writeUtf8Atomic } from "../core/utils.js";
import { errorMessage, MetaPlanInvalidatedError, SafetyError } from "../core/errors.js";
import { createLinkedAbortScope, throwIfAborted } from "../core/abort.js";
import { CodexAppServer } from "../codex/app-server.js";
import { GitRepository } from "../git/repository.js";
import { captureSnapshot, currentContentHash, currentWorkingStateHash } from "../git/snapshot.js";
import { WorktreeManager } from "../git/worktree.js";
import { buildCalibrationIndex, routeCalibrationContext, routeObservationPayload } from "../routing/calibration.js";
import { deriveQuotaState } from "../routing/quota.js";
import { AutoRouter, requireAdmissibleRoute } from "../routing/router.js";
import { TelemetryStore } from "../telemetry/store.js";
import { inspectVerificationCapabilities } from "../verification/detect.js";
import { BlindVerifier } from "../verification/verifier.js";
import { executeArm } from "./arm.js";
import { revalidateControlPolicy, revalidateTreatmentPolicy } from "./policy.js";
import { metaEvidenceHash, parsePairedObservations } from "../meta/evidence.js";
import { ensureContainedDirectory, resolveContainedPath } from "../core/path-safety.js";
import { validateThreadProvenance } from "../core/thread-provenance.js";
import { normalizeUserPrompt } from "./prompt.js";
import { assertExecutionEnvelopeCurrent } from "./envelope.js";

export class SingleRunner {
  readonly #repository: GitRepository;
  readonly #config: CounterlaneConfig;
  readonly #logger: Logger;
  readonly #telemetry: TelemetryStore;

  public constructor(options: { repository: GitRepository; config: CounterlaneConfig; logger: Logger; telemetry: TelemetryStore }) {
    this.#repository = options.repository;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#telemetry = options.telemetry;
  }

  public async run(options: {
    prompt: string;
    mode: "static" | "auto";
    apply?: boolean;
    parentThreadId?: string;
    lastTurnId?: string;
    policyOverride?: ArmPolicy;
    constraints?: RouteConstraints;
    signal?: AbortSignal;
    expectedRepositoryProfileHash?: string;
    expectedMetaEvidenceHash?: string;
    verificationPlan?: VerificationPlan;
    expectedExecutionEnvelope?: ExecutionEnvelope;
    frozenRouteDecision?: RouteDecision;
    beforeTurnStart?: () => Promise<void>;
  }): Promise<SingleRunResult> {
    validateThreadProvenance({
      ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
      ...(options.lastTurnId === undefined ? {} : { lastTurnId: options.lastTurnId }),
    });
    const prompt = normalizeUserPrompt(options.prompt);
    const runId = newId("run");
    const startedAtMs = Date.now();
    const startedAtClock = performance.now();
    const executionScope = createLinkedAbortScope({
      ...(options.signal === undefined ? {} : { parent: options.signal }),
      ...(options.constraints?.deadlineMs === undefined ? {} : {
        timeoutMs: options.constraints.deadlineMs,
        timeoutMessage: `Counterlane run exceeded the ${options.constraints.deadlineMs} ms hard deadline.`,
      }),
    });
    const worktrees = new WorktreeManager(this.#repository, this.#config, runId);
    const managedPrefixes = managedStatePrefixes(this.#config);
    let appServer: CodexAppServer | null = null;
    let threadId: string | null = null;
    let succeeded = false;
    let returnedResult: SingleRunResult | undefined;
    const timing = {
      isolationAndMaterializationMs: 0,
      discoveryMs: 0,
      routingAndPolicyMs: 0,
      delegationSetupMs: 0,
      modelMs: 0,
      verifierMs: 0,
      attemptLocalOverheadMs: 0,
      cleanupAndReconciliationMs: 0,
    };

    try {
      throwIfAborted(executionScope.signal);
      const isolationStartedAtClock = performance.now();
      const dataDirectory = await ensureContainedDirectory(
        this.#repository.root,
        resolveContainedPath(this.#repository.root, this.#config.dataDirectory, {
          target: "Counterlane data directory",
          boundary: "repository",
        }),
        { target: "Counterlane data directory", boundary: "repository" },
      );
      const snapshot = await captureSnapshot(this.#repository, managedPrefixes);
      throwIfAborted(executionScope.signal);
      const profile = await this.#repository.profile(managedPrefixes);
      if (options.expectedRepositoryProfileHash !== undefined && profile.profileHash !== options.expectedRepositoryProfileHash) {
        throw new MetaPlanInvalidatedError("Repository profile changed after the meta decision.", {
          expected: options.expectedRepositoryProfileHash,
          actual: profile.profileHash,
        });
      }
      throwIfAborted(executionScope.signal);
      const worktree = await worktrees.create(newId("blind"), snapshot);
      timing.isolationAndMaterializationMs = elapsedMs(isolationStartedAtClock);
      throwIfAborted(executionScope.signal);
      const discoveryStartedAtClock = performance.now();
      appServer = await CodexAppServer.connect({
        config: this.#config,
        cwd: this.#repository.root,
        logger: this.#logger,
        signal: executionScope.signal,
      });
      throwIfAborted(executionScope.signal);
      const [catalog, rateLimits, events, verificationCapabilities] = await Promise.all([
        appServer.listModels(executionScope.signal),
        appServer.readRateLimits(executionScope.signal),
        this.#telemetry.readLearningEvents(),
        inspectVerificationCapabilities(worktree.path, this.#config),
      ]);
      timing.discoveryMs = elapsedMs(discoveryStartedAtClock);
      throwIfAborted(executionScope.signal);
      const routingStartedAtClock = performance.now();
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
      const quota = deriveQuotaState(rateLimits, this.#config.routing.reservePercent);
      const router = new AutoRouter(this.#config);
      if (options.expectedExecutionEnvelope !== undefined) {
        if (options.frozenRouteDecision === undefined || options.verificationPlan === undefined) {
          throw new SafetyError("A frozen execution envelope requires both the frozen route decision and verifier plan.");
        }
        const frozenCurrentDecision = router.decide({
          prompt,
          repo: profile,
          catalog,
          quota,
          verificationCapabilities,
          // Product execution keeps learning disabled; this must match its
          // no-spend preflight rather than inherited historical telemetry.
          calibration: buildCalibrationIndex([]),
          constraints: options.frozenRouteDecision.constraints,
        });
        assertExecutionEnvelopeCurrent({
          expected: options.expectedExecutionEnvelope,
          repo: profile,
          catalog,
          quota,
          decision: frozenCurrentDecision,
          verificationPlan: options.verificationPlan,
        });
      }
      const staticRoute = router.staticPolicy(catalog, verificationCapabilities);
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
      const autoRoute = options.policyOverride === undefined && options.mode === "auto"
        ? router.decide({
            prompt,
            repo: profile,
            catalog,
            quota,
            verificationCapabilities,
            calibration,
            ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
          })
        : undefined;
      const policyOverride = options.policyOverride === undefined
        ? undefined
        : options.policyOverride.kind === "control"
          ? revalidateControlPolicy({
              policy: options.policyOverride,
              prompt,
              config: this.#config,
              catalog,
              quota,
              repo: profile,
              verificationCapabilities,
              calibration,
            })
          : revalidateTreatmentPolicy({
              policy: options.policyOverride,
              prompt,
              config: this.#config,
              catalog,
              quota,
              repo: profile,
              verificationCapabilities,
              calibration,
              ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
            });
      const policy: ArmPolicy = policyOverride ?? (options.mode === "auto"
        ? autoPolicy(requireAdmissibleRoute(requireAutoRoute(autoRoute)))
        : revalidateControlPolicy({
            policy: configuredControlPolicy,
            prompt,
            config: this.#config,
            catalog,
            quota,
            repo: profile,
            verificationCapabilities,
              calibration,
          }));
      timing.routingAndPolicyMs = elapsedMs(routingStartedAtClock);

      const delegationStartedAtClock = performance.now();
      if (options.parentThreadId !== undefined) {
        await appServer.resumeThread(options.parentThreadId);
        throwIfAborted(executionScope.signal);
        threadId = await appServer.forkThread({
          threadId: options.parentThreadId,
          ...(options.lastTurnId === undefined ? {} : { lastTurnId: options.lastTurnId }),
          cwd: worktree.path,
          modelId: policy.modelId,
          serviceTier: policy.serviceTier,
        });
      } else {
        threadId = await appServer.startThread({
          cwd: worktree.path,
          modelId: policy.modelId,
          serviceTier: policy.serviceTier,
        });
      }
      timing.delegationSetupMs = elapsedMs(delegationStartedAtClock);
      throwIfAborted(executionScope.signal);
      const arm = await executeArm({
        experimentId: runId,
        policy,
        worktree,
        threadId,
        prompt,
        appServer,
        worktrees,
        config: this.#config,
        logger: this.#logger,
        ...(options.verificationPlan === undefined ? {} : { verificationPlan: options.verificationPlan }),
        ...(options.beforeTurnStart === undefined ? {} : { beforeTurnStart: options.beforeTurnStart }),
        signal: executionScope.signal,
      });
      timing.modelMs = arm.turn.durationMs;
      timing.verifierMs = arm.verification.durationMs;
      timing.attemptLocalOverheadMs = Math.max(0, arm.durationMs - timing.modelMs - timing.verifierMs);
      await worktrees.assertExperimentControlState([worktree]);
      const currentHash = await currentWorkingStateHash(this.#repository, managedPrefixes);
      const originalStateUnchanged = currentHash === snapshot.manifest.workingStateHash;
      if (!originalStateUnchanged) {
        throw new SafetyError("Original repository changed during isolated execution; refusing to certify or apply the result.");
      }
      succeeded = arm.successful;
      let applied = false;
      let postApplyVerification: VerificationReport | undefined;
      const artifactDirectory = await ensureContainedDirectory(
        dataDirectory,
        resolve(dataDirectory, "runs", runId),
        { target: "run artifact directory", boundary: "configured data directory" },
      );
      await writeUtf8Atomic(join(artifactDirectory, "result.patch"), arm.patch);
      let completedAtMs = Date.now();
      let result: SingleRunResult = {
        runId,
        mode: options.mode,
        promptHash: sha256(prompt),
        repositoryRoot: this.#repository.root,
        snapshot: snapshot.manifest,
        arm,
        originalStateUnchanged,
        applied: false,
        artifactDirectory,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
        timing,
        accountingBoundary: {
          scope: options.parentThreadId === undefined ? "root-pre-turn" : "nested-mcp",
          parentOrCallerUsage: options.parentThreadId === undefined ? "not-applicable" : "unknown-and-excluded",
        },
      };
      // Persist a truthful non-applied result before crossing the original
      // checkout mutation boundary. If the durable applied result cannot be
      // committed later, rollback leaves this preliminary artifact accurate.
      await writeJsonAtomic(join(artifactDirectory, "result.json"), result as unknown as object);

      if (options.apply === true && arm.successful) {
        succeeded = false;
        const originalContentHash = await currentContentHash(this.#repository, managedPrefixes);
        await worktrees.applyPatchToOriginal(arm.patch, async () => {
          const [candidateContent, appliedContent] = await Promise.all([
            currentContentHash(this.#repository, managedPrefixes, worktree.path),
            currentContentHash(this.#repository, managedPrefixes),
          ]);
          if (candidateContent !== appliedContent) {
            throw new SafetyError("Applied checkout content does not match the certified candidate.", {
              candidateContent,
              appliedContent,
            });
          }
          return worktrees.verifyOriginalWithoutMutation(async () => {
            postApplyVerification = await new BlindVerifier(
              this.#config,
              this.#logger.child({ component: "post-apply-verifier" }),
            ).verify(this.#repository.root, arm.policy.proofTier, executionScope.signal);
            return postApplyVerification.passed;
          });
        });
        applied = true;
        completedAtMs = Date.now();
        result = {
          ...result,
          applied: true,
          ...(postApplyVerification === undefined ? {} : { postApplyVerification }),
          completedAt: new Date(completedAtMs).toISOString(),
          durationMs: completedAtMs - startedAtMs,
        };
        try {
          await writeJsonAtomic(join(artifactDirectory, "result.json"), result as unknown as object);
        } catch (artifactError) {
          try {
            await worktrees.rollbackPatchFromOriginal(
              arm.patch,
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
            throw new SafetyError("The applied patch artifact failed to commit and exact rollback also failed; recovery state was preserved.", {
              artifactError: errorMessage(artifactError),
              rollbackError: errorMessage(rollbackError),
            });
          }
          throw new SafetyError("The applied patch was rolled back because its durable result artifact could not be committed.", {
            artifactError: errorMessage(artifactError),
          });
        }
        succeeded = true;
      }

      returnedResult = result;
      const telemetryWrites: Array<Promise<unknown>> = [];
      if (arm.turn.reroutes.length === 0) {
        telemetryWrites.push(this.#telemetry.append("route.observed", routeObservationPayload({
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
        }), runId));
      }
      telemetryWrites.push(this.#telemetry.append("run.completed", {
          mode: options.mode,
          successful: arm.successful,
          outcome: arm.outcome,
          turnStatus: arm.turn.status,
          modelId: arm.policy.modelId,
          effort: arm.policy.effort,
          speedId: arm.policy.speedId,
          serviceTier: arm.policy.serviceTier,
          topology: arm.policy.topology,
          proofTier: arm.policy.proofTier,
          proofAdequate: arm.verification.adequate,
          normalizedCredits: arm.cost.normalizedCredits,
          durationMs: arm.durationMs,
          applied,
          postApplyVerified: postApplyVerification?.passed ?? null,
          routeCompliant: arm.turn.reroutes.length === 0,
          backendReroutes: arm.turn.reroutes.map((reroute) => ({
            fromModel: reroute.fromModel,
            toModel: reroute.toModel,
            ...(reroute.reason === undefined ? {} : { reason: reroute.reason }),
          })),
        }, runId));
      const telemetryResults = await Promise.allSettled(telemetryWrites);
      for (const telemetryResult of telemetryResults) {
        if (telemetryResult.status === "rejected") {
          addSingleBookkeepingWarning(result, this.#logger, "A run telemetry event could not be persisted.", telemetryResult.reason);
        }
      }
      if (result.bookkeepingWarnings !== undefined) {
        await writeJsonAtomic(join(artifactDirectory, "result.json"), result as unknown as object).catch((error: unknown) => {
          addSingleBookkeepingWarning(result, this.#logger, "The run artifact could not be updated with bookkeeping warnings.", error);
        });
      }
      return result;
    } finally {
      const cleanupStartedAtClock = performance.now();
      executionScope.dispose();
      const cleanupErrors: unknown[] = [];
      if (appServer !== null) {
        if (threadId !== null) {
          await appServer.deleteThread(threadId).catch((error: unknown) => cleanupErrors.push(error));
        }
        await appServer.close().catch((error: unknown) => cleanupErrors.push(error));
      }
      await worktrees.cleanup(succeeded).catch((error: unknown) => cleanupErrors.push(error));
      timing.cleanupAndReconciliationMs = elapsedMs(cleanupStartedAtClock);
      if (returnedResult !== undefined) {
        returnedResult.completedAt = new Date().toISOString();
        returnedResult.durationMs = elapsedMs(startedAtClock);
        if (cleanupErrors.length > 0) {
          for (const error of cleanupErrors) {
            addSingleBookkeepingWarning(returnedResult, this.#logger, "Post-run resource cleanup failed; the durable result remains authoritative.", error);
          }
        }
        await writeJsonAtomic(
          join(returnedResult.artifactDirectory, "result.json"),
          returnedResult as unknown as object,
        ).catch((error: unknown) => {
          addSingleBookkeepingWarning(
            returnedResult as SingleRunResult,
            this.#logger,
            "The run artifact could not be updated with final timing or cleanup warnings.",
            error,
          );
        });
      } else if (cleanupErrors.length > 0) {
        // A non-applying run has already persisted a durable artifact too.  Do
        // not turn a successful, isolated MCP result into an error merely
        // because best-effort resource disposal failed afterwards.
        if (cleanupErrors.length === 1) {
          throw cleanupErrors[0];
        } else {
          throw new AggregateError(cleanupErrors, "Multiple SingleRunner cleanup operations failed.");
        }
      }
    }
  }
}

function elapsedMs(startedAtClock: number): number {
  return Math.max(0, Math.round(performance.now() - startedAtClock));
}

function addSingleBookkeepingWarning(
  result: SingleRunResult,
  logger: Logger,
  message: string,
  error: unknown,
): void {
  const warning = `${message} ${errorMessage(error)}`;
  result.bookkeepingWarnings ??= [];
  result.bookkeepingWarnings.push(warning);
  logger.warn(message, { error: errorMessage(error) });
}

function requireAutoRoute<T>(route: T | undefined): T {
  if (route === undefined) throw new Error("Auto route was not computed.");
  return route;
}

function autoPolicy(route: NonNullable<ReturnType<AutoRouter["decide"]>>): ArmPolicy {
  return {
    kind: "treatment",
    name: "counterlane-auto",
    modelId: route.selected.modelId,
    modelFamily: route.selected.modelFamily,
    effort: route.selected.effort,
    serviceTier: route.selected.serviceTier,
    speedId: route.selected.speedId,
    speedCostMultiplier: route.selected.speedCostMultiplier,
    speedLatencyMultiplier: route.selected.speedLatencyMultiplier,
    topology: route.selected.topology,
    proofTier: route.selected.proofTier,
    routeDecision: route,
  };
}
