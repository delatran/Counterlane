import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CounterlaneConfig, VerificationCommandConfig } from "../config/types.js";
import type {
  ProofTier,
  VerificationIntegrity,
  VerificationPlan,
  VerifierCodeOwnership,
} from "../core/types.js";
import { sha256, stableStringify } from "../core/utils.js";
import {
  commandMinimumTier,
  commandsForProofTier,
  inspectVerificationCapabilities,
  resolveVerificationCommands,
} from "./detect.js";

const MAX_PROTECTED_ASSET_BYTES = 256 * 1024 * 1024;
const SECRET_LIKE_ENVIRONMENT_KEY = /(?:token|secret|password|credential|api[_-]?key|authorization|cookie)/iu;
const PROCESS_CONTROL_ENVIRONMENT_KEY = /^(?:path|home|userprofile|tmp|temp|tmpdir|node_options|node_path|comspec|systemroot|windir|pathext|ld_preload|ld_library_path|dyld_.+)$/iu;
const INLINE_PROGRAM_FLAGS = new Set(["-e", "--eval", "-c", "/c", "-command", "--command"]);
const GENERIC_INTERPRETERS = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "cscript",
  "cscript.exe",
  "node",
  "node.exe",
  "npm",
  "npm.cmd",
  "npx",
  "npx.cmd",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "python",
  "python.exe",
  "python3",
  "python3.exe",
  "sh",
  "wscript",
  "wscript.exe",
]);

export type VerificationPolicyAuthority = "host" | "repository";

interface CommandAsset {
  path: string;
  scope: "candidate-repository" | "host";
  role: "executable" | "argument" | "manifest";
}

/**
 * Capture the exact verifier command surface before a product model turn. The
 * plan intentionally retains no prompt or verifier output. Candidate assets
 * use repository-relative identities; trusted host assets retain canonical
 * absolute identities so their exact bytes can be rechecked after delegation.
 */
export async function freezeVerificationPlan(
  cwd: string,
  config: CounterlaneConfig,
  proofTier: ProofTier,
  options: { authority?: VerificationPolicyAuthority } = {},
): Promise<VerificationPlan> {
  const [allCommands, capabilities] = await Promise.all([
    resolveVerificationCommands(cwd, config),
    inspectVerificationCapabilities(cwd, config),
  ]);
  const selected = commandsForProofTier(allCommands, proofTier);
  const commands: VerificationPlan["commands"] = [];
  const protectedByPath = new Map<string, { codeOwnership: VerifierCodeOwnership; scope: CommandAsset["scope"] }>();
  const authority = options.authority ?? "repository";

  for (const input of selected) {
    const environment = { ...(input.environment ?? {}) };
    const unsafeKey = Object.keys(environment).find((key) =>
      SECRET_LIKE_ENVIRONMENT_KEY.test(key) || PROCESS_CONTROL_ENVIRONMENT_KEY.test(key)
    );
    if (unsafeKey !== undefined) {
      throw new Error(`Verifier command ${input.name} declares a secret-like or process-control environment key ${unsafeKey}; product verification refuses it.`);
    }
    const assets = await commandDefiningAssets(cwd, input);
    const ownership = classifyCodeOwnership(input, assets, authority);
    for (const asset of assets) {
      const key = `${asset.scope}\0${asset.path}`;
      const previous = protectedByPath.get(key);
      protectedByPath.set(key, {
        scope: asset.scope,
        codeOwnership: stricterOwnership(previous?.codeOwnership, ownership),
      });
    }
    commands.push({
      name: input.name,
      command: [...input.command],
      required: input.required,
      taskSpecific: input.taskSpecific === true,
      minimumTier: commandMinimumTier(input),
      timeoutMs: input.timeoutMs ?? config.verification.defaultTimeoutMs,
      environment,
      candidateCodePolicy: input.candidateCodePolicy ?? "undeclared",
      codeOwnership: ownership,
    });
  }

  const protectedAssets = await Promise.all(
    [...protectedByPath.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([key, asset]) => {
        const path = key.slice(key.indexOf("\0") + 1);
        return {
          path,
          scope: asset.scope,
          sha256: await hashProtectedAsset(cwd, { path, scope: asset.scope }),
          codeOwnership: asset.codeOwnership,
        };
      }),
  );
  const adequate = selected.length > 0 && capabilities.availableTiers.includes(proofTier);
  const taskSpecific = commands.filter((command) => command.taskSpecific);
  const certifying = adequate && taskSpecific.some((command) =>
    command.codeOwnership === "host-owned-immutable" && command.candidateCodePolicy === "data-only"
  );
  const containment = {
    filesystem: "isolated-worktree" as const,
    // The current portable runtime has no OS-level network enforcement adapter.
    // This is intentionally not inferred from an empty environment or cwd.
    network: "unverified" as const,
    environment: "minimal-allowlist" as const,
    processLimits: "best-effort" as const,
  };
  const identity = {
    schemaVersion: 1 as const,
    proofTier,
    adequate,
    certifying,
    minimumIndependentChecks: config.verification.routing.minimumIndependentChecks[proofTier],
    taskSpecificRequired: config.verification.requireTaskSpecificCheck,
    commands,
    protectedAssets,
    containment,
  };
  return { ...identity, planHash: sha256(stableStringify(identity)) };
}

