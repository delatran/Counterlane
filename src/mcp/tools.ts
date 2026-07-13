import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { CodexAppServer } from "../codex/app-server.js";
import { loadConfig } from "../config/load.js";
import { managedStatePrefixes } from "../config/managed-state.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { CounterlaneConfig } from "../config/types.js";
import { errorMessage } from "../core/errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../core/json.js";
import { Logger } from "../core/logger.js";
import type {
  ExperimentResult,
  MetaExecutionResult,
  ModelCatalog,
  RouteConstraints,
  RouteDecision,
  SingleRunResult,
} from "../core/types.js";
import { GitRepository } from "../git/repository.js";
import { MetaExecutionRunner } from "../runner/meta.js";
import { SingleRunner } from "../runner/single.js";
import { TwinRunner } from "../runner/twin.js";
import { deriveQuotaState } from "../routing/quota.js";
import { AutoRouter } from "../routing/router.js";
import { buildCalibrationIndex } from "../routing/calibration.js";
import { inspectVerificationCapabilities } from "../verification/detect.js";
import { TelemetryStore } from "../telemetry/store.js";
import { COUNTERLANE_BUILD_ID } from "../identity.js";
import { validateThreadProvenance } from "../core/thread-provenance.js";

export const COUNTERLANE_MCP_BUILD_ID = COUNTERLANE_BUILD_ID;
export const MCP_TRUSTED_CODEX_COMMAND_ENV = "COUNTERLANE_MCP_TRUSTED_CODEX_COMMAND";
export const MCP_TRUSTED_CODEX_ARGS_ENV = "COUNTERLANE_MCP_TRUSTED_CODEX_ARGS_JSON";

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  annotations: JsonObject;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: JsonObject;
  isError?: boolean;
}

export interface McpToolContext {
  defaultCwd?: string;
  allowedRoots?: readonly string[];
  allowConfigOverride?: boolean;
  /** Host-owned launch authority. Tool arguments and repository config cannot set this. */
  trustedCodexLaunch?: { command: string; args: readonly string[] };
  /**
   * Host-owned verifier authority. Repository config is never used for MCP
   * verification unless the host explicitly supplies a policy here.
   */
  trustedVerification?: CounterlaneConfig["verification"];
  signal?: AbortSignal;
}

const promptProperty: JsonObject = {
  type: "string",
  minLength: 1,
  description: "The coding or repository task to route or execute.",
};

const cwdProperty: JsonObject = {
  type: "string",
  description: "Absolute or relative repository path. Defaults to the MCP server working directory.",
};

const configProperty: JsonObject = {
  type: "string",
  description: "Optional path to counterlane.config.json, resolved from cwd.",
};

const threadProperty: JsonObject = {
  type: "string",
  description: "Optional existing Codex thread id to fork before delegated execution.",
};

const lastTurnProperty: JsonObject = {
  type: "string",
  description: "Optional final turn id to include when forking the existing Codex thread.",
};

const modelProperty: JsonObject = {
  type: "string",
  description: "Optional exact model id from model/list. Omit or use auto to let Counterlane choose.",
};

const familyProperty: JsonObject = {
  type: "string",
  enum: ["auto", "luna", "terra", "sol"],
  description: "Optional GPT-5.6 capability-family constraint.",
};

const effortProperty: JsonObject = {
  type: "string",
  description: "Optional exact reasoning effort. Omit or use auto to let Counterlane choose.",
};

const speedProperty: JsonObject = {
  type: "string",
  description: "Optional service/speed tier such as standard or fast. Unsupported tiers are rejected.",
};

const topologyProperty: JsonObject = {
  type: "string",
  enum: ["auto", "single", "ultra"],
  description: "Optional execution-topology constraint.",
};

const latencyPriorityProperty: JsonObject = {
  type: "string",
  enum: ["auto", "economy", "balanced", "urgent"],
  description: "Soft latency intent. Unlike speed, this lets Counterlane choose whether premium speed is worth its quota cost.",
};

const proofTierProperty: JsonObject = {
  type: "string",
  enum: ["auto", "basic", "standard", "strong", "adversarial"],
  description: "Optional proof-burden constraint. Unsafe or unavailable proof tiers fail closed.",
};

const deadlineProperty: JsonObject = {
  type: "integer",
  minimum: 1,
  description: "Optional hard wall-clock deadline in milliseconds for each delegated arm.",
};

