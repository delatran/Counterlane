import { join } from "node:path";
import type { CounterlaneConfig, VerificationCommandConfig } from "../config/types.js";
import type { ProofTier, VerificationCapabilitySummary } from "../core/types.js";
import { pathExists, readUtf8Bounded, sha256, stableStringify } from "../core/utils.js";

const MAX_PACKAGE_JSON_BYTES = 2 * 1024 * 1024;

export const PROOF_TIERS: readonly ProofTier[] = ["basic", "standard", "strong", "adversarial"];

const PROOF_RANK: Readonly<Record<ProofTier, number>> = {
  basic: 0,
  standard: 1,
  strong: 2,
  adversarial: 3,
};

export function proofTierRank(tier: ProofTier): number {
  return PROOF_RANK[tier];
}

export function commandMinimumTier(command: VerificationCommandConfig): ProofTier {
  return command.minimumTier ?? "standard";
}

export function commandsForProofTier(
  commands: readonly VerificationCommandConfig[],
  tier: ProofTier,
): VerificationCommandConfig[] {
  const maximumRank = proofTierRank(tier);
  return commands.filter((command) => proofTierRank(commandMinimumTier(command)) <= maximumRank);
}

export async function resolveVerificationCommands(
  cwd: string,
  config: CounterlaneConfig,
): Promise<VerificationCommandConfig[]> {
  const commands = config.verification.commands.map(normalizeCommand);
  if (config.verification.autoDetect) {
    commands.push(...(await detectCommands(cwd)));
  }
  return deduplicate(commands);
}

export async function inspectVerificationCapabilities(
  cwd: string,
  config: CounterlaneConfig,
): Promise<VerificationCapabilitySummary> {
  const commands = await resolveVerificationCommands(cwd, config);
  const availableTiers: ProofTier[] = [];
  const commandCountByTier = emptyTierRecord(0);
  const taskSpecificCommandCountByTier = emptyTierRecord(0);
  const requiredCountByTier = emptyTierRecord(0);
  const estimatedCostWeightByTier = emptyTierRecord(0);

  for (const tier of PROOF_TIERS) {
    const selected = commandsForProofTier(commands, tier);
    const minimumChecks = config.verification.routing.minimumIndependentChecks[tier];
    commandCountByTier[tier] = selected.length;
    taskSpecificCommandCountByTier[tier] = selected.filter((command) => command.taskSpecific === true).length;
    requiredCountByTier[tier] = minimumChecks;
    estimatedCostWeightByTier[tier] = config.verification.routing.costWeights[tier];

    if (isTierAvailable(tier, selected, minimumChecks, config)) {
      availableTiers.push(tier);
    }
  }

  return {
    availableTiers,
    commandCountByTier,
    taskSpecificCommandCountByTier,
    taskSpecificRequired: config.verification.requireTaskSpecificCheck,
    requiredCountByTier,
    estimatedCostWeightByTier,
    fingerprint: sha256(stableStringify({
      commands: commands.map((command) => ({
        name: command.name,
        command: command.command,
        required: command.required,
        taskSpecific: command.taskSpecific === true,
        candidateCodePolicy: command.candidateCodePolicy ?? "undeclared",
        minimumTier: commandMinimumTier(command),
        timeoutMs: command.timeoutMs ?? config.verification.defaultTimeoutMs,
        environment: command.environment ?? {},
      })),
      routing: config.verification.routing,
      requireAtLeastOne: config.verification.requireAtLeastOne,
      failOnNoVerifier: config.verification.failOnNoVerifier,
      requireTaskSpecificCheck: config.verification.requireTaskSpecificCheck,
    })),
  };
}

function isTierAvailable(
  tier: ProofTier,
  selected: readonly VerificationCommandConfig[],
  minimumChecks: number,
  config: CounterlaneConfig,
): boolean {
  if (!config.verification.routing.enabled && tier !== config.verification.routing.defaultTier) {
    return false;
  }

  const verifierOptional = selected.length === 0 &&
    !config.verification.requireAtLeastOne &&
    !config.verification.failOnNoVerifier;
  if (selected.length < minimumChecks && !verifierOptional) {
    return false;
  }
  if (selected.length === 0) {
    return verifierOptional;
  }
  if (config.verification.requireTaskSpecificCheck && !hasTaskSpecificCoverage(tier, selected)) {
    return false;
  }
  if (!config.verification.routing.enabled) {
    return true;
  }

  // A pile of lint-only checks must not masquerade as executable validation.
  if (tier === "standard") {
    return selected.some((command) => proofTierRank(commandMinimumTier(command)) >= proofTierRank("standard"));
  }

  // Strong proof may be assembled from an executable standard check plus an
  // independent supporting check (for example unit tests + type checking). A
  // pile of lint/typecheck-only commands must not be promoted to strong proof.
  if (tier === "strong") {
    return selected.some(
      (command) => proofTierRank(commandMinimumTier(command)) >= proofTierRank("standard"),
    );
  }

  // Adversarial proof requires an explicitly classified mutation, property,
  // fuzz, or security check. Merely accumulating ordinary tests is not enough.
  if (tier === "adversarial") {
    return selected.some((command) => commandMinimumTier(command) === "adversarial");
  }

  return true;
}

