import type {
  ExperimentResult,
  MetaDecision,
  MetaExecutionResult,
  ModelCatalog,
  RouteDecision,
  SingleRunResult,
  TelemetryEvent,
} from "../core/types.js";
import { round } from "../core/utils.js";

const useColor = process.stdout.isTTY && process.env["NO_COLOR"] === undefined;
const ansi = {
  bold: (text: string) => color("1", text),
  dim: (text: string) => color("2", text),
  green: (text: string) => color("32", text),
  yellow: (text: string) => color("33", text),
  red: (text: string) => color("31", text),
  cyan: (text: string) => color("36", text),
};

export function printRoute(decision: RouteDecision): void {
  const selected = decision.selected;
  process.stdout.write(`${ansi.bold(selected.admissible ? "Counterlane route" : "Counterlane diagnostic route — NOT EXECUTABLE")}\n`);
  process.stdout.write(`  Action: ${selected.admissible ? ansi.green("execute") : ansi.red("abstain")}\n`);
  process.stdout.write(`  Route: ${ansi.cyan(sanitizeTerminalText(routeLabel(selected.modelFamily, selected.effort, selected.speedId, selected.topology, selected.proofTier)))} (${sanitizeTerminalText(selected.modelId)})\n`);
  process.stdout.write(`  Service tier: ${sanitizeTerminalText(selected.serviceTier ?? "standard")}\n`);
  const constraints = formatRouteConstraints(decision.constraints);
  if (constraints !== null) {
    process.stdout.write(`  Route controls: ${sanitizeTerminalText(constraints)}\n`);
  }
  process.stdout.write(`  Task: ${decision.features.taskKind}\n`);
  process.stdout.write(`  Proof tier: ${selected.proofTier}\n`);
  process.stdout.write(`  Verification fingerprint: ${decision.verificationCapabilities.fingerprint.slice(0, 16)}\n`);
  process.stdout.write(`  Success estimate: ${percent(selected.successEstimate)}\n`);
  process.stdout.write(`  Detection estimate: ${percent(selected.detectionEstimate)}\n`);
  process.stdout.write(`  Bad-escape estimate: ${percent(selected.badEscapeEstimate)}\n`);
  process.stdout.write(`  Predicted duration: ${(selected.predictedDurationMs / 1000).toFixed(1)}s mean / ${(selected.predictedP90DurationMs / 1000).toFixed(1)}s p90\n`);
  process.stdout.write(`  Predicted normalized credits: ${selected.predictedNormalizedCredits.toFixed(3)}\n`);
  process.stdout.write(`  Calibration samples: ${selected.calibrationSamples}\n`);
  process.stdout.write(`  Estimated speed cost: ${selected.speedCostMultiplier.toFixed(2)}x\n`);
  process.stdout.write(`  Estimated latency factor: ${selected.speedLatencyMultiplier.toFixed(3)}x\n`);
  process.stdout.write(`  Quota pressure: ${decision.quota.known ? percent(decision.quota.pressure) : "unknown (premium/Twin disabled)"}\n`);
  if (decision.quota.exhausted) {
    process.stdout.write(
      `  Quota status: ${ansi.red("exhausted")} (${sanitizeTerminalText(decision.quota.sourceLimitId ?? "selected")}, reached=${sanitizeTerminalText(decision.quota.rateLimitReachedType ?? "usage boundary")})\n`,
    );
  }
  process.stdout.write(`  Objective: ${round(selected.objective)}\n`);
  if (!selected.admissible) {
    process.stdout.write(`  Rejections:\n${selected.rejectionReasons.map((reason) => `    - ${sanitizeTerminalText(reason)}`).join("\n")}\n`);
  }
  process.stdout.write(`  Rationale:\n${decision.rationale.map((item) => `    - ${sanitizeTerminalText(item)}`).join("\n")}\n`);
  process.stdout.write(`\n${ansi.dim("Top candidates")}\n`);
  const rows = decision.candidates.slice(0, 12).map((candidate) => [
    routeLabel(candidate.modelFamily, candidate.effort, candidate.speedId, candidate.topology, candidate.proofTier),
    candidate.modelId,
    percent(candidate.successEstimate),
    percent(candidate.detectionEstimate),
    `${(candidate.predictedP90DurationMs / 1000).toFixed(0)}s`,
    candidate.predictedNormalizedCredits.toFixed(1),
    round(candidate.objective).toString(),
    candidate.admissible ? "yes" : "no",
  ]);
  printTable(["Route", "Model", "P(success)", "P(detect)", "P90", "Credits", "Objective", "Admissible"], rows);
}

