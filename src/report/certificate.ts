import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExperimentResult } from "../core/types.js";
import type { CounterlaneConfig } from "../config/types.js";
import { ensureContainedDirectory, resolveContainedPath } from "../core/path-safety.js";
import { writeJsonAtomic, writeUtf8Atomic } from "../core/utils.js";

export async function writeExperimentArtifacts(
  result: Omit<ExperimentResult, "certificatePath">,
  config: CounterlaneConfig,
): Promise<string> {
  const dataDirectory = resolveContainedPath(result.repositoryRoot, config.dataDirectory, {
    target: "Counterlane data directory",
    boundary: "repository",
  });
  const canonicalDataDirectory = await ensureContainedDirectory(result.repositoryRoot, dataDirectory, {
    target: "Counterlane data directory",
    boundary: "repository",
  });
  const directory = resolveContainedPath(
    canonicalDataDirectory,
    resolve(canonicalDataDirectory, "experiments", result.experimentId),
    { target: "experiment artifact directory", boundary: "configured data directory" },
  );
  const canonicalDirectory = await ensureContainedDirectory(canonicalDataDirectory, directory, {
    target: "experiment artifact directory",
    boundary: "configured data directory",
  });
  await writeUtf8Atomic(join(canonicalDirectory, "control.patch"), result.control.patch);
  await writeUtf8Atomic(join(canonicalDirectory, "treatment.patch"), result.treatment.patch);
  await writeJsonAtomic(join(canonicalDirectory, "result.json"), result as unknown as object);
  const certificatePath = join(canonicalDirectory, "certificate.md");
  await writeUtf8Atomic(certificatePath, renderCertificate(result));
  return certificatePath;
}

function renderCertificate(result: Omit<ExperimentResult, "certificatePath">): string {
  const rows: Array<[string, string, string]> = [
    ["Outcome", result.control.outcome, result.treatment.outcome],
    ["Verified success", yesNo(result.control.successful), yesNo(result.treatment.successful)],
    ["Model", result.control.policy.modelId, result.treatment.policy.modelId],
    ["Effort", result.control.policy.effort, result.treatment.policy.effort],
    ["Speed", result.control.policy.speedId, result.treatment.policy.speedId],
    ["Service tier", result.control.policy.serviceTier ?? "standard", result.treatment.policy.serviceTier ?? "standard"],
    ["Topology", result.control.policy.topology, result.treatment.policy.topology],
    ["Proof tier", result.control.policy.proofTier, result.treatment.policy.proofTier],
    ["Proof adequate", yesNo(result.control.verification.adequate), yesNo(result.treatment.verification.adequate)],
    ["Speed cost multiplier", `${result.control.policy.speedCostMultiplier.toFixed(2)}x`, `${result.treatment.policy.speedCostMultiplier.toFixed(2)}x`],
    ["Verification score", result.control.verification.score.toFixed(3), result.treatment.verification.score.toFixed(3)],
    ["Normalized credits", result.control.cost.normalizedCredits.toFixed(3), result.treatment.cost.normalizedCredits.toFixed(3)],
    ["Total tokens", tokenValue(result.control, "totalTokens"), tokenValue(result.treatment, "totalTokens")],
    ["Input tokens", tokenValue(result.control, "inputTokens"), tokenValue(result.treatment, "inputTokens")],
    ["Cached input tokens", tokenValue(result.control, "cachedInputTokens"), tokenValue(result.treatment, "cachedInputTokens")],
    ["Output tokens", tokenValue(result.control, "outputTokens"), tokenValue(result.treatment, "outputTokens")],
    ["Diagnostic utility (not the selection basis)", result.control.utility.toFixed(3), result.treatment.utility.toFixed(3)],
    ["Files changed", String(result.control.diffSummary.filesChanged), String(result.treatment.diffSummary.filesChanged)],
    ["Duration", formatDuration(result.control.durationMs), formatDuration(result.treatment.durationMs)],
    ["Backend reroutes", String(result.control.turn.reroutes.length), String(result.treatment.turn.reroutes.length)],
    ["Warnings", String(result.control.turn.warnings.length), String(result.treatment.turn.warnings.length)],
  ];

  return `# Counterlane experiment certificate\n\n` +
    `- Experiment: \`${result.experimentId}\`\n` +
    `- Prompt hash: \`${result.promptHash}\`\n` +
    `- Repository snapshot: \`${result.snapshot.workingStateHash}\`\n` +
    `- Winner: **${result.winner.winner}**\n` +
    `- Decision: ${escapeInline(result.winner.reason)}\n` +
    `- Decision strength: ${result.winner.decisionStrength}\n` +
    `- Cost leader: ${result.winner.costLeader} (${result.winner.costComparison})\n` +
    `- Latency leader: ${result.winner.latencyLeader}\n` +
    `- Partial leader: ${result.winner.partialLeader ?? "none"} (non-applicable)\n` +
    `- Confidence: ${result.winner.confidenceStatus}; no calibrated confidence value is produced\n` +
    `- Original working state unchanged: ${yesNo(result.originalStateUnchanged)}\n` +
    `- Winner applied: ${yesNo(result.appliedWinner)}\n` +
    `- Post-apply verification: ${result.postApplyVerification === undefined ? "not run" : yesNo(result.postApplyVerification.passed)}\n\n` +
    `| Metric | Control | Treatment |\n|---|---:|---:|\n` +
    rows.map(([metric, control, treatment]) => `| ${metric} | ${escapeCell(control)} | ${escapeCell(treatment)} |`).join("\n") +
    `\n\n## Treatment route rationale\n\n` +
    (result.treatment.policy.routeDecision?.rationale.map((item) => `- ${escapeInline(item)}`).join("\n") ?? "- Static treatment route") +
    `\n\n## Verification checks\n\n` +
    renderChecks("Control", result.control.verification.checks) +
    `\n\n` +
    renderChecks("Treatment", result.treatment.verification.checks) +
    `\n\n## Runtime warnings and reroutes\n\n` +
    renderRuntimeEvidence("Control", result.control.turn.warnings, result.control.turn.reroutes) +
    `\n\n` +
    renderRuntimeEvidence("Treatment", result.treatment.turn.warnings, result.treatment.turn.reroutes) +
    `\n`;
}

