import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
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
  ExecutionEnvelope,
  ModelCatalog,
  RouteConstraints,
  RouteDecision,
  SingleRunResult,
  VerificationPlan,
  VerificationReport,
} from "../core/types.js";
import { GitRepository } from "../git/repository.js";
import { MetaExecutionRunner } from "../runner/meta.js";
import { SingleRunner } from "../runner/single.js";
import { TwinRunner } from "../runner/twin.js";
import { executeVgcl, type VgclExecutionResult } from "../runner/vgcl.js";
import { createExecutionEnvelope } from "../runner/envelope.js";
import { deriveQuotaState } from "../routing/quota.js";
import { AutoRouter } from "../routing/router.js";
import { buildCalibrationIndex } from "../routing/calibration.js";
import { inspectVerificationCapabilities } from "../verification/detect.js";
import { freezeVerificationPlan, type VerificationPolicyAuthority } from "../verification/plan.js";
import { TelemetryStore } from "../telemetry/store.js";
import { COUNTERLANE_BUILD_ID } from "../identity.js";
import { validateThreadProvenance } from "../core/thread-provenance.js";
import { sha256, stableStringify, writeJsonAtomic } from "../core/utils.js";
import { ensureContainedDirectory, resolveContainedPath } from "../core/path-safety.js";
import {
  buildProductReceipt,
  redactPublicReceipt,
  type ReceiptEvidenceKind,
} from "../receipt/receipt.js";

export const COUNTERLANE_MCP_BUILD_ID = COUNTERLANE_BUILD_ID;
export const MCP_TRUSTED_CODEX_COMMAND_ENV = "COUNTERLANE_MCP_TRUSTED_CODEX_COMMAND";
export const MCP_TRUSTED_CODEX_ARGS_ENV = "COUNTERLANE_MCP_TRUSTED_CODEX_ARGS_JSON";
/** Host-owned evidence label for deterministic no-quota demonstration runs. */
export const MCP_EVIDENCE_KIND_ENV = "COUNTERLANE_EVIDENCE_KIND";
/**
 * Absolute path to a host-owned Counterlane config file. Only its validated
 * verification policy is used by MCP; every other setting remains subject to
 * the normal MCP boundary.
 */
export const MCP_TRUSTED_VERIFICATION_FILE_ENV = "COUNTERLANE_MCP_TRUSTED_VERIFICATION_FILE";

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonObject;
  /** Versioned machine result schema when a tool has a stable structured result. */
  outputSchema?: JsonObject;
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
  /** Host-owned evidence classification; tool arguments cannot influence it. */
  evidenceKind?: ReceiptEvidenceKind;
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
  description: "Advanced/raw service-tier id. It is retained for route inspection and research tools, not the product execute UX.",
};

const speedModeProperty: JsonObject = {
  type: "string",
  enum: ["off", "auto", "fast"],
  default: "auto",
  description: "Product speed mode: Off forces Standard; Auto may use a permitted premium tier; Fast requests an advertised premium tier or fails closed.",
};

