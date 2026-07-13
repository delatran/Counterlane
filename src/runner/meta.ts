import { join, resolve } from "node:path";
import type { CounterlaneConfig } from "../config/types.js";
import type { Logger } from "../core/logger.js";
import type { MetaExecutionResult, RouteConstraints } from "../core/types.js";
import { newId, writeJsonAtomic } from "../core/utils.js";
import { GitRepository } from "../git/repository.js";
import { prepareMetaPlan } from "../meta/planner.js";
import { TelemetryStore } from "../telemetry/store.js";
import { errorMessage, MetaPlanInvalidatedError } from "../core/errors.js";
import { ensureContainedDirectory, resolveContainedPath } from "../core/path-safety.js";
import { validateThreadProvenance } from "../core/thread-provenance.js";
import { SingleRunner } from "./single.js";
import { TwinRunner } from "./twin.js";
import { normalizeUserPrompt } from "./prompt.js";

export class MetaExecutionRunner {
  readonly #repository: GitRepository;
  readonly #config: CounterlaneConfig;
  readonly #logger: Logger;
  readonly #telemetry: TelemetryStore;

  public constructor(options: {
    repository: GitRepository;
    config: CounterlaneConfig;
    logger: Logger;
    telemetry: TelemetryStore;
  }) {
    this.#repository = options.repository;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#telemetry = options.telemetry;
  }

