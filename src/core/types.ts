import type { JsonObject, JsonValue } from "./json.js";

export type ModelFamily = "luna" | "terra" | "sol" | "unknown";
export type RoutingProfile = "economy" | "balanced" | "quality";
export type Topology = "single" | "ultra";
export type SpeedId = string;
export type LatencyPriority = "economy" | "balanced" | "urgent";
export type ArmKind = "control" | "treatment";
export type ExperimentMode = "static" | "auto" | "twin";
export type MetaAction = "static" | "auto" | "twin" | "abstain";
export type RiskTier = "normal" | "elevated" | "critical";
export type VerifierTier = "weak" | "moderate" | "strong";
export type ProofTier = "basic" | "standard" | "strong" | "adversarial";
export type ArmOutcome = "success" | "failure" | "timeout" | "cancelled";
export type ScopeTier = "narrow" | "medium" | "broad";

export interface RouteConstraints {
  /** Exact model id advertised by model/list. */
  modelId?: string;
  /** Restrict Auto to one advertised capability family. */
  modelFamily?: Exclude<ModelFamily, "unknown">;
  /** Exact reasoning effort advertised for the selected model. */
  effort?: string;
  /** Logical speed id. "standard" maps to serviceTier=null. */
  speedId?: SpeedId;
  /** Topology is conceptually separate; Ultra is encoded by the Ultra effort on the wire. */
  topology?: Topology;
  /** Soft urgency intent used when Auto is allowed to choose the speed tier. */
  latencyPriority?: LatencyPriority;
  /** Hard proof-burden constraint. Higher tiers run a superset of lower-tier checks. */
  proofTier?: ProofTier;
  /** Hard wall-clock target for the complete routed arm, in milliseconds. */
  deadlineMs?: number;
  /** Hard normalized-credit ceiling for the routed arm. */
  maxNormalizedCredits?: number;
}

export interface ReasoningEffortOption {
  reasoningEffort: string;
  description?: string | null;
}

export interface ModelServiceTierOption {
  id: string;
  name: string;
  description: string;
}

