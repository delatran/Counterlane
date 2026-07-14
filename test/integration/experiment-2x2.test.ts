import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { projectRoot } from "../helpers.js";

interface Assignment {
  assignmentId: string;
  blockId: string;
  order: number;
  studyId: string;
  protocolHash: string;
  taskId: string;
  taskHash: string;
  hostSurface: "codex" | "chatgpt-work";
  counterlaneEnabled: boolean;
  replicate: number;
  sourceHash: string;
  promptHash: string;
  verifierHash: string;
  oracleHash: string;
}

interface Schedule {
  assignments: Assignment[];
}

interface Study {
  protocol: Record<string, any>;
  protocolHash: string;
  tasks: Array<{
    taskId: string;
    visibleVerifier: { argv: string[]; timeoutMs: number; minimumTier: string };
  }>;
}

interface Analysis {
  trialCount: number;
  completeTaskClusters: number;
  primaryEndpoint: string;
  interaction: number | null;
  hostEffects: Record<string, {
    delta: number;
    commonCost: {
      savingsPct: number | null;
      thresholdMet: boolean | null;
      claimEligible: boolean;
      contaminationEligible: boolean;
      complianceEligible: boolean;
      reason: string;
    };
  }>;
  contamination: { retainedTrialCount: number; codes: Record<string, number> };
  automaticCodexChecks: Array<{
    contaminated: boolean;
    noncompliant: boolean;
    quota: { status: string; observedMaxUsedPercentDelta: number | null };
    route: { status: string };
  }>;
  statisticalConfidence: { claimed: boolean; reason: string };
  runtimeBindings: Array<{
    counterlaneEnabled: boolean;
    modelCatalog: { sha256: string | null };
    quotaSnapshot: { sha256: string | null };
  }>;
}

interface TokenBreakdown {
  totalTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
}

interface CommonCost {
  unit: string;
  value: number | null;
  source: string;
  breakdown: TokenBreakdown;
}

interface Harness {
  loadStudy(options?: Record<string, string>): Promise<Study>;
  resolveCounterlaneCliPath(configuredPath: string): string;
  buildCounterlaneConfig(protocol: Record<string, any>, task: Study["tasks"][number]): Record<string, any>;
  buildCounterlaneArgs(
    protocol: Record<string, any>,
    task: Study["tasks"][number],
    paths: { cliPath: string; workspace: string; configPath: string },
  ): string[];
  executeAfterPreflight<T, U>(preflight: () => Promise<T>, execute: () => Promise<U>): Promise<{ preflight: T; execution: U }>;
  captureReproduciblePatch(workspace: string, baselineCommit: string): Promise<{ stdout: string }>;
  runProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<{
    timedOut: boolean;
  }>;
  resolveTaskCommandArgv(
    specification: { argv: string[] },
    context: { cwd: string; workspace: string },
  ): string[];
  assertAssignmentReady(schedule: Schedule, existingTrials: Trial[], assignment: Assignment): void;
  acquireTrialLock(path: string): Promise<() => Promise<void>>;
  writeJsonImmutable(path: string, value: unknown): Promise<void>;
  writeAttemptMarker(rawDirectory: string, assignment: Assignment, environmentHash: string, startedAtMs?: number): Promise<string>;
  assertNoPriorAttempt(rawDirectory: string, assignment: Assignment): Promise<void>;
  cleanupExperimentWorkspace(workspace: string | null, preserveForRecovery: boolean): Promise<void>;
  buildSchedule(study: Study): Promise<Schedule>;
  validateSchedule(schedule: Schedule, study: Study): Promise<Schedule>;
  hashDirectory(root: string, excludedNames?: string[]): Promise<string>;
  validateCompleteTrials(schedule: Schedule, trials: Trial[], protocol: Record<string, any>): Trial[];
  analyzeTrials(study: Study, schedule: Schedule, trials: Trial[]): Promise<Analysis>;
  renderReport(analysis: Analysis): string;
  computeEnvironmentHash(evidence: Record<string, unknown>): string;
  extractCommonCost(stdout: string): CommonCost;
  extractCounterlaneRoute(stdout: string): Record<string, unknown> | null;
  bindCounterlaneRouteEvidence(
    evidence: Record<string, unknown>,
    counterlaneEnabled: boolean,
    stdout: string,
  ): Record<string, any>;
  validateProtocol(protocol: Record<string, unknown>): void;
  resolveExistingWithin(root: string, candidate: string, label: string, expectedType: "file" | "directory"): Promise<string>;
  retainPostRunFailure(options: Record<string, unknown>): Promise<Trial>;
  sealWorkBundle(
    study: Study,
    schedule: Schedule,
    options: Record<string, string>,
  ): Promise<{ assignmentId: string; output: string; bundlePath: string; envelopePath: string }>;
  deriveWorkTrialFromBundle(
    study: Study,
    schedule: Schedule,
    envelope: Record<string, unknown>,
    bundlePath: string,
    options?: { derivedDirectory?: string },
  ): Promise<Trial>;
}

interface Trial extends Assignment {
  schemaVersion: 1;
  startedAt: string;
  completedAt: string;
  runCompleted: boolean;
  visibleVerifierPassed: boolean;
  hiddenOraclePassed: boolean;
  verifiedSuccess: boolean;
  badEscape: boolean;
  durationMs: number;
  commonCost: CommonCost;
  treatmentCompliance: "compliant" | "noncompliant" | "unknown";
  contamination: Array<{ code: string; detail: string }>;
  runtimeEvidence: Record<string, any>;
  rawArtifactHashes: Record<string, string>;
  rawArtifactPaths: Record<string, string>;
  exitCode: number | null;
  timedOut: boolean;
  outputOverflow: boolean;
  spawnError: string | null;
}

const harnessPromise = import(
  pathToFileURL(resolve(projectRoot, "scripts", "experiment-2x2.mjs")).href
) as Promise<Harness>;
const workProtocolPath = resolve(projectRoot, "experiments", "work-codex-2x2", "protocol.json");
const appProtocolPath = resolve(projectRoot, "experiments", "work-codex-2x2", "protocol.codex-app.json");
const syntheticArtifactPath = resolve(projectRoot, "package.json");
const syntheticArtifactHash = createHash("sha256").update(readFileSync(syntheticArtifactPath)).digest("hex");
const syntheticRuntimeOutputPath = resolve(projectRoot, "test", "fixtures", "experiment-runtime-output.json");
const syntheticRuntimeOutput = readFileSync(syntheticRuntimeOutputPath, "utf8");
const mediumRuntimeOutputPath = resolve(projectRoot, "test", "fixtures", "experiment-runtime-output-medium.json");
const syntheticModelCatalogPath = resolve(projectRoot, "test", "fixtures", "experiment-model-catalog.json");
const syntheticModelCatalog = JSON.parse(readFileSync(syntheticModelCatalogPath, "utf8")) as Record<string, unknown>;
const syntheticModelCatalogHash = createHash("sha256").update(readFileSync(syntheticModelCatalogPath)).digest("hex");
const driftedModelCatalogPath = resolve(projectRoot, "test", "fixtures", "experiment-model-catalog-drift.json");
const syntheticQuotaOffPath = resolve(projectRoot, "test", "fixtures", "experiment-quota-off.json");
const syntheticQuotaOnPath = resolve(projectRoot, "test", "fixtures", "experiment-quota-on.json");
const driftedQuotaPath = resolve(projectRoot, "test", "fixtures", "experiment-quota-drift.json");
const reroutedRuntimeOutputPath = resolve(projectRoot, "test", "fixtures", "experiment-runtime-output-reroute.json");
const tierDriftRuntimeOutputPath = resolve(projectRoot, "test", "fixtures", "experiment-runtime-output-tier-drift.json");
const nativeRerouteRuntimeOutputPath = resolve(projectRoot, "test", "fixtures", "experiment-runtime-output-native-reroute.jsonl");