function renderChecks(label: string, checks: ExperimentResult["control"]["verification"]["checks"]): string {
  if (checks.length === 0) {
    return `### ${label}\n\nNo verifier command completed.`;
  }
  return `### ${label}\n\n` + checks.map((check) => {
    const state = check.result.aborted
      ? "ABORT"
      : check.result.timedOut
        ? "TIMEOUT"
        : check.passed ? "PASS" : "FAIL";
    return `- ${state} [proof:${check.minimumTier}] \`${escapeInline(check.command.join(" "))}\` ` +
      `(${check.result.durationMs} ms, exit=${check.result.exitCode ?? "null"})`;
  }).join("\n");
}

function renderRuntimeEvidence(
  label: string,
  warnings: readonly string[],
  reroutes: readonly { fromModel: string; toModel: string; reason?: string }[],
): string {
  const lines = [
    ...reroutes.map((reroute) =>
      `- REROUTE ${escapeInline(reroute.fromModel)} → ${escapeInline(reroute.toModel)}` +
      `${reroute.reason === undefined ? "" : ` (${escapeInline(reroute.reason)})`}`
    ),
    ...warnings.map((warning) => `- WARNING ${escapeInline(warning)}`),
  ];
  return `### ${label}\n\n${lines.length === 0 ? "No runtime warnings or backend reroutes." : lines.join("\n")}`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function escapeCell(value: string): string {
  return escapeInline(value).replaceAll("|", "\\|");
}

function escapeInline(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\r\n]+/gu, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]+/gu, " ")
    .replaceAll("`", "&#96;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function tokenValue(
  arm: ExperimentResult["control"],
  field: "totalTokens" | "inputTokens" | "cachedInputTokens" | "outputTokens",
): string {
  return arm.turn.tokenUsage === undefined ? "unavailable" : String(arm.turn.tokenUsage.last[field]);
}