export function printMetaDecision(decision: MetaDecision): void {
  process.stdout.write(`${ansi.bold("Counterlane meta-decision")}\n`);
  process.stdout.write(`  Action: ${formatMetaAction(decision.action)}\n`);
  process.stdout.write(`  Context: ${sanitizeTerminalText(decision.context.key)}\n`);
  process.stdout.write(`  Evidence key: ${sanitizeTerminalText(decision.posterior.evidenceKey)}\n`);
  process.stdout.write(`  Paired samples: ${decision.posterior.sampleCount}\n`);
  process.stdout.write(`  Estimated uplift: ${decision.posterior.mean.toFixed(3)}\n`);
  process.stdout.write(
    `  Confidence interval: [${decision.posterior.lowerBound.toFixed(3)}, ${decision.posterior.upperBound.toFixed(3)}]\n`,
  );
  process.stdout.write(`  Expected information value: ${decision.expectedInformationValue.toFixed(3)}\n`);
  process.stdout.write(`  Estimated twin cost: ${decision.estimatedTwinCost.toFixed(3)}\n`);
  process.stdout.write(`  Reasons:\n${decision.reasons.map((reason) => `    - ${sanitizeTerminalText(reason)}`).join("\n")}\n`);
}

export function printMetaExecution(result: MetaExecutionResult): void {
  printMetaDecision(result.decision);
  process.stdout.write(`\n${ansi.bold("Execution")}\n`);
  process.stdout.write(`  Decision ID: ${sanitizeTerminalText(result.decisionId)}\n`);
  process.stdout.write(`  Mode: ${result.execution}\n`);
  process.stdout.write(`  Decision artifact: ${sanitizeTerminalText(result.artifactPath)}\n\n`);
  if (result.single !== undefined) {
    printSingle(result.single);
  } else if (result.twin !== undefined) {
    printExperiment(result.twin);
  } else {
    process.stdout.write(`${ansi.yellow("No unattended execution was performed.")}\n`);
  }
}

export function printModels(catalog: ModelCatalog): void {
  const rows = catalog.models.map((model) => [
    model.isDefault ? "*" : "",
    model.id,
    model.displayName,
    model.defaultReasoningEffort,
    model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort).join(", "),
    model.defaultServiceTier ?? "standard",
    model.serviceTiers.map((tier) => `${tier.id} (${tier.name})`).join(", ") || "standard only",
    model.hidden ? "yes" : "no",
  ]);
  printTable(
    ["", "ID", "Name", "Default effort", "Supported efforts", "Default speed", "Advertised speed tiers", "Hidden"],
    rows,
  );
}

export function printExperiment(result: ExperimentResult): void {
  const winner = result.winner.winner;
  process.stdout.write(`${ansi.bold("Counterlane paired experiment")} ${ansi.dim(result.experimentId)}\n`);
  process.stdout.write(`  Winner: ${formatWinner(winner)}\n`);
  process.stdout.write(`  Decision: ${sanitizeTerminalText(result.winner.reason)}\n`);
  process.stdout.write(`  Original repository unchanged: ${formatBoolean(result.originalStateUnchanged)}\n`);
  process.stdout.write(`  Winner applied: ${formatBoolean(result.appliedWinner)}\n`);
  process.stdout.write(`  Certificate: ${sanitizeTerminalText(result.certificatePath)}\n\n`);
  printTable(
    ["Arm", "Route", "Outcome", "Verified", "Score", "Credits", "Utility", "Files", "Duration"],
    [
      armRow("control", result.control),
      armRow("treatment", result.treatment),
    ],
  );
}

export function printSingle(result: SingleRunResult): void {
  process.stdout.write(`${ansi.bold("Counterlane run")} ${ansi.dim(result.runId)}\n`);
  process.stdout.write(`  Mode: ${result.mode}\n`);
  process.stdout.write(
    `  Route: ${sanitizeTerminalText(routeLabel(result.arm.policy.modelFamily, result.arm.policy.effort, result.arm.policy.speedId, result.arm.policy.topology, result.arm.policy.proofTier))} (${sanitizeTerminalText(result.arm.policy.modelId)})\n`,
  );
  process.stdout.write(`  Service tier: ${sanitizeTerminalText(result.arm.policy.serviceTier ?? "standard")}\n`);
  process.stdout.write(`  Outcome: ${result.arm.outcome}\n`);
  process.stdout.write(`  Verified: ${formatBoolean(result.arm.successful)}\n`);
  process.stdout.write(`  Proof tier: ${result.arm.verification.proofTier}\n`);
  process.stdout.write(`  Proof adequate: ${formatBoolean(result.arm.verification.adequate)}\n`);
  process.stdout.write(`  Verification score: ${result.arm.verification.score.toFixed(3)}\n`);
  process.stdout.write(`  Normalized credits: ${result.arm.cost.normalizedCredits.toFixed(3)}\n`);
  process.stdout.write(`  Applied: ${formatBoolean(result.applied)}\n`);
  process.stdout.write(`  Artifacts: ${sanitizeTerminalText(result.artifactDirectory)}\n`);
}

