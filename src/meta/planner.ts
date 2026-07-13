import type { CounterlaneConfig } from "../config/types.js";
import { managedStatePrefixes } from "../config/managed-state.js";
import type { Logger } from "../core/logger.js";
import type {
  ArmPolicy,
  MetaContext,
  MetaDecision,
  QuotaState,
  RepoProfile,
  RouteCandidate,
  RouteConstraints,
  RouteDecision,
} from "../core/types.js";
import { CodexAppServer } from "../codex/app-server.js";
import { GitRepository } from "../git/repository.js";
import { buildCalibrationIndex } from "../routing/calibration.js";
import { deriveQuotaState } from "../routing/quota.js";
import { AutoRouter, estimateRouteCostWeight } from "../routing/router.js";
import { TelemetryStore } from "../telemetry/store.js";
import { inspectVerificationCapabilities } from "../verification/detect.js";
import { throwIfAborted } from "../core/abort.js";
import { MetaController } from "./controller.js";
import { buildMetaContext, routeInterventionSignature } from "./context.js";
import { metaEvidenceHash, parsePairedObservations } from "./evidence.js";

export interface MetaPlan {
  decision: MetaDecision;
  context: MetaContext;
  route: RouteDecision;
  repo: RepoProfile;
  quota: QuotaState;
  controlPolicy: ArmPolicy;
  treatmentPolicy: ArmPolicy;
  evidenceHash: string;
  staticAdmissible: boolean;
}

export async function prepareMetaPlan(options: {
  prompt: string;
  repository: GitRepository;
  config: CounterlaneConfig;
  telemetry: TelemetryStore;
  logger: Logger;
  constraints?: RouteConstraints;
  signal?: AbortSignal;
}): Promise<MetaPlan> {
  throwIfAborted(options.signal);
  const server = await CodexAppServer.connect({
    config: options.config,
    cwd: options.repository.root,
    logger: options.logger.child({ component: "meta-app-server" }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    throwIfAborted(options.signal);
    const [catalog, rateLimits, repo, events, verificationCapabilities] = await Promise.all([
      server.listModels(options.signal),
      server.readRateLimits(options.signal),
      options.repository.profile(managedStatePrefixes(options.config)),
      options.telemetry.readLearningEvents(),
      inspectVerificationCapabilities(options.repository.root, options.config),
    ]);
    throwIfAborted(options.signal);
    const quota = deriveQuotaState(rateLimits, options.config.routing.reservePercent);
    const router = new AutoRouter(options.config);
    const calibration = buildCalibrationIndex(events);
    const route = router.decide({
      prompt: options.prompt,
      repo,
      catalog,
      quota,
      verificationCapabilities,
      calibration,
      ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
    });
    const staticRoute = router.staticPolicy(catalog, verificationCapabilities);
    const controlPolicy: ArmPolicy = {
      kind: "control",
      name: "static-no-auto",
      modelId: staticRoute.model.id,
      modelFamily: staticRoute.family,
      effort: staticRoute.effort,
      serviceTier: staticRoute.serviceTier,
      speedId: staticRoute.speedId,
      speedCostMultiplier: staticRoute.speedCostMultiplier,
      speedLatencyMultiplier: staticRoute.speedLatencyMultiplier,
      topology: staticRoute.topology,
      proofTier: staticRoute.proofTier,
    };
    const treatmentPolicy: ArmPolicy = {
      kind: "treatment",
      name: "counterlane-auto",
      modelId: route.selected.modelId,
      modelFamily: route.selected.modelFamily,
      effort: route.selected.effort,
      serviceTier: route.selected.serviceTier,
      speedId: route.selected.speedId,
      speedCostMultiplier: route.selected.speedCostMultiplier,
      speedLatencyMultiplier: route.selected.speedLatencyMultiplier,
      topology: route.selected.topology,
      proofTier: route.selected.proofTier,
      routeDecision: route,
    };
    const context = buildMetaContext(
      route.features,
      repo,
      route.selected.detectionEstimate,
      routeInterventionSignature(controlPolicy, treatmentPolicy),
    );
    const observations = parsePairedObservations(events);
    const evidenceHash = metaEvidenceHash(observations, calibration);
    let staticCandidate: RouteCandidate | undefined;
    try {
      staticCandidate = router.decide({
        prompt: options.prompt,
        repo,
        catalog,
        quota,
        verificationCapabilities,
        calibration,
        constraints: {
          modelId: controlPolicy.modelId,
          effort: controlPolicy.effort,
          speedId: controlPolicy.speedId,
          topology: controlPolicy.topology,
          proofTier: controlPolicy.proofTier,
        },
      }).selected;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("The requested route constraints do not satisfy Counterlane safety and quota gates")) {
        throw error;
      }
    }
    const staticCostWeight = staticCandidate?.costWeight ?? (
      estimateRouteCostWeight(
        options.config,
        controlPolicy.modelFamily,
        controlPolicy.effort,
        staticRoute.speedCostMultiplier,
      ) + options.config.verification.routing.costWeights[controlPolicy.proofTier]
    );
    const staticAdmissible = staticCandidate?.admissible ?? false;
    const decision = new MetaController(options.config).decide({
      context,
      route,
      staticModelId: controlPolicy.modelId,
      staticEffort: controlPolicy.effort,
      staticSpeedId: controlPolicy.speedId,
      staticTopology: controlPolicy.topology,
      staticProofTier: controlPolicy.proofTier,
      staticCostWeight,
      staticAdmissible,
      observations,
      quota,
    });

    return {
      decision,
      context,
      route,
      repo,
      quota,
      controlPolicy,
      treatmentPolicy,
      evidenceHash,
      staticAdmissible,
    };
  } finally {
    await server.close();
  }
}