const maxCreditsProperty: JsonObject = {
  type: "number",
  exclusiveMinimum: 0,
  description: "Optional hard ceiling on predicted normalized credits for the selected route.",
};

const routeHintProperties: JsonObject = {
  model: modelProperty,
  family: familyProperty,
  effort: effortProperty,
  speed: speedProperty,
  topology: topologyProperty,
  latencyPriority: latencyPriorityProperty,
  proofTier: proofTierProperty,
  deadlineMs: deadlineProperty,
  maxCredits: maxCreditsProperty,
};

export const COUNTERLANE_TOOLS: McpToolDefinition[] = [
  {
    name: "counterlane_models",
    title: "List Counterlane routing capabilities",
    description:
      "Read the live Codex model catalog, reasoning efforts, service/speed tiers, and quota snapshot used by Counterlane.",
    inputSchema: objectSchema({ cwd: cwdProperty, config: configProperty }),
    annotations: annotations("Inspect live model, effort, speed, and quota capabilities", true, true),
  },
  {
    name: "counterlane_route",
    title: "Route a task",
    description:
      "Select model, reasoning effort, speed/service tier, and topology for a task without executing it. This is advisory when called from inside an already-running parent turn.",
    inputSchema: objectSchema({ prompt: promptProperty, cwd: cwdProperty, config: configProperty, ...routeHintProperties }, ["prompt"]),
    annotations: annotations("Choose a cognitive-compute route", true, true),
  },
  {
    name: "counterlane_decide",
    title: "Choose Static, Auto, Twin, or Abstain",
    description:
      "Run the self-falsifying meta-controller and decide whether Auto has earned the right to route, whether to buy a paired twin, retain the static policy, or abstain.",
    inputSchema: objectSchema({ prompt: promptProperty, cwd: cwdProperty, config: configProperty, ...routeHintProperties }, ["prompt"]),
    annotations: annotations("Evaluate whether Auto should intervene", true, true),
  },
  {
    name: "counterlane_execute",
    title: "Execute through Counterlane",
    description:
      "Delegate a task to Counterlane's root control plane. It may execute Static, Auto, Twin, or Abstain. Source changes are isolated and never applied by this MCP tool.",
    inputSchema: objectSchema(
      {
        prompt: promptProperty,
        cwd: cwdProperty,
        config: configProperty,
        threadId: threadProperty,
        lastTurnId: lastTurnProperty,
        ...routeHintProperties,
      },
      ["prompt"],
    ),
    annotations: annotations("Execute an evidence-gated delegated Codex task", false, false),
  },
  {
    name: "counterlane_run",
    title: "Run one explicit policy",
    description:
      "Execute one isolated Auto or Static arm. The original repository is never modified by this MCP tool.",
    inputSchema: objectSchema(
      {
        prompt: promptProperty,
        cwd: cwdProperty,
        config: configProperty,
        mode: { type: "string", enum: ["auto", "static"], default: "auto" },
        threadId: threadProperty,
        lastTurnId: lastTurnProperty,
        ...routeHintProperties,
      },
      ["prompt"],
    ),
    annotations: annotations("Execute one isolated route", false, false),
  },
  {
    name: "counterlane_compare",
    title: "Compare Auto and No-Auto twins",
    description:
      "Run paired counterfactual Codex arms from the same repository state and blind-verify the results. The original repository is never modified by this MCP tool.",
    inputSchema: objectSchema(
      {
        prompt: promptProperty,
        cwd: cwdProperty,
        config: configProperty,
        threadId: threadProperty,
        lastTurnId: lastTurnProperty,
        ...routeHintProperties,
      },
      ["prompt"],
    ),
    annotations: annotations("Run a paired causal comparison", false, false),
  },
];

export async function callCounterlaneTool(name: string, rawArguments: unknown, context: McpToolContext = {}): Promise<McpToolResult> {
  const args = isJsonObject(rawArguments) ? rawArguments : {};
  try {
    throwIfAborted(context.signal);
    switch (name) {
      case "counterlane_models":
        return success(await modelsTool(args, context));
      case "counterlane_route":
        return success(await routeTool(args, context));
      case "counterlane_decide":
        return success(await decideTool(args, context));
      case "counterlane_execute":
        return success(await executeTool(args, context));
      case "counterlane_run":
        return success(await runTool(args, context));
      case "counterlane_compare":
        return success(await compareTool(args, context));
      default:
        return failure(`Unknown Counterlane tool: ${name}`);
    }
  } catch (error) {
    return failure(errorMessage(error));
  }
}