function hasTaskSpecificCoverage(
  tier: ProofTier,
  selected: readonly VerificationCommandConfig[],
): boolean {
  if (tier === "adversarial") {
    return selected.some((command) =>
      command.taskSpecific === true && commandMinimumTier(command) === "adversarial"
    );
  }
  if (tier === "standard" || tier === "strong") {
    return selected.some((command) =>
      command.taskSpecific === true &&
      proofTierRank(commandMinimumTier(command)) >= proofTierRank("standard")
    );
  }
  return selected.some((command) => command.taskSpecific === true);
}

async function detectCommands(cwd: string): Promise<VerificationCommandConfig[]> {
  const commands: VerificationCommandConfig[] = [];
  const packageJsonPath = join(cwd, "package.json");
  if (await pathExists(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(
        await readUtf8Bounded(packageJsonPath, MAX_PACKAGE_JSON_BYTES, "package.json"),
      ) as unknown;
      if (typeof packageJson === "object" && packageJson !== null && !Array.isArray(packageJson)) {
        const scriptsValue = (packageJson as Record<string, unknown>)["scripts"];
        const scripts = typeof scriptsValue === "object" && scriptsValue !== null && !Array.isArray(scriptsValue)
          ? (scriptsValue as Record<string, unknown>)
          : {};

        if (typeof scripts["typecheck"] === "string") {
          commands.push(command("npm-typecheck", ["npm", "run", "typecheck"], true, "basic"));
        } else if (typeof scripts["check:types"] === "string") {
          commands.push(command("npm-check-types", ["npm", "run", "check:types"], true, "basic"));
        }
        if (typeof scripts["lint"] === "string") {
          commands.push(command("npm-lint", ["npm", "run", "lint"], false, "basic"));
        }
        if (typeof scripts["test"] === "string" && !/^echo\s+["']?Error: no test specified/iu.test(scripts["test"] as string)) {
          commands.push(command("npm-test", ["npm", "test"], true, "standard"));
        }
        addNpmScript(commands, scripts, "test:integration", "npm-test-integration", "strong");
        addNpmScript(commands, scripts, "test:e2e", "npm-test-e2e", "strong");
        addNpmScript(commands, scripts, "test:property", "npm-test-property", "adversarial");
        addNpmScript(commands, scripts, "test:mutation", "npm-test-mutation", "adversarial");
        addNpmScript(commands, scripts, "security", "npm-security", "adversarial");
      }
    } catch {
      // Invalid package.json is itself likely to be surfaced by the agent or an
      // explicit verifier. Detection stays side-effect free and conservative.
    }
  }

  if ((await pathExists(join(cwd, "pyproject.toml"))) || (await pathExists(join(cwd, "pytest.ini")))) {
    commands.push(command("pytest", ["python", "-m", "pytest", "-q"], true, "standard"));
  }
  if (await pathExists(join(cwd, "Cargo.toml"))) {
    commands.push(command("cargo-test", ["cargo", "test", "--all-targets"], true, "standard"));
  }
  if (await pathExists(join(cwd, "go.mod"))) {
    commands.push(command("go-test", ["go", "test", "./..."], true, "standard"));
  }

  return commands;
}

function addNpmScript(
  commands: VerificationCommandConfig[],
  scripts: Record<string, unknown>,
  scriptName: string,
  name: string,
  minimumTier: ProofTier,
): void {
  if (typeof scripts[scriptName] === "string") {
    commands.push(command(name, ["npm", "run", scriptName], true, minimumTier));
  }
}

function command(
  name: string,
  argv: string[],
  required: boolean,
  minimumTier: ProofTier,
): VerificationCommandConfig {
  return { name, command: argv, required, minimumTier };
}

function normalizeCommand(commandConfig: VerificationCommandConfig): VerificationCommandConfig {
  return {
    ...commandConfig,
    command: [...commandConfig.command],
    minimumTier: commandMinimumTier(commandConfig),
    ...(commandConfig.environment === undefined ? {} : { environment: { ...commandConfig.environment } }),
  };
}

function deduplicate(commands: readonly VerificationCommandConfig[]): VerificationCommandConfig[] {
  const byCommand = new Map<string, VerificationCommandConfig>();
  for (const input of commands) {
    const current = normalizeCommand(input);
    const key = JSON.stringify(current.command);
    const previous = byCommand.get(key);
    if (previous === undefined) {
      byCommand.set(key, current);
      continue;
    }

    // Explicit configuration is added first. Preserve its human-facing name and
    // environment while merging toward the stricter behavior.
    const timeoutMs = previous.timeoutMs ?? current.timeoutMs;
    byCommand.set(key, {
      ...previous,
      required: previous.required || current.required,
      taskSpecific: previous.taskSpecific === true || current.taskSpecific === true,
      minimumTier: proofTierRank(commandMinimumTier(previous)) <= proofTierRank(commandMinimumTier(current))
        ? commandMinimumTier(previous)
        : commandMinimumTier(current),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }
  return [...byCommand.values()];
}

function emptyTierRecord(value: number): Record<ProofTier, number> {
  return {
    basic: value,
    standard: value,
    strong: value,
    adversarial: value,
  };
}