void test("2x2 planner is deterministic and emits every cell once per blocked task replicate", async () => {
  const harness = await harnessPromise;
  const study = await harness.loadStudy({ protocol: workProtocolPath });
  const first = await harness.buildSchedule(study);
  const second = await harness.buildSchedule(study);

  assert.deepEqual(first, second);
  assert.equal(first.assignments.length, 4);
  assert.deepEqual(
    new Set(first.assignments.map((assignment) => `${assignment.hostSurface}:${assignment.counterlaneEnabled}`)),
    new Set(["codex:false", "codex:true", "chatgpt-work:false", "chatgpt-work:true"]),
  );
  assert.deepEqual(
    [...first.assignments.map((assignment) => assignment.order)].sort((left, right) => left - right),
    [1, 2, 3, 4],
  );
  const fixture = resolve(projectRoot, "experiments", "work-codex-2x2", "fixtures", "tiny-exact-edit");
  const completeSourceHash = await harness.hashDirectory(fixture);
  const hashWithoutLineEndingContract = await harness.hashDirectory(fixture, [".gitattributes"]);
  assert.ok(first.assignments.every((assignment) => assignment.sourceHash === completeSourceHash));
  assert.notEqual(completeSourceHash, hashWithoutLineEndingContract, ".gitattributes must be source-hashed");
});

void test("Codex-app protocol emits only native OFF and Counterlane ON with the pinned control route", async () => {
  const harness = await harnessPromise;
  const study = await harness.loadStudy();
  const pathAliasStudy = await harness.loadStudy({ protocolPath: appProtocolPath });
  assert.equal(study.protocolHash, pathAliasStudy.protocolHash);
  const first = await harness.buildSchedule(study);
  const second = await harness.buildSchedule(study);

  assert.deepEqual(first, second);
  assert.equal(study.protocol["codex"].model, "gpt-5.6-sol");
  assert.equal(study.protocol["codex"].effort, "xhigh");
  assert.equal(study.protocol["codex"].speed, "standard");
  assert.equal(study.protocol["studyId"], "counterlane-codex-app-ab-smoke-v5");
  assert.equal(first.assignments.length, 2);
  assert.deepEqual(
    new Set(first.assignments.map((assignment) => `${assignment.hostSurface}:${assignment.counterlaneEnabled}`)),
    new Set(["codex:false", "codex:true"]),
  );
  assert.deepEqual(
    [...first.assignments.map((assignment) => assignment.order)].sort((left, right) => left - right),
    [1, 2],
  );

  const trials = first.assignments.map((assignment) =>
    trialFor(harness, assignment, assignment.counterlaneEnabled),
  );
  const analysis = await harness.analyzeTrials(study, first, trials);
  assert.equal(analysis.trialCount, 2);
  assert.equal(analysis.hostEffects["codex"]?.delta, 1);
  assert.equal(analysis.interaction, null);
  assert.notEqual(
    analysis.runtimeBindings.find((binding) => !binding.counterlaneEnabled)?.quotaSnapshot.sha256,
    analysis.runtimeBindings.find((binding) => binding.counterlaneEnabled)?.quotaSnapshot.sha256,
    "sequential quota snapshots may differ without defeating catalog/runtime parity",
  );
  assert.doesNotMatch(harness.renderReport(analysis), /ChatGPT Work/u);

  const artifactTamper = structuredClone(trials);
  artifactTamper[0]!.rawArtifactHashes["finalPatch"] = "0".repeat(64);
  await assert.rejects(harness.analyzeTrials(study, first, artifactTamper), /artifact finalPatch SHA-256/u);

  const derivedCostTamper = structuredClone(trials);
  derivedCostTamper[0]!.commonCost.source = "runtime-output";
  setCommonCostTotal(derivedCostTamper[0]!, 99);
  await assert.rejects(
    harness.analyzeTrials(study, first, derivedCostTamper),
    /commonCost derived from runStdout/u,
  );

  const runtimeDrift = structuredClone(trials);
  const drifted = runtimeDrift[1]!;
  drifted.runtimeEvidence["codex"].sha256 = "9".repeat(64);
  drifted.rawArtifactHashes["codexVersion"] = "9".repeat(64);
  const { environmentHash: _oldHash, ...withoutHash } = drifted.runtimeEvidence;
  drifted.runtimeEvidence["environmentHash"] = harness.computeEnvironmentHash(withoutHash);
  drifted.rawArtifactHashes["environment"] = drifted.runtimeEvidence["environmentHash"];
  await assert.rejects(harness.analyzeTrials(study, first, runtimeDrift), /runtime codex parity/u);

  const catalogDrift = structuredClone(trials);
  const catalogTrial = catalogDrift[1]!;
  const driftedCatalogBytes = readFileSync(driftedModelCatalogPath);
  const driftedCatalogHash = createHash("sha256").update(driftedCatalogBytes).digest("hex");
  catalogTrial.runtimeEvidence["modelCatalog"] = verifiedSnapshotEvidence(
    driftedModelCatalogPath,
    driftedCatalogHash,
    "1 live model(s)",
    "codex-app-server-live-catalog",
    JSON.parse(driftedCatalogBytes.toString("utf8")) as Record<string, unknown>,
  );
  catalogTrial.rawArtifactHashes["modelCatalog"] = driftedCatalogHash;
  catalogTrial.rawArtifactPaths["modelCatalog"] = driftedModelCatalogPath;
  const { environmentHash: _catalogEnvironment, ...catalogEvidence } = catalogTrial.runtimeEvidence;
  catalogTrial.runtimeEvidence["environmentHash"] = harness.computeEnvironmentHash(catalogEvidence);
  catalogTrial.rawArtifactHashes["environment"] = catalogTrial.runtimeEvidence["environmentHash"];
  await assert.rejects(harness.analyzeTrials(study, first, catalogDrift), /runtime modelCatalog parity/u);
});

