import type { CounterlaneConfig, VerificationCommandConfig } from "../config/types.js";
import { runCommand } from "../core/process.js";
import type { ProofTier, VerificationCheck, VerificationReport } from "../core/types.js";
import { sha256, stableStringify } from "../core/utils.js";
import type { Logger } from "../core/logger.js";
import {
  commandMinimumTier,
  commandsForProofTier,
  inspectVerificationCapabilities,
  resolveVerificationCommands,
} from "./detect.js";

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
  ): Promise<VerificationReport> {
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
    const requiredPassed = required.filter((check) => check.passed).length;
    const optionalPassed = optional.filter((check) => check.passed).length;
    const hasVerifier = checks.length > 0;
    const passed =
      adequate &&
      signal?.aborted !== true &&
      hasVerifier &&
      (!this.#config.verification.requireAtLeastOne || hasVerifier) &&
      (!this.#config.verification.failOnNoVerifier || hasVerifier) &&
      requiredPassed === required.length;
    const score = checks.length === 0
      ? 0
      : (requiredPassed * 2 + optionalPassed) / Math.max(1, required.length * 2 + optional.length);
    const completedAtMs = Date.now();

    return {
      proofTier,
      adequate,
      minimumIndependentChecks,
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
          commands: commands.map((command) => ({
            name: command.name,
            command: command.command,
            required: command.required,
            minimumTier: commandMinimumTier(command),
            timeoutMs: command.timeoutMs ?? this.#config.verification.defaultTimeoutMs,
            environment: command.environment ?? {},
          })),
        }),
      ),
    };
  }

  async #runCheck(
    cwd: string,
    check: VerificationCommandConfig,
    signal?: AbortSignal,
  ): Promise<VerificationCheck> {
    this.#logger.info("Running verifier", {
      name: check.name,
      minimumTier: commandMinimumTier(check),
    });
    const result = await runCommand(check.command, {
      cwd,
      timeoutMs: check.timeoutMs ?? this.#config.verification.defaultTimeoutMs,
      maximumOutputBytes: this.#config.verification.maximumOutputBytes,
      environment: {
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
      minimumTier: commandMinimumTier(check),
      passed,
      result,
    };
  }
}