export interface ModelCatalogEntry {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
  serviceTiers: ModelServiceTierOption[];
  defaultServiceTier: string | null;
  isDefault: boolean;
  inputModalities?: string[];
  raw: JsonObject;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
  fetchedAt: string;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface RateLimitBucket {
  limitId: string;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  rateLimitReachedType?: string | null;
}

export interface RateLimitSnapshot {
  primary?: RateLimitBucket | null;
  byId: Record<string, RateLimitBucket>;
  planType?: string | null;
  fetchedAt: string;
  raw: JsonObject;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface RepoProfile {
  root: string;
  headCommit: string;
  branch: string | null;
  dirty: boolean;
  trackedFileCount: number;
  untrackedFileCount: number;
  changedFileCount: number;
  packageCount: number;
  testFileCount: number;
  languages: Record<string, number>;
  sensitivePathHits: string[];
  manifests: string[];
  verifierHints: string[];
  profileHash: string;
}

export interface TaskFeatures {
  ambiguity: number;
  breadth: number;
  depth: number;
  risk: number;
  verifiability: number;
  mechanicalness: number;
  novelty: number;
  parallelizability: number;
  latencySensitivity: number;
  destructivePotential: number;
  taskKind:
    | "mechanical_edit"
    | "bugfix"
    | "feature"
    | "refactor"
    | "review"
    | "research"
    | "migration"
    | "security"
    | "unknown";
  evidence: string[];
}

export interface QuotaState {
  known: boolean;
  exhausted: boolean;
  rateLimitReachedType: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  minutesUntilReset: number | null;
  pressure: number;
  healthy: boolean;
  sourceLimitId: string | null;
}

export interface MetaContext {
  key: string;
  fallbackKeys: string[];
  taskKind: TaskFeatures["taskKind"];
  riskTier: RiskTier;
  verifierTier: VerifierTier;
  scopeTier: ScopeTier;
  verifierStrength: number;
  routeSignature: string;
}

export interface PairedUpliftObservation {
  experimentId: string;
  timestamp: string;
  contextKeys: string[];
  utilityDelta: number;
  verifiedSuccessDelta: number;
  controlSuccessful: boolean;
  treatmentSuccessful: boolean;
}

export interface UpliftPosterior {
  evidenceKey: string;
  sampleCount: number;
  priorSampleCount: number;
  mean: number;
  standardDeviation: number;
  standardError: number;
  lowerBound: number;
  upperBound: number;
  treatmentWinRate: number;
  controlWinRate: number;
  tieRate: number;
}

export interface MetaDecision {
  action: MetaAction;
  context: MetaContext;
  posterior: UpliftPosterior;
  expectedInformationValue: number;
  estimatedTwinCost: number;
  routeEquivalentToStatic: boolean;
  reasons: string[];
  decidedAt: string;
}

export interface RouteCalibration {
  routeKey: string;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
  successRate: number;
  meanDurationMs: number;
  standardDeviationDurationMs: number;
  p90DurationMs: number;
  meanNormalizedCredits: number;
  updatedAt: string;
}

export interface RouteCalibrationIndex {
  byRouteKey: Record<string, RouteCalibration>;
  sampleCount: number;
  ignoredObservationCount: number;
  builtAt: string;
}

export interface VerificationCapabilitySummary {
  availableTiers: ProofTier[];
  commandCountByTier: Record<ProofTier, number>;
  requiredCountByTier: Record<ProofTier, number>;
  estimatedCostWeightByTier: Record<ProofTier, number>;
  fingerprint: string;
}

export interface RouteCandidate {
  modelId: string;
  modelFamily: ModelFamily;
  effort: string;
  serviceTier: string | null;
  speedId: SpeedId;
  speedName: string;
  speedCostMultiplier: number;
  speedLatencyMultiplier: number;
  topology: Topology;
  proofTier: ProofTier;
  proofCostWeight: number;
  detectionEstimate: number;
  predictedDurationMs: number;
  predictedP90DurationMs: number;
  predictedNormalizedCredits: number;
  calibrationSamples: number;
  capabilityScore: number;
  costWeight: number;
  latencyWeight: number;
  successEstimate: number;
  uncertainty: number;
  badEscapeEstimate: number;
  quotaPenalty: number;
  switchPenalty: number;
  objective: number;
  admissible: boolean;
  rejectionReasons: string[];
}

export interface RouteDecision {
  profile: RoutingProfile;
  constraints: RouteConstraints;
  selected: RouteCandidate;
  candidates: RouteCandidate[];
  features: TaskFeatures;
  repo: RepoProfile;
  quota: QuotaState;
  verificationCapabilities: VerificationCapabilitySummary;
  rationale: string[];
  decidedAt: string;
}

export interface SandboxPolicy {
  type: "readOnly" | "workspaceWrite" | "dangerFullAccess" | "externalSandbox";
  writableRoots?: string[];
  networkAccess?: boolean | "restricted" | "enabled";
  [key: string]: JsonValue | undefined;
}

export interface TurnRunRequest {
  threadId: string;
  prompt: string;
  cwd: string;
  modelId: string;
  effort: string;
  serviceTier?: string | null;
  sandboxPolicy: SandboxPolicy;
  approvalPolicy: string;
  outputSchema?: JsonObject;
  extraParams?: JsonObject;
  signal?: AbortSignal;
}

export interface ModelRerouteEvent {
  fromModel: string;
  toModel: string;
  reason?: string;
}

export interface TurnRunResult {
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed" | string;
  finalMessage: string;
  diff: string;
  tokenUsage?: ThreadTokenUsage;
  reroutes: ModelRerouteEvent[];
  warnings: string[];
  error?: JsonObject | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  rawEventCount: number;
}

export interface CommandResult {
  command: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

export interface VerificationCheck {
  name: string;
  command: string[];
  required: boolean;
  minimumTier: ProofTier;
  passed: boolean;
  result: CommandResult;
}

export interface VerificationReport {
  proofTier: ProofTier;
  adequate: boolean;
  minimumIndependentChecks: number;
  passed: boolean;
  score: number;
  requiredPassed: number;
  requiredTotal: number;
  optionalPassed: number;
  optionalTotal: number;
  checks: VerificationCheck[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  verifierHash: string;
}

export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  newFiles: number;
  deletedFiles: number;
  binaryFiles: number;
}

export interface CostEstimate {
  normalizedCredits: number;
  modelWeight: number;
  serviceTier: string | null;
  speedCostMultiplier: number;
  inputComponent: number;
  cachedInputComponent: number;
  outputComponent: number;
  source: "token_usage" | "fallback";
}

export interface ArmPolicy {
  kind: ArmKind;
  name: string;
  modelId: string;
  modelFamily: ModelFamily;
  effort: string;
  serviceTier: string | null;
  speedId: SpeedId;
  speedCostMultiplier: number;
  speedLatencyMultiplier: number;
  topology: Topology;
  proofTier: ProofTier;
  routeDecision?: RouteDecision;
}

export interface ArmResult {
  armId: string;
  experimentId: string;
  policy: ArmPolicy;
  worktreePath: string;
  baselineCommit: string;
  turn: TurnRunResult;
  patch: string;
  patchHash: string;
  diffSummary: DiffSummary;
  verification: VerificationReport;
  cost: CostEstimate;
  utility: number;
  successful: boolean;
  outcome: ArmOutcome;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error?: JsonObject;
}

export interface SnapshotManifest {
  repositoryRoot: string;
  headCommit: string;
  branch: string | null;
  baselineTreeHash: string;
  workingStateHash: string;
  trackedPatchHash: string;
  untrackedFiles: Array<{
    path: string;
    kind: "file" | "symlink";
    mode: number;
    contentHash: string;
    size: number;
  }>;
  createdAt: string;
}

export interface WinnerDecision {
  winner: ArmKind | "tie" | "none";
  reason: string;
  controlUtility: number;
  treatmentUtility: number;
  utilityDelta: number;
  verifiedSuccessDelta: number;
  confidence: number;
}

export interface ExperimentResult {
  experimentId: string;
  promptHash: string;
  prompt?: string;
  repositoryRoot: string;
  snapshot: SnapshotManifest;
  control: ArmResult;
  treatment: ArmResult;
  winner: WinnerDecision;
  originalStateUnchanged: boolean;
  appliedWinner: boolean;
  postApplyVerification?: VerificationReport;
  certificatePath: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Non-fatal persistence or cleanup failures that occurred after a durable apply result existed. */
  bookkeepingWarnings?: string[];
}

export interface SingleRunResult {
  runId: string;
  mode: "static" | "auto";
  promptHash: string;
  repositoryRoot: string;
  snapshot: SnapshotManifest;
  arm: ArmResult;
  originalStateUnchanged: boolean;
  applied: boolean;
  postApplyVerification?: VerificationReport;
  artifactDirectory: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Non-fatal persistence or cleanup failures that occurred after a durable apply result existed. */
  bookkeepingWarnings?: string[];
}

export interface MetaExecutionResult {
  decisionId: string;
  decision: MetaDecision;
  execution: "none" | "single" | "twin";
  single?: SingleRunResult;
  twin?: ExperimentResult;
  artifactPath: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Non-fatal outer-ledger failures; nested run artifacts remain authoritative. */
  bookkeepingWarnings?: string[];
}

export interface TelemetryEvent {
  id: string;
  type: string;
  timestamp: string;
  experimentId?: string;
  payload: JsonObject;
}