async function modelsTool(args: JsonObject, context: McpToolContext): Promise<JsonObject> {
  const cwd = await cwdArgument(args, context);
  const { config } = await loadConfigForArgs(cwd, args, context);
  const logger = silentLogger();
  const server = await CodexAppServer.connect({
    config,
    cwd,
    logger,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  try {
    const [catalog, limits] = await Promise.all([server.listModels(context.signal), server.readRateLimits(context.signal)]);
    return {
      cwd,
      models: catalog.models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        defaultReasoningEffort: model.defaultReasoningEffort,
        reasoningEfforts: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
        defaultSpeed: model.defaultServiceTier ?? "standard",
        speedTiers: [
          { id: "standard", name: "Standard", description: "Default service tier" },
          ...model.serviceTiers,
        ],
        isDefault: model.isDefault,
        hidden: model.hidden,
      })) as unknown as JsonValue,
      quota: {
        primary: limits.primary ?? null,
        byId: limits.byId,
        ...(limits.planType === undefined ? {} : { planType: limits.planType }),
        fetchedAt: limits.fetchedAt,
      } as unknown as JsonValue,
    };
  } finally {
    await server.close();
  }
}

async function routeTool(args: JsonObject, context: McpToolContext): Promise<JsonObject> {
  const prompt = requiredString(args, "prompt");
  const workspace = await workspaceForArgs(args, context);
  const server = await CodexAppServer.connect({
    config: workspace.config,
    cwd: workspace.repository.root,
    logger: workspace.logger,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  try {
    const [catalog, limits, profile, verificationCapabilities, events] = await Promise.all([
      server.listModels(context.signal),
      server.readRateLimits(context.signal),
      workspace.repository.profile(managedStatePrefixes(workspace.config)),
      inspectVerificationCapabilities(workspace.repository.root, workspace.config),
      workspace.telemetry.readLearningEvents(),
    ]);
    const quota = deriveQuotaState(limits, workspace.config.routing.reservePercent);
    return summarizeRoute(new AutoRouter(workspace.config).decide({
      prompt,
      repo: profile,
      catalog,
      quota,
      verificationCapabilities,
      calibration: buildCalibrationIndex(events),
      ...constraintsArgument(args),
    }));
  } finally {
    await server.close();
  }
}

async function decideTool(args: JsonObject, context: McpToolContext): Promise<JsonObject> {
  const prompt = requiredString(args, "prompt");
  const workspace = await workspaceForArgs(args, context);
  const plan = await new MetaExecutionRunner(workspace).plan(prompt, constraintsFromArgs(args), context.signal);
  return {
    action: plan.decision.action,
    reasons: plan.decision.reasons,
    expectedInformationValue: plan.decision.expectedInformationValue,
    estimatedTwinCost: plan.decision.estimatedTwinCost,
    posterior: plan.decision.posterior as unknown as JsonValue,
    context: plan.context as unknown as JsonValue,
    control: summarizePolicy(plan.controlPolicy),
    treatment: summarizePolicy(plan.treatmentPolicy),
    autoRoute: summarizeRoute(plan.route),
  };
}

async function executeTool(args: JsonObject, context: McpToolContext): Promise<JsonObject> {
  const prompt = requiredString(args, "prompt");
  const thread = threadArguments(args);
  const workspace = await workspaceForArgs(args, context);
  const result = await new MetaExecutionRunner(workspace).run({
    prompt,
    apply: false,
    ...constraintsArgument(args),
    ...thread,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return summarizeMetaExecution(result);
}

async function runTool(args: JsonObject, context: McpToolContext): Promise<JsonObject> {
  const prompt = requiredString(args, "prompt");
  const thread = threadArguments(args);
  const mode = optionalString(args, "mode") ?? "auto";
  if (mode !== "auto" && mode !== "static") {
    throw new Error("mode must be auto or static");
  }
  const workspace = await workspaceForArgs(args, context);
  const result = await new SingleRunner(workspace).run({
    prompt,
    mode,
    apply: false,
    ...constraintsArgument(args),
    ...thread,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return summarizeSingle(result);
}

async function compareTool(args: JsonObject, context: McpToolContext): Promise<JsonObject> {
  const prompt = requiredString(args, "prompt");
  const thread = threadArguments(args);
  const workspace = await workspaceForArgs(args, context);
  const result = await new TwinRunner(workspace).run({
    prompt,
    applyWinner: false,
    ...constraintsArgument(args),
    ...thread,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  return summarizeExperiment(result);
}

async function workspaceForArgs(args: JsonObject, context: McpToolContext): Promise<{
  repository: GitRepository;
  config: CounterlaneConfig;
  logger: Logger;
  telemetry: TelemetryStore;
}> {
  const cwd = await cwdArgument(args, context);
  const { config } = await loadConfigForArgs(cwd, args, context);
  const repository = await GitRepository.discover(cwd);
  if (context.allowedRoots !== undefined) {
    await assertAllowedPath(repository.root, context.allowedRoots, "repository root");
  }
  const logger = silentLogger();
  const telemetry = new TelemetryStore(repository.root, config);
  return { repository, config, logger, telemetry };
}

async function loadConfigForArgs(
  cwd: string,
  args: JsonObject,
  context: McpToolContext,
): ReturnType<typeof loadConfig> {
  const configPath = optionalString(args, "config");
  if (configPath !== undefined && context.allowConfigOverride === false) {
    throw new Error("Remote MCP configuration overrides are disabled by server policy.");
  }
  if (configPath !== undefined && context.allowedRoots !== undefined) {
    await assertAllowedPath(isAbsolute(configPath) ? configPath : resolve(cwd, configPath), context.allowedRoots, "config");
  }
  const loaded = await loadConfig({ cwd, ...(configPath === undefined ? {} : { configPath }) });
  if (loaded.configPath !== null && context.allowedRoots !== undefined) {
    await assertAllowedPath(loaded.configPath, context.allowedRoots, "resolved config");
  }
  const trustedLaunch = resolveTrustedCodexLaunch(context);
  return {
    ...loaded,
    config: secureMcpConfig(loaded.config, trustedLaunch, context.trustedVerification),
  };
}

export function secureMcpConfig(
  config: CounterlaneConfig,
  trustedLaunch: { command: string; args: readonly string[] },
  trustedVerification?: CounterlaneConfig["verification"],
): CounterlaneConfig {
  return {
    ...config,
    codex: {
      ...config.codex,
      command: trustedLaunch.command,
      args: [...trustedLaunch.args],
      // Repository-controlled MCP config may tighten the filesystem sandbox,
      // but it cannot enable network access, alter approval semantics, or pass
      // undocumented turn fields across the host boundary.
      approvalPolicy: DEFAULT_CONFIG.codex.approvalPolicy,
      sandbox: {
        type: config.codex.sandbox.type === "readOnly" ? "readOnly" : DEFAULT_CONFIG.codex.sandbox.type,
        networkAccess: false,
      },
      extraTurnParams: {},
    },
    meta: trustedVerification === undefined
      ? { ...config.meta, enabled: false }
      : { ...config.meta },
    verification: cloneMcpVerificationPolicy(trustedVerification ?? defaultMcpVerificationPolicy()),
  };
}

function defaultMcpVerificationPolicy(): CounterlaneConfig["verification"] {
  const defaults = DEFAULT_CONFIG.verification;
  return {
    ...defaults,
    autoDetect: false,
    routing: {
      ...defaults.routing,
      enabled: false,
      candidateTiers: ["basic"],
      defaultTier: "basic",
      // No command means no independent detection evidence. Keep this posture
      // available only for isolated basic execution, while the unchanged risk
      // floors continue to reject elevated and critical work.
      costWeights: { ...defaults.routing.costWeights, basic: 0 },
      detectionBoosts: { ...defaults.routing.detectionBoosts, basic: 0 },
      detectionFloors: { ...defaults.routing.detectionFloors, basic: 0 },
      minimumIndependentChecks: { ...defaults.routing.minimumIndependentChecks, basic: 0 },
    },
    requireAtLeastOne: false,
    failOnNoVerifier: false,
    commands: [],
  };
}

function cloneMcpVerificationPolicy(
  policy: CounterlaneConfig["verification"],
): CounterlaneConfig["verification"] {
  return {
    ...policy,
    routing: {
      ...policy.routing,
      candidateTiers: [...policy.routing.candidateTiers],
      minimumTierByRisk: { ...policy.routing.minimumTierByRisk },
      costWeights: { ...policy.routing.costWeights },
      detectionBoosts: { ...policy.routing.detectionBoosts },
      detectionFloors: { ...policy.routing.detectionFloors },
      minimumIndependentChecks: { ...policy.routing.minimumIndependentChecks },
    },
    commands: policy.commands.map((command) => ({
      ...command,
      command: [...command.command],
      ...(command.environment === undefined ? {} : { environment: { ...command.environment } }),
    })),
  };
}

function resolveTrustedCodexLaunch(context: McpToolContext): { command: string; args: readonly string[] } {
  if (context.trustedCodexLaunch !== undefined) return context.trustedCodexLaunch;
  const command = process.env[MCP_TRUSTED_CODEX_COMMAND_ENV];
  const encodedArgs = process.env[MCP_TRUSTED_CODEX_ARGS_ENV];
  if (command === undefined && encodedArgs === undefined) return DEFAULT_CONFIG.codex;
  if (command === undefined || command.trim().length === 0) {
    throw new Error(`${MCP_TRUSTED_CODEX_COMMAND_ENV} must be a non-empty host-owned command.`);
  }
  if (encodedArgs === undefined) return { command, args: [] };
  const parsed = JSON.parse(encodedArgs) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error(`${MCP_TRUSTED_CODEX_ARGS_ENV} must be a JSON array of strings.`);
  }
  return { command, args: parsed };
}

function constraintsArgument(args: JsonObject): { constraints?: RouteConstraints } {
  const constraints = constraintsFromArgs(args);
  return constraints === undefined ? {} : { constraints };
}

function constraintsFromArgs(args: JsonObject): RouteConstraints | undefined {
  const constraints: RouteConstraints = {};
  const model = optionalString(args, "model");
  if (model !== undefined && model !== "auto") constraints.modelId = model;
  const family = optionalString(args, "family");
  if (family !== undefined && family !== "auto") {
    if (family !== "luna" && family !== "terra" && family !== "sol") throw new Error("family must be auto, luna, terra, or sol");
    constraints.modelFamily = family;
  }
  const effort = optionalString(args, "effort");
  if (effort !== undefined && effort !== "auto") constraints.effort = effort;
  const speed = optionalString(args, "speed");
  if (speed !== undefined && speed !== "auto") constraints.speedId = speed;
  const topology = optionalString(args, "topology");
  if (topology !== undefined && topology !== "auto") {
    if (topology !== "single" && topology !== "ultra") throw new Error("topology must be auto, single, or ultra");
    constraints.topology = topology;
  }
  const latencyPriority = optionalString(args, "latencyPriority");
  if (latencyPriority !== undefined && latencyPriority !== "auto") {
    if (latencyPriority !== "economy" && latencyPriority !== "balanced" && latencyPriority !== "urgent") {
      throw new Error("latencyPriority must be auto, economy, balanced, or urgent");
    }
    constraints.latencyPriority = latencyPriority;
  }
  const proofTier = optionalString(args, "proofTier");
  if (proofTier !== undefined && proofTier !== "auto") {
    if (proofTier !== "basic" && proofTier !== "standard" && proofTier !== "strong" && proofTier !== "adversarial") {
      throw new Error("proofTier must be auto, basic, standard, strong, or adversarial");
    }
    constraints.proofTier = proofTier;
  }
  const deadlineMs = optionalPositiveNumber(args, "deadlineMs", true);
  if (deadlineMs !== undefined) constraints.deadlineMs = deadlineMs;
  const maxCredits = optionalPositiveNumber(args, "maxCredits", false);
  if (maxCredits !== undefined) constraints.maxNormalizedCredits = maxCredits;
  return Object.keys(constraints).length === 0 ? undefined : constraints;
}

function threadArguments(args: JsonObject): { parentThreadId?: string; lastTurnId?: string } {
  const parentThreadId = optionalString(args, "threadId");
  const lastTurnId = optionalString(args, "lastTurnId");
  validateThreadProvenance({
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(lastTurnId === undefined ? {} : { lastTurnId }),
    parentLabel: "threadId",
    lastTurnLabel: "lastTurnId",
  });
  return {
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(lastTurnId === undefined ? {} : { lastTurnId }),
  };
}

async function cwdArgument(args: JsonObject, context: McpToolContext): Promise<string> {
  const candidate = resolve(optionalString(args, "cwd") ?? context.defaultCwd ?? process.cwd());
  if (context.allowedRoots !== undefined) {
    await assertAllowedPath(candidate, context.allowedRoots, "cwd");
  }
  return candidate;
}

function optionalPositiveNumber(args: JsonObject, key: string, integer: boolean): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${key} must be a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

async function assertAllowedPath(candidate: string, allowedRoots: readonly string[], label: string): Promise<void> {
  let canonicalCandidate: string;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch {
    throw new Error(`${label} does not exist or cannot be resolved: ${candidate}`);
  }
  for (const root of allowedRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch {
      continue;
    }
    const rel = relative(canonicalRoot, canonicalCandidate);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  }
  throw new Error(`${label} is outside the MCP server's allowed repository roots: ${candidate}`);
}

function requiredString(args: JsonObject, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

export function summarizeRoute(decision: RouteDecision): JsonObject {
  return {
    action: decision.selected.admissible ? "execute" : "abstain",
    admissible: decision.selected.admissible,
    rejectionReasons: decision.selected.rejectionReasons,
    selected: {
      modelId: decision.selected.modelId,
      modelFamily: decision.selected.modelFamily,
      effort: decision.selected.effort,
      speed: decision.selected.speedId,
      serviceTier: decision.selected.serviceTier,
      speedCostMultiplier: decision.selected.speedCostMultiplier,
      speedLatencyMultiplier: decision.selected.speedLatencyMultiplier,
      topology: decision.selected.topology,
      proofTier: decision.selected.proofTier,
      detectionEstimate: decision.selected.detectionEstimate,
      predictedDurationMs: decision.selected.predictedDurationMs,
      predictedP90DurationMs: decision.selected.predictedP90DurationMs,
      predictedNormalizedCredits: decision.selected.predictedNormalizedCredits,
      calibrationSamples: decision.selected.calibrationSamples,
      successEstimate: decision.selected.successEstimate,
      badEscapeEstimate: decision.selected.badEscapeEstimate,
      objective: decision.selected.objective,
      admissible: decision.selected.admissible,
      rejectionReasons: decision.selected.rejectionReasons,
    },
    profile: decision.profile,
    constraints: decision.constraints as unknown as JsonValue,
    task: {
      kind: decision.features.taskKind,
      ambiguity: decision.features.ambiguity,
      depth: decision.features.depth,
      breadth: decision.features.breadth,
      risk: decision.features.risk,
      verifiability: decision.features.verifiability,
      parallelizability: decision.features.parallelizability,
      latencySensitivity: decision.features.latencySensitivity,
      evidence: decision.features.evidence,
    },
    quota: decision.quota as unknown as JsonValue,
    verification: {
      posture: verificationPosture(decision.verificationCapabilities.commandCountByTier[decision.selected.proofTier]),
      availableTiers: decision.verificationCapabilities.availableTiers,
      selectedCommandCount: decision.verificationCapabilities.commandCountByTier[decision.selected.proofTier],
      selectedRequiredCount: decision.verificationCapabilities.requiredCountByTier[decision.selected.proofTier],
      fingerprint: decision.verificationCapabilities.fingerprint,
    },
    rationale: decision.rationale,
    topCandidates: decision.candidates.slice(0, 8).map((candidate) => ({
      modelId: candidate.modelId,
      family: candidate.modelFamily,
      effort: candidate.effort,
      speed: candidate.speedId,
      serviceTier: candidate.serviceTier,
      topology: candidate.topology,
      proofTier: candidate.proofTier,
      detectionEstimate: candidate.detectionEstimate,
      predictedDurationMs: candidate.predictedDurationMs,
      predictedP90DurationMs: candidate.predictedP90DurationMs,
      predictedNormalizedCredits: candidate.predictedNormalizedCredits,
      calibrationSamples: candidate.calibrationSamples,
      admissible: candidate.admissible,
      objective: candidate.objective,
      costWeight: candidate.costWeight,
      latencyWeight: candidate.latencyWeight,
      rejectionReasons: candidate.rejectionReasons,
    })) as unknown as JsonValue,
  };
}

function summarizePolicy(policy: {
  name: string;
  modelId: string;
  modelFamily: string;
  effort: string;
  speedId: string;
  serviceTier: string | null;
  topology: string;
  proofTier: string;
}): JsonObject {
  return {
    name: policy.name,
    modelId: policy.modelId,
    modelFamily: policy.modelFamily,
    effort: policy.effort,
    speed: policy.speedId,
    serviceTier: policy.serviceTier,
    topology: policy.topology,
    proofTier: policy.proofTier,
  };
}

function summarizeSingle(result: SingleRunResult): JsonObject {
  return {
    runId: result.runId,
    mode: result.mode,
    successful: result.arm.successful,
    outcome: result.arm.outcome,
    policy: summarizePolicy(result.arm.policy),
    verification: {
      posture: verificationPosture(result.arm.verification.checks.length),
      checkCount: result.arm.verification.checks.length,
      verified: result.arm.verification.checks.length > 0 &&
        result.arm.verification.adequate && result.arm.verification.passed,
      passed: result.arm.verification.passed,
      adequate: result.arm.verification.adequate,
      proofTier: result.arm.verification.proofTier,
      score: result.arm.verification.score,
      requiredPassed: result.arm.verification.requiredPassed,
      requiredTotal: result.arm.verification.requiredTotal,
    },
    cost: result.arm.cost as unknown as JsonValue,
    durationMs: result.durationMs,
    finalMessage: result.arm.turn.finalMessage,
    patchHash: result.arm.patchHash,
    artifactDirectory: result.artifactDirectory,
    applied: false,
  };
}

function summarizeExperiment(result: ExperimentResult): JsonObject {
  return {
    experimentId: result.experimentId,
    winner: result.winner as unknown as JsonValue,
    control: summarizeArm(result.control),
    treatment: summarizeArm(result.treatment),
    originalStateUnchanged: result.originalStateUnchanged,
    appliedWinner: false,
    certificatePath: result.certificatePath,
    durationMs: result.durationMs,
  };
}

function summarizeMetaExecution(result: MetaExecutionResult): JsonObject {
  return {
    decisionId: result.decisionId,
    action: result.decision.action,
    reasons: result.decision.reasons,
    execution: result.execution,
    ...(result.single === undefined ? {} : { single: summarizeSingle(result.single) }),
    ...(result.twin === undefined ? {} : { twin: summarizeExperiment(result.twin) }),
    artifactPath: result.artifactPath,
    durationMs: result.durationMs,
  };
}

function summarizeArm(arm: ExperimentResult["control"]): JsonObject {
  return {
    successful: arm.successful,
    outcome: arm.outcome,
    policy: summarizePolicy(arm.policy),
    verification: {
      posture: verificationPosture(arm.verification.checks.length),
      checkCount: arm.verification.checks.length,
      verified: arm.verification.checks.length > 0 && arm.verification.adequate && arm.verification.passed,
      passed: arm.verification.passed,
      adequate: arm.verification.adequate,
      proofTier: arm.verification.proofTier,
      score: arm.verification.score,
      requiredPassed: arm.verification.requiredPassed,
      requiredTotal: arm.verification.requiredTotal,
    },
    cost: arm.cost as unknown as JsonValue,
    utility: arm.utility,
    durationMs: arm.durationMs,
    patchHash: arm.patchHash,
    finalMessage: arm.turn.finalMessage,
  };
}

function verificationPosture(commandCount: number): "no-verifier" | "host-authorized" {
  return commandCount === 0 ? "no-verifier" : "host-authorized";
}

function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

function annotations(title: string, readOnly: boolean, idempotent: boolean): JsonObject {
  return {
    title,
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: true,
  };
}

function success(value: JsonObject): McpToolResult {
  const text = JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], structuredContent: value };
}

function failure(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: `Counterlane error: ${message}` }],
    structuredContent: { error: message },
    isError: true,
  };
}

function silentLogger(): Logger {
  return new Logger({ level: "silent", json: true });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason = signal.reason;
  const error = reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "MCP request cancelled.");
  if (error.name === "Error") error.name = "AbortError";
  throw error;
}

export function catalogSummary(catalog: ModelCatalog): JsonObject {
  return {
    models: catalog.models.map((model) => ({
      id: model.id,
      efforts: model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
      speeds: ["standard", ...model.serviceTiers.map((tier) => tier.id)],
    })) as unknown as JsonValue,
  };
}