void test("long-task token protocol pins the native route and seals exactly two paired assignments", async () => {
  const harness = await harnessPromise;
  const protocol = resolve(
    projectRoot,
    "experiments",
    "codex-long-token",
    "protocol.json",
  );
  const study = await harness.loadStudy({ protocol });
  const first = await harness.buildSchedule(study);
  const second = await harness.buildSchedule(study);

  assert.deepEqual(first, second);
  assert.equal(study.tasks.length, 1);
  assert.equal(study.tasks[0]?.taskId, "bounded-batch-executor-v1");
  assert.equal(study.protocol["studyId"], "counterlane-codex-app-long-token-v6");
  assert.equal(study.protocol["codex"].model, "gpt-5.6-sol");
  assert.equal(study.protocol["codex"].effort, "xhigh");
  assert.equal(study.protocol["codex"].speed, "standard");
  assert.equal(study.protocol["analysis"].practicalTokenSavingsThresholdPct, 10);
  assert.equal(study.protocol["contaminationPolicy"].automaticCodexChecks.maxQuotaUsedPercentDelta, 2);
  assert.equal(
    study.protocol["contaminationPolicy"].automaticCodexChecks.routeInterventionSemantics,
    "counterlane-auto-selection-v2",
  );
  assert.equal(study.protocol["contaminationPolicy"].automaticCodexChecks.expectedServiceTier, null);
  assert.equal(study.protocol["counterlane"].cli, "dist/cli.js");
  assert.equal(study.tasks[0]?.visibleVerifier.minimumTier, "standard");
  const generatedConfig = harness.buildCounterlaneConfig(study.protocol, study.tasks[0]!);
  assert.equal(generatedConfig["verification"].requireTaskSpecificCheck, true);
  assert.equal(generatedConfig["verification"].commands[0].minimumTier, "standard");
  assert.equal(generatedConfig["verification"].commands[0].taskSpecific, true);
  const generatedArgs = harness.buildCounterlaneArgs(study.protocol, study.tasks[0]!, {
    cliPath: "counterlane-cli",
    workspace: "workspace",
    configPath: "counterlane.config.json",
  });
  assert.deepEqual(generatedArgs.slice(generatedArgs.indexOf("--proof-tier"), generatedArgs.indexOf("--proof-tier") + 2), [
    "--proof-tier",
    "standard",
  ]);
  assert.throws(
    () => harness.resolveCounterlaneCliPath("../../dist/cli.js"),
    /counterlane\.cli escapes/u,
  );
  assert.equal(first.assignments.length, 2);
  assert.deepEqual(
    new Set(first.assignments.map((assignment) => `${assignment.hostSurface}:${assignment.counterlaneEnabled}`)),
    new Set(["codex:false", "codex:true"]),
  );
  assert.equal(new Set(first.assignments.map((assignment) => assignment.sourceHash)).size, 1);
  assert.equal(new Set(first.assignments.map((assignment) => assignment.promptHash)).size, 1);

  const missingHarnessCode = structuredClone(study.protocol);
  missingHarnessCode["contaminationPolicy"].labels = missingHarnessCode["contaminationPolicy"].labels
    .filter((label: string) => label !== "other");
  assert.throws(
    () => harness.validateProtocol(missingHarnessCode),
    /must include harness-generated code: other/u,
  );
  const missingAutomaticChecks = structuredClone(study.protocol);
  delete missingAutomaticChecks["contaminationPolicy"].automaticCodexChecks;
  assert.throws(
    () => harness.validateProtocol(missingAutomaticChecks),
    /automaticCodexChecks/u,
  );
  const contradictoryRoute = structuredClone(study.protocol);
  contradictoryRoute["contaminationPolicy"].automaticCodexChecks.expectedModelId = "another-model";
  assert.throws(
    () => harness.validateProtocol(contradictoryRoute),
    /expectedModelId/u,
  );
});

void test("experiment execution never starts when runtime preflight fails", async () => {
  const harness = await harnessPromise;
  let executed = false;
  await assert.rejects(
    harness.executeAfterPreflight(
      async () => { throw new Error("missing runtime binding"); },
      async () => { executed = true; return "ran"; },
    ),
    /missing runtime binding/u,
  );
  assert.equal(executed, false);
});

void test("runtime output binds structured token usage and an effective Counterlane route", async () => {
  const harness = await harnessPromise;
  const native = harness.extractCommonCost(JSON.stringify({
    usage: {
      total_tokens: 125,
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 25,
      reasoning_output_tokens: 10,
    },
  }));
  assert.deepEqual(native, {
    unit: "total_tokens",
    value: 125,
    source: "runtime-output",
    breakdown: {
      totalTokens: 125,
      inputTokens: 100,
      cachedInputTokens: 40,
      uncachedInputTokens: 60,
      outputTokens: 25,
      reasoningOutputTokens: 10,
    },
  });
  const counterlane = harness.extractCommonCost(syntheticRuntimeOutput);
  assert.equal(counterlane.breakdown.cachedInputTokens, 20);
  assert.equal(counterlane.breakdown.reasoningOutputTokens, 10);
  assert.deepEqual(harness.extractCommonCost("not JSON").breakdown, {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
  });

  const base = { schemaVersion: 1, hostSurface: "codex" };
  const off = harness.bindCounterlaneRouteEvidence(base, false, syntheticRuntimeOutput);
  assert.equal(off["counterlaneRoute"].status, "not-applicable");
  assert.equal(off["counterlaneRoute"].value, null);
  assert.deepEqual(off["backendRoute"].value, []);
  const on = harness.bindCounterlaneRouteEvidence(base, true, syntheticRuntimeOutput);
  assert.equal(on["counterlaneRoute"].status, "verified");
  assert.equal(on["counterlaneRoute"].value.modelId, "gpt-5.6-sol");
  assert.equal(on["counterlaneRoute"].value.selectionSource, "auto-router");
  assert.equal(on["counterlaneRoute"].value.routeAdmissible, true);
  assert.equal(on["counterlaneRoute"].value.routeDecisionMatch, true);
  assert.deepEqual(on["backendRoute"].value, []);
  const missing = harness.bindCounterlaneRouteEvidence(base, true, "{}\n");
  assert.equal(missing["counterlaneRoute"].status, "unavailable");
  const nativeRerouted = harness.bindCounterlaneRouteEvidence(
    base,
    false,
    `${JSON.stringify({ type: "model/rerouted", fromModel: "gpt-5.6-sol", toModel: "gpt-5.6-terra" })}\n`,
  );
  assert.deepEqual(nativeRerouted["backendRoute"].value, [{
    fromModel: "gpt-5.6-sol",
    toModel: "gpt-5.6-terra",
  }]);
});

