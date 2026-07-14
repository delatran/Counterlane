import type { CounterlaneConfig } from "../config/types.js";
import { SafetyError } from "../core/errors.js";
import type {
  ArmPolicy,
  ModelCatalog,
  QuotaState,
  RepoProfile,
  RouteDecision,
  RouteCalibrationIndex,
  RouteConstraints,
  VerificationCapabilitySummary,
} from "../core/types.js";
import { AutoRouter, requireAdmissibleRoute } from "../routing/router.js";

export function revalidateControlPolicy(options: {
  policy: ArmPolicy;
  prompt: string;
  config: CounterlaneConfig;
  catalog: ModelCatalog;
  quota: QuotaState;
  repo: RepoProfile;
  verificationCapabilities: VerificationCapabilitySummary;
  calibration: RouteCalibrationIndex;
}): ArmPolicy {
  if (!options.verificationCapabilities.availableTiers.includes(options.policy.proofTier)) {
    throw new SafetyError(`The planned static proof tier ${options.policy.proofTier} is no longer available.`);
  }
  const current = new AutoRouter(options.config).staticPolicy(options.catalog, options.verificationCapabilities);
  const expected = [
    current.model.id,
    current.family,
    current.effort,
    current.speedId,
    current.topology,
    current.proofTier,
  ].join("\0");
  const planned = [
    options.policy.modelId,
    options.policy.modelFamily,
    options.policy.effort,
    options.policy.speedId,
    options.policy.topology,
    options.policy.proofTier,
  ].join("\0");
  if (expected !== planned) {
    throw new SafetyError("The planned static policy no longer matches the live model catalog or verifier capabilities.", {
      planned,
      current: expected,
    });
  }
  let decision: RouteDecision;
  try {
    decision = new AutoRouter(options.config).decide({
      prompt: options.prompt,
      repo: options.repo,
      catalog: options.catalog,
      quota: options.quota,
      verificationCapabilities: options.verificationCapabilities,
      calibration: options.calibration,
      constraints: {
        modelId: options.policy.modelId,
        effort: options.policy.effort,
        speedId: options.policy.speedId,
        topology: options.policy.topology,
        proofTier: options.policy.proofTier,
      },
    });
  } catch (error) {
    throw new SafetyError("The configured static policy violates current task safety or quota gates.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const selected = requireAdmissibleRoute(decision).selected;
  return {
    ...options.policy,
    modelId: selected.modelId,
    modelFamily: selected.modelFamily,
    effort: selected.effort,
    serviceTier: selected.serviceTier,
    speedId: selected.speedId,
    speedCostMultiplier: selected.speedCostMultiplier,
    speedLatencyMultiplier: selected.speedLatencyMultiplier,
    topology: selected.topology,
    proofTier: selected.proofTier,
    routeDecision: decision,
  };
}

export function revalidateTreatmentPolicy(options: {
  policy: ArmPolicy;
  prompt: string;
  config: CounterlaneConfig;
  catalog: ModelCatalog;
  quota: QuotaState;
  repo: RepoProfile;
  verificationCapabilities: VerificationCapabilitySummary;
  calibration: RouteCalibrationIndex;
  constraints?: RouteConstraints;
}): ArmPolicy {
  const decision = requireAdmissibleRoute(new AutoRouter(options.config).decide({
    prompt: options.prompt,
    repo: options.repo,
    catalog: options.catalog,
    quota: options.quota,
    verificationCapabilities: options.verificationCapabilities,
    calibration: options.calibration,
    constraints: {
      ...options.constraints,
      modelId: options.policy.modelId,
      effort: options.policy.effort,
      // Product speedMode is a semantic permission boundary. Reintroducing a
      // raw speedId here would both violate that boundary and create an
      // ambiguous constraint pair; the selected route is compared below.
      ...(options.constraints?.speedMode === undefined ? { speedId: options.policy.speedId } : {}),
      topology: options.policy.topology,
      proofTier: options.policy.proofTier,
    },
  }));
  const selected = decision.selected;
  if (options.constraints?.speedMode !== undefined && selected.speedId !== options.policy.speedId) {
    throw new SafetyError("The product speed route changed after preflight; a fresh no-spend preflight is required.", {
      plannedSpeed: options.policy.speedId,
      selectedSpeed: selected.speedId,
      speedMode: options.constraints.speedMode,
    });
  }
  return {
    ...options.policy,
    modelId: selected.modelId,
    modelFamily: selected.modelFamily,
    effort: selected.effort,
    serviceTier: selected.serviceTier,
    speedId: selected.speedId,
    speedCostMultiplier: selected.speedCostMultiplier,
    speedLatencyMultiplier: selected.speedLatencyMultiplier,
    topology: selected.topology,
    proofTier: selected.proofTier,
    routeDecision: decision,
  };
}