export async function verifyFrozenPlanIntegrity(
  cwd: string,
  plan: VerificationPlan,
): Promise<{ integrity: VerificationIntegrity; reasons: string[] }> {
  const reasons: string[] = [];
  for (const asset of plan.protectedAssets) {
    try {
      const current = await hashProtectedAsset(cwd, asset);
      if (current !== asset.sha256) reasons.push(`protected verifier asset changed: ${asset.path}`);
    } catch {
      reasons.push(`protected verifier asset is unavailable: ${asset.path}`);
    }
  }
  return reasons.length === 0 ? { integrity: "intact", reasons } : { integrity: "compromised", reasons };
}

/** Minimal runtime environment for frozen product verification only. */
export async function minimalVerifierEnvironment(
  cwd: string,
  config: CounterlaneConfig,
  additions: Record<string, string>,
  proofTier: ProofTier,
): Promise<NodeJS.ProcessEnv> {
  const base = resolve(cwd, config.dataDirectory, "verifier-runtime");
  const home = join(base, "home");
  const temporary = join(base, "tmp");
  await Promise.all([mkdir(home, { recursive: true }), mkdir(temporary, { recursive: true })]);
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    COUNTERLANE_BLIND_VERIFIER: "1",
    COUNTERLANE_PROOF_TIER: proofTier,
    HOME: home,
    USERPROFILE: home,
    TMP: temporary,
    TEMP: temporary,
    TMPDIR: temporary,
    npm_config_cache: join(base, "npm-cache"),
    ...additions,
  };
  // PATH and Windows loader variables are runtime prerequisites, not broad
  // application configuration. No credential/profile variables are inherited.
  for (const key of process.platform === "win32"
    ? ["Path", "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]
    : ["PATH", "LANG", "LC_ALL"]
  ) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function classifyCodeOwnership(
  command: VerificationCommandConfig,
  assets: readonly CommandAsset[],
  authority: VerificationPolicyAuthority,
): VerifierCodeOwnership {
  const executable = basename(command.command[0] ?? "").toLowerCase();
  if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(executable)) {
    return "candidate-controlled";
  }
  const candidateAssets = assets.filter((asset) => asset.scope === "candidate-repository");
  const hostAssets = assets.filter((asset) => asset.scope === "host");
  if (
    authority === "host" &&
    command.candidateCodePolicy === "data-only" &&
    isAbsolute(command.command[0] ?? "") &&
    !containsInlineProgram(command.command) &&
    !hasUnsupportedPreEntrypointOption(command.command) &&
    candidateAssets.length === 0 &&
    hasImmutableHostEntrypoint(executable, hostAssets)
  ) {
    return "host-owned-immutable";
  }
  return candidateAssets.length > 0 ? "baseline-frozen" : "unknown";
}

function stricterOwnership(
  previous: VerifierCodeOwnership | undefined,
  next: VerifierCodeOwnership,
): VerifierCodeOwnership {
  if (previous === undefined) return next;
  const rank: Record<VerifierCodeOwnership, number> = {
    "host-owned-immutable": 0,
    "baseline-frozen": 1,
    "candidate-controlled": 2,
    unknown: 3,
  };
  return rank[previous] >= rank[next] ? previous : next;
}