void test("reproducible patch capture includes new files and rejects agent commits", async () => {
  const harness = await harnessPromise;
  const workspace = await mkdtemp(join(tmpdir(), "counterlane-patch-capture-"));
  try {
    await writeFile(join(workspace, "tracked.txt"), "baseline\n", "utf8");
    git(workspace, ["init", "-q"]);
    git(workspace, ["add", "-A"]);
    git(workspace, ["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "baseline"]);
    const baseline = git(workspace, ["rev-parse", "HEAD"]).trim();
    await writeFile(join(workspace, "new-file.txt"), "new\n", "utf8");
    const patch = await harness.captureReproduciblePatch(workspace, baseline);
    assert.match(patch.stdout, /new-file\.txt/u);

    git(workspace, ["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qam", "agent commit"]);
    await assert.rejects(
      harness.captureReproduciblePatch(workspace, baseline),
      /moved HEAD/u,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

void test("experiment subprocess timeouts terminate resistant descendants", async () => {
  const harness = await harnessPromise;
  const directory = await mkdtemp(join(tmpdir(), "counterlane-experiment-tree-"));
  const marker = join(directory, "late-marker.txt");
  const grandchild = join(directory, "grandchild.mjs");
  const parent = join(directory, "parent.mjs");
  await writeFile(
    grandchild,
    `import { writeFile } from "node:fs/promises";\nprocess.on("SIGTERM", () => {});\nawait new Promise((resolve) => setTimeout(resolve, 500));\nawait writeFile(${JSON.stringify(marker)}, "late\\n");\n`,
    "utf8",
  );
  await writeFile(
    parent,
    `import { spawn } from "node:child_process";\nspawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });\nawait new Promise((resolve) => setTimeout(resolve, 5000));\n`,
    "utf8",
  );
  const result = await harness.runProcess(process.execPath, [parent], {
    cwd: directory,
    timeoutMs: 50,
    env: process.env,
  });
  assert.equal(result.timedOut, true);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
  await assert.rejects(readFile(marker, "utf8"), /ENOENT/u);
});

void test("experiment subprocesses resolve Windows npm shims without a shell", { skip: process.platform !== "win32" }, async () => {
  const harness = await harnessPromise;
  const result = await harness.runProcess("npm", ["--version"], {
    cwd: projectRoot,
    timeoutMs: 30_000,
    env: { ...process.env, Path: "" },
  }) as unknown as { exitCode: number | null; spawnError: string | null; stdout: string };
  assert.equal(result.exitCode, 0, result.spawnError ?? result.stdout);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/u);
});

void test("nested visible-verifier paths resolve inside the assigned workspace", async () => {
  const harness = await harnessPromise;
  const workspace = resolve(projectRoot, "fixture-workspace");
  const argv = harness.resolveTaskCommandArgv(
    { argv: ["$NODE", "checks/verify.mjs", "{workspace}"] },
    { cwd: workspace, workspace },
  );
  assert.equal(argv[1], resolve(workspace, "checks", "verify.mjs"));
  assert.equal(argv[2], workspace);
});

void test("experiment fixture and oracle roots reject filesystem-link escapes", async () => {
  const harness = await harnessPromise;
  const parent = await mkdtemp(join(tmpdir(), "counterlane-study-confinement-"));
  const root = join(parent, "study");
  const outside = join(parent, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await writeFile(join(root, "inside.mjs"), "export {};\n", "utf8");
  const link = join(root, "escaped");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(
      await harness.resolveExistingWithin(root, "inside.mjs", "inside", "file"),
      await realpath(resolve(root, "inside.mjs")),
    );
    await assert.rejects(
      harness.resolveExistingWithin(root, "escaped", "fixture", "directory"),
      /non-symlink|escapes/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("trial-set validation rejects missing and duplicate assignments", async () => {
  const harness = await harnessPromise;
  const study = await harness.loadStudy();
  const schedule = await harness.buildSchedule(study);
  const trials = schedule.assignments.map((assignment) => trialFor(harness, assignment, false));

  assert.throws(
    () => harness.validateCompleteTrials(schedule, trials.slice(1), study.protocol),
    /Missing trials/u,
  );
  assert.throws(
    () => harness.validateCompleteTrials(schedule, [...trials, trials[0]!], study.protocol),
    /Duplicate trial/u,
  );
  const missingPatch = structuredClone(trials);
  delete missingPatch[0]!.rawArtifactHashes["finalPatch"];
  assert.throws(
    () => harness.validateCompleteTrials(schedule, missingPatch, study.protocol),
    /finalPatch/u,
  );
  const inconsistentProcess = structuredClone(trials);
  inconsistentProcess[0]!.timedOut = true;
  assert.throws(
    () => harness.validateCompleteTrials(schedule, inconsistentProcess, study.protocol),
    /trial\.runCompleted/u,
  );
});

void test("trial execution enforces seeded order, exclusive ledger access, and immutable plans", async () => {
  const harness = await harnessPromise;
  const study = await harness.loadStudy();
  const schedule = await harness.buildSchedule(study);
  const ordered = [...schedule.assignments].sort((left, right) => left.order - right.order);
  assert.doesNotThrow(() => harness.assertAssignmentReady(schedule, [], ordered[0]!));
  assert.throws(
    () => harness.assertAssignmentReady(schedule, [], ordered[1]!),
    /out of preregistered order/u,
  );

  const directory = await mkdtemp(join(tmpdir(), "counterlane-ledger-lock-"));
  const trialsPath = join(directory, "trials.jsonl");
  const release = await harness.acquireTrialLock(trialsPath);
  await assert.rejects(harness.acquireTrialLock(trialsPath), /locked by another execution/u);
  await release();

  const staleTrialsPath = join(directory, "stale", "trials.jsonl");
  await mkdir(join(directory, "stale"));
  const exitedProcess = spawnSync(process.execPath, ["-e", "process.exit(0)"], { shell: false });
  assert.ok(exitedProcess.pid > 0);
  await writeFile(
    `${staleTrialsPath}.lock`,
    `${JSON.stringify({ schemaVersion: 1, pid: exitedProcess.pid, createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    "utf8",
  );
  const releaseReclaimed = await harness.acquireTrialLock(staleTrialsPath);
  await releaseReclaimed();
  await assert.rejects(readFile(`${staleTrialsPath}.lock`, "utf8"), /ENOENT/u);

  const schedulePath = join(directory, "new-parent", "schedule.json");
  await harness.writeJsonImmutable(schedulePath, schedule);
  await harness.writeJsonImmutable(schedulePath, schedule);
  await assert.rejects(
    harness.writeJsonImmutable(schedulePath, { ...schedule, seed: "changed" }),
    /Refusing to overwrite immutable preregistration/u,
  );

  const attemptDirectory = join(directory, "attempt");
  const assignment = ordered[0]!;
  const attemptPath = await harness.writeAttemptMarker(attemptDirectory, assignment, "a".repeat(64), Date.UTC(2026, 6, 12));
  assert.match(await readFile(attemptPath, "utf8"), new RegExp(assignment.assignmentId, "u"));
  await assert.rejects(harness.assertNoPriorAttempt(attemptDirectory, assignment), /no-rerun rule forbids/u);
  await assert.rejects(
    harness.writeAttemptMarker(attemptDirectory, assignment, "a".repeat(64)),
    /refusing a rerun/u,
  );

  const recoveryWorkspace = join(directory, "recovery-workspace");
  await mkdir(recoveryWorkspace);
  await writeFile(join(recoveryWorkspace, "evidence.txt"), "retain\n", "utf8");
  await harness.cleanupExperimentWorkspace(recoveryWorkspace, true);
  assert.equal(await readFile(join(recoveryWorkspace, "evidence.txt"), "utf8"), "retain\n");
  await harness.cleanupExperimentWorkspace(recoveryWorkspace, false);
  await assert.rejects(readFile(join(recoveryWorkspace, "evidence.txt"), "utf8"), /ENOENT/u);
  await rm(directory, { recursive: true, force: true });
});

void test("post-run processing failures retain exactly one failed ITT trial and evidence", async () => {
  const harness = await harnessPromise;
  const study = await harness.loadStudy();
  const schedule = await harness.buildSchedule(study);
  const assignment = [...schedule.assignments].sort((left, right) => left.order - right.order)[0]!;
  const template = trialFor(harness, assignment, false);
  const artifactRoot = await mkdtemp(join(tmpdir(), "counterlane-post-run-retention-"));
  const trialsPath = join(artifactRoot, "raw", "trials.jsonl");
  const rawDirectory = join(artifactRoot, "raw", assignment.assignmentId);
  try {
    const retained = await harness.retainPostRunFailure({
      study,
      schedule,
      assignment,
      trialsPath,
      rawDirectory,
      workspace: null,
      startedAtMs: Date.now() - 1_000,
      run: {
        exitCode: 0,
        signal: null,
        stdout: `${JSON.stringify({ usage: { total_tokens: 42 } })}\n`,
        stderr: "",
        timedOut: false,
        outputOverflow: false,
        spawnError: null,
      },
      runtimeEvidence: template.runtimeEvidence,
      baselineCommit: null,
      error: new Error("verifier mutated candidate"),
    });
    assert.equal(retained.verifiedSuccess, false);
    assert.equal(retained.runCompleted, true);
    assert.equal(retained.commonCost.value, 42);
    assert.equal(retained.contamination[0]?.code, "other");
    assert.match(await readFile(join(rawDirectory, "visible-verifier.log"), "utf8"), /verifier mutated candidate/u);
    const ledger = (await readFile(trialsPath, "utf8")).trim().split("\n");
    assert.equal(ledger.length, 1);
    assert.throws(
      () => harness.assertAssignmentReady(schedule, [retained], assignment),
      /Duplicate trial/u,
    );
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

void test("schedule validation rejects forged task identity, hashes, and seeded order", async () => {
  const harness = await harnessPromise;
  const study = await harness.loadStudy({ protocol: workProtocolPath });
  const schedule = await harness.buildSchedule(study);
  for (const mutate of [
    (copy: Schedule) => { copy.assignments[0]!.taskId = "not-registered"; },
    (copy: Schedule) => { copy.assignments[0]!.promptHash = "f".repeat(64); },
    (copy: Schedule) => {
      const first = copy.assignments[0]!;
      const second = copy.assignments[1]!;
      [first.order, second.order] = [second.order, first.order];
    },
  ]) {
    const forged = structuredClone(schedule);
    mutate(forged);
    await assert.rejects(harness.validateSchedule(forged, study), /registered task hashes and seeded order/u);
  }
});

void test("analysis retains contamination, uses ITT cells, and refuses confidence for one cluster", async () => {
  const harness = await harnessPromise;
  const study = await harness.loadStudy({ protocol: workProtocolPath });
  const schedule = await harness.buildSchedule(study);
  const trials = schedule.assignments.map((assignment) => {
    const success = assignment.hostSurface === "codex" && assignment.counterlaneEnabled;
    const trial = trialFor(harness, assignment, success, mediumRuntimeOutputPath);
    if (assignment.hostSurface === "chatgpt-work" && assignment.counterlaneEnabled) {
      trial.treatmentCompliance = "noncompliant";
      trial.contamination.push({ code: "human-intervention", detail: "smoke fixture intervention retained" });
    }
    return trial;
  });

  const analysis = await harness.analyzeTrials(study, schedule, trials);
  assert.equal(analysis.trialCount, 4);
  assert.equal(analysis.completeTaskClusters, 1);
  assert.equal(analysis.hostEffects["codex"]?.delta, 1);
  assert.equal(analysis.hostEffects["chatgpt-work"]?.delta, 0);
  assert.equal(analysis.hostEffects["codex"]?.commonCost.claimEligible, false);
  assert.equal(analysis.interaction, -1);
  assert.equal(analysis.contamination.retainedTrialCount, 1);
  assert.equal(analysis.contamination.codes["human-intervention"], 1);
  assert.equal(analysis.statisticalConfidence.claimed, false);
  assert.match(analysis.statisticalConfidence.reason, /forbids statistical-confidence claims/u);
});

void test("long-token analysis enforces comparable cost, both-verified, and the preregistered threshold", async () => {
  const harness = await harnessPromise;
  const protocol = resolve(projectRoot, "experiments", "codex-long-token", "protocol.json");
  const study = await harness.loadStudy({ protocol });
  const schedule = await harness.buildSchedule(study);
  const successful = schedule.assignments.map((assignment) => {
    const trial = trialFor(harness, assignment, true);
    setCommonCostTotal(trial, assignment.counterlaneEnabled ? 150 : 200);
    return trial;
  });
  const eligibleAnalysis = await harness.analyzeTrials(study, schedule, successful);
  const eligible = eligibleAnalysis.hostEffects["codex"]!.commonCost;
  assert.equal(eligible.savingsPct, 25);
  assert.equal(eligible.thresholdMet, true);
  assert.equal(eligible.claimEligible, true);
  assert.equal(eligible.contaminationEligible, true);
  assert.equal(eligible.complianceEligible, true);
  assert.equal(eligibleAnalysis.automaticCodexChecks[0]?.quota.status, "within-tolerance");
  assert.equal(eligibleAnalysis.automaticCodexChecks[0]?.quota.observedMaxUsedPercentDelta, 1);
  assert.equal(eligibleAnalysis.automaticCodexChecks[0]?.route.status, "within-tolerance");
  const report = harness.renderReport(eligibleAnalysis);
  assert.match(report, /gross total_tokens difference/u);
  assert.match(report, /Cached input.*Reasoning output/u);
  assert.match(report, /150\.0|200\.0/u);
  assert.match(report, /Automatic paired contamination checks/u);

  const intentionalAutoRoute = structuredClone(successful);
  const intentionalOn = intentionalAutoRoute.find((trial) => trial.counterlaneEnabled)!;
  bindRuntimeOutputFixture(harness, intentionalOn, mediumRuntimeOutputPath);
  const intentionalAnalysis = await harness.analyzeTrials(study, schedule, intentionalAutoRoute);
  assert.equal(intentionalAnalysis.hostEffects["codex"]!.commonCost.claimEligible, true);
  assert.equal(intentionalAnalysis.contamination.codes["model-reroute"], undefined);
  assert.equal(intentionalAnalysis.automaticCodexChecks[0]?.route.status, "within-tolerance");

  const missingRoute = structuredClone(successful);
  const missingRouteTrial = missingRoute.find((trial) => trial.counterlaneEnabled)!;
  missingRouteTrial.runtimeEvidence["counterlaneRoute"] = unavailableEvidence(
    "counterlane-on-effective-route",
    "route absent from output",
  );
  missingRouteTrial.treatmentCompliance = "noncompliant";
  missingRouteTrial.contamination.push({
    code: "treatment-noncompliance",
    detail: "route absent from output",
  });
  missingRouteTrial.rawArtifactHashes["runStdout"] = syntheticArtifactHash;
  missingRouteTrial.rawArtifactPaths["runStdout"] = syntheticArtifactPath;
  missingRouteTrial.runtimeEvidence["backendRoute"].sourceSha256 = syntheticArtifactHash;
  const { environmentHash: _missingRouteEnvironment, ...missingRouteEvidence } = missingRouteTrial.runtimeEvidence;
  missingRouteTrial.runtimeEvidence["environmentHash"] = harness.computeEnvironmentHash(missingRouteEvidence);
  missingRouteTrial.rawArtifactHashes["environment"] = missingRouteTrial.runtimeEvidence["environmentHash"];
  const routeIneligible = (await harness.analyzeTrials(study, schedule, missingRoute)).hostEffects["codex"]!.commonCost;
  assert.equal(routeIneligible.claimEligible, false);
  assert.match(routeIneligible.reason, /effective route evidence is unavailable/u);

  const quotaDrift = structuredClone(successful);
  const quotaDriftTrial = quotaDrift.find((trial) => trial.counterlaneEnabled)!;
  bindQuotaFixture(harness, quotaDriftTrial, driftedQuotaPath);
  const quotaDriftAnalysis = await harness.analyzeTrials(study, schedule, quotaDrift);
  const quotaIneligible = quotaDriftAnalysis.hostEffects["codex"]!.commonCost;
  assert.equal(quotaIneligible.claimEligible, false);
  assert.equal(quotaIneligible.contaminationEligible, false);
  assert.match(quotaIneligible.reason, /contaminated/u);
  assert.equal(quotaDriftAnalysis.contamination.retainedTrialCount, 1);
  assert.equal(quotaDriftAnalysis.contamination.codes["quota-interference"], 1);
  assert.equal(quotaDriftAnalysis.automaticCodexChecks[0]?.quota.status, "contaminated");
  assert.equal(quotaDriftAnalysis.automaticCodexChecks[0]?.quota.observedMaxUsedPercentDelta, 15);

  const rerouted = structuredClone(successful);
  const reroutedTrial = rerouted.find((trial) => trial.counterlaneEnabled)!;
  bindRuntimeOutputFixture(harness, reroutedTrial, reroutedRuntimeOutputPath);
  const reroutedAnalysis = await harness.analyzeTrials(study, schedule, rerouted);
  const reroutedIneligible = reroutedAnalysis.hostEffects["codex"]!.commonCost;
  assert.equal(reroutedIneligible.claimEligible, false);
  assert.equal(reroutedIneligible.complianceEligible, false);
  assert.match(reroutedIneligible.reason, /treatment-noncompliant/u);
  assert.equal(reroutedAnalysis.contamination.codes["model-reroute"], 1);
  assert.equal(reroutedAnalysis.automaticCodexChecks[0]?.route.status, "noncompliant");

  const nativeRerouted = structuredClone(successful);
  const nativeOff = nativeRerouted.find((trial) => !trial.counterlaneEnabled)!;
  bindRuntimeOutputFixture(harness, nativeOff, nativeRerouteRuntimeOutputPath);
  const nativeReroutedAnalysis = await harness.analyzeTrials(study, schedule, nativeRerouted);
  assert.equal(nativeReroutedAnalysis.hostEffects["codex"]!.commonCost.claimEligible, false);
  assert.equal(nativeReroutedAnalysis.contamination.codes["model-reroute"], 1);
  assert.equal(nativeReroutedAnalysis.automaticCodexChecks[0]?.noncompliant, true);

  const tierDrift = structuredClone(successful);
  const tierDriftTrial = tierDrift.find((trial) => trial.counterlaneEnabled)!;
  bindRuntimeOutputFixture(harness, tierDriftTrial, tierDriftRuntimeOutputPath);
  const tierDriftAnalysis = await harness.analyzeTrials(study, schedule, tierDrift);
  const tierDriftIneligible = tierDriftAnalysis.hostEffects["codex"]!.commonCost;
  assert.equal(tierDriftIneligible.claimEligible, false);
  assert.equal(tierDriftIneligible.complianceEligible, false);
  assert.equal(tierDriftAnalysis.contamination.codes["service-tier-drift"], 1);
  assert.equal(tierDriftAnalysis.automaticCodexChecks[0]?.route.status, "noncompliant");

  const manuallyContaminated = structuredClone(successful);
  manuallyContaminated.find((trial) => !trial.counterlaneEnabled)!.contamination.push({
    code: "human-intervention",
    detail: "operator touched the native control arm",
  });
  const manualIneligible = (await harness.analyzeTrials(study, schedule, manuallyContaminated))
    .hostEffects["codex"]!.commonCost;
  assert.equal(manualIneligible.claimEligible, false);
  assert.equal(manualIneligible.contaminationEligible, false);

  successful.find((trial) => trial.counterlaneEnabled)!.verifiedSuccess = false;
  successful.find((trial) => trial.counterlaneEnabled)!.hiddenOraclePassed = false;
  successful.find((trial) => trial.counterlaneEnabled)!.badEscape = true;
  const ineligible = (await harness.analyzeTrials(study, schedule, successful)).hostEffects["codex"]!.commonCost;
  assert.equal(ineligible.claimEligible, false);
  assert.match(ineligible.reason, /both arms/u);
});

void test("external hidden oracle rejects the baseline and accepts only the exact isolated edit", async () => {
  const studyDirectory = resolve(projectRoot, "experiments", "work-codex-2x2");
  const fixture = join(studyDirectory, "fixtures", "tiny-exact-edit");
  const oracle = join(studyDirectory, "oracles", "tiny-exact-edit.mjs");
  const workspace = await mkdtemp(join(tmpdir(), "counterlane-2x2-oracle-"));
  try {
    await cp(fixture, workspace, { recursive: true });
    const baseline = spawnSync(process.execPath, [oracle, workspace], { shell: false, encoding: "utf8" });
    assert.equal(baseline.status, 1);

    await writeFile(join(workspace, "answer.txt"), "counterlane-smoke\n", "utf8");
    const corrected = spawnSync(process.execPath, [oracle, workspace], { shell: false, encoding: "utf8" });
    assert.equal(corrected.status, 0, corrected.stderr);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

void test("Work import replays a sealed bundle, derives outcomes, and rejects user claims or artifact drift", async () => {
  const harness = await harnessPromise;
  const study = await harness.loadStudy({ protocol: workProtocolPath });
  const schedule = await harness.buildSchedule(study);
  const assignment = schedule.assignments.find(
    (candidate) => candidate.hostSurface === "chatgpt-work" && candidate.counterlaneEnabled,
  );
  assert.ok(assignment);
  const studyDirectory = resolve(projectRoot, "experiments", "work-codex-2x2");
  const fixture = join(studyDirectory, "fixtures", "tiny-exact-edit");
  const sourceWorkspace = await mkdtemp(join(tmpdir(), "counterlane-2x2-work-source-"));
  const mismatchWorkspace = await mkdtemp(join(tmpdir(), "counterlane-2x2-work-mismatch-"));
  const operatorRoot = await mkdtemp(join(tmpdir(), "counterlane-2x2-work-operator-"));
  const derived = await mkdtemp(join(tmpdir(), "counterlane-2x2-work-derived-"));
  try {
    await cp(fixture, sourceWorkspace, { recursive: true });
    git(sourceWorkspace, ["init", "-q"]);
    git(sourceWorkspace, ["add", "-A"]);
    git(sourceWorkspace, [
      "-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid",
      "commit", "-qm", "fixture baseline",
    ]);
    await writeFile(join(sourceWorkspace, "answer.txt"), "counterlane-smoke\n", "utf8");
    const patch = git(sourceWorkspace, ["diff", "--binary", "HEAD"]);
    const stdout = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
    const stderr = Buffer.from("connected Work stderr\n", "utf8");
    const counterlaneResult = `${JSON.stringify({ runId: "work-run-1", mode: "auto" })}\n`;
    const stdoutSource = join(operatorRoot, "source.stdout.log");
    const stderrSource = join(operatorRoot, "source.stderr.log");
    const resultSource = join(operatorRoot, "source.counterlane-result.json");
    await Promise.all([
      writeFile(stdoutSource, stdout),
      writeFile(stderrSource, stderr),
      writeFile(resultSource, counterlaneResult, "utf8"),
    ]);
    const sealedOutput = join(operatorRoot, "sealed");
    const sealed = await harness.sealWorkBundle(study, schedule, {
      assignmentId: assignment.assignmentId,
      workspace: sourceWorkspace,
      stdout: stdoutSource,
      stderr: stderrSource,
      counterlaneResult: resultSource,
      startedAt: "2026-07-12T00:00:00.000Z",
      completedAt: "2026-07-12T00:00:05.000Z",
      output: sealedOutput,
    });
    const bundle = sealed.bundlePath;
    const envelope = JSON.parse(await readFile(sealed.envelopePath, "utf8")) as Record<string, unknown>;
    const manifest = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8")) as {
      files: Record<string, string>;
    };
    assert.equal(await readFile(join(bundle, "final.patch"), "utf8"), patch);
    assert.deepEqual(await readFile(join(bundle, "run.stdout.log")), stdout);
    assert.deepEqual(await readFile(join(bundle, "run.stderr.log")), stderr);
    assert.equal(await readFile(join(bundle, "counterlane-result.json"), "utf8"), counterlaneResult);
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      "counterlane-result.json",
      "final.patch",
      "run.stderr.log",
      "run.stdout.log",
    ]);
    for (const [name, hash] of Object.entries(manifest.files)) {
      assert.equal(hash, createHash("sha256").update(await readFile(join(bundle, name))).digest("hex"));
    }
    assert.equal(envelope["bundlePath"], "bundle");

    const trial = await harness.deriveWorkTrialFromBundle(study, schedule, envelope, bundle, {
      derivedDirectory: derived,
    });
    assert.equal(trial.verifiedSuccess, true);
    assert.equal(trial.badEscape, false);
    assert.equal(trial.treatmentCompliance, "compliant");
    assert.equal(trial.runtimeEvidence["codex"].status, "unavailable");
    assert.equal(trial.rawArtifactHashes["finalPatch"], sha256(patch));

    await assert.rejects(
      harness.deriveWorkTrialFromBundle(
        study,
        schedule,
        { ...envelope, verifiedSuccess: true },
        bundle,
        { derivedDirectory: derived },
      ),
      /must not supply derived field/u,
    );

    await writeFile(join(bundle, "run.stdout.log"), "tampered\n", "utf8");
    await assert.rejects(
      harness.deriveWorkTrialFromBundle(study, schedule, envelope, bundle, { derivedDirectory: derived }),
      /sealed bundle hash/u,
    );
    await writeFile(join(bundle, "run.stdout.log"), stdout);
    await rm(join(bundle, "run.stderr.log"));
    await assert.rejects(
      harness.deriveWorkTrialFromBundle(study, schedule, envelope, bundle, { derivedDirectory: derived }),
      /cover every payload file|missing required artifact/u,
    );

    const codexAssignment = schedule.assignments.find((candidate) => candidate.hostSurface === "codex");
    assert.ok(codexAssignment);
    await assert.rejects(
      harness.sealWorkBundle(study, schedule, {
        assignmentId: codexAssignment.assignmentId,
        workspace: sourceWorkspace,
        stdout: stdoutSource,
        stderr: stderrSource,
        startedAt: "2026-07-12T00:00:00.000Z",
        completedAt: "2026-07-12T00:00:05.000Z",
        output: join(operatorRoot, "wrong-host"),
      }),
      /not a ChatGPT Work cell/u,
    );
    await assert.rejects(
      harness.sealWorkBundle(study, schedule, {
        assignmentId: assignment.assignmentId,
        workspace: sourceWorkspace,
        stdout: stdoutSource,
        stderr: stderrSource,
        startedAt: "2026-07-12T00:00:05.000Z",
        completedAt: "2026-07-12T00:00:00.000Z",
        output: join(operatorRoot, "bad-time"),
      }),
      /timestamps must be ordered/u,
    );
    await assert.rejects(
      harness.sealWorkBundle(study, schedule, {
        assignmentId: assignment.assignmentId,
        workspace: sourceWorkspace,
        stdout: stdoutSource,
        stderr: stderrSource,
        startedAt: "2026-07-12T00:00:00.000Z",
        completedAt: "2026-07-12T00:00:05.000Z",
        output: join(sourceWorkspace, "sealed"),
      }),
      /output must remain outside/u,
    );

    await cp(fixture, mismatchWorkspace, { recursive: true });
    await writeFile(join(mismatchWorkspace, "answer.txt"), "different-baseline\n", "utf8");
    git(mismatchWorkspace, ["init", "-q"]);
    git(mismatchWorkspace, ["add", "-A"]);
    git(mismatchWorkspace, [
      "-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid",
      "commit", "-qm", "mismatched baseline",
    ]);
    await writeFile(join(mismatchWorkspace, "answer.txt"), "counterlane-smoke\n", "utf8");
    await assert.rejects(
      harness.sealWorkBundle(study, schedule, {
        assignmentId: assignment.assignmentId,
        workspace: mismatchWorkspace,
        stdout: stdoutSource,
        stderr: stderrSource,
        startedAt: "2026-07-12T00:00:00.000Z",
        completedAt: "2026-07-12T00:00:05.000Z",
        output: join(operatorRoot, "bad-baseline"),
      }),
      /Git HEAD sourceHash/u,
    );
  } finally {
    await Promise.all([
      rm(sourceWorkspace, { recursive: true, force: true }),
      rm(mismatchWorkspace, { recursive: true, force: true }),
      rm(operatorRoot, { recursive: true, force: true }),
      rm(derived, { recursive: true, force: true }),
    ]);
  }
});

function trialFor(
  harness: Harness,
  assignment: Assignment,
  success: boolean,
  runtimeOutputPath = syntheticRuntimeOutputPath,
): Trial {
  const runtimeOutput = readFileSync(runtimeOutputPath, "utf8");
  const runtimeOutputHash = createHash("sha256").update(runtimeOutput).digest("hex");
  const sourceManifest = verifiedEvidence(syntheticArtifactPath, syntheticArtifactHash, "100 bytes", "local-build");
  const counterlaneCli = verifiedEvidence(syntheticArtifactPath, syntheticArtifactHash, "100 bytes", "local-build");
  const node = verifiedEvidence(syntheticArtifactPath, syntheticArtifactHash, "v22.0.0", assignment.hostSurface === "codex" ? "execution-host" : "local-evaluator");
  const codex = assignment.hostSurface === "codex"
    ? verifiedEvidence(syntheticArtifactPath, syntheticArtifactHash, "codex-cli test", "execution-host")
    : unavailableEvidence("remote-execution-host", "not observable");
  const counterlaneConfig = assignment.hostSurface === "codex"
    ? assignment.counterlaneEnabled
      ? verifiedEvidence(syntheticArtifactPath, syntheticArtifactHash, "100 bytes", "execution-config")
      : unavailableEvidence("execution-config", "not applicable", "not-applicable")
    : unavailableEvidence("remote-execution-host", "not observable");
  const quotaPath = assignment.counterlaneEnabled ? syntheticQuotaOnPath : syntheticQuotaOffPath;
  const quotaBytes = readFileSync(quotaPath);
  const quotaSnapshot = JSON.parse(quotaBytes.toString("utf8")) as Record<string, unknown>;
  const modelCatalog = assignment.hostSurface === "codex"
    ? verifiedSnapshotEvidence(
      syntheticModelCatalogPath,
      syntheticModelCatalogHash,
      "1 live model(s)",
      "codex-app-server-live-catalog",
      syntheticModelCatalog,
    )
    : unavailableEvidence("remote-execution-host", "not observable");
  const quota = assignment.hostSurface === "codex"
    ? verifiedSnapshotEvidence(
      quotaPath,
      createHash("sha256").update(quotaBytes).digest("hex"),
      "1 live quota bucket(s)",
      "codex-app-server-live-quota",
      quotaSnapshot,
    )
    : unavailableEvidence("remote-execution-host", "not observable");
  const evidenceWithoutHash: Record<string, unknown> = {
    schemaVersion: 1,
    studyId: assignment.studyId,
    protocolHash: assignment.protocolHash,
    hostSurface: assignment.hostSurface,
    counterlaneEnabled: assignment.counterlaneEnabled,
    platform: "test",
    arch: "test",
    sourceManifest,
    counterlaneCli,
    counterlaneConfig,
    node,
    codex,
    modelCatalog,
    quotaSnapshot: quota,
  };
  const runtimeEvidence = assignment.hostSurface === "codex"
    ? harness.bindCounterlaneRouteEvidence(
      evidenceWithoutHash,
      assignment.counterlaneEnabled,
      runtimeOutput,
    )
    : {
      ...evidenceWithoutHash,
      counterlaneRoute: unavailableEvidence("remote-execution-host", "not observable"),
      backendRoute: unavailableEvidence("remote-execution-host", "not observable"),
      environmentHash: harness.computeEnvironmentHash({
        ...evidenceWithoutHash,
        counterlaneRoute: unavailableEvidence("remote-execution-host", "not observable"),
        backendRoute: unavailableEvidence("remote-execution-host", "not observable"),
      }),
    };
  const runtimeHashes: Record<string, string> = {
    sourceManifest: sourceManifest["sha256"] as string,
    counterlaneCli: counterlaneCli["sha256"] as string,
    nodeVersion: node["sha256"] as string,
    environment: runtimeEvidence["environmentHash"],
  };
  if (codex["status"] === "verified") runtimeHashes["codexVersion"] = codex["sha256"] as string;
  if (counterlaneConfig["status"] === "verified") runtimeHashes["counterlaneConfig"] = counterlaneConfig["sha256"] as string;
  if (modelCatalog["status"] === "verified") runtimeHashes["modelCatalog"] = modelCatalog["sha256"] as string;
  if (quota["status"] === "verified") runtimeHashes["quotaSnapshot"] = quota["sha256"] as string;
  const rawArtifactHashes: Record<string, string> = {
    runStdout: runtimeOutputHash,
    runStderr: syntheticArtifactHash,
    visibleVerifier: syntheticArtifactHash,
    hiddenOracle: syntheticArtifactHash,
    finalPatch: syntheticArtifactHash,
    finalWorkspace: syntheticArtifactHash,
    ...runtimeHashes,
  };
  const rawArtifactPaths: Record<string, string> = {
    runStdout: runtimeOutputPath,
    runStderr: syntheticArtifactPath,
    visibleVerifier: syntheticArtifactPath,
    hiddenOracle: syntheticArtifactPath,
    finalPatch: syntheticArtifactPath,
    sourceManifest: syntheticArtifactPath,
    counterlaneCli: syntheticArtifactPath,
  };
  if (assignment.hostSurface === "codex") {
    rawArtifactHashes["attempt"] = syntheticArtifactHash;
    rawArtifactPaths["attempt"] = syntheticArtifactPath;
  }
  if (counterlaneConfig["status"] === "verified") rawArtifactPaths["counterlaneConfig"] = syntheticArtifactPath;
  if (modelCatalog["status"] === "verified") rawArtifactPaths["modelCatalog"] = syntheticModelCatalogPath;
  if (quota["status"] === "verified") rawArtifactPaths["quotaSnapshot"] = quotaPath;
  const commonCost = harness.extractCommonCost(runtimeOutput);
  commonCost.source = "mock";
  return {
    schemaVersion: 1,
    ...assignment,
    startedAt: "2026-07-12T00:00:00.000Z",
    completedAt: "2026-07-12T00:00:01.000Z",
    runCompleted: true,
    visibleVerifierPassed: true,
    hiddenOraclePassed: success,
    verifiedSuccess: success,
    badEscape: !success,
    durationMs: 1_000,
    commonCost,
    treatmentCompliance: "compliant",
    contamination: [],
    runtimeEvidence,
    rawArtifactHashes,
    rawArtifactPaths,
    exitCode: 0,
    timedOut: false,
    outputOverflow: false,
    spawnError: null,
  };
}

function verifiedSnapshotEvidence(
  path: string,
  hash: string,
  value: string,
  scope: string,
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...verifiedEvidence(path, hash, value, scope),
    capturedAt: "2026-07-12T00:00:00.000Z",
    snapshot,
  };
}

function setCommonCostTotal(trial: Trial, totalTokens: number): void {
  const outputTokens = 20;
  const inputTokens = totalTokens - outputTokens;
  const cachedInputTokens = 20;
  trial.commonCost.value = totalTokens;
  trial.commonCost.breakdown = {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: inputTokens - cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 10,
  };
}

function bindQuotaFixture(harness: Harness, trial: Trial, path: string): void {
  const bytes = readFileSync(path);
  const snapshot = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const hash = createHash("sha256").update(bytes).digest("hex");
  trial.runtimeEvidence["quotaSnapshot"] = verifiedSnapshotEvidence(
    path,
    hash,
    "1 live quota bucket(s)",
    "codex-app-server-live-quota",
    snapshot,
  );
  trial.rawArtifactHashes["quotaSnapshot"] = hash;
  trial.rawArtifactPaths["quotaSnapshot"] = path;
  rebindEnvironmentHash(harness, trial);
}

function bindRuntimeOutputFixture(harness: Harness, trial: Trial, path: string): void {
  const stdout = readFileSync(path, "utf8");
  const { environmentHash: _oldEnvironmentHash, ...runtimeEvidence } = trial.runtimeEvidence;
  trial.runtimeEvidence = harness.bindCounterlaneRouteEvidence(runtimeEvidence, trial.counterlaneEnabled, stdout);
  trial.commonCost = harness.extractCommonCost(stdout);
  trial.rawArtifactHashes["runStdout"] = createHash("sha256").update(stdout).digest("hex");
  trial.rawArtifactPaths["runStdout"] = path;
  trial.rawArtifactHashes["environment"] = trial.runtimeEvidence["environmentHash"];
}

function rebindEnvironmentHash(harness: Harness, trial: Trial): void {
  const { environmentHash: _oldEnvironmentHash, ...runtimeEvidence } = trial.runtimeEvidence;
  trial.runtimeEvidence["environmentHash"] = harness.computeEnvironmentHash(runtimeEvidence);
  trial.rawArtifactHashes["environment"] = trial.runtimeEvidence["environmentHash"];
}

function verifiedEvidence(path: string, hash: string, value: string, scope: string): Record<string, unknown> {
  return { status: "verified", scope, path, value, sha256: hash };
}

function unavailableEvidence(scope: string, reason: string, status = "unavailable"): Record<string, unknown> {
  return { status, scope, path: null, value: null, sha256: null, reason };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, shell: false, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