  public async plan(prompt: string, constraints?: RouteConstraints, signal?: AbortSignal): ReturnType<typeof prepareMetaPlan> {
    const normalizedPrompt = normalizeUserPrompt(prompt);
    return prepareMetaPlan({
      prompt: normalizedPrompt,
      ...(constraints === undefined ? {} : { constraints }),
      repository: this.#repository,
      config: this.#config,
      telemetry: this.#telemetry,
      logger: this.#logger,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  public async run(options: {
    prompt: string;
    apply?: boolean;
    parentThreadId?: string;
    lastTurnId?: string;
    constraints?: RouteConstraints;
    signal?: AbortSignal;
  }): Promise<MetaExecutionResult> {
    validateThreadProvenance({
      ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
      ...(options.lastTurnId === undefined ? {} : { lastTurnId: options.lastTurnId }),
    });
    const prompt = normalizeUserPrompt(options.prompt);
    const startedAtMs = Date.now();
    const decisionId = newId("decision");
    const dataDirectory = await ensureContainedDirectory(
      this.#repository.root,
      resolveContainedPath(this.#repository.root, this.#config.dataDirectory, {
        target: "Counterlane data directory",
        boundary: "repository",
      }),
      { target: "Counterlane data directory", boundary: "repository" },
    );
    const plan = await this.plan(prompt, options.constraints, options.signal);
    let decision = plan.decision;
    const artifactDirectory = await ensureContainedDirectory(
      dataDirectory,
      resolve(dataDirectory, "decisions", decisionId),
      { target: "decision artifact directory", boundary: "configured data directory" },
    );
    const artifactPath = join(artifactDirectory, "decision.json");
    await writeJsonAtomic(artifactPath, {
      schemaVersion: 1,
      status: "pending",
      decisionId,
      decision,
      execution: "none",
      artifactPath,
      startedAt: new Date(startedAtMs).toISOString(),
    });
    await this.#telemetry.append("meta.decided", {
      action: plan.decision.action,
      contextKey: plan.context.key,
      evidenceKey: plan.decision.posterior.evidenceKey,
      pairedSamples: plan.decision.posterior.sampleCount,
      upliftMean: plan.decision.posterior.mean,
      upliftLowerBound: plan.decision.posterior.lowerBound,
      upliftUpperBound: plan.decision.posterior.upperBound,
      expectedInformationValue: plan.decision.expectedInformationValue,
      estimatedTwinCost: plan.decision.estimatedTwinCost,
    }, decisionId);

    let execution: MetaExecutionResult["execution"] = "none";
    let single: MetaExecutionResult["single"];
    let twin: MetaExecutionResult["twin"];

    try {
      switch (decision.action) {
      case "static":
        execution = "single";
        single = await new SingleRunner(this.#runnerOptions()).run({
          prompt,
          mode: "static",
          ...(options.apply === undefined ? {} : { apply: options.apply }),
          policyOverride: plan.controlPolicy,
          expectedRepositoryProfileHash: plan.repo.profileHash,
          expectedMetaEvidenceHash: plan.evidenceHash,
          ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
          ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
          ...(options.lastTurnId === undefined ? {} : { lastTurnId: options.lastTurnId }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        break;
      case "auto":
        execution = "single";
        single = await new SingleRunner(this.#runnerOptions()).run({
          prompt,
          mode: "auto",
          ...(options.apply === undefined ? {} : { apply: options.apply }),
          policyOverride: plan.treatmentPolicy,
          expectedRepositoryProfileHash: plan.repo.profileHash,
          expectedMetaEvidenceHash: plan.evidenceHash,
          ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
          ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
          ...(options.lastTurnId === undefined ? {} : { lastTurnId: options.lastTurnId }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        break;
      case "twin":
        execution = "twin";
        twin = await new TwinRunner(this.#runnerOptions()).run({
          prompt,
          ...(options.apply === undefined ? {} : { applyWinner: options.apply }),
          controlPolicyOverride: plan.controlPolicy,
          treatmentPolicyOverride: plan.treatmentPolicy,
          expectedRepositoryProfileHash: plan.repo.profileHash,
          expectedMetaEvidenceHash: plan.evidenceHash,
          expectedMetaContextKey: plan.context.key,
          requireMetaTwinQuota: true,
          ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
          ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
          ...(options.lastTurnId === undefined ? {} : { lastTurnId: options.lastTurnId }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        break;
      case "abstain":
        this.#logger.warn("Meta-controller abstained from unattended execution", {
          decisionId,
          context: plan.context.key,
          reasons: plan.decision.reasons,
        });
        break;
      }
    } catch (error) {
      if (!(error instanceof MetaPlanInvalidatedError)) throw error;
      const refreshed = await this.plan(prompt, options.constraints, options.signal);
      let effectiveAction = refreshed.decision.action;
      if (effectiveAction === "twin") {
        effectiveAction = refreshed.staticAdmissible ? "static" : "auto";
      }
      decision = {
        ...refreshed.decision,
        action: effectiveAction,
        reasons: [
          ...refreshed.decision.reasons,
          `execution-time revalidation replaced ${plan.decision.action} after drift: ${error.message}`,
        ],
        decidedAt: new Date().toISOString(),
      };
      twin = undefined;
      await this.#telemetry.append("meta.revalidated", {
        plannedAction: plan.decision.action,
        effectiveAction,
        reason: error.message,
      }, decisionId);
      if (effectiveAction === "abstain") {
        execution = "none";
        single = undefined;
      } else {
        const mode = effectiveAction === "auto" ? "auto" : "static";
        execution = "single";
        single = await new SingleRunner(this.#runnerOptions()).run({
          prompt,
          mode,
          ...(options.apply === undefined ? {} : { apply: options.apply }),
          policyOverride: mode === "auto" ? refreshed.treatmentPolicy : refreshed.controlPolicy,
          expectedRepositoryProfileHash: refreshed.repo.profileHash,
          expectedMetaEvidenceHash: refreshed.evidenceHash,
          ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
          ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
          ...(options.lastTurnId === undefined ? {} : { lastTurnId: options.lastTurnId }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }
    }

    const completedAtMs = Date.now();
    const result: MetaExecutionResult = {
      decisionId,
      decision,
      execution,
      ...(single === undefined ? {} : { single }),
      ...(twin === undefined ? {} : { twin }),
      artifactPath,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
    };
    const nestedApplied = single?.applied === true || twin?.appliedWinner === true;
    const bookkeepingWarnings: string[] = [];
    try {
      await writeJsonAtomic(artifactPath, result as unknown as object);
    } catch (error) {
      if (!nestedApplied) throw error;
      recordBookkeepingWarning(
        bookkeepingWarnings,
        this.#logger,
        "The nested result applied successfully, but the outer decision artifact could not be finalized; the nested run artifact is authoritative.",
        error,
      );
    }
    const selectedTwinArm = twin?.winner.winner === "control"
      ? twin.control
      : twin?.winner.winner === "treatment"
        ? twin.treatment
        : undefined;
    try {
      await this.#telemetry.append("meta.completed", {
        action: decision.action,
        execution,
        successful: single?.arm.successful ?? selectedTwinArm?.successful ?? false,
        outcome: single?.arm.outcome ?? selectedTwinArm?.outcome ?? (decision.action === "abstain" ? "abstained" : "inconclusive"),
        ...(twin === undefined ? {} : {
          twinWinner: twin.winner.winner,
          controlOutcome: twin.control.outcome,
          treatmentOutcome: twin.treatment.outcome,
        }),
        artifactPath,
      }, decisionId);
    } catch (error) {
      recordBookkeepingWarning(
        bookkeepingWarnings,
        this.#logger,
        "The meta completion telemetry event could not be persisted.",
        error,
      );
    }
    if (bookkeepingWarnings.length > 0) {
      result.bookkeepingWarnings = [...bookkeepingWarnings];
      await writeJsonAtomic(artifactPath, result as unknown as object).catch((error: unknown) => {
        recordBookkeepingWarning(
          bookkeepingWarnings,
          this.#logger,
          "The decision artifact could not be updated with bookkeeping warnings.",
          error,
        );
        result.bookkeepingWarnings = [...bookkeepingWarnings];
      });
    }
    return result;
  }

  #runnerOptions(): {
    repository: GitRepository;
    config: CounterlaneConfig;
    logger: Logger;
    telemetry: TelemetryStore;
  } {
    return {
      repository: this.#repository,
      config: this.#config,
      logger: this.#logger,
      telemetry: this.#telemetry,
    };
  }
}

function recordBookkeepingWarning(
  warnings: string[],
  logger: Logger,
  message: string,
  error: unknown,
): void {
  const warning = `${message} ${errorMessage(error)}`;
  warnings.push(warning);
  logger.warn(message, { error: errorMessage(error) });
}
