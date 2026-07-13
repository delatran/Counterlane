import type {
  ArmPolicy,
  MetaContext,
  RepoProfile,
  RiskTier,
  ScopeTier,
  TaskFeatures,
  VerifierTier,
} from "../core/types.js";
import { clamp } from "../core/utils.js";

/**
 * Converts continuous task/repository features into a deliberately coarse,
 * privacy-preserving context key. The key is stable enough for local causal
 * learning without storing the raw prompt.
 */
export function buildMetaContext(
  features: TaskFeatures,
  repo: RepoProfile,
  configuredVerifierStrength = 0,
  routeSignature = "*",
): MetaContext {
  const riskTier = classifyRisk(features);
  const verifierStrength = Math.max(
    estimateVerifierStrength(features, repo),
    clamp(configuredVerifierStrength),
  );
  const verifierTier = classifyVerifier(verifierStrength);
  const scopeTier = classifyScope(features, repo);
  const taskKind = features.taskKind;
  const base = `${taskKind}|risk:${riskTier}|verify:${verifierTier}|scope:${scopeTier}`;
  const key = `${base}|route:${routeSignature}`;
  const fallbackKeys = [
    key,
    `${base}|route:*`,
    base, // legacy 0.1/early 0.2 evidence
    `${taskKind}|risk:${riskTier}|verify:${verifierTier}|scope:*|route:*`,
    `${taskKind}|risk:${riskTier}|verify:*|scope:*|route:*`,
    `${taskKind}|risk:*|verify:*|scope:*|route:*`,
    `*|risk:${riskTier}|verify:*|scope:*|route:*`,
    "*|risk:*|verify:*|scope:*|route:*",
    "*|risk:*|verify:*|scope:*", // legacy global evidence
  ];

  return {
    key,
    fallbackKeys,
    taskKind,
    riskTier,
    verifierTier,
    scopeTier,
    verifierStrength,
    routeSignature,
  };
}

/**
 * A privacy-preserving intervention label used for exact paired-uplift evidence.
 * It intentionally excludes raw model ids and prompts while retaining every
 * first-class route axis, including speed-only changes.
 */
export function routeInterventionSignature(control: ArmPolicy, treatment: ArmPolicy): string {
  return `${policySignature(control)}>${policySignature(treatment)}`;
}

function policySignature(policy: ArmPolicy): string {
  return [policy.modelFamily, policy.effort, policy.speedId, policy.topology, policy.proofTier]
    .map((part) => encodeURIComponent(part.toLowerCase()))
    .join("~");
}

export function classifyRisk(features: TaskFeatures): RiskTier {
  if (features.risk >= 0.72 || features.destructivePotential >= 0.72) {
    return "critical";
  }
  if (features.risk >= 0.4 || features.destructivePotential >= 0.4 || features.depth >= 0.72) {
    return "elevated";
  }
  return "normal";
}

export function estimateVerifierStrength(features: TaskFeatures, repo: RepoProfile): number {
  const testDensity = repo.trackedFileCount === 0
    ? 0
    : clamp((repo.testFileCount / repo.trackedFileCount) * 10);
  const explicitVerifierHints = clamp(repo.verifierHints.length / 5);
  return clamp(
    features.verifiability * 0.64 +
    testDensity * 0.22 +
    explicitVerifierHints * 0.1 +
    features.mechanicalness * 0.04,
  );
}

function classifyVerifier(strength: number): VerifierTier {
  if (strength >= 0.68) {
    return "strong";
  }
  if (strength >= 0.36) {
    return "moderate";
  }
  return "weak";
}

export function classifyScope(features: TaskFeatures, repo: RepoProfile): ScopeTier {
  const repositoryBreadth = clamp(repo.packageCount / 10 + Math.log10(Math.max(10, repo.trackedFileCount)) / 8);
  const combined = clamp(features.breadth * 0.76 + repositoryBreadth * 0.24);
  if (combined >= 0.62) {
    return "broad";
  }
  if (combined >= 0.28) {
    return "medium";
  }
  return "narrow";
}
