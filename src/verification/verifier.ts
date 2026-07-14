import type { CounterlaneConfig, VerificationCommandConfig } from "../config/types.js";
import { runCommand } from "../core/process.js";
import type { ProofTier, VerificationCheck, VerificationPlan, VerificationReport } from "../core/types.js";
import { sha256, stableStringify } from "../core/utils.js";
import type { Logger } from "../core/logger.js";
import {
  commandMinimumTier,
  commandsForProofTier,
  inspectVerificationCapabilities,
  resolveVerificationCommands,
} from "./detect.js";
import { minimalVerifierEnvironment, verifyFrozenPlanIntegrity } from "./plan.js";

export class BlindVerifier {
  readonly #config: CounterlaneConfig;
  readonly #logger: Logger;

  public constructor(config: CounterlaneConfig, logger: Logger) {
    this.#config = config;
    this.#logger = logger;
  }

  public async verify(
    cwd: string,
    proofTier: ProofTier = this.#config.verification.routing.defaultTier,
    signal?: AbortSignal,
    plan?: VerificationPlan,
  ): Promise<VerificationReport> {
    if (plan !== undefined) return this.#verifyFrozen(cwd, proofTier, plan, signal);
    const startedAtMs = Date.now();
    const allCommands = await resolveVerificationCommands(cwd, this.#config);
    const capabilities = await inspectVerificationCapabilities(cwd, this.#config);
    const commands = commandsForProofTier(allCommands, proofTier);
    const minimumIndependentChecks = this.#config.verification.routing.minimumIndependentChecks[proofTier];
    // A policy may allow an isolated run to proceed without a verifier, but
    // zero executed checks are never independent proof and must not become a
    // vacuous verified success.
    const adequate = commands.length > 0 && capabilities.availableTiers.includes(proofTier);
    const checks: VerificationCheck[] = [];

    for (const command of commands) {
      if (signal?.aborted === true) {
        break;
      }
      checks.push(await this.#runCheck(cwd, command, signal));
    }

    const required = checks.filter((check) => check.required);
    const optional = checks.filter((check) => !check.required);
    const taskSpecific = checks.filter((check) => check.taskSpecific);
    const requiredPassed = required.filter((check) => check.passed).length;
    const optionalPassed = optional.filter((check) => check.passed).length;
    const taskSpecificPassed = taskSpecific.filter((check) => check.passed).length;
    const hasVerifier = checks.length > 0;
    const passed =
      adequate &&
      signal?.aborted !== true &&
      hasVerifier &&
      (!this.#config.verification.requireAtLeastOne || hasVerifier) &&
      (!this.#config.verification.failOnNoVerifier || hasVerifier) &&
      (!this.#config.verification.requireTaskSpecificCheck || (
        taskSpecific.length > 0 && taskSpecificPassed === taskSpecific.length
      )) &&
      requiredPassed === required.length;
    const score = checks.length === 0
      ? 0
      : (requiredPassed * 2 + optionalPassed) / Math.max(1, required.length * 2 + optional.length);
    const completedAtMs = Date.now();

    return {
      proofTier,
      adequate,
      minimumIndependentChecks,
      taskSpecificRequired: this.#config.verification.requireTaskSpecificCheck,
      taskSpecificPassed,
      taskSpecificTotal: taskSpecific.length,
      passed,
      score,
      requiredPassed,
      requiredTotal: required.length,
      optionalPassed,
      optionalTotal: optional.length,
      checks,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      verifierHash: sha256(
        stableStringify({
          proofTier,
          adequate,
          minimumIndependentChecks,
          requireTaskSpecificCheck: this.#config.verification.requireTaskSpecificCheck,
          commands: commands.map((command) => ({
            name: command.name,
            command: command.command,
            required: command.required,
            taskSpecific: command.taskSpecific === true,
            minimumTier: commandMinimumTier(command),
            timeoutMs: command.timeoutMs ?? this.#config.verification.defaultTimeoutMs,
            environment: command.environment ?? {},
          })),
        }),
      ),
      integrity: "unavailable",
      containment: {
        filesystem: "unverified",
        network: "unverified",
        environment: "inherited",
        processLimits: "best-effort",
      },
    };
  }

  async #verifyFrozen(
    cwd: string,
    proofTier: ProofTier,
    plan: VerificationPlan,
    signal?: AbortSignal,
  ): Promise<VerificationReport> {
    if (plan.proofTier !== proofTier) {
      throw new Error(`Frozen verifier plan proof tier ${plan.proofTier} does not match requested tier ${proofTier}.`);
    }
    const startedAtMs = Date.now();
    const integrity = await verifyFrozenPlanIntegrity(cwd, plan);
    if (integrity.integrity !== "intact") {
      const completedAtMs = Date.now();
      return failedFrozenReport({
        plan,
        startedAtMs,
        completedAtMs,
        integrity: integrity.integrity,
        integrityReasons: integrity.reasons,
      });
    }
    const checks: VerificationCheck[] = [];
    for (const command of plan.commands) {
      if (signal?.aborted === true) break;
      checks.push(await this.#runCheck(
        cwd,
        {
          name: command.name,
          command: command.command,
          required: command.required,
          taskSpecific: command.taskSpecific,
          minimumTier: command.minimumTier,
          timeoutMs: command.timeoutMs,
          environment: command.environment,
        },
        signal,
        await minimalVerifierEnvironment(cwd, this.#config, command.environment, command.minimumTier),
      ));
    }
    const required = checks.filter((check) => check.required);
    const optional = checks.filter((check) => !check.required);
    const taskSpecific = checks.filter((check) => check.taskSpecific);
    const requiredPassed = required.filter((check) => check.passed).length;
    const optionalPassed = optional.filter((check) => check.passed).length;
    const taskSpecificPassed = taskSpecific.filter((check) => check.passed).length;
    const adequate = plan.adequate && plan.certifying && checks.length === plan.commands.length && signal?.aborted !== true;
    const passed = adequate &&
      requiredPassed === required.length &&
      (!plan.taskSpecificRequired || (taskSpecific.length > 0 && taskSpecificPassed === taskSpecific.length));
    const completedAtMs = Date.now();
    return {
      proofTier,
      adequate,
      minimumIndependentChecks: plan.minimumIndependentChecks,
      taskSpecificRequired: plan.taskSpecificRequired,
      taskSpecificPassed,
      taskSpecificTotal: taskSpecific.length,
      passed,
      score: checks.length === 0
        ? 0
        : (requiredPassed * 2 + optionalPassed) / Math.max(1, required.length * 2 + optional.length),
      requiredPassed,
      requiredTotal: required.length,
      optionalPassed,
      optionalTotal: optional.length,
      checks,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
      verifierHash: plan.planHash,
      planHash: plan.planHash,
      integrity: "intact",
      integrityReasons: [],
      containment: plan.containment,
      codeOwnership: plan.commands.map((command) => command.codeOwnership),
    };
  }

  async #runCheck(
    cwd: string,
    check: VerificationCommandConfig,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
  ): Promise<VerificationCheck> {
    this.#logger.info("Running verifier", {
      name: check.name,
      minimumTier: commandMinimumTier(check),
      taskSpecific: check.taskSpecific === true,
    });
    const result = await runCommand(check.command, {
      cwd,
      timeoutMs: check.timeoutMs ?? this.#config.verification.defaultTimeoutMs,
      maximumOutputBytes: this.#config.verification.maximumOutputBytes,
      environment: environment ?? {
        ...process.env,
        CI: process.env["CI"] ?? "1",
        COUNTERLANE_BLIND_VERIFIER: "1",
        COUNTERLANE_PROOF_TIER: commandMinimumTier(check),
        ...(check.environment ?? {}),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    const passed = result.exitCode === 0 && !result.timedOut && !result.aborted && signal?.aborted !== true;
    this.#logger.info("Verifier completed", {
      name: check.name,
      passed,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
    return {
      name: check.name,
      command: [...check.command],
      required: check.required,
      taskSpecific: check.taskSpecific === true,
      minimumTier: commandMinimumTier(check),
      passed,
      result,
    };
  }
}

function failedFrozenReport(options: {
  plan: VerificationPlan;
  startedAtMs: number;
  completedAtMs: number;
  integrity: "compromised" | "unavailable";
  integrityReasons: string[];
}): VerificationReport {
  const required = options.plan.commands.filter((command) => command.required);
  const taskSpecific = options.plan.commands.filter((command) => command.taskSpecific);
  return {
    proofTier: options.plan.proofTier,
    adequate: false,
    minimumIndependentChecks: options.plan.minimumIndependentChecks,
    taskSpecificRequired: options.plan.taskSpecificRequired,
    taskSpecificPassed: 0,
    taskSpecificTotal: taskSpecific.length,
    passed: false,
    score: 0,
    requiredPassed: 0,
    requiredTotal: required.length,
    optionalPassed: 0,
    optionalTotal: options.plan.commands.length - required.length,
    checks: [],
    startedAt: new Date(options.startedAtMs).toISOString(),
    completedAt: new Date(options.completedAtMs).toISOString(),
    durationMs: options.completedAtMs - options.startedAtMs,
    verifierHash: options.plan.planHash,
    planHash: options.plan.planHash,
    integrity: options.integrity,
    integrityReasons: options.integrityReasons.slice(0, 16),
    containment: options.plan.containment,
    codeOwnership: options.plan.commands.map((command) => command.codeOwnership),
  };
}