async function commandDefiningAssets(cwd: string, command: VerificationCommandConfig): Promise<CommandAsset[]> {
  const assets = new Map<string, CommandAsset>();
  const canonicalRoot = await realpath(cwd);
  const executable = basename(command.command[0] ?? "").toLowerCase();
  if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(executable)) {
    for (const manifest of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]) {
      await addIfRegularFile(canonicalRoot, resolve(canonicalRoot, manifest), "manifest", assets);
    }
  }
  const commandPath = command.command[0];
  if (commandPath !== undefined && isAbsolute(commandPath)) {
    await addIfRegularFile(canonicalRoot, commandPath, "executable", assets);
  }
  let skipInlineValue = false;
  for (const value of command.command.slice(1)) {
    if (skipInlineValue) {
      skipInlineValue = false;
      continue;
    }
    if (INLINE_PROGRAM_FLAGS.has(value.toLowerCase())) {
      skipInlineValue = true;
      continue;
    }
    if (value.startsWith("-")) {
      const assignedPath = assignedOptionPath(value);
      if (assignedPath !== undefined) {
        const candidate = isAbsolute(assignedPath) ? assignedPath : resolve(canonicalRoot, assignedPath);
        await addIfRegularFile(canonicalRoot, candidate, "argument", assets);
      }
      continue;
    }
    const candidate = isAbsolute(value) ? value : resolve(canonicalRoot, value);
    await addIfRegularFile(canonicalRoot, candidate, "argument", assets);
  }
  return [...assets.values()].sort((left, right) =>
    `${left.scope}\0${left.path}\0${left.role}`.localeCompare(`${right.scope}\0${right.path}\0${right.role}`)
  );
}

async function addIfRegularFile(
  canonicalRoot: string,
  value: string,
  role: CommandAsset["role"],
  target: Map<string, CommandAsset>,
): Promise<void> {
  const absolute = resolve(value);
  try {
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PROTECTED_ASSET_BYTES) return;
    const canonical = await realpath(absolute);
    const scope = isWithin(canonicalRoot, canonical) ? "candidate-repository" : "host";
    const path = scope === "candidate-repository"
      ? relative(canonicalRoot, canonical).replaceAll("\\", "/")
      : canonical;
    target.set(`${scope}\0${path}`, { path, scope, role });
  } catch {
    // A missing optional lockfile or a non-file argument is not a protected asset.
  }
}

async function hashProtectedAsset(
  cwd: string,
  asset: Pick<VerificationPlan["protectedAssets"][number], "path" | "scope">,
): Promise<string> {
  const canonicalRoot = await realpath(cwd);
  const absolute = asset.scope === "host" ? resolve(asset.path) : resolve(canonicalRoot, asset.path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PROTECTED_ASSET_BYTES) {
    throw new Error("protected verifier asset is not an eligible regular file");
  }
  const canonical = await realpath(absolute);
  if (asset.scope === "candidate-repository" && !isWithin(canonicalRoot, canonical)) {
    throw new Error("protected verifier asset escaped its repository boundary");
  }
  if (asset.scope === "host" && isWithin(canonicalRoot, canonical)) {
    throw new Error("host verifier asset resolved inside the candidate repository");
  }
  return sha256(await readFile(absolute));
}

function containsInlineProgram(command: readonly string[]): boolean {
  return command.some((value) => INLINE_PROGRAM_FLAGS.has(value.toLowerCase()));
}

function hasUnsupportedPreEntrypointOption(command: readonly string[]): boolean {
  const executable = basename(command[0] ?? "").toLowerCase();
  if (!GENERIC_INTERPRETERS.has(executable)) return false;
  let optionsEnded = false;
  for (const value of command.slice(1)) {
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value.startsWith("-")) return true;
    // The first positional argument is the frozen interpreter entrypoint;
    // later flags belong to that host-owned program rather than the interpreter.
    return false;
  }
  return false;
}

function assignedOptionPath(value: string): string | undefined {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return value.slice(separator + 1);
}

function hasImmutableHostEntrypoint(executable: string, hostAssets: readonly CommandAsset[]): boolean {
  const executableAsset = hostAssets.some((asset) => asset.role === "executable");
  if (!executableAsset) return false;
  if (!GENERIC_INTERPRETERS.has(executable)) return true;
  return hostAssets.some((asset) => asset.role === "argument");
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