export function printHistory(events: readonly TelemetryEvent[]): void {
  if (events.length === 0) {
    process.stdout.write("No telemetry events found.\n");
    return;
  }
  const rows = events.map((event) => [
    event.timestamp,
    event.type,
    event.experimentId ?? "",
    summarizePayload(event.payload),
  ]);
  printTable(["Timestamp", "Type", "Experiment", "Summary"], rows);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printDoctorCheck(label: string, ok: boolean, detail: string): void {
  const status = ok ? ansi.green("PASS") : ansi.red("FAIL");
  process.stdout.write(`${status} ${sanitizeTerminalText(label)}: ${sanitizeTerminalText(detail)}\n`);
}

function armRow(label: string, arm: ExperimentResult["control"]): string[] {
  return [
    label,
    routeLabel(arm.policy.modelFamily, arm.policy.effort, arm.policy.speedId, arm.policy.topology, arm.policy.proofTier),
    arm.outcome,
    arm.successful ? "yes" : "no",
    arm.verification.score.toFixed(3),
    arm.cost.normalizedCredits.toFixed(3),
    arm.utility.toFixed(3),
    String(arm.diffSummary.filesChanged),
    `${(arm.durationMs / 1000).toFixed(1)}s`,
  ];
}

function formatRouteConstraints(constraints: RouteDecision["constraints"]): string | null {
  const entries: string[] = [];
  if (constraints.modelId !== undefined) entries.push(`model=${constraints.modelId}`);
  if (constraints.modelFamily !== undefined) entries.push(`family=${constraints.modelFamily}`);
  if (constraints.effort !== undefined) entries.push(`effort=${constraints.effort}`);
  if (constraints.speedId !== undefined) entries.push(`speed=${constraints.speedId}`);
  if (constraints.topology !== undefined) entries.push(`topology=${constraints.topology}`);
  if (constraints.latencyPriority !== undefined) entries.push(`latency=${constraints.latencyPriority}`);
  if (constraints.proofTier !== undefined) entries.push(`proof=${constraints.proofTier}`);
  if (constraints.deadlineMs !== undefined) entries.push(`deadline=${constraints.deadlineMs}ms`);
  if (constraints.maxNormalizedCredits !== undefined) entries.push(`maxCredits=${constraints.maxNormalizedCredits}`);
  return entries.length === 0 ? null : entries.join(", ");
}

function routeLabel(family: string, effort: string, speed: string, topology: string, proof?: string): string {
  return `${family}/${effort}/${speed}${topology === "ultra" ? "/ultra" : ""}${proof === undefined ? "" : `/proof:${proof}`}`;
}

function printTable(headers: string[], rows: string[][]): void {
  const safeHeaders = headers.map(sanitizeTerminalText);
  const safeRows = rows.map((row) => row.map(sanitizeTerminalText));
  const widths = safeHeaders.map((header, index) =>
    Math.max(header.length, ...safeRows.map((row) => (row[index] ?? "").length)),
  );
  process.stdout.write(`${formatRow(safeHeaders, widths)}\n`);
  process.stdout.write(`${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
  for (const row of safeRows) {
    process.stdout.write(`${formatRow(row, widths)}\n`);
  }
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}

function formatRow(row: string[], widths: number[]): string {
  return widths.map((width, index) => (row[index] ?? "").padEnd(width)).join("  ");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatBoolean(value: boolean): string {
  return value ? ansi.green("yes") : ansi.red("no");
}

function formatMetaAction(value: MetaDecision["action"]): string {
  switch (value) {
    case "auto":
      return ansi.green(value);
    case "twin":
      return ansi.cyan(value);
    case "static":
      return ansi.yellow(value);
    case "abstain":
      return ansi.red(value);
  }
}

function formatWinner(value: ExperimentResult["winner"]["winner"]): string {
  if (value === "treatment") {
    return ansi.green(value);
  }
  if (value === "control") {
    return ansi.yellow(value);
  }
  return value === "none" ? ansi.red(value) : value;
}

function summarizePayload(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload).slice(0, 5);
  return entries.map(([key, value]) => `${key}=${primitive(value)}`).join(" ");
}

function primitive(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return Array.isArray(value) ? `[${value.length}]` : value === null ? "null" : "{…}";
}

function color(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}