const executionContextProperty: JsonObject = {
  type: "string",
  enum: ["foreground", "background"],
  description: "Whether a human is actively waiting. Auto premium speed requires an explicit foreground context.",
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

const preflightOnlyProperty: JsonObject = {
  type: "boolean",
  default: false,
  description: "Return the no-spend execution preflight only. No thread or model turn is created.",
};

const executeOutputSchema: JsonObject = {
  type: "object",
  additionalProperties: true,
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    state: {
      type: "string",
      enum: [
        "ready",
        "configuration_required",
        "abstain",
        "attempted",
        "verified",
        "failed",
        "cancelled",
        "reconciliation_required",
      ],
    },
    modelTurnStarted: { type: "boolean" },
    modelTurnStartState: { type: "string", enum: ["started", "not-started", "unknown"] },
    maxExpensiveTurns: { type: "integer", minimum: 0, maximum: 2 },
    reservedAttempts: { type: "integer", minimum: 0, maximum: 2 },
    spentAttempts: { type: "integer", minimum: 0, maximum: 2 },
    unknownAttempts: { type: "integer", minimum: 0, maximum: 2 },
    nonApplying: { type: "boolean" },
    receiptSchemaVersion: { type: "integer", const: 1 },
    reason: { type: "string" },
    envelopeHash: { type: "string" },
  },
  required: [
    "schemaVersion",
    "state",
    "modelTurnStarted",
    "modelTurnStartState",
    "maxExpensiveTurns",
    "reservedAttempts",
    "spentAttempts",
    "unknownAttempts",
    "nonApplying",
    "receiptSchemaVersion",
  ],
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

const executeRouteHintProperties: JsonObject = {
  model: modelProperty,
  family: familyProperty,
  effort: effortProperty,
  speedMode: speedModeProperty,
  executionContext: executionContextProperty,
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
    title: "Research: inspect Static, Auto, Twin, or Abstain",
    description:
      "Read-only Research planning. Inspect whether to use a Static route, an Auto route, an explicit paired Research comparison, or abstain. It does not start a model turn.",
    inputSchema: objectSchema({ prompt: promptProperty, cwd: cwdProperty, config: configProperty, ...routeHintProperties }, ["prompt"]),
    annotations: annotations("Evaluate whether Auto should intervene", true, true),
  },
  {
    name: "counterlane_execute",
    title: "Execute a verification-gated task",
    description:
      "Preferred product workflow. It performs a no-spend preflight, then runs a bounded isolated verification-gated path only when trusted task-specific verification is available. Product speed is Off, Auto, or Fast; it never starts Twin, Compare, or background exploration, and source changes are never applied by this MCP tool.",
    inputSchema: objectSchema(
      {
        prompt: promptProperty,
        cwd: cwdProperty,
        config: configProperty,
        threadId: threadProperty,
        lastTurnId: lastTurnProperty,
        preflightOnly: preflightOnlyProperty,
        ...executeRouteHintProperties,
      },
      ["prompt"],
    ),
    outputSchema: executeOutputSchema,
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
    title: "Research: compare two isolated routes (two expensive turns)",
    description:
      "Explicit paired Research acquisition: run exactly two isolated Codex arms from the same repository state and blind-verify the results. It incurs two expensive turns, is not the default product workflow, and never modifies the original repository.",
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
    annotations: annotations("Run an explicit paired Research acquisition with two expensive turns", false, false),
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
  const executionStartedAtClock = performance.now();
  const prompt = requiredString(args, "prompt");
  const thread = threadArguments(args);
  const workspace = await workspaceForArgs(args, context);
  const productConstraints = constraintsArgument(args, { productExecution: true });
  const preflight = await executePreflight(prompt, productConstraints, workspace, context);
  const preflightAndDiscoveryMs = elapsedMs(executionStartedAtClock);
  if (preflight.output["state"] !== "ready" || optionalBoolean(args, "preflightOnly") === true) {
    return {
      ...preflight.output,
      timing: {
        clock: "monotonic-local-elapsed",
        phasesOverlap: false,
        preflightAndDiscoveryMs,
      } as unknown as JsonValue,
    };
  }
  // MetaExecutionRunner is intentionally not used here because its Research
  // decision state can acquire a paired Twin. Product execution is one
  // isolated path; Compare remains the explicit research-only tool.
  const runner = new SingleRunner(workspace);
  const vgcl = await executeVgcl({
    journalRoot: await executeJournalRoot(workspace),
    decision: preflight.decision!,
    envelopeHash: preflight.executionEnvelope!.envelopeHash,
    executeAttempt: async (policy, lifecycle) => runner.run({
      prompt,
      mode: "auto",
      apply: false,
      policyOverride: policy,
      expectedRepositoryProfileHash: preflight.decision!.repo.profileHash,
      expectedExecutionEnvelope: preflight.executionEnvelope!,
      frozenRouteDecision: preflight.decision!,
      verificationPlan: preflight.verificationPlan!,
      beforeTurnStart: lifecycle.beforeTurnStart,
      ...productConstraints,
      ...thread,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    }),
  });
  const receipt = buildProductReceipt({
    execution: vgcl,
    envelopeHash: preflight.executionEnvelope!.envelopeHash,
    nonApplying: true,
    evidenceKind: receiptEvidenceKind(context),
    timing: {
      preflightAndDiscoveryMs,
      endToEndMs: elapsedMs(executionStartedAtClock),
    },
  });
  const publicReceipt = redactPublicReceipt(receipt);
  await persistProductReceipts(workspace, vgcl.runId, receipt, publicReceipt);
  return summarizeVgclExecution(preflight.output, vgcl, receipt, publicReceipt);
}

function elapsedMs(startedAtClock: number): number {
  return Math.max(0, Math.round(performance.now() - startedAtClock));
}

async function executePreflight(
  prompt: string,
  productConstraints: { constraints?: RouteConstraints },
  workspace: {
    repository: GitRepository;
    config: CounterlaneConfig;
    logger: Logger;
    telemetry: TelemetryStore;
    verificationAuthority: VerificationPolicyAuthority;
  },
  context: McpToolContext,
): Promise<{
  output: JsonObject;
  decision?: RouteDecision;
  verificationPlan?: VerificationPlan;
  executionEnvelope?: ExecutionEnvelope;
}> {
  const server = await CodexAppServer.connect({
    config: workspace.config,
    cwd: workspace.repository.root,
    logger: workspace.logger,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  try {
    const [catalog, limits, profile, verificationCapabilities] = await Promise.all([
      server.listModels(context.signal),
      server.readRateLimits(context.signal),
      workspace.repository.profile(managedStatePrefixes(workspace.config)),
      inspectVerificationCapabilities(workspace.repository.root, workspace.config),
    ]);
    const quota = deriveQuotaState(limits, workspace.config.routing.reservePercent);
    const base = {
      schemaVersion: 1,
      modelTurnStarted: false,
      modelTurnStartState: "not-started",
      maxExpensiveTurns: 2,
      reservedAttempts: 0,
      spentAttempts: 0,
      unknownAttempts: 0,
      nonApplying: true,
      receiptSchemaVersion: 1,
    } as const;
    const taskSpecificCommandCount = Object.values(verificationCapabilities.taskSpecificCommandCountByTier)
      .reduce((total, count) => total + count, 0);
    if (verificationCapabilities.taskSpecificRequired && taskSpecificCommandCount === 0) {
      return {
        output: {
          ...base,
          state: "configuration_required",
          reason: "A trusted task-specific verifier command is required before Counterlane can start a delegated model turn.",
          verification: {
            availableTiers: verificationCapabilities.availableTiers,
            taskSpecificRequired: true,
            fingerprint: verificationCapabilities.fingerprint,
          },
        },
      };
    }
    const preflightFingerprint = sha256(stableStringify({
      schemaVersion: 1,
      sourceProfileHash: profile.profileHash,
      catalogModelIds: catalog.models.map((model) => model.id).sort(),
      quota,
      verificationFingerprint: verificationCapabilities.fingerprint,
      constraints: productConstraints.constraints ?? {},
    }));
    let decision: RouteDecision;
    try {
      decision = new AutoRouter(workspace.config).decide({
        prompt,
        repo: profile,
        catalog,
        quota,
        verificationCapabilities,
        // Learning remains disabled for the initial product path. Historical
        // records stay auditable but cannot alter a delegated execution route.
        calibration: buildCalibrationIndex([]),
        ...productConstraints,
      });
    } catch (error) {
      return {
        output: {
          ...base,
          state: "abstain",
          reason: errorMessage(error),
          envelopeHash: preflightFingerprint,
          rejectionReasons: [errorMessage(error)],
        },
      };
    }
    let verificationPlan: VerificationPlan;
    try {
      verificationPlan = await freezeVerificationPlan(
        workspace.repository.root,
        workspace.config,
        decision.selected.proofTier,
        { authority: workspace.verificationAuthority },
      );
    } catch (error) {
      return {
        output: {
          ...base,
          state: "configuration_required",
          reason: `The frozen verifier plan is unsafe or unavailable: ${errorMessage(error)}`,
          envelopeHash: preflightFingerprint,
        },
      };
    }
    if (!verificationPlan.adequate || !verificationPlan.certifying) {
      return {
        output: {
          ...base,
          state: "configuration_required",
          reason: "The selected verifier plan lacks an intact host-owned, data-only, task-specific certification path.",
          envelopeHash: preflightFingerprint,
          verification: {
            planHash: verificationPlan.planHash,
            certifying: verificationPlan.certifying,
            containment: verificationPlan.containment as unknown as JsonValue,
          },
        },
      };
    }
    if (decision.features.risk >= 0.5 && verificationPlan.containment.network === "unverified") {
      return {
        output: {
          ...base,
          state: "abstain",
          reason: "Elevated or critical product execution requires a verified network-containment adapter; this portable runtime reports network containment as unverified.",
          envelopeHash: preflightFingerprint,
          rejectionReasons: ["network containment is unverified for elevated/critical execution"],
        },
      };
    }
    const executionEnvelope = createExecutionEnvelope({
      repo: profile,
      catalog,
      quota,
      decision,
      verificationPlan,
    });
    const envelopeHash = executionEnvelope.envelopeHash;
    if (!decision.selected.admissible) {
      return {
        output: {
          ...base,
          state: "abstain",
          reason: decision.selected.rejectionReasons.join("; ") || "No admissible execution route is available.",
          envelopeHash,
          route: summarizeRoute(decision),
        },
      };
    }
    return {
      output: {
        ...base,
        state: "ready",
        envelopeHash,
        route: summarizeRoute(decision),
        speed: {
          requestedMode: decision.constraints.speedMode ?? "auto",
          resolvedSpeed: decision.selected.speedId,
          actualServiceTier: decision.selected.serviceTier,
          pricingProvenance: "configured-speed-profile",
        },
        verification: {
          availableTiers: verificationCapabilities.availableTiers,
          taskSpecificRequired: verificationCapabilities.taskSpecificRequired,
          fingerprint: verificationCapabilities.fingerprint,
          planHash: verificationPlan.planHash,
          certifying: verificationPlan.certifying,
          containment: verificationPlan.containment as unknown as JsonValue,
        },
      },
      decision,
      verificationPlan,
      executionEnvelope,
    };
  } finally {
    await server.close();
  }
}

async function executeJournalRoot(workspace: {
  repository: GitRepository;
  config: CounterlaneConfig;
}): Promise<string> {
  const dataDirectory = await executeDataDirectory(workspace);
  return ensureContainedDirectory(
    dataDirectory,
    join(dataDirectory, "vgcl-journal"),
    { target: "VGCL attempt journal directory", boundary: "Counterlane data directory" },
  );
}

async function executeDataDirectory(workspace: {
  repository: GitRepository;
  config: CounterlaneConfig;
}): Promise<string> {
  const dataDirectory = await ensureContainedDirectory(
    workspace.repository.root,
    resolveContainedPath(workspace.repository.root, workspace.config.dataDirectory, {
      target: "Counterlane data directory",
      boundary: "repository",
    }),
    { target: "Counterlane data directory", boundary: "repository" },
  );
  return dataDirectory;
}

async function persistProductReceipts(
  workspace: { repository: GitRepository; config: CounterlaneConfig },
  runId: string,
  receipt: JsonObject,
  publicReceipt: JsonObject,
): Promise<void> {
  const dataDirectory = await executeDataDirectory(workspace);
  const receiptDirectory = await ensureContainedDirectory(
    dataDirectory,
    join(dataDirectory, "receipts"),
    { target: "product receipt directory", boundary: "Counterlane data directory" },
  );
  const localPath = resolveContainedPath(receiptDirectory, `${runId}.json`, {
    target: "authoritative product receipt",
    boundary: "product receipt directory",
  });
  const publicPath = resolveContainedPath(receiptDirectory, `${runId}.public.json`, {
    target: "public product receipt",
    boundary: "product receipt directory",
  });
  await Promise.all([
    writeJsonAtomic(localPath, receipt),
    writeJsonAtomic(publicPath, publicReceipt),
  ]);
}

function summarizeVgclExecution(
  preflight: JsonObject,
  execution: VgclExecutionResult,
  receipt: JsonObject,
  publicReceipt: JsonObject,
): JsonObject {
  const unknownAttempts = execution.accounting.unresolved;
  const startedAttempts = execution.accounting.modelAttempts;
  return {
    ...preflight,
    state: execution.terminalState,
    modelTurnStarted: startedAttempts > 0,
    modelTurnStartState: unknownAttempts > 0 ? "unknown" : startedAttempts > 0 ? "started" : "not-started",
    maxExpensiveTurns: execution.accounting.maximumAttempts,
    reservedAttempts: execution.accounting.reserved,
    spentAttempts: startedAttempts,
    unknownAttempts,
    reason: execution.terminalState === "verified"
      ? "The bounded sequential controller reached a trusted host-verified result. External adjudication was not performed."
      : execution.failureCause === undefined
        ? `The bounded sequential controller ended as ${execution.terminalState}.`
        : `The bounded sequential controller stopped after ${execution.failureCause}; no unqualified retry was started.`,
    receipt: {
      ...receipt,
      ...(execution.failureCapsule === undefined ? {} : { failureCapsule: execution.failureCapsule }),
    },
    receiptArtifacts: {
      runId: execution.runId,
      localReceiptHash: receipt["receiptHash"],
      publicReceiptHash: publicReceipt["publicReceiptHash"],
      localPersistence: "completed",
    } as unknown as JsonValue,
    publicReceipt,
  };
}

function receiptEvidenceKind(context: McpToolContext): ReceiptEvidenceKind {
  if (context.evidenceKind !== undefined) return context.evidenceKind;
  const configured = process.env[MCP_EVIDENCE_KIND_ENV];
  if (configured === undefined) return "unverified";
  if (configured === "runtime" || configured === "simulated" || configured === "unverified") return configured;
  throw new Error(`${MCP_EVIDENCE_KIND_ENV} must be runtime, simulated, or unverified when set.`);
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
  verificationAuthority: VerificationPolicyAuthority;
}> {
  const cwd = await cwdArgument(args, context);
  const { config, verificationAuthority } = await loadConfigForArgs(cwd, args, context);
  const repository = await GitRepository.discover(cwd);
  if (context.allowedRoots !== undefined) {
    await assertAllowedPath(repository.root, context.allowedRoots, "repository root");
  }
  const logger = silentLogger();
  const telemetry = new TelemetryStore(repository.root, config);
  return { repository, config, logger, telemetry, verificationAuthority };
}

async function loadConfigForArgs(
  cwd: string,
  args: JsonObject,
  context: McpToolContext,
): Promise<Awaited<ReturnType<typeof loadConfig>> & { verificationAuthority: VerificationPolicyAuthority }> {
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
  const [trustedLaunch, trustedVerification] = await Promise.all([
    resolveTrustedCodexLaunch(context),
    resolveTrustedVerification(context),
  ]);
  return {
    ...loaded,
    config: secureMcpConfig(loaded.config, trustedLaunch, trustedVerification),
    verificationAuthority: trustedVerification === undefined ? "repository" : "host",
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
    verification: {
      ...cloneMcpVerificationPolicy(trustedVerification ?? defaultMcpVerificationPolicy()),
      // MCP proof is host-authorized. Require the host to state explicitly
      // which executable check covers the delegated task contract.
      requireTaskSpecificCheck: true,
    },
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
    requireTaskSpecificCheck: true,
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

async function resolveTrustedVerification(
  context: McpToolContext,
): Promise<CounterlaneConfig["verification"] | undefined> {
  if (context.trustedVerification !== undefined) return context.trustedVerification;
  const configuredPath = process.env[MCP_TRUSTED_VERIFICATION_FILE_ENV];
  if (configuredPath === undefined) return undefined;
  if (configuredPath.trim().length === 0 || !isAbsolute(configuredPath)) {
    throw new Error(`${MCP_TRUSTED_VERIFICATION_FILE_ENV} must be an absolute host-owned config path.`);
  }
  const { config } = await loadConfig({ configPath: configuredPath });
  return config.verification;
}

function constraintsArgument(
  args: JsonObject,
  options: { productExecution?: boolean } = {},
): { constraints?: RouteConstraints } {
  const constraints = constraintsFromArgs(args, options);
  return constraints === undefined ? {} : { constraints };
}

function constraintsFromArgs(
  args: JsonObject,
  options: { productExecution?: boolean } = {},
): RouteConstraints | undefined {
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
  if (options.productExecution === true && speed !== undefined) {
    throw new Error("counterlane_execute uses speedMode (off, auto, or fast), not a raw speed tier.");
  }
  if (speed !== undefined && speed !== "auto") constraints.speedId = speed;
  const speedMode = optionalString(args, "speedMode");
  if (options.productExecution === true) {
    const resolvedMode = speedMode ?? "auto";
    if (resolvedMode !== "off" && resolvedMode !== "auto" && resolvedMode !== "fast") {
      throw new Error("speedMode must be off, auto, or fast");
    }
    constraints.speedMode = resolvedMode;
  } else if (speedMode !== undefined) {
    throw new Error("speedMode is supported only by counterlane_execute; advanced tools use raw speed.");
  }
  const executionContext = optionalString(args, "executionContext");
  if (executionContext !== undefined) {
    if (options.productExecution !== true) throw new Error("executionContext is supported only by counterlane_execute.");
    if (executionContext !== "foreground" && executionContext !== "background") {
      throw new Error("executionContext must be foreground or background");
    }
    constraints.executionContext = executionContext;
  }
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

function optionalBoolean(args: JsonObject, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
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
      completionEstimateSource: decision.selected.calibrationSamples > 0 ? "empirical-blend" : "heuristic-prior",
      badEscapeEstimate: decision.selected.badEscapeEstimate,
      badEscapeEstimateKind: "pre-turn-heuristic-risk",
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
      coverage: decision.verificationCapabilities.taskSpecificCommandCountByTier[decision.selected.proofTier] > 0
        ? "task-specific-declared"
        : "no-task-specific-declaration",
      hostVerification: "not-run",
      externalAdjudication: "not-performed",
      availableTiers: decision.verificationCapabilities.availableTiers,
      selectedCommandCount: decision.verificationCapabilities.commandCountByTier[decision.selected.proofTier],
      selectedTaskSpecificCommandCount:
        decision.verificationCapabilities.taskSpecificCommandCountByTier[decision.selected.proofTier],
      selectedRequiredCount: decision.verificationCapabilities.requiredCountByTier[decision.selected.proofTier],
      taskSpecificRequired: decision.verificationCapabilities.taskSpecificRequired,
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
      successEstimate: candidate.successEstimate,
      badEscapeEstimate: candidate.badEscapeEstimate,
      badEscapeEstimateKind: "pre-turn-heuristic-risk",
      completionEstimateSource: candidate.calibrationSamples > 0 ? "empirical-blend" : "heuristic-prior",
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
      coverage: result.arm.verification.taskSpecificTotal > 0
        ? "task-specific-declared"
        : "no-task-specific-declaration",
      checkCount: result.arm.verification.checks.length,
      hostVerified: hostVerified(result.arm.verification),
      // Backward-compatible alias. This means host verification only; MCP
      // never runs or implies an external hidden-oracle adjudication.
      verified: hostVerified(result.arm.verification),
      externalAdjudication: "not-performed",
      passed: result.arm.verification.passed,
      adequate: result.arm.verification.adequate,
      proofTier: result.arm.verification.proofTier,
      score: result.arm.verification.score,
      requiredPassed: result.arm.verification.requiredPassed,
      requiredTotal: result.arm.verification.requiredTotal,
      taskSpecificRequired: result.arm.verification.taskSpecificRequired,
      taskSpecificPassed: result.arm.verification.taskSpecificPassed,
      taskSpecificTotal: result.arm.verification.taskSpecificTotal,
      integrity: result.arm.verification.integrity ?? "unavailable",
      integrityReasons: result.arm.verification.integrityReasons ?? [],
      planHash: result.arm.verification.planHash ?? null,
      containment: result.arm.verification.containment ?? {
        filesystem: "unverified",
        network: "unverified",
        environment: "inherited",
        processLimits: "unverified",
      },
      codeOwnership: result.arm.verification.codeOwnership ?? [],
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

function summarizeArm(arm: ExperimentResult["control"]): JsonObject {
  return {
    successful: arm.successful,
    outcome: arm.outcome,
    policy: summarizePolicy(arm.policy),
    verification: {
      posture: verificationPosture(arm.verification.checks.length),
      coverage: arm.verification.taskSpecificTotal > 0
        ? "task-specific-declared"
        : "no-task-specific-declaration",
      checkCount: arm.verification.checks.length,
      hostVerified: hostVerified(arm.verification),
      verified: hostVerified(arm.verification),
      externalAdjudication: "not-performed",
      passed: arm.verification.passed,
      adequate: arm.verification.adequate,
      proofTier: arm.verification.proofTier,
      score: arm.verification.score,
      requiredPassed: arm.verification.requiredPassed,
      requiredTotal: arm.verification.requiredTotal,
      taskSpecificRequired: arm.verification.taskSpecificRequired,
      taskSpecificPassed: arm.verification.taskSpecificPassed,
      taskSpecificTotal: arm.verification.taskSpecificTotal,
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

function hostVerified(report: VerificationReport): boolean {
  return report.checks.length > 0 && report.adequate && report.passed;
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
