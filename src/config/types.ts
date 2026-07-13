import type { JsonObject } from "../core/json.js";
import type { ProofTier, RoutingProfile } from "../core/types.js";

export interface VerificationCommandConfig {
  name: string;
  command: string[];
  required: boolean;
  timeoutMs?: number;
  environment?: Record<string, string>;
  /** Lowest proof tier that executes this command. */
  minimumTier?: ProofTier;
}

/**
 * Local economic model for a Codex service tier. The runtime catalog is the
 * source of truth for availability; these values only estimate cost/latency.
 */
export interface SpeedProfileOverrideConfig {
  /** Case-insensitive substring matcher, or `re:<pattern>` for a regular expression. */
  matcher: string;
  costMultiplier?: number;
  latencyMultiplier?: number;
}

export interface SpeedProfileConfig {
  costMultiplier: number;
  latencyMultiplier: number;
  premium: boolean;
  /** Optional per-model economics because Fast pricing can differ by model. */
  modelOverrides?: SpeedProfileOverrideConfig[];
}

export interface CounterlaneConfig {
  version: 1;
  dataDirectory: string;
  codex: {
    command: string;
    args: string[];
    startupTimeoutMs: number;
    requestTimeoutMs: number;
    turnTimeoutMs: number;
    shutdownTimeoutMs: number;
    experimentalApi: boolean;
    approvalPolicy: "never" | "on-request" | "untrusted";
    sandbox: {
      type: "workspaceWrite" | "readOnly";
      networkAccess: boolean;
    };
    extraTurnParams: JsonObject;
  };
  routing: {
    profile: RoutingProfile;
    static: {
      family: "luna" | "terra" | "sol";
      effort: string;
      /** "standard" maps to serviceTier=null. */
      speed: string;
    };
    familyMatchers: {
      luna: string[];
      terra: string[];
      sol: string[];
    };
    candidateEfforts: string[];
    prediction: {
      baselineDurationMs: number;
      p90Multiplier: number;
      minimumCalibrationSamples: number;
      shrinkageSamples: number;
      fallbackCreditsPerCostWeight: number;
    };
    speed: {
      enabled: boolean;
      /** Candidate logical speed ids. "standard" is always locally available. */
      candidateTiers: string[];
      defaultTier: string;
      /** Never send a tier absent from model/list unless explicitly enabled. */
      allowUnadvertisedTiers: boolean;
      /** Premium tiers are gated once live quota usage reaches this percentage. */
      maxUsagePercentForPremium: number;
      /** Minimum task latency-sensitivity score required for premium speed. */
      minimumLatencySensitivityForPremium: number;
      profiles: Record<string, SpeedProfileConfig>;
    };
    reservePercent: number;
    enableMax: boolean;
    enableUltra: boolean;
    maxUsagePercentForMax: number;
    maxUsagePercentForUltra: number;
    minimumQuality: {
      normal: number;
      elevated: number;
      critical: number;
    };
    costModel: {
      inputCreditsPerMillionAtLuna: number;
      cachedInputCreditsPerMillionAtLuna: number;
      outputCreditsPerMillionAtLuna: number;
      familyWeights: {
        luna: number;
        terra: number;
        sol: number;
        unknown: number;
      };
    };
    weights: {
      cost: number;
      latency: number;
      quota: number;
      failure: number;
      uncertainty: number;
      switching: number;
    };
  };
  meta: {
    enabled: boolean;
    minimumExactSamples: number;
    minimumFallbackSamples: number;
    maximumTwinSamplesPerContext: number;
    confidenceZ: number;
    upliftMargin: number;
    priorStrength: number;
    priorStandardDeviation: number;
    expectedFutureSimilarTasks: number;
    informationValueScale: number;
    twinCostMultiplier: number;
    maximumQuotaPressureForTwin: number;
    maximumUsedPercentForTwin: number;
    minimumCriticalVerifierStrength: number;
  };
  twin: {
    execution: "parallel" | "sequential";
    preserveWorktrees: "never" | "on-failure" | "always";
    maximumDurationMs: number;
    applyWinnerByDefault: boolean;
    requireOriginalStateUnchanged: boolean;
    worktreeBaseDirectory: string | null;
    dependencyDirectories: string[];
    maximumDependencyFiles: number;
    maximumDependencyBytes: number;
  };
  verification: {
    autoDetect: boolean;
    routing: {
      enabled: boolean;
      candidateTiers: ProofTier[];
      defaultTier: ProofTier;
      minimumTierByRisk: {
        normal: ProofTier;
        elevated: ProofTier;
        critical: ProofTier;
      };
      costWeights: Record<ProofTier, number>;
      detectionBoosts: Record<ProofTier, number>;
      detectionFloors: Record<ProofTier, number>;
      minimumIndependentChecks: Record<ProofTier, number>;
    };
    requireAtLeastOne: boolean;
    failOnNoVerifier: boolean;
    defaultTimeoutMs: number;
    maximumOutputBytes: number;
    commands: VerificationCommandConfig[];
  };
  telemetry: {
    enabled: boolean;
    includePrompt: boolean;
    allowHostLedgerLearning: boolean;
    file: string;
    maximumReadEvents: number;
    maximumReadBytes: number;
  };
  utility: {
    verifiedSuccessValue: number;
    verificationScoreValue: number;
    normalizedCreditPenalty: number;
    latencyPenaltyPerMinute: number;
    failedTurnPenalty: number;
    badEscapePenalty: number;
    practicalEquivalenceMargin: number;
  };
}
