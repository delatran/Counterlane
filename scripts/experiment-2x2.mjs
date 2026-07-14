import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkSourceManifest } from "./source-manifest.mjs";

export const CELL_DEFINITIONS = Object.freeze([
  Object.freeze({ cellId: "codex-off", hostSurface: "codex", counterlaneEnabled: false }),
  Object.freeze({ cellId: "codex-on", hostSurface: "codex", counterlaneEnabled: true }),
  Object.freeze({ cellId: "chatgpt-work-off", hostSurface: "chatgpt-work", counterlaneEnabled: false }),
  Object.freeze({ cellId: "chatgpt-work-on", hostSurface: "chatgpt-work", counterlaneEnabled: true }),
]);

export function cellDefinitionsForProtocol(protocol) {
  const enabledHosts = new Set(protocol.hostSurfaces);
  return CELL_DEFINITIONS.filter((cell) => enabledHosts.has(cell.hostSurface));
}

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_STUDY_DIRECTORY = join(REPOSITORY_ROOT, "experiments", "work-codex-2x2");
const DEFAULT_PROTOCOL_PATH = join(DEFAULT_STUDY_DIRECTORY, "protocol.codex-app.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const INVALID_LOCK_RECLAIM_AGE_MS = 6 * 60 * 60 * 1_000;
const REQUIRED_CONTAMINATION_CODES = Object.freeze([
  "model-reroute",
  "service-tier-drift",
  "quota-interference",
  "other",
  "treatment-noncompliance",
]);
const RUNTIME_PARITY_FIELDS = Object.freeze([
  "sourceManifest",
  "counterlaneCli",
  "node",
  "codex",
  "modelCatalog",
]);
const REQUIRED_TRIAL_ARTIFACTS = Object.freeze([
  "runStdout",
  "runStderr",
  "visibleVerifier",
  "hiddenOracle",
  "finalPatch",
  "sourceManifest",
  "counterlaneCli",
]);

export async function loadStudy(options = {}) {
  const protocolPath = resolve(options.protocolPath ?? options.protocol ?? DEFAULT_PROTOCOL_PATH);
  const studyDirectory = dirname(protocolPath);
  const tasksPath = resolve(options.tasksPath ?? options.tasks ?? join(studyDirectory, "tasks.jsonl"));
  const protocolRaw = await readFile(protocolPath, "utf8");
  const protocol = parseJson(protocolRaw, protocolPath);
  validateProtocol(protocol);
  const tasks = await readJsonLines(tasksPath);
  if (tasks.length === 0) throw new Error(`No tasks found in ${tasksPath}`);
  const seen = new Set();
  for (const task of tasks) {
    await validateTask(task, studyDirectory);
    if (seen.has(task.taskId)) throw new Error(`Duplicate taskId: ${task.taskId}`);
    seen.add(task.taskId);
  }
  return {
    protocolPath,
    tasksPath,
    studyDirectory,
    protocol,
    protocolHash: sha256(protocolRaw),
    tasks,
  };
}

export function resolveCounterlaneCliPath(configuredPath) {
  expectNonEmptyString(configuredPath, "protocol.counterlane.cli");
  return resolveWithin(REPOSITORY_ROOT, configuredPath, "counterlane.cli");
}

export async function buildSchedule(study) {
  const assignments = await buildExpectedAssignments(study);
  const schedule = {
    schemaVersion: 1,
    studyId: study.protocol.studyId,
    phase: study.protocol.phase,
    protocolHash: study.protocolHash,
    seed: study.protocol.randomization.seed,
    algorithm: study.protocol.randomization.algorithm,
    assignments,
  };
  await validateSchedule(schedule, study);
  return schedule;
}

async function buildExpectedAssignments(study) {
  const assignments = [];
  const definitions = cellDefinitionsForProtocol(study.protocol);
  const sortedTasks = [...study.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId));
  for (const task of sortedTasks) {
    const taskHash = sha256(stableJson(task));
    const fixture = await resolveExistingWithin(
      study.studyDirectory,
      task.fixturePath,
      `fixturePath for ${task.taskId}`,
      "directory",
    );
    const sourceHash = await hashDirectory(fixture);
    const promptHash = sha256(task.prompt);
    const verifierHash = sha256(stableJson(task.visibleVerifier));
    const oracleHash = await hashOracle(study.studyDirectory, task.hiddenOracle);
    for (let replicate = 1; replicate <= study.protocol.repetitions; replicate += 1) {
      const blockId = `${task.taskId}:r${replicate}`;
      const cells = seededShuffle(
        definitions,
        `${study.protocol.randomization.seed}\0${blockId}`,
      );
      for (const [index, cell] of cells.entries()) {
        const assignmentId = sha256(
          `${study.protocol.studyId}\0${task.taskId}\0${replicate}\0${cell.cellId}`,
        ).slice(0, 24);
        assignments.push({
          schemaVersion: 1,
          assignmentId,
          blockId,
          order: index + 1,
          studyId: study.protocol.studyId,
          protocolHash: study.protocolHash,
          taskId: task.taskId,
          taskHash,
          hostSurface: cell.hostSurface,
          counterlaneEnabled: cell.counterlaneEnabled,
          replicate,
          sourceHash,
          promptHash,
          verifierHash,
          oracleHash,
        });
      }
    }
  }
  return assignments;
}

export async function validateSchedule(schedule, study) {
  expectRecord(schedule, "schedule");
  expectEqual(schedule.schemaVersion, 1, "schedule.schemaVersion");
  expectEqual(schedule.studyId, study.protocol.studyId, "schedule.studyId");
  expectEqual(schedule.protocolHash, study.protocolHash, "schedule.protocolHash");
  expectEqual(schedule.seed, study.protocol.randomization.seed, "schedule.seed");
  expectEqual(schedule.algorithm, study.protocol.randomization.algorithm, "schedule.algorithm");
  if (!Array.isArray(schedule.assignments)) throw new Error("schedule.assignments must be an array");
  const assignmentIds = new Set();
  const blocks = new Map();
  for (const assignment of schedule.assignments) {
    validateAssignment(assignment);
    if (assignmentIds.has(assignment.assignmentId)) {
      throw new Error(`Duplicate assignmentId in schedule: ${assignment.assignmentId}`);
    }
    assignmentIds.add(assignment.assignmentId);
    const block = blocks.get(assignment.blockId) ?? [];
    block.push(assignment);
    blocks.set(assignment.blockId, block);
  }
  const definitions = cellDefinitionsForProtocol(study.protocol);
  const expectedCells = new Set(definitions.map((cell) => cell.cellId));
  const expectedOrders = definitions.map((_cell, index) => index + 1);
  for (const [blockId, assignments] of blocks) {
    if (assignments.length !== definitions.length) {
      throw new Error(`Block ${blockId} must contain exactly ${definitions.length} cells`);
    }
    const orders = new Set(assignments.map((assignment) => assignment.order));
    const cells = new Set(assignments.map(cellIdForAssignment));
    if (orders.size !== expectedOrders.length || !expectedOrders.every((order) => orders.has(order))) {
      throw new Error(`Block ${blockId} must contain orders 1 through ${expectedOrders.length} exactly once`);
    }
    if (cells.size !== expectedCells.size || [...expectedCells].some((cell) => !cells.has(cell))) {
      throw new Error(`Block ${blockId} does not contain the complete configured cell set`);
    }
  }
  const expectedBlocks = study.tasks.length * study.protocol.repetitions;
  if (blocks.size !== expectedBlocks) {
    throw new Error(`Expected ${expectedBlocks} blocks, found ${blocks.size}`);
  }
  const expectedAssignments = await buildExpectedAssignments(study);
  if (stableJson(schedule.assignments) !== stableJson(expectedAssignments)) {
    const mismatchIndex = schedule.assignments.findIndex(
      (assignment, index) => stableJson(assignment) !== stableJson(expectedAssignments[index]),
    );
    throw new Error(
      `Schedule assignments do not match the registered task hashes and seeded order` +
      (mismatchIndex < 0 ? "." : ` at index ${mismatchIndex}.`),
    );
  }
  return schedule;
}

export async function createWorkPacket(study, schedule, assignmentId) {
  const assignment = findAssignment(schedule, assignmentId);
  if (assignment.hostSurface !== "chatgpt-work") {
    throw new Error(`Assignment ${assignmentId} is not a ChatGPT Work cell`);
  }
  const task = findTask(study, assignment.taskId);
  await validateTask(task, study.studyDirectory);
  const fixturePath = await resolveExistingWithin(study.studyDirectory, task.fixturePath, "fixturePath", "directory");
  const fixtureFiles = await readFixtureManifest(fixturePath);
  const localRuntimeEvidence = await collectRuntimeEvidence(study, {
    hostSurface: "chatgpt-work",
    counterlaneEnabled: assignment.counterlaneEnabled,
  });
  const action = assignment.counterlaneEnabled
    ? "Invoke the connected Counterlane app for this task and use its delegated result."
    : "Use native ChatGPT Work for this task. Do not invoke or mention Counterlane.";
  return {
    schemaVersion: 1,
    packetKind: "manual-or-connected-chatgpt-work-trial",
    studyId: study.protocol.studyId,
    protocolHash: study.protocolHash,
    assignment,
    localRuntimeEvidence,
    task: {
      taskId: task.taskId,
      family: task.family,
      riskTier: task.riskTier,
      prompt: task.prompt,
      fixturePath,
      fixtureFiles,
      sourceHash: assignment.sourceHash,
      visibleVerifier: task.visibleVerifier,
      hiddenOracleHash: assignment.oracleHash,
    },
    instructions: [
      "Start from a fresh copy of the registered fixture and a new conversation.",
      action,
      "Export final.patch from git diff --binary HEAD plus run.stdout.log and run.stderr.log into one local bundle directory.",
      "Add bundle.json whose files object covers every payload file and contains each SHA-256; do not include the hidden oracle.",
      "For Counterlane-on, also include the raw structured result as counterlane-result.json so compliance can be derived.",
      "The importer applies final.patch to a fresh fixture and runs the common verifier and external hidden oracle locally.",
      "Record every contamination or intervention; do not discard the assigned trial.",
      "Complete only the import envelope; outcome booleans, hashes, cost, and compliance supplied by a user are rejected.",
    ],
    sealedBundleContract: {
      requiredFiles: ["final.patch", "run.stdout.log", "run.stderr.log"],
      optionalFiles: ["counterlane-result.json"],
      manifest: {
        schemaVersion: 1,
        assignmentId: assignment.assignmentId,
        files: {
          "final.patch": "REPLACE_WITH_SHA256",
          "run.stdout.log": "REPLACE_WITH_SHA256",
          "run.stderr.log": "REPLACE_WITH_SHA256",
        },
      },
    },
    importEnvelope: {
      schemaVersion: 1,
      assignmentId: assignment.assignmentId,
      bundlePath: "REPLACE_WITH_LOCAL_BUNDLE_DIRECTORY",
      startedAt: "REPLACE_WITH_ISO_8601",
      completedAt: "REPLACE_WITH_ISO_8601",
      contamination: [],
    },
  };
}

export function validateTrialRecord(trial, assignment, protocol) {
  expectRecord(trial, "trial");
  expectEqual(trial.schemaVersion, 1, "trial.schemaVersion");
  for (const field of [
    "studyId",
    "protocolHash",
    "taskId",
    "taskHash",
    "hostSurface",
    "assignmentId",
    "sourceHash",
    "promptHash",
    "verifierHash",
    "oracleHash",
    "startedAt",
    "completedAt",
  ]) {
    expectNonEmptyString(trial[field], `trial.${field}`);
  }
  if (trial.hostSurface !== "codex" && trial.hostSurface !== "chatgpt-work") {
    throw new Error("trial.hostSurface must be codex or chatgpt-work");
  }
  expectBoolean(trial.counterlaneEnabled, "trial.counterlaneEnabled");
  expectPositiveInteger(trial.replicate, "trial.replicate");
  expectPositiveInteger(trial.order, "trial.order");
  if (trial.order > 4) throw new Error("trial.order must be between 1 and 4");
  for (const field of ["protocolHash", "taskHash", "sourceHash", "promptHash", "verifierHash", "oracleHash"]) {
    if (!SHA256_PATTERN.test(trial[field])) throw new Error(`trial.${field} must be a SHA-256 hex digest`);
  }
  for (const field of [
    "runCompleted",
    "visibleVerifierPassed",
    "hiddenOraclePassed",
    "verifiedSuccess",
    "badEscape",
  ]) {
    expectBoolean(trial[field], `trial.${field}`);
  }
  if (trial.exitCode !== null && (!Number.isInteger(trial.exitCode) || trial.exitCode < 0)) {
    throw new Error("trial.exitCode must be null or a non-negative integer");
  }
  expectBoolean(trial.timedOut, "trial.timedOut");
  expectBoolean(trial.outputOverflow, "trial.outputOverflow");
  if (trial.spawnError !== null && (typeof trial.spawnError !== "string" || trial.spawnError.length === 0)) {
    throw new Error("trial.spawnError must be null or a non-empty string");
  }
  const expectedRunCompleted = trial.exitCode === 0 && !trial.timedOut &&
    !trial.outputOverflow && trial.spawnError === null;
  expectEqual(trial.runCompleted, expectedRunCompleted, "trial.runCompleted");
  expectNonNegativeNumber(trial.durationMs, "trial.durationMs");
  const startedAtMs = Date.parse(trial.startedAt);
  const completedAtMs = Date.parse(trial.completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs < startedAtMs) {
    throw new Error("trial timestamps must be ordered ISO-8601 values");
  }
  if (Math.abs(completedAtMs - startedAtMs - trial.durationMs) > 1_000) {
    throw new Error("trial.durationMs must match the recorded timestamps within one second");
  }
  validateCommonCost(trial.commonCost);
  if (!["compliant", "noncompliant", "unknown"].includes(trial.treatmentCompliance)) {
    throw new Error("trial.treatmentCompliance must be compliant, noncompliant, or unknown");
  }
  validateContamination(trial.contamination, protocol);
  validateRuntimeEvidence(trial.runtimeEvidence, trial);
  expectRecord(trial.rawArtifactHashes, "trial.rawArtifactHashes");
  const artifactHashes = Object.entries(trial.rawArtifactHashes);
  if (artifactHashes.length === 0) throw new Error("trial.rawArtifactHashes must not be empty");
  if (typeof trial.rawArtifactHashes.finalPatch !== "string" ||
      !SHA256_PATTERN.test(trial.rawArtifactHashes.finalPatch)) {
    throw new Error("trial.rawArtifactHashes.finalPatch must contain the git diff --binary HEAD hash");
  }
  for (const [name, hash] of artifactHashes) {
    expectNonEmptyString(name, "trial.rawArtifactHashes key");
    if (typeof hash !== "string" || !SHA256_PATTERN.test(hash)) {
      throw new Error(`trial.rawArtifactHashes.${name} must be a SHA-256 hex digest`);
    }
  }
  expectRecord(trial.rawArtifactPaths, "trial.rawArtifactPaths");
  for (const [name, path] of Object.entries(trial.rawArtifactPaths)) {
    expectNonEmptyString(name, "trial.rawArtifactPaths key");
    expectNonEmptyString(path, `trial.rawArtifactPaths.${name}`);
  }
  for (const name of REQUIRED_TRIAL_ARTIFACTS) {
    if (typeof trial.rawArtifactHashes[name] !== "string" || !SHA256_PATTERN.test(trial.rawArtifactHashes[name])) {
      throw new Error(`trial.rawArtifactHashes.${name} is required`);
    }
    expectNonEmptyString(trial.rawArtifactPaths[name], `trial.rawArtifactPaths.${name}`);
  }
  if (trial.rawArtifactHashes.counterlaneConfig !== undefined) {
    expectNonEmptyString(trial.rawArtifactPaths.counterlaneConfig, "trial.rawArtifactPaths.counterlaneConfig");
  }
  if (trial.hostSurface === "codex") {
    if (typeof trial.rawArtifactHashes.attempt !== "string" || !SHA256_PATTERN.test(trial.rawArtifactHashes.attempt)) {
      throw new Error("trial.rawArtifactHashes.attempt is required for Codex execution");
    }
    expectNonEmptyString(trial.rawArtifactPaths.attempt, "trial.rawArtifactPaths.attempt");
  }
  validateRuntimeArtifactBindings(trial.runtimeEvidence, trial.rawArtifactHashes);
  const expectedVerified = trial.runCompleted && trial.visibleVerifierPassed && trial.hiddenOraclePassed;
  const expectedBadEscape = trial.runCompleted && trial.visibleVerifierPassed && !trial.hiddenOraclePassed;
  if (trial.verifiedSuccess !== expectedVerified) {
    throw new Error("trial.verifiedSuccess is inconsistent with run/verifier/oracle outcomes");
  }
  if (trial.badEscape !== expectedBadEscape) {
    throw new Error("trial.badEscape is inconsistent with run/verifier/oracle outcomes");
  }
  if (assignment !== undefined) {
    for (const field of [
      "studyId",
      "protocolHash",
      "taskId",
      "taskHash",
      "hostSurface",
      "counterlaneEnabled",
      "replicate",
      "assignmentId",
      "order",
      "sourceHash",
      "promptHash",
      "verifierHash",
      "oracleHash",
    ]) {
      expectEqual(trial[field], assignment[field], `trial.${field}`);
    }
  }
  return trial;
}

export function validateRecordedTrials(schedule, trials, protocol) {
  if (!Array.isArray(trials)) throw new Error("trials must be an array");
  const expected = new Map(schedule.assignments.map((assignment) => [assignment.assignmentId, assignment]));
  const seen = new Set();
  for (const trial of trials) {
    const assignmentId = trial?.assignmentId;
    const assignment = expected.get(assignmentId);
    if (assignment === undefined) throw new Error(`Unknown assignmentId in trial set: ${String(assignmentId)}`);
    if (seen.has(assignmentId)) throw new Error(`Duplicate trial for assignmentId: ${assignmentId}`);
    validateTrialRecord(trial, assignment, protocol);
    seen.add(assignmentId);
  }
  return seen;
}

export function validateCompleteTrials(schedule, trials, protocol) {
  const seen = validateRecordedTrials(schedule, trials, protocol);
  const expected = new Map(schedule.assignments.map((assignment) => [assignment.assignmentId, assignment]));
  const missing = [...expected.keys()].filter((assignmentId) => !seen.has(assignmentId));
  if (missing.length > 0) throw new Error(`Missing trials for assignments: ${missing.join(", ")}`);
  return trials;
}

export async function validateTrialArtifactFiles(trial) {
  for (const [name, pathValue] of Object.entries(trial.rawArtifactPaths)) {
    const expectedHash = trial.rawArtifactHashes[name];
    if (expectedHash === undefined) continue;
    const path = isAbsolute(pathValue) ? resolve(pathValue) : resolve(REPOSITORY_ROOT, pathValue);
    const metadata = await lstat(path).catch(() => null);
    if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Trial artifact ${name} is missing or not a regular non-symlink file: ${path}`);
    }
    const actualHash = sha256(await readFile(path));
    expectEqual(actualHash, expectedHash, `trial artifact ${name} SHA-256`);
  }
  for (const [field, artifactName] of [
    ["modelCatalog", "modelCatalog"],
    ["quotaSnapshot", "quotaSnapshot"],
  ]) {
    const evidence = trial.runtimeEvidence[field];
    if (evidence.status !== "verified") continue;
    const pathValue = trial.rawArtifactPaths[artifactName];
    const path = isAbsolute(pathValue) ? resolve(pathValue) : resolve(REPOSITORY_ROOT, pathValue);
    const artifact = parseJson(await readFile(path, "utf8"), path);
    expectEqual(
      stableJson(artifact),
      stableJson(evidence.snapshot),
      `trial.runtimeEvidence.${field}.snapshot derived from ${artifactName}`,
    );
  }
  if (trial.hostSurface === "codex") {
    const stdoutPathValue = trial.rawArtifactPaths.runStdout;
    const stdoutPath = isAbsolute(stdoutPathValue)
      ? resolve(stdoutPathValue)
      : resolve(REPOSITORY_ROOT, stdoutPathValue);
    const stdout = await readFile(stdoutPath, "utf8");
    if (["runtime-output", "unavailable"].includes(trial.commonCost.source)) {
      expectEqual(
        stableJson(extractCommonCost(stdout)),
        stableJson(trial.commonCost),
        "trial.commonCost derived from runStdout",
      );
    }
    if (trial.counterlaneEnabled) {
      const route = extractCounterlaneRoute(stdout);
      if (trial.runtimeEvidence.counterlaneRoute.status === "verified") {
        expectEqual(
          stableJson(route),
          stableJson(trial.runtimeEvidence.counterlaneRoute.value),
          "trial.runtimeEvidence.counterlaneRoute derived from runStdout",
        );
      } else if (route !== null) {
        throw new Error("Counterlane ON route is present in runStdout but runtime evidence marks it unavailable");
      }
    }
  }
}

export function validateCrossArmRuntimeParity(schedule, trials) {
  const assignments = new Map(schedule.assignments.map((assignment) => [assignment.assignmentId, assignment]));
  const groups = new Map();
  for (const trial of trials) {
    const assignment = assignments.get(trial.assignmentId);
    const key = `${assignment.blockId}\0${trial.hostSurface}`;
    const group = groups.get(key) ?? [];
    group.push(trial);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const baseline = group[0].runtimeEvidence;
    for (const trial of group.slice(1)) {
      const candidate = trial.runtimeEvidence;
      expectEqual(candidate.platform, baseline.platform, `${key} runtime platform parity`);
      expectEqual(candidate.arch, baseline.arch, `${key} runtime architecture parity`);
      for (const field of RUNTIME_PARITY_FIELDS) {
        const expected = stableJson(runtimeParityIdentity(baseline[field]));
        const actual = stableJson(runtimeParityIdentity(candidate[field]));
        expectEqual(actual, expected, `${key} runtime ${field} parity`);
      }
    }
  }
}

function deriveAutomaticCodexChecks(protocol, schedule, trials) {
  const derivedTrials = trials.map((trial) => structuredClone(trial));
  const assignments = new Map(schedule.assignments.map((assignment) => [assignment.assignmentId, assignment]));
  const groups = new Map();
  const routeChecks = new Map();
  for (const trial of derivedTrials) {
    if (trial.hostSurface !== "codex") continue;
    let route = null;
    if (trial.counterlaneEnabled) {
      route = compareEffectiveRoute(protocol, trial);
    }
    const issues = [...(route?.issues ?? []), ...backendRouteIssues(trial)];
    for (const issue of issues) {
      addContamination(trial, issue.code, issue.detail);
      trial.treatmentCompliance = "noncompliant";
    }
    if (route !== null) {
      route = {
        ...route,
        issues,
        status: issues.length === 0 ? "within-tolerance" : "noncompliant",
        reason: issues.length === 0
          ? "Counterlane selected an admissible Auto route and no backend reroute was reported"
          : issues.map((issue) => issue.detail).join("; "),
      };
      routeChecks.set(trial.assignmentId, route);
    }
    const assignment = assignments.get(trial.assignmentId);
    if (assignment === undefined) continue;
    const group = groups.get(assignment.blockId) ?? [];
    group.push(trial);
    groups.set(assignment.blockId, group);
  }

  const comparisons = [];
  for (const [blockId, group] of groups) {
    const off = group.find((trial) => !trial.counterlaneEnabled);
    const on = group.find((trial) => trial.counterlaneEnabled);
    if (off === undefined || on === undefined) continue;

    const route = routeChecks.get(on.assignmentId);
    if (route === undefined) throw new Error(`Automatic route check is missing for ${on.assignmentId}`);

    const quota = compareQuotaSnapshots(
      off.runtimeEvidence.quotaSnapshot,
      on.runtimeEvidence.quotaSnapshot,
      protocol.contaminationPolicy.automaticCodexChecks.maxQuotaUsedPercentDelta,
    );
    if (!quota.withinTolerance) {
      const later = off.order > on.order ? off : on;
      addContamination(later, "quota-interference", quota.reason);
    }

    comparisons.push({
      blockId,
      hostSurface: "codex",
      offAssignmentId: off.assignmentId,
      onAssignmentId: on.assignmentId,
      quota,
      route,
      contaminated: !quota.withinTolerance || route.issues.length > 0,
      noncompliant: route.issues.length > 0 ||
        off.treatmentCompliance === "noncompliant" || on.treatmentCompliance === "noncompliant",
    });
  }
  return { trials: derivedTrials, comparisons };
}

function compareEffectiveRoute(protocol, onTrial) {
  const tolerance = protocol.contaminationPolicy.automaticCodexChecks;
  const evidence = onTrial.runtimeEvidence.counterlaneRoute;
  const nativeControl = {
    modelId: tolerance.expectedModelId,
    effort: tolerance.expectedEffort,
    serviceTier: tolerance.expectedServiceTier,
    speedId: tolerance.expectedSpeedId,
  };
  if (evidence.status !== "verified") {
    return {
      status: "unavailable",
      nativeControl,
      observed: null,
      issues: [],
      reason: evidence.reason,
    };
  }
  const observed = {
    modelId: evidence.value.modelId,
    effort: evidence.value.effort,
    serviceTier: evidence.value.serviceTier,
    speedId: evidence.value.speedId,
    topology: evidence.value.topology,
    proofTier: evidence.value.proofTier,
    selectionSource: evidence.value.selectionSource,
  };
  const issues = [];
  if (observed.selectionSource !== "auto-router") {
    issues.push({
      code: "treatment-noncompliance",
      detail: "Counterlane ON did not expose an Auto-router decision",
    });
  }
  if (evidence.value.routeAdmissible !== true) {
    issues.push({
      code: "treatment-noncompliance",
      detail: "Counterlane ON route was not recorded as admissible",
    });
  }
  if (evidence.value.routeDecisionMatch !== true) {
    const mismatches = evidence.value.routeDecisionMismatches;
    if (mismatches.includes("model-effort")) {
      issues.push({
        code: "model-reroute",
        detail: "Requested Counterlane model/effort does not match its sealed Auto-router selection",
      });
    }
    if (mismatches.includes("service-tier-speed")) {
      issues.push({
        code: "service-tier-drift",
        detail: "Requested Counterlane service tier/speed does not match its sealed Auto-router selection",
      });
    }
    if (!mismatches.includes("model-effort") && !mismatches.includes("service-tier-speed")) {
      issues.push({
        code: "treatment-noncompliance",
        detail: "Requested Counterlane policy does not match its sealed Auto-router selection",
      });
    }
  }
  return {
    status: issues.length === 0 ? "within-tolerance" : "noncompliant",
    nativeControl,
    observed,
    issues,
    reason: issues.length === 0
      ? "Counterlane selected an admissible Auto route; route differences from native OFF are the treatment intervention"
      : issues.map((issue) => issue.detail).join("; "),
  };
}

function backendRouteIssues(trial) {
  const evidence = trial.runtimeEvidence.backendRoute;
  if (evidence?.status !== "verified" || !Array.isArray(evidence.value)) {
    return [{
      code: "treatment-noncompliance",
      detail: "Backend reroute evidence is unavailable for this Codex arm",
    }];
  }
  if (evidence.value.length === 0) return [];
  return [{
    code: "model-reroute",
    detail: `Backend reported ${evidence.value.length} model reroute event(s): ` +
      evidence.value.map((item) => `${item.fromModel}->${item.toModel}`).join(", "),
  }];
}

function compareQuotaSnapshots(offEvidence, onEvidence, maxUsedPercentDelta) {
  if (offEvidence.status !== "verified" || onEvidence.status !== "verified") {
    return {
      status: "unavailable",
      withinTolerance: false,
      maxUsedPercentDelta,
      observedMaxUsedPercentDelta: null,
      differences: ["one or both per-arm quota snapshots are unavailable"],
      reason: "one or both per-arm quota snapshots are unavailable",
    };
  }
  const off = quotaWindowMap(offEvidence.snapshot);
  const on = quotaWindowMap(onEvidence.snapshot);
  const differences = [];
  const deltas = [];
  if (offEvidence.snapshot.planType !== onEvidence.snapshot.planType) {
    differences.push(
      `plan type changed from ${String(offEvidence.snapshot.planType)} to ${String(onEvidence.snapshot.planType)}`,
    );
  }
  const keys = [...new Set([...off.keys(), ...on.keys()])].sort();
  for (const key of keys) {
    const offWindow = off.get(key);
    const onWindow = on.get(key);
    if (offWindow === undefined || onWindow === undefined) {
      differences.push(`quota window ${key} was present in only one arm`);
      continue;
    }
    if (offWindow.windowDurationMins !== onWindow.windowDurationMins || offWindow.resetsAt !== onWindow.resetsAt) {
      differences.push(`quota window ${key} changed duration or reset boundary between arms`);
      continue;
    }
    const delta = Math.abs(onWindow.usedPercent - offWindow.usedPercent);
    deltas.push(delta);
    if (delta > maxUsedPercentDelta) {
      differences.push(
        `quota window ${key} changed by ${formatCompactNumber(delta)} percentage points, exceeding ` +
        `the preregistered ${formatCompactNumber(maxUsedPercentDelta)}-point tolerance`,
      );
    }
  }
  const observedMaxUsedPercentDelta = deltas.length === 0 ? null : Math.max(...deltas);
  const withinTolerance = differences.length === 0;
  return {
    status: withinTolerance ? "within-tolerance" : "contaminated",
    withinTolerance,
    maxUsedPercentDelta,
    observedMaxUsedPercentDelta,
    differences,
    reason: withinTolerance
      ? `all comparable quota windows stayed within the preregistered ${formatCompactNumber(maxUsedPercentDelta)}-point tolerance`
      : differences.join("; "),
  };
}

function quotaWindowMap(snapshot) {
  const output = new Map();
  const buckets = [
    ...(snapshot.primary === null || snapshot.primary === undefined
      ? []
      : [{ source: "primary", bucket: snapshot.primary }]),
    ...Object.entries(snapshot.byId).map(([id, bucket]) => ({ source: `byId:${id}`, bucket })),
  ];
  for (const { source, bucket } of buckets) {
    for (const kind of ["primary", "secondary"]) {
      const window = bucket[kind];
      if (window !== null && window !== undefined) {
        output.set(`${source}/${bucket.limitId}/${kind}`, window);
      }
    }
  }
  return output;
}

function addContamination(trial, code, detail) {
  if (!trial.contamination.some((item) => item.code === code)) {
    trial.contamination.push({ code, detail });
  }
}

function formatCompactNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
}

export async function analyzeTrials(study, schedule, trials) {
  validateCompleteTrials(schedule, trials, study.protocol);
  await Promise.all(trials.map(validateTrialArtifactFiles));
  validateCrossArmRuntimeParity(schedule, trials);
  const automaticChecks = deriveAutomaticCodexChecks(study.protocol, schedule, trials);
  const analysisTrials = automaticChecks.trials;
  validateCompleteTrials(schedule, analysisTrials, study.protocol);
  const definitions = cellDefinitionsForProtocol(study.protocol);
  const cells = definitions.map((definition) => {
    const selected = analysisTrials.filter(
      (trial) => trial.hostSurface === definition.hostSurface &&
        trial.counterlaneEnabled === definition.counterlaneEnabled,
    );
    const successes = selected.filter((trial) => trial.verifiedSuccess).length;
    const badEscapes = selected.filter((trial) => trial.badEscape).length;
    const contaminated = selected.filter((trial) => trial.contamination.length > 0).length;
    const noncompliant = selected.filter((trial) => trial.treatmentCompliance === "noncompliant").length;
    const verifiedCounterlaneRoutes = selected.filter(
      (trial) => !trial.counterlaneEnabled || trial.runtimeEvidence.counterlaneRoute.status === "verified",
    ).length;
    return {
      ...definition,
      assigned: selected.length,
      successes,
      verifiedSuccessRate: successes / selected.length,
      badEscapes,
      badEscapeRate: badEscapes / selected.length,
      meanDurationMs: mean(selected.map((trial) => trial.durationMs)),
      commonCost: summarizeCommonCost(selected.map((trial) => trial.commonCost)),
      contaminated,
      noncompliant,
      verifiedCounterlaneRoutes,
    };
  });
  const effects = {};
  for (const hostSurface of study.protocol.hostSurfaces) {
    const off = cells.find((cell) => cell.hostSurface === hostSurface && !cell.counterlaneEnabled);
    const on = cells.find((cell) => cell.hostSurface === hostSurface && cell.counterlaneEnabled);
    effects[hostSurface] = {
      offVerifiedSuccessRate: off.verifiedSuccessRate,
      onVerifiedSuccessRate: on.verifiedSuccessRate,
      delta: on.verifiedSuccessRate - off.verifiedSuccessRate,
      commonCost: compareCommonCost(
        off,
        on,
        study.protocol.analysis,
        automaticChecks.comparisons.filter((comparison) => comparison.hostSurface === hostSurface),
      ),
    };
  }
  const contaminationCodes = {};
  for (const trial of analysisTrials) {
    for (const item of trial.contamination) {
      contaminationCodes[item.code] = (contaminationCodes[item.code] ?? 0) + 1;
    }
  }
  const clusterCount = new Set(analysisTrials.map((trial) => trial.taskId)).size;
  const minimumClusters = study.protocol.analysis.minimumCompleteTaskClustersForConfidence;
  const confidenceReason = study.protocol.analysis.allowStatisticalConfidenceClaim
    ? `No inferential estimator is implemented by this smoke harness, even though ${clusterCount} clusters were observed.`
    : `Protocol forbids statistical-confidence claims; ${clusterCount} complete task cluster(s) were observed and the preregistered floor is ${minimumClusters}.`;
  return {
    schemaVersion: 1,
    studyId: study.protocol.studyId,
    phase: study.protocol.phase,
    protocolHash: study.protocolHash,
    estimand: "descriptive intention-to-treat",
    trialCount: analysisTrials.length,
    completeTaskClusters: clusterCount,
    primaryEndpoint: study.protocol.endpoints.primary,
    cells,
    hostEffects: effects,
    interaction: effects["chatgpt-work"] === undefined
      ? null
      : effects["chatgpt-work"].delta - effects.codex.delta,
    contamination: {
      retainedTrialCount: analysisTrials.filter((trial) => trial.contamination.length > 0).length,
      codes: contaminationCodes,
    },
    automaticCodexChecks: automaticChecks.comparisons,
    runtimeBindings: analysisTrials.map(runtimeBindingSummary),
    statisticalConfidence: {
      claimed: false,
      reason: confidenceReason,
    },
    claimBoundary: study.protocol.claimBoundary,
  };
}

function runtimeParityIdentity(item) {
  return {
    status: item.status,
    scope: item.scope,
    sha256: item.sha256,
    value: item.value,
  };
}

export function renderReport(analysis) {
  const codexOnly = analysis.cells.every((cell) => cell.hostSurface === "codex");
  const lines = [
    codexOnly
      ? "# Codex app x Counterlane paired smoke report"
      : "# Work/Codex x Counterlane 2x2 smoke report",
    "",
    `- Study: \`${analysis.studyId}\``,
    `- Phase: \`${analysis.phase}\``,
    `- Estimand: ${analysis.estimand}`,
    `- Trials: ${analysis.trialCount}`,
    `- Complete task clusters: ${analysis.completeTaskClusters}`,
    `- Preregistered primary endpoint: ${analysis.primaryEndpoint}`,
    "",
    "## Cell outcomes",
    "",
    "| Host | Counterlane | Assigned | Verified success | Bad escape | Mean duration ms | Mean common cost | Unit | Contaminated | Noncompliant |",
    "|---|---:|---:|---:|---:|---:|---:|---|---:|---:|",
  ];
  for (const cell of analysis.cells) {
    lines.push(
      `| ${cell.hostSurface} | ${cell.counterlaneEnabled ? "on" : "off"} | ${cell.assigned} | ` +
      `${formatRate(cell.verifiedSuccessRate)} | ${formatRate(cell.badEscapeRate)} | ` +
      `${cell.meanDurationMs.toFixed(1)} | ${formatNullableNumber(cell.commonCost.mean)} | ${cell.commonCost.unit} | ` +
      `${cell.contaminated} | ${cell.noncompliant} |`,
    );
  }
  lines.push(
    "",
    "## Preregistered common token metric",
    "",
    "The comparable token metric is gross runtime `total_tokens` (`input_tokens + output_tokens`). Cached input and reasoning output are retained as components; they are not substituted for the preregistered gross total.",
    "",
    "| Host | Counterlane | Gross total | Input | Cached input | Uncached input | Output | Reasoning output |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const cell of analysis.cells) {
    const breakdown = cell.commonCost.breakdown;
    lines.push(
      `| ${cell.hostSurface} | ${cell.counterlaneEnabled ? "on" : "off"} | ` +
      `${formatNullableNumber(breakdown.totalTokens)} | ${formatNullableNumber(breakdown.inputTokens)} | ` +
      `${formatNullableNumber(breakdown.cachedInputTokens)} | ${formatNullableNumber(breakdown.uncachedInputTokens)} | ` +
      `${formatNullableNumber(breakdown.outputTokens)} | ${formatNullableNumber(breakdown.reasoningOutputTokens)} |`,
    );
  }
  lines.push(
    "",
    "## Descriptive intention-to-treat effects",
    "",
  );
  for (const [hostSurface, effect] of Object.entries(analysis.hostEffects)) {
    lines.push(`- ${hostSurface} on-minus-off verified-success delta: ${formatSignedRate(effect.delta)}`);
    const cost = effect.commonCost;
    lines.push(
      `- ${hostSurface} common-cost effect: ${cost.comparable ? `${formatSignedNumber(cost.onMinusOff)} ${cost.unit}; savings ${formatNullablePercent(cost.savingsPct)}` : "not comparable"}`,
    );
    lines.push(`- ${hostSurface} token/cost-savings claim eligible: ${cost.claimEligible ? "yes" : "no"} (${cost.reason})`);
  }
  if (analysis.interaction !== null) {
    lines.push(`- Interaction (Work delta minus Codex delta): ${formatSignedRate(analysis.interaction)}`);
  }
  lines.push(
    "",
    "## Runtime catalog, quota, and route binding",
    "",
    "Model-catalog hashes are a strict cross-arm parity gate. Quota is captured immediately before each sequential arm; hashes may differ, but normalized windows are compared under the preregistered contamination tolerance below.",
    "",
    "| Assignment | Arm | Model catalog SHA-256 | Quota SHA-256 | Quota windows | Effective Counterlane route | Backend reroutes |",
    "|---|---|---|---|---|---|---|",
  );
  for (const binding of analysis.runtimeBindings) {
    lines.push(
      `| ${binding.assignmentId} | ${binding.counterlaneEnabled ? "on" : "off"} | ` +
      `${binding.modelCatalog.sha256 ?? binding.modelCatalog.status} | ` +
      `${binding.quotaSnapshot.sha256 ?? binding.quotaSnapshot.status} | ` +
      `${formatQuotaWindows(binding.quotaSnapshot.windows)} | ${formatRouteBinding(binding.counterlaneRoute)} | ` +
      `${formatBackendRouteBinding(binding.backendRoute)} |`,
    );
  }
  lines.push(
    "",
    "## Automatic paired contamination checks",
    "",
    "The harness compares hashed per-arm quota snapshots, validates that ON used an admissible coherent Auto decision, and rejects any backend-reported reroute in either arm. Auto route differences from native OFF are the intervention, not contamination. These checks retain every assigned trial but make a contaminated or noncompliant token-savings comparison claim-ineligible.",
    "",
    "| Block | Quota check | Observed max quota delta | Route check | Contaminated | Noncompliant |",
    "|---|---|---:|---|---:|---:|",
  );
  for (const comparison of analysis.automaticCodexChecks) {
    lines.push(
      `| ${comparison.blockId} | ${comparison.quota.status} | ` +
      `${comparison.quota.observedMaxUsedPercentDelta === null ? "unavailable" : `${formatCompactNumber(comparison.quota.observedMaxUsedPercentDelta)} pp`} | ` +
      `${comparison.route.status} | ${comparison.contaminated ? "yes" : "no"} | ` +
      `${comparison.noncompliant ? "yes" : "no"} |`,
    );
  }
  const flaggedComparisons = analysis.automaticCodexChecks.filter(
    (candidate) => candidate.contaminated || candidate.noncompliant,
  );
  if (flaggedComparisons.length > 0) lines.push("");
  for (const comparison of flaggedComparisons) {
    lines.push(
      `- ${comparison.blockId}: quota=${comparison.quota.reason}; route=${comparison.route.reason}`,
    );
  }
  lines.push(
    "",
    "## Contamination",
    "",
    `Retained contaminated trials: ${analysis.contamination.retainedTrialCount}`,
    "",
    "```json",
    JSON.stringify(analysis.contamination.codes, null, 2),
    "```",
    "",
    "## Statistical claim boundary",
    "",
    `No statistical confidence is claimed. ${analysis.statisticalConfidence.reason}`,
    "",
    analysis.claimBoundary,
    "",
  );
  return lines.join("\n");
}

function runtimeBindingSummary(trial) {
  const modelCatalog = trial.runtimeEvidence.modelCatalog;
  const quotaSnapshot = trial.runtimeEvidence.quotaSnapshot;
  return {
    assignmentId: trial.assignmentId,
    hostSurface: trial.hostSurface,
    counterlaneEnabled: trial.counterlaneEnabled,
    modelCatalog: {
      status: modelCatalog.status,
      sha256: modelCatalog.sha256,
      capturedAt: modelCatalog.capturedAt ?? null,
    },
    quotaSnapshot: {
      status: quotaSnapshot.status,
      sha256: quotaSnapshot.sha256,
      capturedAt: quotaSnapshot.capturedAt ?? null,
      windows: quotaSnapshot.status === "verified" ? quotaWindows(quotaSnapshot.snapshot) : [],
    },
    counterlaneRoute: trial.runtimeEvidence.counterlaneRoute,
    backendRoute: trial.runtimeEvidence.backendRoute,
  };
}

function formatBackendRouteBinding(evidence) {
  if (evidence?.status !== "verified") return evidence?.status ?? "unavailable";
  return evidence.value.length === 0
    ? "none reported"
    : evidence.value.map((item) => `${item.fromModel}->${item.toModel}`).join(", ");
}

function quotaWindows(snapshot) {
  const buckets = [
    ...(snapshot.primary === null ? [] : [snapshot.primary]),
    ...Object.values(snapshot.byId),
  ];
  const windows = [];
  for (const bucket of buckets) {
    for (const kind of ["primary", "secondary"]) {
      const window = bucket[kind];
      if (window !== null && window !== undefined) {
        windows.push({
          limitId: bucket.limitId,
          kind,
          usedPercent: window.usedPercent,
          windowDurationMins: window.windowDurationMins,
          resetsAt: window.resetsAt,
        });
      }
    }
  }
  return windows;
}

function formatQuotaWindows(windows) {
  if (windows.length === 0) return "unavailable";
  return windows
    .map((window) => `${window.limitId}/${window.kind}: ${window.usedPercent}%`)
    .join("; ");
}

function formatRouteBinding(route) {
  if (route.status === "not-applicable") return "not applicable (native OFF)";
  if (route.status !== "verified") return `unavailable: ${route.reason}`;
  return [
    route.value.modelId,
    route.value.effort,
    route.value.speedId,
    route.value.topology,
    route.value.proofTier,
  ].join(" / ");
}

export async function runCodexAssignment(study, schedule, assignmentId, options = {}) {
  const assignment = findAssignment(schedule, assignmentId);
  if (assignment.hostSurface !== "codex") {
    throw new Error(`Assignment ${assignmentId} is not a Codex cell`);
  }
  const task = findTask(study, assignment.taskId);
  await validateTask(task, study.studyDirectory);
  const artifactRoot = resolve(options.artifactRoot ?? defaultArtifactRoot(study));
  const trialsPath = resolve(options.trialsPath ?? join(artifactRoot, "raw", "trials.jsonl"));
  const releaseLock = await acquireTrialLock(trialsPath);
  let workspace = null;
  const rawDirectory = join(artifactRoot, "raw", assignmentId);
  const startedAtMs = Date.now();
  let run = null;
  let runtimeEvidence = null;
  let baselineCommit = null;
  let attemptPath = null;
  let preserveWorkspaceForRecovery = false;
  try {
    const existing = await readJsonLinesIfPresent(trialsPath);
    validateRecordedTrials(schedule, existing, study.protocol);
    await Promise.all(existing.map(validateTrialArtifactFiles));
    assertAssignmentReady(schedule, existing, assignment);
    await assertNoPriorAttempt(rawDirectory, assignment);
    workspace = await mkdtemp(join(tmpdir(), `counterlane-2x2-${assignmentId}-`));
    await mkdir(rawDirectory, { recursive: true });
    const fixture = await resolveExistingWithin(study.studyDirectory, task.fixturePath, "fixturePath", "directory");
    await copyDirectory(fixture, workspace);
    const sourceHash = await hashDirectory(workspace);
    if (sourceHash !== assignment.sourceHash) {
      throw new Error(`Source drift for ${assignmentId}: expected ${assignment.sourceHash}, got ${sourceHash}`);
    }
    baselineCommit = await initializeGitRepository(workspace);
    const prepared = assignment.counterlaneEnabled
      ? await prepareCounterlaneOn(study, task, workspace, rawDirectory)
      : prepareCodexOff(study, task, workspace);
    runtimeEvidence = await collectRuntimeEvidence(study, {
      hostSurface: "codex",
      counterlaneEnabled: assignment.counterlaneEnabled,
      counterlaneConfigPath: prepared.counterlaneConfigPath,
      rawDirectory,
      task,
      workspace,
    });
    attemptPath = await writeAttemptMarker(rawDirectory, assignment, runtimeEvidence.environmentHash, startedAtMs);
    run = (await prepared.execute()).process;
    runtimeEvidence = bindCounterlaneRouteEvidence(
      runtimeEvidence,
      assignment.counterlaneEnabled,
      run.stdout,
    );
    await assertBaselineHead(workspace, baselineCommit);
    const candidateStateHash = await hashDirectory(workspace, [".git", ".counterlane-study"]);
    const visible = await executeTaskCommand(task.visibleVerifier, {
      cwd: workspace,
      studyDirectory: study.studyDirectory,
      workspace,
    });
    const hidden = await executeTaskCommand(task.hiddenOracle, {
      cwd: study.studyDirectory,
      studyDirectory: study.studyDirectory,
      workspace,
    });
    const verifiedStateHash = await hashDirectory(workspace, [".git", ".counterlane-study"]);
    if (verifiedStateHash !== candidateStateHash) {
      throw new Error("Visible verifier or hidden oracle mutated the candidate workspace; refusing to certify an incomplete patch");
    }
    const finalPatch = await captureReproduciblePatch(workspace, baselineCommit);
    const stdoutPath = join(rawDirectory, "run.stdout.log");
    const stderrPath = join(rawDirectory, "run.stderr.log");
    const visiblePath = join(rawDirectory, "visible-verifier.log");
    const hiddenPath = join(rawDirectory, "hidden-oracle.log");
    const patchPath = join(rawDirectory, "final.patch");
    await Promise.all([
      writeFile(stdoutPath, run.stdout, "utf8"),
      writeFile(stderrPath, run.stderr, "utf8"),
      writeFile(visiblePath, renderProcessEvidence(visible), "utf8"),
      writeFile(hiddenPath, renderProcessEvidence(hidden), "utf8"),
      writeFile(patchPath, finalPatch.stdout, "utf8"),
    ]);
    const completedAtMs = Date.now();
    const runCompleted = run.exitCode === 0 && !run.timedOut && !run.outputOverflow && run.spawnError === null;
    const visibleVerifierPassed = visible.exitCode === 0 && !visible.timedOut && visible.spawnError === null;
    const hiddenOraclePassed = hidden.exitCode === 0 && !hidden.timedOut && hidden.spawnError === null;
    const treatment = deriveCodexTreatmentState(
      assignment.counterlaneEnabled,
      run,
      runtimeEvidence,
    );
    const contamination = [...treatment.contamination];
    if (run.outputOverflow) contamination.push({ code: "other", detail: "run output exceeded capture limit" });
    const trial = {
      schemaVersion: 1,
      studyId: assignment.studyId,
      protocolHash: assignment.protocolHash,
      taskId: assignment.taskId,
      taskHash: assignment.taskHash,
      hostSurface: assignment.hostSurface,
      counterlaneEnabled: assignment.counterlaneEnabled,
      replicate: assignment.replicate,
      assignmentId: assignment.assignmentId,
      order: assignment.order,
      sourceHash: assignment.sourceHash,
      promptHash: assignment.promptHash,
      verifierHash: assignment.verifierHash,
      oracleHash: assignment.oracleHash,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      runCompleted,
      visibleVerifierPassed,
      hiddenOraclePassed,
      verifiedSuccess: runCompleted && visibleVerifierPassed && hiddenOraclePassed,
      badEscape: runCompleted && visibleVerifierPassed && !hiddenOraclePassed,
      durationMs: completedAtMs - startedAtMs,
      commonCost: extractCommonCost(run.stdout),
      treatmentCompliance: treatment.compliance,
      contamination,
      runtimeEvidence,
      rawArtifactHashes: {
        runStdout: sha256(run.stdout),
        runStderr: sha256(run.stderr),
        visibleVerifier: sha256(renderProcessEvidence(visible)),
        hiddenOracle: sha256(renderProcessEvidence(hidden)),
        finalPatch: sha256(finalPatch.stdout),
        finalWorkspace: await hashDirectory(workspace, [".git", ".counterlane-study"]),
        attempt: sha256(await readFile(attemptPath)),
        ...runtimeArtifactHashes(runtimeEvidence),
      },
      rawArtifactPaths: {
        runStdout: relativePortable(REPOSITORY_ROOT, stdoutPath),
        runStderr: relativePortable(REPOSITORY_ROOT, stderrPath),
        visibleVerifier: relativePortable(REPOSITORY_ROOT, visiblePath),
        hiddenOracle: relativePortable(REPOSITORY_ROOT, hiddenPath),
        finalPatch: relativePortable(REPOSITORY_ROOT, patchPath),
        attempt: relativePortable(REPOSITORY_ROOT, attemptPath),
        ...runtimeArtifactPaths(runtimeEvidence),
      },
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      outputOverflow: run.outputOverflow,
      spawnError: run.spawnError,
      baselineCommit,
    };
    validateTrialRecord(trial, assignment, study.protocol);
    const recordedTrial = await appendTrial(trialsPath, trial, schedule, study.protocol, { lockHeld: true });
    return { trial: recordedTrial, trialsPath, rawDirectory };
  } catch (error) {
    if (run !== null && runtimeEvidence !== null) {
      let retained;
      try {
        retained = await retainPostRunFailure({
          study,
          schedule,
          assignment,
          trialsPath,
          rawDirectory,
          workspace,
          startedAtMs,
          run,
          runtimeEvidence,
          baselineCommit,
          error,
        });
      } catch (retentionError) {
        preserveWorkspaceForRecovery = true;
        throw new AggregateError(
          [error, retentionError],
          `Codex execution completed, failure retention also failed, and the recovery workspace was preserved at ${workspace}`,
        );
      }
      throw new Error(
        `Codex execution completed but post-run processing failed; a failure trial was retained for ${retained.assignmentId}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await cleanupExperimentWorkspace(workspace, preserveWorkspaceForRecovery);
    await releaseLock();
  }
}

export async function assertNoPriorAttempt(rawDirectory, assignment) {
  const attemptPath = join(rawDirectory, "attempt.json");
  let attempt;
  try {
    attempt = parseJson(await readFile(attemptPath, "utf8"), attemptPath);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  expectRecord(attempt, "attempt marker");
  expectEqual(attempt.assignmentId, assignment.assignmentId, "attempt.assignmentId");
  expectEqual(attempt.protocolHash, assignment.protocolHash, "attempt.protocolHash");
  throw new Error(
    `Assignment ${assignment.assignmentId} already has a sealed execution attempt from ${String(attempt.startedAt)}; ` +
    "the preregistered no-rerun rule forbids another model turn",
  );
}

export async function writeAttemptMarker(rawDirectory, assignment, environmentHash, startedAtMs = Date.now()) {
  await mkdir(rawDirectory, { recursive: true });
  const attemptPath = join(rawDirectory, "attempt.json");
  const handle = await open(attemptPath, "wx", 0o600).catch((error) => {
    if (error !== null && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`Execution attempt already exists for ${assignment.assignmentId}; refusing a rerun`, { cause: error });
    }
    throw error;
  });
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      status: "started",
      studyId: assignment.studyId,
      protocolHash: assignment.protocolHash,
      assignmentId: assignment.assignmentId,
      taskId: assignment.taskId,
      counterlaneEnabled: assignment.counterlaneEnabled,
      environmentHash,
      startedAt: new Date(startedAtMs).toISOString(),
      nonce: randomUUID(),
    }, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return attemptPath;
}

export async function cleanupExperimentWorkspace(workspace, preserveForRecovery) {
  if (workspace === null || preserveForRecovery) return;
  await rm(workspace, { recursive: true, force: true });
}

export async function retainPostRunFailure(options) {
  const runtimeEvidence = bindCounterlaneRouteEvidence(
    options.runtimeEvidence,
    options.assignment.counterlaneEnabled,
    options.run.stdout,
  );
  const failureText = `Post-run processing failure: ${options.error instanceof Error ? options.error.stack ?? options.error.message : String(options.error)}\n`;
  let patch = "";
  if (options.workspace !== null && options.baselineCommit !== null) {
    try {
      patch = (await captureReproduciblePatch(options.workspace, options.baselineCommit)).stdout;
    } catch {
      patch = "";
    }
  }
  const stdoutPath = join(options.rawDirectory, "run.stdout.log");
  const stderrPath = join(options.rawDirectory, "run.stderr.log");
  const visiblePath = join(options.rawDirectory, "visible-verifier.log");
  const hiddenPath = join(options.rawDirectory, "hidden-oracle.log");
  const patchPath = join(options.rawDirectory, "final.patch");
  const attemptPath = join(options.rawDirectory, "attempt.json");
  await mkdir(options.rawDirectory, { recursive: true });
  if (!existsSync(attemptPath)) {
    await writeAttemptMarker(
      options.rawDirectory,
      options.assignment,
      runtimeEvidence.environmentHash,
      options.startedAtMs,
    );
  }
  await Promise.all([
    writeFile(stdoutPath, options.run.stdout, "utf8"),
    writeFile(stderrPath, options.run.stderr, "utf8"),
    writeFile(visiblePath, failureText, "utf8"),
    writeFile(hiddenPath, failureText, "utf8"),
    writeFile(patchPath, patch, "utf8"),
  ]);
  const completedAtMs = Date.now();
  const runCompleted = options.run.exitCode === 0 && !options.run.timedOut &&
    !options.run.outputOverflow && options.run.spawnError === null;
  const finalWorkspaceHash = options.workspace === null
    ? sha256("workspace-unavailable")
    : await hashDirectory(options.workspace, [".git", ".counterlane-study"]).catch(() => sha256("workspace-hash-unavailable"));
  const treatment = deriveCodexTreatmentState(
    options.assignment.counterlaneEnabled,
    options.run,
    runtimeEvidence,
  );
  const trial = {
    schemaVersion: 1,
    studyId: options.assignment.studyId,
    protocolHash: options.assignment.protocolHash,
    taskId: options.assignment.taskId,
    taskHash: options.assignment.taskHash,
    hostSurface: options.assignment.hostSurface,
    counterlaneEnabled: options.assignment.counterlaneEnabled,
    replicate: options.assignment.replicate,
    assignmentId: options.assignment.assignmentId,
    order: options.assignment.order,
    sourceHash: options.assignment.sourceHash,
    promptHash: options.assignment.promptHash,
    verifierHash: options.assignment.verifierHash,
    oracleHash: options.assignment.oracleHash,
    startedAt: new Date(options.startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    runCompleted,
    visibleVerifierPassed: false,
    hiddenOraclePassed: false,
    verifiedSuccess: false,
    badEscape: false,
    durationMs: completedAtMs - options.startedAtMs,
    commonCost: extractCommonCost(options.run.stdout),
    treatmentCompliance: treatment.compliance,
    contamination: [{
      code: "other",
      detail: `Post-run processing failed after model execution: ${options.error instanceof Error ? options.error.message : String(options.error)}`,
    }, ...treatment.contamination],
    runtimeEvidence,
    rawArtifactHashes: {
      runStdout: sha256(options.run.stdout),
      runStderr: sha256(options.run.stderr),
      visibleVerifier: sha256(failureText),
      hiddenOracle: sha256(failureText),
      finalPatch: sha256(patch),
      finalWorkspace: finalWorkspaceHash,
      attempt: sha256(await readFile(attemptPath)),
      ...runtimeArtifactHashes(runtimeEvidence),
    },
    rawArtifactPaths: {
      runStdout: relativePortable(REPOSITORY_ROOT, stdoutPath),
      runStderr: relativePortable(REPOSITORY_ROOT, stderrPath),
      visibleVerifier: relativePortable(REPOSITORY_ROOT, visiblePath),
      hiddenOracle: relativePortable(REPOSITORY_ROOT, hiddenPath),
      finalPatch: relativePortable(REPOSITORY_ROOT, patchPath),
      attempt: relativePortable(REPOSITORY_ROOT, attemptPath),
      ...runtimeArtifactPaths(runtimeEvidence),
    },
    exitCode: options.run.exitCode,
    timedOut: options.run.timedOut,
    outputOverflow: options.run.outputOverflow,
    spawnError: options.run.spawnError,
    baselineCommit: options.baselineCommit ?? "unavailable",
  };
  validateTrialRecord(trial, options.assignment, options.study.protocol);
  return appendTrial(
    options.trialsPath,
    trial,
    options.schedule,
    options.study.protocol,
    { lockHeld: true },
  );
}

function prepareCodexOff(study, task, workspace) {
  const codex = study.protocol.codex;
  const args = [
    "exec",
    ...(codex.disablePlugins ? ["--disable", "plugins"] : []),
    "--disable",
    "fast_mode",
    ...(codex.ephemeral ? ["--ephemeral"] : []),
    "--model",
    codex.model,
    "--config",
    `model_reasoning_effort=${tomlString(codex.effort)}`,
    "--config",
    `approval_policy=${tomlString(codex.approvalPolicy)}`,
    "--sandbox",
    codex.sandbox,
    "--cd",
    workspace,
    "--color",
    "never",
    "--json",
    task.prompt,
  ];
  return {
    counterlaneConfigPath: null,
    execute: async () => ({
      process: await runProcess(codex.command, args, {
        cwd: workspace,
        timeoutMs: codex.turnTimeoutMs,
        env: { ...process.env, CI: "1" },
      }),
      counterlaneConfigPath: null,
    }),
  };
}

async function prepareCounterlaneOn(study, task, workspace, rawDirectory) {
  const protocol = study.protocol;
  const cliPath = resolveWithin(REPOSITORY_ROOT, protocol.counterlane.cli, "counterlane.cli");
  await stat(cliPath).catch(() => {
    throw new Error(`Built Counterlane CLI not found at ${cliPath}; run npm run build first`);
  });
  const configPath = join(rawDirectory, "counterlane.config.json");
  const config = buildCounterlaneConfig(protocol, task);
  await writeJson(configPath, config);
  const args = buildCounterlaneArgs(protocol, task, { cliPath, workspace, configPath });
  return {
    counterlaneConfigPath: configPath,
    execute: async () => ({
      process: await runProcess(process.execPath, args, {
        cwd: REPOSITORY_ROOT,
        timeoutMs: protocol.codex.turnTimeoutMs,
        env: { ...process.env, CI: "1" },
      }),
      counterlaneConfigPath: configPath,
    }),
  };
}

export async function executeAfterPreflight(preflight, execute) {
  const preflightResult = await preflight();
  return { preflight: preflightResult, execution: await execute() };
}

export function bindCounterlaneRouteEvidence(runtimeEvidence, counterlaneEnabled, stdout) {
  expectRecord(runtimeEvidence, "runtimeEvidence");
  let counterlaneRoute;
  if (!counterlaneEnabled) {
    counterlaneRoute = unavailableCounterlaneRoute(
      "native-control",
      "Native Codex OFF does not execute Counterlane, so no Counterlane route exists",
      "not-applicable",
    );
  } else {
    const route = extractCounterlaneRoute(stdout);
    counterlaneRoute = route === null
      ? unavailableCounterlaneRoute(
        "counterlane-on-effective-route",
        "Counterlane ON output did not contain a valid effective arm.policy route",
      )
      : {
        status: "verified",
        scope: "counterlane-on-effective-route",
        sourceArtifact: "runStdout",
        sourceSha256: sha256(stdout),
        value: route,
        sha256: sha256(stableJson(route)),
      };
  }
  const backendReroutes = extractBackendReroutes(stdout, counterlaneEnabled);
  const backendRoute = {
    status: "verified",
    scope: counterlaneEnabled ? "counterlane-on-backend-route" : "native-control-backend-route",
    sourceArtifact: "runStdout",
    sourceSha256: sha256(stdout),
    value: backendReroutes,
    sha256: sha256(stableJson(backendReroutes)),
  };
  const bound = { ...runtimeEvidence, counterlaneRoute, backendRoute };
  return { ...bound, environmentHash: computeEnvironmentHash(bound) };
}

function deriveCodexTreatmentState(counterlaneEnabled, run, runtimeEvidence) {
  const contamination = [];
  if (run.spawnError !== null) {
    contamination.push({ code: "treatment-noncompliance", detail: run.spawnError });
  }
  if (counterlaneEnabled && runtimeEvidence.counterlaneRoute.status !== "verified") {
    contamination.push({
      code: "treatment-noncompliance",
      detail: runtimeEvidence.counterlaneRoute.reason,
    });
  }
  if (runtimeEvidence.backendRoute.status !== "verified") {
    contamination.push({
      code: "treatment-noncompliance",
      detail: "Backend reroute evidence is unavailable",
    });
  } else if (runtimeEvidence.backendRoute.value.length > 0) {
    contamination.push({
      code: "model-reroute",
      detail: `Backend reported ${runtimeEvidence.backendRoute.value.length} model reroute event(s)`,
    });
  }
  return {
    compliance: contamination.length === 0 ? "compliant" : "noncompliant",
    contamination,
  };
}

export function buildCounterlaneConfig(protocol, task) {
  return {
    dataDirectory: ".counterlane-study",
    codex: {
      command: protocol.codex.command,
      args: [
        ...(protocol.codex.disablePlugins ? ["--disable", "plugins"] : []),
        "app-server",
      ],
      approvalPolicy: protocol.codex.approvalPolicy,
      sandbox: { type: "workspaceWrite", networkAccess: false },
    },
    routing: {
      static: { family: "sol", effort: protocol.codex.effort, speed: "standard" },
      speed: { allowUnadvertisedTiers: false },
    },
    twin: { applyWinnerByDefault: false },
    verification: {
      autoDetect: false,
      requireAtLeastOne: true,
      failOnNoVerifier: true,
      requireTaskSpecificCheck: true,
      commands: [
        {
          name: "common-visible-verifier",
          command: task.visibleVerifier.argv.map((value) => value === "$NODE" ? process.execPath : value),
          required: true,
          taskSpecific: true,
          timeoutMs: task.visibleVerifier.timeoutMs,
          minimumTier: task.visibleVerifier.minimumTier,
        },
      ],
    },
    telemetry: { enabled: true, includePrompt: false },
  };
}

export function buildCounterlaneArgs(protocol, task, paths) {
  return [
    paths.cliPath,
    "run",
    "--mode",
    protocol.counterlane.mode,
    "--cwd",
    paths.workspace,
    "--config",
    paths.configPath,
    "--proof-tier",
    task.visibleVerifier.minimumTier,
    "--prompt",
    task.prompt,
    ...(protocol.counterlane.apply ? ["--apply"] : []),
    "--json",
  ];
}

async function executeTaskCommand(specification, context) {
  const argv = resolveTaskCommandArgv(specification, context);
  return runProcess(argv[0], argv.slice(1), {
    cwd: context.cwd,
    timeoutMs: specification.timeoutMs,
    env: { ...process.env, CI: "1" },
  });
}

export function resolveTaskCommandArgv(specification, context) {
  return specification.argv.map((value, index) => {
    if (value === "$NODE") return process.execPath;
    if (value === "{workspace}") return context.workspace;
    if (index > 0 && !isAbsolute(value) && value.includes("/")) {
      return resolveWithin(context.cwd, value, "task command path");
    }
    return value;
  });
}

export async function deriveWorkTrialFromBundle(study, schedule, envelope, bundlePath, options = {}) {
  validateWorkImportEnvelope(envelope, study.protocol);
  const assignment = findAssignment(schedule, envelope.assignmentId);
  if (assignment.hostSurface !== "chatgpt-work") {
    throw new Error(`Assignment ${assignment.assignmentId} is not a ChatGPT Work cell`);
  }
  const task = findTask(study, assignment.taskId);
  await validateTask(task, study.studyDirectory);
  const sealed = await readSealedBundle(bundlePath, assignment.assignmentId);
  const workspace = await mkdtemp(join(tmpdir(), `counterlane-work-import-${assignment.assignmentId}-`));
  const derivedDirectory = resolve(
    options.derivedDirectory ?? join(defaultArtifactRoot(study), "raw", assignment.assignmentId, "import-derived"),
  );
  await mkdir(derivedDirectory, { recursive: true });
  try {
    const fixture = await resolveExistingWithin(study.studyDirectory, task.fixturePath, "fixturePath", "directory");
    await copyDirectory(fixture, workspace);
    const sourceHash = await hashDirectory(workspace);
    expectEqual(sourceHash, assignment.sourceHash, "Work import sourceHash");
    await initializeGitRepository(workspace);
    if (sealed.contents["final.patch"].byteLength === 0) {
      throw new Error("Sealed Work bundle final.patch must not be empty");
    }
    const applied = await runProcess(
      "git",
      ["apply", "--binary", "--whitespace=nowarn", sealed.paths["final.patch"]],
      { cwd: workspace, timeoutMs: 30_000, env: process.env },
    );
    if (applied.exitCode !== 0 || applied.spawnError !== null || applied.timedOut) {
      throw new Error(`Sealed Work final.patch does not apply cleanly: ${applied.spawnError ?? applied.stderr}`);
    }
    const replayPatch = await runProcess("git", ["diff", "--binary", "HEAD"], {
      cwd: workspace,
      timeoutMs: 30_000,
      env: process.env,
    });
    if (replayPatch.exitCode !== 0 || replayPatch.spawnError !== null || replayPatch.timedOut) {
      throw new Error(`Unable to recapture imported Work patch: ${replayPatch.spawnError ?? replayPatch.stderr}`);
    }
    expectEqual(sha256(replayPatch.stdout), sealed.hashes["final.patch"], "replayed final.patch SHA-256");
    const visible = await executeTaskCommand(task.visibleVerifier, {
      cwd: workspace,
      studyDirectory: study.studyDirectory,
      workspace,
    });
    const hidden = await executeTaskCommand(task.hiddenOracle, {
      cwd: study.studyDirectory,
      studyDirectory: study.studyDirectory,
      workspace,
    });
    const visibleEvidence = renderProcessEvidence(visible);
    const hiddenEvidence = renderProcessEvidence(hidden);
    const visiblePath = join(derivedDirectory, "visible-verifier.import.log");
    const hiddenPath = join(derivedDirectory, "hidden-oracle.import.log");
    const replayPath = join(derivedDirectory, "final.replayed.patch");
    await Promise.all([
      writeFile(visiblePath, visibleEvidence, "utf8"),
      writeFile(hiddenPath, hiddenEvidence, "utf8"),
      writeFile(replayPath, replayPatch.stdout, "utf8"),
    ]);
    const runtimeEvidence = await collectRuntimeEvidence(study, {
      hostSurface: "chatgpt-work",
      counterlaneEnabled: assignment.counterlaneEnabled,
    });
    const treatmentCompliance = deriveWorkTreatmentCompliance(assignment, sealed);
    const contamination = envelope.contamination.map((item) => ({ ...item }));
    if (treatmentCompliance === "noncompliant" &&
        !contamination.some((item) => item.code === "treatment-noncompliance")) {
      contamination.push({
        code: "treatment-noncompliance",
        detail: assignment.counterlaneEnabled
          ? "Counterlane-on Work bundle lacks a recognizable counterlane-result.json"
          : "Counterlane evidence was present in a Work OFF bundle",
      });
    }
    const startedAtMs = Date.parse(envelope.startedAt);
    const completedAtMs = Date.parse(envelope.completedAt);
    const visibleVerifierPassed = visible.exitCode === 0 && !visible.timedOut && visible.spawnError === null;
    const hiddenOraclePassed = hidden.exitCode === 0 && !hidden.timedOut && hidden.spawnError === null;
    const rawArtifactHashes = {
      finalPatch: sealed.hashes["final.patch"],
      runStdout: sealed.hashes["run.stdout.log"],
      runStderr: sealed.hashes["run.stderr.log"],
      bundleManifest: sealed.manifestHash,
      replayedPatch: sha256(replayPatch.stdout),
      visibleVerifier: sha256(visibleEvidence),
      hiddenOracle: sha256(hiddenEvidence),
      finalWorkspace: await hashDirectory(workspace, [".git", ".counterlane-study"]),
      ...runtimeArtifactHashes(runtimeEvidence),
    };
    if (sealed.hashes["counterlane-result.json"] !== undefined) {
      rawArtifactHashes.counterlaneResult = sealed.hashes["counterlane-result.json"];
    }
    const trial = {
      schemaVersion: 1,
      studyId: assignment.studyId,
      protocolHash: assignment.protocolHash,
      taskId: assignment.taskId,
      taskHash: assignment.taskHash,
      hostSurface: assignment.hostSurface,
      counterlaneEnabled: assignment.counterlaneEnabled,
      replicate: assignment.replicate,
      assignmentId: assignment.assignmentId,
      order: assignment.order,
      sourceHash: assignment.sourceHash,
      promptHash: assignment.promptHash,
      verifierHash: assignment.verifierHash,
      oracleHash: assignment.oracleHash,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      runCompleted: true,
      visibleVerifierPassed,
      hiddenOraclePassed,
      verifiedSuccess: visibleVerifierPassed && hiddenOraclePassed,
      badEscape: visibleVerifierPassed && !hiddenOraclePassed,
      durationMs: completedAtMs - startedAtMs,
      commonCost: {
        unit: "total_tokens",
        value: null,
        source: "chatgpt-work-host-usage-unavailable",
        breakdown: emptyTokenBreakdown(),
      },
      treatmentCompliance,
      contamination,
      runtimeEvidence,
      rawArtifactHashes,
      rawArtifactPaths: {
        bundleManifest: displayPath(sealed.manifestPath),
        finalPatch: displayPath(sealed.paths["final.patch"]),
        runStdout: displayPath(sealed.paths["run.stdout.log"]),
        runStderr: displayPath(sealed.paths["run.stderr.log"]),
        visibleVerifier: displayPath(visiblePath),
        hiddenOracle: displayPath(hiddenPath),
        replayedPatch: displayPath(replayPath),
        ...runtimeArtifactPaths(runtimeEvidence),
      },
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      spawnError: null,
    };
    validateTrialRecord(trial, assignment, study.protocol);
    return trial;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function sealWorkBundle(study, schedule, options) {
  expectRecord(options, "seal-work options");
  const assignment = findAssignment(schedule, options.assignmentId);
  if (assignment.hostSurface !== "chatgpt-work") {
    throw new Error(`Assignment ${assignment.assignmentId} is not a ChatGPT Work cell`);
  }

  const workspace = await requireLocalDirectory(options.workspace, "seal-work workspace");
  const stdoutPath = await requireLocalFile(options.stdout, "seal-work stdout");
  const stderrPath = await requireLocalFile(options.stderr, "seal-work stderr");
  const counterlaneResultPath = options.counterlaneResult === undefined
    ? null
    : await requireLocalFile(options.counterlaneResult, "seal-work counterlane result");
  const output = await resolveNewOutputDirectory(options.output, workspace);
  for (const [label, path] of [
    ["stdout", stdoutPath],
    ["stderr", stderrPath],
    ...(counterlaneResultPath === null ? [] : [["counterlane result", counterlaneResultPath]]),
  ]) {
    if (isWithinPath(workspace, path)) {
      throw new Error(`seal-work ${label} must remain outside the task workspace`);
    }
  }

  const envelope = {
    schemaVersion: 1,
    assignmentId: assignment.assignmentId,
    bundlePath: "bundle",
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    contamination: [],
  };
  validateWorkImportEnvelope(envelope, study.protocol);

  await validateWorkWorkspace(study, assignment, workspace);
  const patchResult = await runProcess("git", ["diff", "--binary", "HEAD"], {
    cwd: workspace,
    timeoutMs: 30_000,
    env: process.env,
  });
  requireSuccessfulProcess(patchResult, "capture seal-work final.patch");
  if (patchResult.stdout.length === 0) throw new Error("seal-work final.patch must not be empty");

  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), `.${basename(output)}.staging-`));
  try {
    const bundle = join(staging, "bundle");
    await mkdir(bundle);
    const payloadSources = new Map([
      ["run.stdout.log", stdoutPath],
      ["run.stderr.log", stderrPath],
    ]);
    if (counterlaneResultPath !== null) {
      payloadSources.set("counterlane-result.json", counterlaneResultPath);
    }
    await writeFile(join(bundle, "final.patch"), patchResult.stdout, "utf8");
    for (const [name, source] of payloadSources) await copyFile(source, join(bundle, name));

    const payloadNames = ["final.patch", ...payloadSources.keys()].sort();
    const files = {};
    for (const name of payloadNames) files[name] = sha256(await readFile(join(bundle, name)));
    await writeJson(join(bundle, "bundle.json"), {
      schemaVersion: 1,
      assignmentId: assignment.assignmentId,
      files,
    });
    await writeJson(join(staging, "work-import-envelope.json"), envelope);
    await rename(staging, output);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    assignmentId: assignment.assignmentId,
    output,
    bundlePath: join(output, "bundle"),
    envelopePath: join(output, "work-import-envelope.json"),
  };
}

function validateWorkImportEnvelope(envelope, protocol) {
  expectRecord(envelope, "Work import envelope");
  const allowed = new Set(["schemaVersion", "assignmentId", "bundlePath", "startedAt", "completedAt", "contamination"]);
  for (const field of Object.keys(envelope)) {
    if (!allowed.has(field)) {
      throw new Error(`Work import envelope must not supply derived field: ${field}`);
    }
  }
  expectEqual(envelope.schemaVersion, 1, "Work import envelope.schemaVersion");
  expectNonEmptyString(envelope.assignmentId, "Work import envelope.assignmentId");
  if (envelope.bundlePath !== undefined) expectNonEmptyString(envelope.bundlePath, "Work import envelope.bundlePath");
  expectNonEmptyString(envelope.startedAt, "Work import envelope.startedAt");
  expectNonEmptyString(envelope.completedAt, "Work import envelope.completedAt");
  const startedAtMs = Date.parse(envelope.startedAt);
  const completedAtMs = Date.parse(envelope.completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs < startedAtMs) {
    throw new Error("Work import envelope timestamps must be ordered ISO-8601 values");
  }
  validateContamination(envelope.contamination, protocol);
}

async function readSealedBundle(bundlePath, assignmentId) {
  const directory = resolve(bundlePath);
  const directoryStat = await lstat(directory).catch(() => null);
  if (directoryStat === null || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Sealed Work artifact bundle must be a local directory: ${directory}`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("Sealed Work artifact bundle may contain regular files only");
  }
  const manifestEntry = entries.find((entry) => entry.name === "bundle.json");
  if (manifestEntry === undefined) throw new Error("Sealed Work artifact bundle is missing bundle.json");
  const manifestPath = join(directory, "bundle.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = parseJson(manifestRaw, manifestPath);
  expectRecord(manifest, "bundle.json");
  expectEqual(manifest.schemaVersion, 1, "bundle.json.schemaVersion");
  expectEqual(manifest.assignmentId, assignmentId, "bundle.json.assignmentId");
  expectRecord(manifest.files, "bundle.json.files");
  for (const required of ["final.patch", "run.stdout.log", "run.stderr.log"]) {
    if (!Object.hasOwn(manifest.files, required)) throw new Error(`Sealed Work bundle is missing required artifact: ${required}`);
  }
  const payloadNames = entries.filter((entry) => entry.name !== "bundle.json").map((entry) => entry.name).sort();
  const declaredNames = Object.keys(manifest.files).sort();
  if (JSON.stringify(payloadNames) !== JSON.stringify(declaredNames)) {
    throw new Error("bundle.json must cover every payload file and no absent file");
  }
  const contents = {};
  const paths = {};
  const hashes = {};
  for (const name of declaredNames) {
    if (basename(name) !== name || name === "." || name === "..") {
      throw new Error(`Unsafe sealed bundle filename: ${name}`);
    }
    const declaredHash = manifest.files[name];
    if (typeof declaredHash !== "string" || !SHA256_PATTERN.test(declaredHash)) {
      throw new Error(`bundle.json files.${name} must be a SHA-256 hex digest`);
    }
    const path = join(directory, name);
    const entryStat = await lstat(path);
    if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error(`Bundle payload must be a regular file: ${name}`);
    const content = await readFile(path);
    const actualHash = sha256(content);
    expectEqual(actualHash, declaredHash, `sealed bundle hash for ${name}`);
    contents[name] = content;
    paths[name] = path;
    hashes[name] = actualHash;
  }
  let counterlaneResult = null;
  if (contents["counterlane-result.json"] !== undefined) {
    counterlaneResult = parseJson(contents["counterlane-result.json"].toString("utf8"), paths["counterlane-result.json"]);
  }
  return {
    directory,
    manifestPath,
    manifestHash: sha256(manifestRaw),
    manifest,
    contents,
    paths,
    hashes,
    counterlaneResult,
  };
}

function deriveWorkTreatmentCompliance(assignment, sealed) {
  const recognized = sealed.counterlaneResult !== null && containsCounterlaneResultIdentity(sealed.counterlaneResult);
  if (assignment.counterlaneEnabled) return recognized ? "compliant" : "noncompliant";
  return sealed.counterlaneResult === null ? "unknown" : "noncompliant";
}

function containsCounterlaneResultIdentity(value) {
  if (Array.isArray(value)) return value.some(containsCounterlaneResultIdentity);
  if (value === null || typeof value !== "object") return false;
  const hasRun = typeof value.runId === "string" && ["auto", "static"].includes(value.mode);
  const hasDecision = typeof value.decisionId === "string" && ["auto", "static", "twin", "abstain"].includes(value.action);
  const hasExperiment = typeof value.experimentId === "string" && value.control !== undefined && value.treatment !== undefined;
  if (hasRun || hasDecision || hasExperiment) return true;
  return Object.values(value).some(containsCounterlaneResultIdentity);
}

async function appendTrial(path, trial, schedule, protocol, options = {}) {
  const releaseLock = options.lockHeld ? async () => {} : await acquireTrialLock(path);
  try {
    const existing = await readJsonLinesIfPresent(path);
    validateRecordedTrials(schedule, existing, protocol);
    await Promise.all(existing.map(validateTrialArtifactFiles));
    const assignment = findAssignment(schedule, trial.assignmentId);
    validateTrialRecord(trial, assignment, protocol);
    await validateTrialArtifactFiles(trial);
    const candidateSet = [...existing, trial];
    validateCrossArmRuntimeParity(schedule, candidateSet);
    const checked = deriveAutomaticCodexChecks(protocol, schedule, candidateSet);
    const recordedTrial = checked.trials.find((candidate) => candidate.assignmentId === trial.assignmentId);
    if (recordedTrial === undefined) throw new Error(`Automatic checks lost assignment ${trial.assignmentId}`);
    validateTrialRecord(recordedTrial, assignment, protocol);
    assertAssignmentReady(schedule, existing, assignment);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(recordedTrial)}\n`, "utf8");
    return recordedTrial;
  } finally {
    await releaseLock();
  }
}

export function assertAssignmentReady(schedule, existingTrials, assignment) {
  if (existingTrials.some((trial) => trial.assignmentId === assignment.assignmentId)) {
    throw new Error(`Duplicate trial for assignmentId: ${assignment.assignmentId}`);
  }
  const completedIds = new Set(existingTrials.map((trial) => trial.assignmentId));
  const missingEarlier = schedule.assignments.filter((candidate) =>
    candidate.blockId === assignment.blockId &&
    candidate.order < assignment.order &&
    !completedIds.has(candidate.assignmentId)
  );
  if (missingEarlier.length > 0) {
    throw new Error(
      `Assignment ${assignment.assignmentId} is out of preregistered order; complete ` +
      `${missingEarlier.map((candidate) => candidate.assignmentId).join(", ")} first`,
    );
  }
}

export async function acquireTrialLock(trialsPath) {
  const lockPath = `${trialsPath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const identity = `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
  })}\n`;
  let handle = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(identity, "utf8");
      await handle.sync();
      break;
    } catch (error) {
      const createdLock = handle !== null;
      await handle?.close().catch(() => undefined);
      handle = null;
      if (createdLock) await rm(lockPath, { force: true }).catch(() => undefined);
      if (!(error !== null && typeof error === "object" && error.code === "EEXIST")) throw error;
      if (!await reclaimStaleTrialLock(lockPath)) {
        throw new Error(`Trial ledger is locked by another execution (live): ${lockPath}`);
      }
    }
  }
  if (handle === null) throw new Error(`Unable to acquire trial ledger lock after reclaiming stale state: ${lockPath}`);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    const currentIdentity = await readFile(lockPath, "utf8").catch(() => null);
    if (currentIdentity === identity) await rm(lockPath, { force: true });
  };
}

async function reclaimStaleTrialLock(lockPath) {
  const metadata = await lstat(lockPath).catch(() => null);
  if (metadata === null) return true;
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  const raw = await readFile(lockPath, "utf8").catch(() => null);
  const parsed = parseTrialLock(raw);
  if (parsed === null) {
    if (Date.now() - metadata.mtimeMs < INVALID_LOCK_RECLAIM_AGE_MS) return false;
  } else if (isProcessAlive(parsed.pid)) {
    return false;
  }
  const reclaimedPath = `${lockPath}.stale-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await rename(lockPath, reclaimedPath);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return true;
    return false;
  }
  await rm(reclaimedPath, { force: true });
  return true;
}

function parseTrialLock(raw) {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === "object" && Number.isInteger(value.pid) && value.pid > 0
      ? { pid: value.pid }
      : null;
  } catch {
    const legacyPid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(legacyPid) && legacyPid > 0 ? { pid: legacyPid } : null;
  }
}

function isProcessAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ESRCH") return false;
    return true;
  }
}

async function commandPlan(options) {
  const study = await loadStudy(options);
  const schedule = await buildSchedule(study);
  const artifactRoot = resolve(options.artifactRoot ?? defaultArtifactRoot(study));
  const output = resolve(options.output ?? join(artifactRoot, "schedule.json"));
  await writeJsonImmutable(output, schedule);
  return { study, schedule, output, artifactRoot };
}

export async function writeJsonImmutable(path, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error !== null && typeof error === "object" && error.code === "EEXIST")) throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== serialized) throw new Error(`Refusing to overwrite immutable preregistration artifact: ${path}`);
  }
}

async function commandPacket(options) {
  const { study, schedule, artifactRoot } = await loadRuntimeStudy(options);
  const assignmentId = requiredOption(options, "assignment");
  const packet = await createWorkPacket(study, schedule, assignmentId);
  const output = resolve(options.output ?? join(artifactRoot, "packets", `${assignmentId}.json`));
  await writeJson(output, packet);
  return { output, packet };
}

async function commandImport(options) {
  const { study, schedule, artifactRoot } = await loadRuntimeStudy(options);
  const input = resolve(requiredOption(options, "input"));
  const envelope = parseJson(await readFile(input, "utf8"), input);
  validateWorkImportEnvelope(envelope, study.protocol);
  const bundleValue = options.bundle ?? envelope.bundlePath;
  expectNonEmptyString(bundleValue, "Work import bundle path");
  const bundlePath = isAbsolute(bundleValue) ? resolve(bundleValue) : resolve(dirname(input), bundleValue);
  const trial = await deriveWorkTrialFromBundle(study, schedule, envelope, bundlePath, {
    derivedDirectory: join(artifactRoot, "raw", envelope.assignmentId, "import-derived"),
  });
  const trialsPath = resolve(options.trials ?? join(artifactRoot, "raw", "trials.jsonl"));
  await appendTrial(trialsPath, trial, schedule, study.protocol);
  return { input, trialsPath, assignmentId: trial.assignmentId };
}

async function commandSealWork(options) {
  const { study, schedule } = await loadRuntimeStudy(options);
  return sealWorkBundle(study, schedule, {
    assignmentId: requiredOption(options, "assignment"),
    workspace: requiredOption(options, "workspace"),
    stdout: requiredOption(options, "stdout"),
    stderr: requiredOption(options, "stderr"),
    startedAt: requiredOption(options, "startedAt"),
    completedAt: requiredOption(options, "completedAt"),
    output: requiredOption(options, "output"),
    ...(options.counterlaneResult === undefined ? {} : { counterlaneResult: options.counterlaneResult }),
  });
}

async function commandRunCodex(options) {
  const { study, schedule, artifactRoot } = await loadRuntimeStudy(options);
  const assignmentId = requiredOption(options, "assignment");
  return runCodexAssignment(study, schedule, assignmentId, {
    artifactRoot,
    ...(options.trials === undefined ? {} : { trialsPath: resolve(options.trials) }),
  });
}

async function commandAnalyze(options) {
  const { study, schedule, artifactRoot } = await loadRuntimeStudy(options);
  const trialsPath = resolve(options.trials ?? join(artifactRoot, "raw", "trials.jsonl"));
  const trials = await readJsonLines(trialsPath);
  const analysis = await analyzeTrials(study, schedule, trials);
  const markdownPath = resolve(options.output ?? join(artifactRoot, "report.md"));
  const jsonPath = markdownPath.endsWith(".md") ? `${markdownPath.slice(0, -3)}.json` : `${markdownPath}.json`;
  await Promise.all([
    writeText(markdownPath, renderReport(analysis)),
    writeJson(jsonPath, analysis),
  ]);
  return { markdownPath, jsonPath, analysis };
}

async function loadRuntimeStudy(options) {
  const study = await loadStudy(options);
  const artifactRoot = resolve(options.artifactRoot ?? defaultArtifactRoot(study));
  const schedulePath = resolve(options.schedule ?? join(artifactRoot, "schedule.json"));
  const schedule = parseJson(await readFile(schedulePath, "utf8"), schedulePath);
  await validateSchedule(schedule, study);
  return { study, schedule, schedulePath, artifactRoot };
}

export async function main(argv) {
  const command = argv[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  const options = parseOptions(argv.slice(1));
  let result;
  if (command === "plan") result = await commandPlan(options);
  else if (command === "packet") result = await commandPacket(options);
  else if (command === "seal-work") result = await commandSealWork(options);
  else if (command === "import") result = await commandImport(options);
  else if (command === "run-codex") result = await commandRunCodex(options);
  else if (command === "analyze") result = await commandAnalyze(options);
  else throw new Error(`Unknown experiment command: ${command}`);
  process.stdout.write(`${JSON.stringify(serializableResult(result), null, 2)}\n`);
  return 0;
}

export function validateProtocol(protocol) {
  expectRecord(protocol, "protocol");
  expectEqual(protocol.schemaVersion, 1, "protocol.schemaVersion");
  for (const field of [
    "studyId",
    "preregisteredAt",
    "question",
    "hypothesis",
    "claimBoundary",
    "experimentalUnit",
    "stoppingRule",
  ]) {
    expectNonEmptyString(protocol[field], `protocol.${field}`);
  }
  if (!Number.isFinite(Date.parse(protocol.preregisteredAt))) {
    throw new Error("protocol.preregisteredAt must be an ISO-8601 timestamp");
  }
  expectEqual(protocol.phase, "exploratory-smoke", "protocol.phase");
  expectPositiveInteger(protocol.repetitions, "protocol.repetitions");
  if (!Array.isArray(protocol.hostSurfaces) || protocol.hostSurfaces.length === 0 ||
      new Set(protocol.hostSurfaces).size !== protocol.hostSurfaces.length ||
      protocol.hostSurfaces.some((host) => host !== "codex" && host !== "chatgpt-work") ||
      !protocol.hostSurfaces.includes("codex")) {
    throw new Error("protocol.hostSurfaces must contain codex and may additionally contain chatgpt-work");
  }
  if (!sameSet(protocol.counterlaneStates, [false, true])) {
    throw new Error("protocol.counterlaneStates must contain false and true");
  }
  expectRecord(protocol.randomization, "protocol.randomization");
  expectNonEmptyString(protocol.randomization.seed, "protocol.randomization.seed");
  expectEqual(
    protocol.randomization.algorithm,
    "sha256-xorshift32-fisher-yates-v1",
    "protocol.randomization.algorithm",
  );
  expectRecord(protocol.codex, "protocol.codex");
  for (const field of ["command", "model", "effort", "sandbox", "approvalPolicy"]) {
    expectNonEmptyString(protocol.codex[field], `protocol.codex.${field}`);
  }
  if (protocol.codex.speed !== undefined) {
    expectEqual(protocol.codex.speed, "standard", "protocol.codex.speed");
  }
  expectBoolean(protocol.codex.disablePlugins, "protocol.codex.disablePlugins");
  if (!protocol.codex.disablePlugins) throw new Error("Codex OFF must disable plugins for this study");
  expectBoolean(protocol.codex.ephemeral, "protocol.codex.ephemeral");
  expectPositiveInteger(protocol.codex.turnTimeoutMs, "protocol.codex.turnTimeoutMs");
  expectRecord(protocol.counterlane, "protocol.counterlane");
  expectNonEmptyString(protocol.counterlane.cli, "protocol.counterlane.cli");
  expectEqual(protocol.counterlane.mode, "auto", "protocol.counterlane.mode");
  expectEqual(protocol.counterlane.apply, true, "protocol.counterlane.apply");
  expectRecord(protocol.endpoints, "protocol.endpoints");
  expectNonEmptyString(protocol.endpoints.primary, "protocol.endpoints.primary");
  expectRecord(protocol.successDefinition, "protocol.successDefinition");
  expectNonEmptyString(protocol.successDefinition.verifiedSuccess, "protocol.successDefinition.verifiedSuccess");
  expectNonEmptyString(protocol.successDefinition.badEscape, "protocol.successDefinition.badEscape");
  if (protocol.hostSurfaces.includes("chatgpt-work")) {
    expectRecord(protocol.workImport, "protocol.workImport");
    expectNonEmptyString(protocol.workImport.trustBoundary, "protocol.workImport.trustBoundary");
  }
  expectRecord(protocol.runtimeBinding, "protocol.runtimeBinding");
  if (!Array.isArray(protocol.runtimeBinding.codexRequired) || protocol.runtimeBinding.codexRequired.length === 0) {
    throw new Error("protocol.runtimeBinding.codexRequired must be a non-empty array");
  }
  expectRecord(protocol.analysis, "protocol.analysis");
  expectEqual(protocol.analysis.intentionToTreat, true, "protocol.analysis.intentionToTreat");
  expectEqual(protocol.analysis.retainContaminatedTrials, true, "protocol.analysis.retainContaminatedTrials");
  expectEqual(protocol.analysis.allowStatisticalConfidenceClaim, false, "protocol.analysis.allowStatisticalConfidenceClaim");
  if (protocol.analysis.practicalTokenSavingsThresholdPct !== undefined) {
    expectNonNegativeNumber(
      protocol.analysis.practicalTokenSavingsThresholdPct,
      "protocol.analysis.practicalTokenSavingsThresholdPct",
    );
  }
  if (protocol.analysis.requireBothVerifiedForTokenSavingsClaim !== undefined) {
    expectBoolean(
      protocol.analysis.requireBothVerifiedForTokenSavingsClaim,
      "protocol.analysis.requireBothVerifiedForTokenSavingsClaim",
    );
  }
  expectPositiveInteger(
    protocol.analysis.minimumCompleteTaskClustersForConfidence,
    "protocol.analysis.minimumCompleteTaskClustersForConfidence",
  );
  expectRecord(protocol.contaminationPolicy, "protocol.contaminationPolicy");
  expectEqual(protocol.contaminationPolicy.retain, true, "protocol.contaminationPolicy.retain");
  if (!Array.isArray(protocol.contaminationPolicy.labels) || protocol.contaminationPolicy.labels.length === 0) {
    throw new Error("protocol.contaminationPolicy.labels must be a non-empty array");
  }
  const contaminationLabels = new Set(protocol.contaminationPolicy.labels);
  for (const code of REQUIRED_CONTAMINATION_CODES) {
    if (!contaminationLabels.has(code)) {
      throw new Error(`protocol.contaminationPolicy.labels must include harness-generated code: ${code}`);
    }
  }
  expectRecord(
    protocol.contaminationPolicy.automaticCodexChecks,
    "protocol.contaminationPolicy.automaticCodexChecks",
  );
  const automaticChecks = protocol.contaminationPolicy.automaticCodexChecks;
  expectNonNegativeNumber(
    automaticChecks.maxQuotaUsedPercentDelta,
    "protocol.contaminationPolicy.automaticCodexChecks.maxQuotaUsedPercentDelta",
  );
  if (automaticChecks.maxQuotaUsedPercentDelta > 100) {
    throw new Error("protocol.contaminationPolicy.automaticCodexChecks.maxQuotaUsedPercentDelta must be at most 100");
  }
  expectEqual(
    automaticChecks.routeInterventionSemantics,
    "counterlane-auto-selection-v2",
    "protocol.contaminationPolicy.automaticCodexChecks.routeInterventionSemantics",
  );
  expectEqual(
    automaticChecks.backendReroutePolicy,
    "reject-any-reported",
    "protocol.contaminationPolicy.automaticCodexChecks.backendReroutePolicy",
  );
  expectNonEmptyString(
    automaticChecks.expectedModelId,
    "protocol.contaminationPolicy.automaticCodexChecks.expectedModelId",
  );
  expectNonEmptyString(
    automaticChecks.expectedEffort,
    "protocol.contaminationPolicy.automaticCodexChecks.expectedEffort",
  );
  if (automaticChecks.expectedServiceTier !== null) {
    expectNonEmptyString(
      automaticChecks.expectedServiceTier,
      "protocol.contaminationPolicy.automaticCodexChecks.expectedServiceTier",
    );
  }
  expectNonEmptyString(
    automaticChecks.expectedSpeedId,
    "protocol.contaminationPolicy.automaticCodexChecks.expectedSpeedId",
  );
  expectEqual(
    automaticChecks.expectedModelId,
    protocol.codex.model,
    "protocol.contaminationPolicy.automaticCodexChecks.expectedModelId",
  );
  expectEqual(
    automaticChecks.expectedEffort,
    protocol.codex.effort,
    "protocol.contaminationPolicy.automaticCodexChecks.expectedEffort",
  );
  expectEqual(
    automaticChecks.expectedSpeedId,
    protocol.codex.speed ?? "standard",
    "protocol.contaminationPolicy.automaticCodexChecks.expectedSpeedId",
  );
  if ((protocol.codex.speed ?? "standard") === "standard") {
    expectEqual(
      automaticChecks.expectedServiceTier,
      null,
      "protocol.contaminationPolicy.automaticCodexChecks.expectedServiceTier",
    );
  }
}

async function validateTask(task, studyDirectory) {
  expectRecord(task, "task");
  expectEqual(task.schemaVersion, 1, "task.schemaVersion");
  for (const field of ["taskId", "family", "riskTier", "fixturePath", "prompt"]) {
    expectNonEmptyString(task[field], `task.${field}`);
  }
  validateCommandSpecification(task.visibleVerifier, "task.visibleVerifier", true);
  validateCommandSpecification(task.hiddenOracle, "task.hiddenOracle");
  expectEqual(task.hiddenOracle.external, true, "task.hiddenOracle.external");
  const fixture = await resolveExistingWithin(studyDirectory, task.fixturePath, "task.fixturePath", "directory");
  const oraclePathToken = task.hiddenOracle.argv.find((value) => value !== "$NODE" && value !== "{workspace}");
  if (oraclePathToken === undefined) throw new Error("task.hiddenOracle must name an external oracle module");
  const oraclePath = await resolveExistingWithin(studyDirectory, oraclePathToken, "task.hiddenOracle module", "file");
  const oracleRelativeToFixture = relative(fixture, oraclePath);
  if (oracleRelativeToFixture === "" || (!oracleRelativeToFixture.startsWith(`..${sep}`) && oracleRelativeToFixture !== "..")) {
    throw new Error("Hidden oracle must remain outside the task fixture");
  }
}

function validateCommandSpecification(specification, path, requireMinimumTier = false) {
  expectRecord(specification, path);
  if (!Array.isArray(specification.argv) || specification.argv.length === 0 ||
      specification.argv.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error(`${path}.argv must be a non-empty string argv array`);
  }
  expectPositiveInteger(specification.timeoutMs, `${path}.timeoutMs`);
  if (requireMinimumTier && specification.minimumTier === undefined) {
    throw new Error(`${path}.minimumTier is required`);
  }
  if (specification.minimumTier !== undefined &&
      !["basic", "standard", "strong", "adversarial"].includes(specification.minimumTier)) {
    throw new Error(`${path}.minimumTier must be basic, standard, strong, or adversarial`);
  }
}

function validateAssignment(assignment) {
  expectRecord(assignment, "assignment");
  expectEqual(assignment.schemaVersion, 1, "assignment.schemaVersion");
  for (const field of [
    "assignmentId",
    "blockId",
    "studyId",
    "protocolHash",
    "taskId",
    "taskHash",
    "hostSurface",
    "sourceHash",
    "promptHash",
    "verifierHash",
    "oracleHash",
  ]) {
    expectNonEmptyString(assignment[field], `assignment.${field}`);
  }
  expectBoolean(assignment.counterlaneEnabled, "assignment.counterlaneEnabled");
  expectPositiveInteger(assignment.replicate, "assignment.replicate");
  expectPositiveInteger(assignment.order, "assignment.order");
  for (const field of ["protocolHash", "taskHash", "sourceHash", "promptHash", "verifierHash", "oracleHash"]) {
    if (!SHA256_PATTERN.test(assignment[field])) throw new Error(`assignment.${field} must be a SHA-256 hex digest`);
  }
  cellIdForAssignment(assignment);
}

function validateCommonCost(cost) {
  expectRecord(cost, "trial.commonCost");
  expectEqual(cost.unit, "total_tokens", "trial.commonCost.unit");
  expectNonEmptyString(cost.source, "trial.commonCost.source");
  expectRecord(cost.breakdown, "trial.commonCost.breakdown");
  for (const field of [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ]) {
    validateNullableTokenCount(cost.breakdown[field], `trial.commonCost.breakdown.${field}`);
  }
  validateNullableTokenCount(cost.value, "trial.commonCost.value");
  expectEqual(cost.value, cost.breakdown.totalTokens, "trial.commonCost.value");
  const input = cost.breakdown.inputTokens;
  const cached = cost.breakdown.cachedInputTokens;
  const uncached = cost.breakdown.uncachedInputTokens;
  const output = cost.breakdown.outputTokens;
  const reasoning = cost.breakdown.reasoningOutputTokens;
  if (input !== null && cached !== null) {
    if (cached > input) throw new Error("trial.commonCost cached input tokens exceed input tokens");
    expectEqual(uncached, input - cached, "trial.commonCost.breakdown.uncachedInputTokens");
  } else if (uncached !== null) {
    throw new Error("trial.commonCost.breakdown.uncachedInputTokens requires input and cached input counts");
  }
  if (output !== null && reasoning !== null && reasoning > output) {
    throw new Error("trial.commonCost reasoning output tokens exceed output tokens");
  }
  if (input !== null && output !== null) {
    expectEqual(cost.value, input + output, "trial.commonCost gross total_tokens");
  }
}

function validateNullableTokenCount(value, path) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${path} must be null or a non-negative safe integer`);
  }
}

function validateContamination(contamination, protocol) {
  if (!Array.isArray(contamination)) throw new Error("trial.contamination must be an array");
  const allowed = new Set(protocol.contaminationPolicy.labels);
  for (const [index, item] of contamination.entries()) {
    expectRecord(item, `trial.contamination[${index}]`);
    expectNonEmptyString(item.code, `trial.contamination[${index}].code`);
    expectNonEmptyString(item.detail, `trial.contamination[${index}].detail`);
    if (!allowed.has(item.code)) throw new Error(`Unknown contamination code: ${item.code}`);
  }
}

export function computeEnvironmentHash(runtimeEvidence) {
  expectRecord(runtimeEvidence, "runtimeEvidence");
  const { environmentHash: _environmentHash, ...bound } = runtimeEvidence;
  return sha256(stableJson(bound));
}

function validateRuntimeEvidence(evidence, trial) {
  expectRecord(evidence, "trial.runtimeEvidence");
  expectEqual(evidence.schemaVersion, 1, "trial.runtimeEvidence.schemaVersion");
  expectEqual(evidence.studyId, trial.studyId, "trial.runtimeEvidence.studyId");
  expectEqual(evidence.protocolHash, trial.protocolHash, "trial.runtimeEvidence.protocolHash");
  expectEqual(evidence.hostSurface, trial.hostSurface, "trial.runtimeEvidence.hostSurface");
  expectEqual(evidence.counterlaneEnabled, trial.counterlaneEnabled, "trial.runtimeEvidence.counterlaneEnabled");
  expectNonEmptyString(evidence.platform, "trial.runtimeEvidence.platform");
  expectNonEmptyString(evidence.arch, "trial.runtimeEvidence.arch");
  for (const field of [
    "sourceManifest",
    "counterlaneCli",
    "counterlaneConfig",
    "node",
    "codex",
    "modelCatalog",
    "quotaSnapshot",
  ]) {
    validateRuntimeEvidenceItem(evidence[field], `trial.runtimeEvidence.${field}`);
  }
  validateRuntimeSnapshotEvidence(evidence.modelCatalog, "trial.runtimeEvidence.modelCatalog", "model-catalog");
  validateRuntimeSnapshotEvidence(evidence.quotaSnapshot, "trial.runtimeEvidence.quotaSnapshot", "quota-snapshot");
  validateCounterlaneRouteEvidence(evidence.counterlaneRoute, trial);
  validateBackendRouteEvidence(evidence.backendRoute, trial);
  if (trial.hostSurface === "codex") {
    expectEqual(evidence.sourceManifest.status, "verified", "trial.runtimeEvidence.sourceManifest.status");
    expectEqual(evidence.counterlaneCli.status, "verified", "trial.runtimeEvidence.counterlaneCli.status");
    expectEqual(evidence.node.status, "verified", "trial.runtimeEvidence.node.status");
    expectEqual(evidence.node.scope, "execution-host", "trial.runtimeEvidence.node.scope");
    expectEqual(evidence.codex.status, "verified", "trial.runtimeEvidence.codex.status");
    expectEqual(evidence.codex.scope, "execution-host", "trial.runtimeEvidence.codex.scope");
    expectEqual(evidence.modelCatalog.status, "verified", "trial.runtimeEvidence.modelCatalog.status");
    expectEqual(evidence.quotaSnapshot.status, "verified", "trial.runtimeEvidence.quotaSnapshot.status");
    expectEqual(
      evidence.counterlaneConfig.status,
      trial.counterlaneEnabled ? "verified" : "not-applicable",
      "trial.runtimeEvidence.counterlaneConfig.status",
    );
  } else {
    expectEqual(evidence.node.status, "verified", "trial.runtimeEvidence.node.status");
    expectEqual(evidence.node.scope, "local-evaluator", "trial.runtimeEvidence.node.scope");
    expectEqual(evidence.codex.status, "unavailable", "trial.runtimeEvidence.codex.status");
    expectEqual(evidence.counterlaneConfig.status, "unavailable", "trial.runtimeEvidence.counterlaneConfig.status");
    expectEqual(evidence.modelCatalog.status, "unavailable", "trial.runtimeEvidence.modelCatalog.status");
    expectEqual(evidence.quotaSnapshot.status, "unavailable", "trial.runtimeEvidence.quotaSnapshot.status");
  }
  if (typeof evidence.environmentHash !== "string" || !SHA256_PATTERN.test(evidence.environmentHash)) {
    throw new Error("trial.runtimeEvidence.environmentHash must be a SHA-256 hex digest");
  }
  expectEqual(evidence.environmentHash, computeEnvironmentHash(evidence), "trial.runtimeEvidence.environmentHash");
}

function validateRuntimeSnapshotEvidence(item, path, kind) {
  if (item.status !== "verified") return;
  expectNonEmptyString(item.capturedAt, `${path}.capturedAt`);
  if (!Number.isFinite(Date.parse(item.capturedAt))) throw new Error(`${path}.capturedAt must be ISO-8601`);
  expectRecord(item.snapshot, `${path}.snapshot`);
  if (kind === "model-catalog") {
    if (!Array.isArray(item.snapshot.models) || item.snapshot.models.length === 0) {
      throw new Error(`${path}.snapshot.models must contain at least one live model`);
    }
  } else {
    expectRecord(item.snapshot.byId, `${path}.snapshot.byId`);
    if (item.snapshot.primary === null && Object.keys(item.snapshot.byId).length === 0) {
      throw new Error(`${path}.snapshot must contain at least one live quota bucket`);
    }
    if (item.snapshot.primary !== null && item.snapshot.primary !== undefined) {
      validateQuotaBucket(item.snapshot.primary, `${path}.snapshot.primary`);
    }
    for (const [limitId, bucket] of Object.entries(item.snapshot.byId)) {
      expectNonEmptyString(limitId, `${path}.snapshot.byId key`);
      validateQuotaBucket(bucket, `${path}.snapshot.byId.${limitId}`);
    }
  }
}

function validateQuotaBucket(bucket, path) {
  expectRecord(bucket, path);
  expectNonEmptyString(bucket.limitId, `${path}.limitId`);
  let windowCount = 0;
  for (const kind of ["primary", "secondary"]) {
    const window = bucket[kind];
    if (window === null || window === undefined) continue;
    windowCount += 1;
    expectRecord(window, `${path}.${kind}`);
    expectNonNegativeNumber(window.usedPercent, `${path}.${kind}.usedPercent`);
    if (window.usedPercent > 100) throw new Error(`${path}.${kind}.usedPercent must be at most 100`);
    expectNonNegativeNumber(window.windowDurationMins, `${path}.${kind}.windowDurationMins`);
    if (window.windowDurationMins === 0) throw new Error(`${path}.${kind}.windowDurationMins must be positive`);
    expectNonNegativeNumber(window.resetsAt, `${path}.${kind}.resetsAt`);
    if (window.resetsAt === 0) throw new Error(`${path}.${kind}.resetsAt must be positive`);
  }
  if (windowCount === 0) throw new Error(`${path} must contain a primary or secondary quota window`);
}

function validateCounterlaneRouteEvidence(route, trial) {
  expectRecord(route, "trial.runtimeEvidence.counterlaneRoute");
  if (!["verified", "unavailable", "not-applicable"].includes(route.status)) {
    throw new Error("trial.runtimeEvidence.counterlaneRoute.status is invalid");
  }
  expectNonEmptyString(route.scope, "trial.runtimeEvidence.counterlaneRoute.scope");
  if (trial.hostSurface !== "codex") {
    expectEqual(route.status, "unavailable", "trial.runtimeEvidence.counterlaneRoute.status");
    expectNonEmptyString(route.reason, "trial.runtimeEvidence.counterlaneRoute.reason");
    return;
  }
  if (!trial.counterlaneEnabled) {
    expectEqual(route.status, "not-applicable", "trial.runtimeEvidence.counterlaneRoute.status");
    expectEqual(route.value, null, "trial.runtimeEvidence.counterlaneRoute.value");
    expectEqual(route.sha256, null, "trial.runtimeEvidence.counterlaneRoute.sha256");
    expectNonEmptyString(route.reason, "trial.runtimeEvidence.counterlaneRoute.reason");
    return;
  }
  if (route.status !== "verified") {
    expectEqual(route.status, "unavailable", "trial.runtimeEvidence.counterlaneRoute.status");
    expectNonEmptyString(route.reason, "trial.runtimeEvidence.counterlaneRoute.reason");
    if (trial.treatmentCompliance !== "noncompliant" ||
        !trial.contamination.some((item) => item.code === "treatment-noncompliance")) {
      throw new Error("Counterlane ON without verified route evidence must be retained as treatment-noncompliant");
    }
    return;
  }
  expectEqual(route.sourceArtifact, "runStdout", "trial.runtimeEvidence.counterlaneRoute.sourceArtifact");
  if (typeof route.sourceSha256 !== "string" || !SHA256_PATTERN.test(route.sourceSha256)) {
    throw new Error("trial.runtimeEvidence.counterlaneRoute.sourceSha256 must be a SHA-256 hex digest");
  }
  if (typeof route.sha256 !== "string" || !SHA256_PATTERN.test(route.sha256)) {
    throw new Error("trial.runtimeEvidence.counterlaneRoute.sha256 must be a SHA-256 hex digest");
  }
  validateEffectiveRoute(route.value, "trial.runtimeEvidence.counterlaneRoute.value");
  expectEqual(route.sha256, sha256(stableJson(route.value)), "trial.runtimeEvidence.counterlaneRoute.sha256");
}

function validateBackendRouteEvidence(evidence, trial) {
  expectRecord(evidence, "trial.runtimeEvidence.backendRoute");
  if (trial.hostSurface !== "codex") {
    expectEqual(evidence.status, "unavailable", "trial.runtimeEvidence.backendRoute.status");
    expectNonEmptyString(evidence.reason, "trial.runtimeEvidence.backendRoute.reason");
    return;
  }
  expectEqual(evidence.status, "verified", "trial.runtimeEvidence.backendRoute.status");
  expectEqual(evidence.sourceArtifact, "runStdout", "trial.runtimeEvidence.backendRoute.sourceArtifact");
  if (typeof evidence.sourceSha256 !== "string" || !SHA256_PATTERN.test(evidence.sourceSha256)) {
    throw new Error("trial.runtimeEvidence.backendRoute.sourceSha256 must be a SHA-256 hex digest");
  }
  if (typeof evidence.sha256 !== "string" || !SHA256_PATTERN.test(evidence.sha256)) {
    throw new Error("trial.runtimeEvidence.backendRoute.sha256 must be a SHA-256 hex digest");
  }
  if (!Array.isArray(evidence.value)) throw new Error("trial.runtimeEvidence.backendRoute.value must be an array");
  for (const [index, reroute] of evidence.value.entries()) {
    expectRecord(reroute, `trial.runtimeEvidence.backendRoute.value[${index}]`);
    expectNonEmptyString(reroute.fromModel, `trial.runtimeEvidence.backendRoute.value[${index}].fromModel`);
    expectNonEmptyString(reroute.toModel, `trial.runtimeEvidence.backendRoute.value[${index}].toModel`);
  }
  expectEqual(evidence.sha256, sha256(stableJson(evidence.value)), "trial.runtimeEvidence.backendRoute.sha256");
}

function validateRuntimeEvidenceItem(item, path) {
  expectRecord(item, path);
  if (!["verified", "unavailable", "not-applicable"].includes(item.status)) {
    throw new Error(`${path}.status is invalid`);
  }
  expectNonEmptyString(item.scope, `${path}.scope`);
  if (item.status === "verified") {
    expectNonEmptyString(item.path, `${path}.path`);
    expectNonEmptyString(item.value, `${path}.value`);
    if (typeof item.sha256 !== "string" || !SHA256_PATTERN.test(item.sha256)) {
      throw new Error(`${path}.sha256 must be a SHA-256 hex digest`);
    }
  } else {
    expectEqual(item.path, null, `${path}.path`);
    expectEqual(item.sha256, null, `${path}.sha256`);
    expectNonEmptyString(item.reason, `${path}.reason`);
  }
}

function validateRuntimeArtifactBindings(evidence, hashes) {
  for (const [field, artifactName] of [
    ["sourceManifest", "sourceManifest"],
    ["counterlaneCli", "counterlaneCli"],
    ["counterlaneConfig", "counterlaneConfig"],
    ["node", "nodeVersion"],
    ["codex", "codexVersion"],
    ["modelCatalog", "modelCatalog"],
    ["quotaSnapshot", "quotaSnapshot"],
  ]) {
    const item = evidence[field];
    if (item.status === "verified") {
      expectEqual(hashes[artifactName], item.sha256, `trial.rawArtifactHashes.${artifactName}`);
    }
  }
  if (evidence.counterlaneRoute.status === "verified") {
    expectEqual(
      evidence.counterlaneRoute.sourceSha256,
      hashes.runStdout,
      "trial.runtimeEvidence.counterlaneRoute.sourceSha256",
    );
  }
  if (evidence.backendRoute.status === "verified") {
    expectEqual(
      evidence.backendRoute.sourceSha256,
      hashes.runStdout,
      "trial.runtimeEvidence.backendRoute.sourceSha256",
    );
  }
  expectEqual(hashes.environment, evidence.environmentHash, "trial.rawArtifactHashes.environment");
}

async function collectRuntimeEvidence(study, options) {
  const codexHost = options.hostSurface === "codex";
  await checkSourceManifest({ root: REPOSITORY_ROOT, quiet: true });
  const sourceManifest = await fileRuntimeEvidence(
    join(REPOSITORY_ROOT, "SOURCE_MANIFEST.sha256"),
    "local-build",
    codexHost,
  );
  const counterlaneCli = await fileRuntimeEvidence(
    resolveWithin(REPOSITORY_ROOT, study.protocol.counterlane.cli, "counterlane.cli"),
    "local-build",
    codexHost,
  );
  let counterlaneConfig;
  if (codexHost && options.counterlaneEnabled) {
    counterlaneConfig = await fileRuntimeEvidence(options.counterlaneConfigPath, "execution-config", true);
  } else if (codexHost) {
    counterlaneConfig = unavailableRuntimeEvidence("execution-config", "Counterlane config is not applicable to Codex OFF", "not-applicable");
  } else {
    counterlaneConfig = unavailableRuntimeEvidence("remote-execution-host", "Remote Work Counterlane config is not locally observable");
  }
  const nodeDescriptor = stableJson({ executable: process.execPath, version: process.version });
  const node = {
    status: "verified",
    scope: codexHost ? "execution-host" : "local-evaluator",
    path: process.execPath,
    value: process.version,
    sha256: sha256(nodeDescriptor),
  };
  let codex;
  let modelCatalog;
  let quotaSnapshot;
  if (codexHost) {
    const result = await runProcess(study.protocol.codex.command, ["--version"], {
      cwd: REPOSITORY_ROOT,
      timeoutMs: 30_000,
      env: process.env,
    });
    if (result.exitCode !== 0 || result.spawnError !== null || result.timedOut) {
      throw new Error(`Unable to bind Codex version: ${result.spawnError ?? result.stderr}`);
    }
    const version = `${result.stdout}${result.stderr}`.trim();
    expectNonEmptyString(version, "Codex version output");
    codex = {
      status: "verified",
      scope: "execution-host",
      path: study.protocol.codex.command,
      value: version,
      sha256: sha256(version),
    };
    if (options.rawDirectory !== undefined) {
      await writeText(join(options.rawDirectory, "codex.version.log"), version);
      await writeText(join(options.rawDirectory, "node.version.log"), nodeDescriptor);
    }
    ({ modelCatalog, quotaSnapshot } = await captureCodexRuntimeSnapshots(study, options));
  } else {
    codex = unavailableRuntimeEvidence("remote-execution-host", "ChatGPT Work does not expose its delegated Codex version to this local importer");
    modelCatalog = unavailableRuntimeEvidence("remote-execution-host", "ChatGPT Work does not expose its delegated live model catalog to this local importer");
    quotaSnapshot = unavailableRuntimeEvidence("remote-execution-host", "ChatGPT Work does not expose its delegated account quota snapshot to this local importer");
  }
  const counterlaneRoute = codexHost
    ? options.counterlaneEnabled
      ? unavailableCounterlaneRoute("counterlane-on-effective-route", "Effective Counterlane route is pending model execution")
      : unavailableCounterlaneRoute(
        "native-control",
        "Native Codex OFF does not execute Counterlane, so no Counterlane route exists",
        "not-applicable",
      )
    : unavailableCounterlaneRoute("remote-execution-host", "ChatGPT Work route is not observable by the local evaluator");
  const backendRoute = codexHost
    ? unavailableRuntimeEvidence("backend-route", "Backend reroute evidence is pending model execution")
    : unavailableRuntimeEvidence("remote-execution-host", "ChatGPT Work backend reroutes are not observable by the local evaluator");
  const evidence = {
    schemaVersion: 1,
    studyId: study.protocol.studyId,
    protocolHash: study.protocolHash,
    hostSurface: options.hostSurface,
    counterlaneEnabled: options.counterlaneEnabled,
    platform: process.platform,
    arch: process.arch,
    sourceManifest,
    counterlaneCli,
    counterlaneConfig,
    node,
    codex,
    modelCatalog,
    quotaSnapshot,
    counterlaneRoute,
    backendRoute,
  };
  return { ...evidence, environmentHash: computeEnvironmentHash(evidence) };
}

async function captureCodexRuntimeSnapshots(study, options) {
  if (options.rawDirectory === undefined || options.workspace === undefined || options.task === undefined) {
    throw new Error("Codex runtime catalog/quota capture requires rawDirectory, workspace, and task");
  }
  let configPath = options.counterlaneConfigPath;
  if (configPath === null || configPath === undefined) {
    configPath = join(options.rawDirectory, "runtime-probe.config.json");
    await writeJson(configPath, buildCounterlaneConfig(study.protocol, options.task));
  }
  const cliPath = resolveWithin(REPOSITORY_ROOT, study.protocol.counterlane.cli, "counterlane.cli");
  const moduleRoot = dirname(cliPath);
  const [configModule, loggerModule, appServerModule] = await Promise.all([
    import(pathToFileURL(join(moduleRoot, "config", "load.js")).href),
    import(pathToFileURL(join(moduleRoot, "core", "logger.js")).href),
    import(pathToFileURL(join(moduleRoot, "codex", "app-server.js")).href),
  ]);
  const loaded = await configModule.loadConfig({ cwd: REPOSITORY_ROOT, configPath });
  const logger = new loggerModule.Logger({ level: "silent", json: true });
  const server = await appServerModule.CodexAppServer.connect({
    config: loaded.config,
    cwd: options.workspace,
    logger,
  });
  let catalog;
  let quota;
  try {
    catalog = await server.listModels();
    quota = await server.readRateLimits();
  } finally {
    await server.close();
  }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error("Codex App Server returned no live model catalog entries");
  }
  if (quota.primary === null && Object.keys(quota.byId).length === 0) {
    throw new Error("Codex App Server returned no live quota buckets");
  }
  const catalogSnapshot = normalizeModelCatalogSnapshot(catalog);
  const quotaSnapshotValue = normalizeQuotaSnapshot(quota);
  const catalogPath = join(options.rawDirectory, "model-catalog.json");
  const quotaPath = join(options.rawDirectory, "quota-snapshot.json");
  await Promise.all([
    writeFile(catalogPath, `${stableJson(catalogSnapshot)}\n`, "utf8"),
    writeFile(quotaPath, `${stableJson(quotaSnapshotValue)}\n`, "utf8"),
  ]);
  const [catalogEvidence, quotaEvidence] = await Promise.all([
    fileRuntimeEvidence(catalogPath, "codex-app-server-live-catalog", true),
    fileRuntimeEvidence(quotaPath, "codex-app-server-live-quota", true),
  ]);
  return {
    modelCatalog: {
      ...catalogEvidence,
      value: `${catalogSnapshot.models.length} live model(s)`,
      capturedAt: catalog.fetchedAt,
      snapshot: catalogSnapshot,
    },
    quotaSnapshot: {
      ...quotaEvidence,
      value: `${quotaBucketCount(quotaSnapshotValue)} live quota bucket(s)`,
      capturedAt: quota.fetchedAt,
      snapshot: quotaSnapshotValue,
    },
  };
}

function normalizeModelCatalogSnapshot(catalog) {
  return {
    models: [...catalog.models]
      .map((model) => ({ ...model }))
      .sort((left, right) => `${left.id}\0${left.model}`.localeCompare(`${right.id}\0${right.model}`)),
  };
}

function normalizeQuotaSnapshot(quota) {
  return {
    primary: quota.primary ?? null,
    byId: quota.byId,
    planType: quota.planType ?? null,
    raw: quota.raw,
  };
}

function quotaBucketCount(snapshot) {
  return (snapshot.primary === null ? 0 : 1) + Object.keys(snapshot.byId).length;
}

async function fileRuntimeEvidence(path, scope, required) {
  try {
    const content = await readFile(path);
    return {
      status: "verified",
      scope,
      path: displayPath(path),
      value: `${content.byteLength} bytes`,
      sha256: sha256(content),
    };
  } catch (error) {
    if (!required && error !== null && typeof error === "object" && error.code === "ENOENT") {
      return unavailableRuntimeEvidence(scope, `File unavailable: ${displayPath(path)}`);
    }
    throw new Error(`Required runtime evidence is unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function unavailableRuntimeEvidence(scope, reason, status = "unavailable") {
  return { status, scope, path: null, value: null, sha256: null, reason };
}

function unavailableCounterlaneRoute(scope, reason, status = "unavailable") {
  return {
    status,
    scope,
    sourceArtifact: null,
    sourceSha256: null,
    value: null,
    sha256: null,
    reason,
  };
}

function runtimeArtifactHashes(evidence) {
  const output = { environment: evidence.environmentHash };
  for (const [field, artifactName] of [
    ["sourceManifest", "sourceManifest"],
    ["counterlaneCli", "counterlaneCli"],
    ["counterlaneConfig", "counterlaneConfig"],
    ["node", "nodeVersion"],
    ["codex", "codexVersion"],
    ["modelCatalog", "modelCatalog"],
    ["quotaSnapshot", "quotaSnapshot"],
  ]) {
    if (evidence[field].status === "verified") output[artifactName] = evidence[field].sha256;
  }
  return output;
}

function runtimeArtifactPaths(evidence) {
  const output = {};
  for (const [field, artifactName] of [
    ["sourceManifest", "sourceManifest"],
    ["counterlaneCli", "counterlaneCli"],
    ["counterlaneConfig", "counterlaneConfig"],
    ["node", "nodeExecutable"],
    ["codex", "codexCommand"],
    ["modelCatalog", "modelCatalog"],
    ["quotaSnapshot", "quotaSnapshot"],
  ]) {
    if (evidence[field].status === "verified") output[artifactName] = evidence[field].path;
  }
  return output;
}

async function hashOracle(studyDirectory, specification) {
  const moduleToken = specification.argv.find((value) => value !== "$NODE" && value !== "{workspace}");
  if (moduleToken === undefined) throw new Error("Hidden oracle module is missing");
  const modulePath = await resolveExistingWithin(studyDirectory, moduleToken, "hidden oracle module", "file");
  return sha256(`${stableJson(specification)}\0${await readFile(modulePath, "utf8")}`);
}

function cellIdForAssignment(assignment) {
  const definition = CELL_DEFINITIONS.find(
    (cell) => cell.hostSurface === assignment.hostSurface &&
      cell.counterlaneEnabled === assignment.counterlaneEnabled,
  );
  if (definition === undefined) {
    throw new Error(`Invalid 2x2 cell: ${assignment.hostSurface}/${String(assignment.counterlaneEnabled)}`);
  }
  return definition.cellId;
}

function seededShuffle(values, seedText) {
  const output = values.map((value) => ({ ...value }));
  const digest = createHash("sha256").update(seedText).digest();
  let state = digest.readUInt32LE(0) || 0x9e3779b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = output.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [output[index], output[selected]] = [output[selected], output[index]];
  }
  return output;
}

async function initializeGitRepository(workspace) {
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.name=Counterlane Experiment", "-c", "user.email=experiment@local.invalid", "commit", "-qm", "fixture baseline"],
  ]) {
    const result = await runProcess("git", args, { cwd: workspace, timeoutMs: 30_000, env: process.env });
    if (result.exitCode !== 0 || result.spawnError !== null) {
      throw new Error(`git ${args[0]} failed: ${result.spawnError ?? result.stderr}`);
    }
  }
  const baseline = await runProcess("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    timeoutMs: 30_000,
    env: process.env,
  });
  if (baseline.exitCode !== 0 || baseline.spawnError !== null || baseline.timedOut) {
    throw new Error(`Unable to capture fixture baseline commit: ${baseline.spawnError ?? baseline.stderr}`);
  }
  return baseline.stdout.trim();
}

async function assertBaselineHead(workspace, baselineCommit) {
  const current = await runProcess("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    timeoutMs: 30_000,
    env: process.env,
  });
  if (current.exitCode !== 0 || current.spawnError !== null || current.timedOut) {
    throw new Error(`Unable to inspect experiment HEAD: ${current.spawnError ?? current.stderr}`);
  }
  if (current.stdout.trim() !== baselineCommit) {
    throw new Error("Experiment agent moved HEAD; refusing a patch that is not based on the registered fixture baseline");
  }
}

export async function captureReproduciblePatch(workspace, baselineCommit) {
  await assertBaselineHead(workspace, baselineCommit);
  const stage = await runProcess("git", ["add", "-A"], {
    cwd: workspace,
    timeoutMs: 30_000,
    env: process.env,
  });
  if (stage.exitCode !== 0 || stage.spawnError !== null || stage.timedOut) {
    throw new Error(`Unable to stage the final workspace for patch capture: ${stage.spawnError ?? stage.stderr}`);
  }
  const patch = await runProcess("git", ["diff", "--cached", "--binary", baselineCommit], {
    cwd: workspace,
    timeoutMs: 30_000,
    env: process.env,
  });
  if (patch.exitCode !== 0 || patch.spawnError !== null || patch.timedOut) {
    throw new Error(`Unable to capture final.patch: ${patch.spawnError ?? patch.stderr}`);
  }
  return patch;
}

export async function runProcess(command, args, options) {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let outputOverflow = false;
    let spawnError = null;
    let settled = false;
    let didTimeout = false;
    let terminationRequested = false;
    let forceTimer;
    const resolvedCommand = resolveExperimentCommand(command, args, options.env);
    const child = spawn(resolvedCommand.command, resolvedCommand.args, {
      cwd: options.cwd,
      env: resolvedCommand.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminateExperimentProcessTree(child, false);
      forceTimer = setTimeout(() => terminateExperimentProcessTree(child, true), 2_000);
      forceTimer.unref();
    };
    const timer = setTimeout(() => {
      didTimeout = true;
      terminate();
    }, options.timeoutMs);
    timer.unref();
    const capture = (kind, chunk) => {
      const text = chunk.toString("utf8");
      capturedBytes += Buffer.byteLength(text);
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        outputOverflow = true;
        terminate();
        return;
      }
      if (kind === "stdout") stdout += text;
      else stderr += text;
    };
    child.stdout?.on("data", (chunk) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk) => capture("stderr", chunk));
    const finish = (exitCode, signal, timedOut) => {
      if (settled) return;
      settled = true;
      if (terminationRequested) terminateExperimentProcessTree(child, true);
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolvePromise({ exitCode, signal, stdout, stderr, timedOut, outputOverflow, spawnError });
    };
    child.once("error", (error) => {
      spawnError = error.message;
      finish(null, null, false);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal, didTimeout));
  });
}

function resolveExperimentCommand(command, args, env) {
  if (process.platform !== "win32") return { command, args, env };
  const executableName = win32.basename(command).toLowerCase();
  if (!['npm', 'npm.cmd', 'npm.ps1'].includes(executableName)) return { command, args, env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const pathEntries = String(env[pathKey] ?? "").split(";")
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
  const directories = new Set([win32.dirname(process.execPath), ...pathEntries]);
  if (win32.isAbsolute(command)) directories.add(win32.dirname(command));
  for (const directory of directories) {
    const npmCli = win32.join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    const node = win32.join(directory, "node.exe");
    const hasShim = existsSync(win32.join(directory, "npm.cmd")) || existsSync(win32.join(directory, "npm.ps1"));
    if (hasShim && existsSync(npmCli) && existsSync(node)) {
      return {
        command: node,
        args: [npmCli, ...args],
        env: { ...env, [pathKey]: [directory, ...pathEntries.filter((entry) => win32.resolve(entry).toLowerCase() !== win32.resolve(directory).toLowerCase())].join(";") },
      };
    }
  }
  return { command, args, env };
}

function terminateExperimentProcessTree(child, force) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    const fallback = () => child.kill(force ? "SIGKILL" : "SIGTERM");
    killer.once("error", fallback);
    killer.once("exit", (code) => { if (code !== 0) fallback(); });
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

export function extractCommonCost(stdout) {
  const candidates = [];
  for (const value of parseRuntimeJsonValues(stdout)) collectTokenBreakdowns(value, candidates);
  candidates.sort((left, right) =>
    right.totalTokens - left.totalTokens || tokenBreakdownCompleteness(right) - tokenBreakdownCompleteness(left));
  const selected = candidates[0] ?? emptyTokenBreakdown();
  const value = selected.totalTokens;
  return {
    unit: "total_tokens",
    value,
    source: value === null ? "unavailable" : "runtime-output",
    breakdown: selected,
  };
}

function collectTokenBreakdowns(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectTokenBreakdowns(item, output);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const total = tokenCountForKeys(value, ["total_tokens", "totalTokens", "total_token_count", "totalTokenCount"]);
  const input = tokenCountForKeys(value, ["input_tokens", "inputTokens", "input_token_count", "inputTokenCount"]);
  const cached = tokenCountForKeys(value, [
    "cached_input_tokens",
    "cachedInputTokens",
    "cached_input_token_count",
    "cachedInputTokenCount",
  ]);
  const outputTokens = tokenCountForKeys(value, ["output_tokens", "outputTokens", "output_token_count", "outputTokenCount"]);
  const reasoning = tokenCountForKeys(value, [
    "reasoning_output_tokens",
    "reasoningOutputTokens",
    "reasoning_tokens",
    "reasoningTokens",
  ]);
  const computedTotal = total ?? (input !== null && outputTokens !== null ? input + outputTokens : null);
  if (computedTotal !== null &&
      (input === null || outputTokens === null || computedTotal === input + outputTokens) &&
      (cached === null || input === null || cached <= input) &&
      (reasoning === null || outputTokens === null || reasoning <= outputTokens)) {
    output.push({
      totalTokens: computedTotal,
      inputTokens: input,
      cachedInputTokens: cached,
      uncachedInputTokens: input !== null && cached !== null ? input - cached : null,
      outputTokens,
      reasoningOutputTokens: reasoning,
    });
  }
  for (const nested of Object.values(value)) collectTokenBreakdowns(nested, output);
}

function tokenCountForKeys(value, keys) {
  for (const key of keys) {
    const candidate = value[key];
    if (Number.isSafeInteger(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

function tokenBreakdownCompleteness(value) {
  return Object.values(value).filter((item) => item !== null).length;
}

function emptyTokenBreakdown() {
  return {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
  };
}

function parseRuntimeJsonValues(stdout) {
  const values = [];
  const trimmed = stdout.trim();
  if (trimmed.length > 0) {
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      // Pretty JSON may be absent when a native Codex JSONL stream is captured.
    }
  }
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // Non-JSON console text remains in the raw artifact and is ignored here.
    }
  }
  return values;
}

export function extractCounterlaneRoute(stdout) {
  const routes = [];
  for (const value of parseRuntimeJsonValues(stdout)) collectCounterlaneRoutes(value, routes);
  return routes[0] ?? null;
}

function collectCounterlaneRoutes(value, output) {
  if (Array.isArray(value)) {
    for (const item of value) collectCounterlaneRoutes(item, output);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (value.arm !== null && typeof value.arm === "object" && !Array.isArray(value.arm)) {
    const route = normalizeEffectiveRoute(value.arm.policy, value.arm.turn);
    if (route !== null) output.push(route);
  }
  for (const nested of Object.values(value)) collectCounterlaneRoutes(nested, output);
}

function normalizeEffectiveRoute(policy, turn) {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) return null;
  const decision = policy.routeDecision !== null && typeof policy.routeDecision === "object" && !Array.isArray(policy.routeDecision)
    ? policy.routeDecision
    : null;
  const selected = decision?.selected !== null && typeof decision?.selected === "object" && !Array.isArray(decision.selected)
    ? decision.selected
    : null;
  const routeDecisionMismatches = selected === null
    ? ["missing-selection"]
    : [
        ...(selected.modelId === policy.modelId && selected.effort === policy.effort ? [] : ["model-effort"]),
        ...(selected.serviceTier === policy.serviceTier && selected.speedId === policy.speedId ? [] : ["service-tier-speed"]),
        ...(selected.topology === policy.topology && selected.proofTier === policy.proofTier ? [] : ["topology-proof"]),
      ];
  const route = {
    modelId: policy.modelId,
    modelFamily: policy.modelFamily,
    effort: policy.effort,
    serviceTier: policy.serviceTier,
    speedId: policy.speedId,
    speedCostMultiplier: policy.speedCostMultiplier,
    speedLatencyMultiplier: policy.speedLatencyMultiplier,
    topology: policy.topology,
    proofTier: policy.proofTier,
    selectionSource: decision === null ? "static-policy" : "auto-router",
    routeAdmissible: selected?.admissible === true,
    routeDecisionMatch: routeDecisionMismatches.length === 0,
    routeDecisionMismatches,
    backendReroutes: normalizeRerouteArray(turn?.reroutes),
  };
  try {
    validateEffectiveRoute(route, "effective route");
    return route;
  } catch {
    return null;
  }
}

function validateEffectiveRoute(route, path) {
  expectRecord(route, path);
  for (const field of ["modelId", "modelFamily", "effort", "speedId", "topology", "proofTier", "selectionSource"]) {
    expectNonEmptyString(route[field], `${path}.${field}`);
  }
  if (route.serviceTier !== null) expectNonEmptyString(route.serviceTier, `${path}.serviceTier`);
  expectNonNegativeNumber(route.speedCostMultiplier, `${path}.speedCostMultiplier`);
  expectNonNegativeNumber(route.speedLatencyMultiplier, `${path}.speedLatencyMultiplier`);
  expectBoolean(route.routeAdmissible, `${path}.routeAdmissible`);
  expectBoolean(route.routeDecisionMatch, `${path}.routeDecisionMatch`);
  if (!Array.isArray(route.routeDecisionMismatches) || route.routeDecisionMismatches.some((item) => typeof item !== "string")) {
    throw new Error(`${path}.routeDecisionMismatches must be a string array`);
  }
  if (!Array.isArray(route.backendReroutes)) throw new Error(`${path}.backendReroutes must be an array`);
  for (const [index, reroute] of route.backendReroutes.entries()) {
    expectRecord(reroute, `${path}.backendReroutes[${index}]`);
    expectNonEmptyString(reroute.fromModel, `${path}.backendReroutes[${index}].fromModel`);
    expectNonEmptyString(reroute.toModel, `${path}.backendReroutes[${index}].toModel`);
    if (reroute.reason !== undefined) expectNonEmptyString(reroute.reason, `${path}.backendReroutes[${index}].reason`);
  }
}

export function extractBackendReroutes(stdout, counterlaneEnabled) {
  const reroutes = [];
  for (const value of parseRuntimeJsonValues(stdout)) {
    collectReportedBackendReroutes(value, reroutes, counterlaneEnabled);
  }
  const bySignature = new Map(reroutes.map((reroute) => [stableJson(reroute), reroute]));
  return [...bySignature.values()];
}

function collectReportedBackendReroutes(value, output, counterlaneEnabled) {
  if (Array.isArray(value)) {
    for (const item of value) collectReportedBackendReroutes(item, output, counterlaneEnabled);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (counterlaneEnabled && value.arm !== null && typeof value.arm === "object" && !Array.isArray(value.arm)) {
    output.push(...normalizeRerouteArray(value.arm.turn?.reroutes));
  }
  const eventKind = value.method ?? value.type;
  if (["model/rerouted", "model_rerouted", "model.rerouted"].includes(eventKind)) {
    const payload = value.params !== null && typeof value.params === "object" && !Array.isArray(value.params)
      ? value.params
      : value;
    const reroute = normalizeReroute(payload);
    if (reroute !== null) output.push(reroute);
  }
  for (const nested of Object.values(value)) collectReportedBackendReroutes(nested, output, false);
}

function normalizeRerouteArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeReroute).filter((item) => item !== null);
}

function normalizeReroute(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const fromModel = value.fromModel ?? value.from_model ?? value.from;
  const toModel = value.toModel ?? value.to_model ?? value.to;
  if (typeof fromModel !== "string" || fromModel.length === 0 || typeof toModel !== "string" || toModel.length === 0) {
    return null;
  }
  return {
    fromModel,
    toModel,
    ...(typeof value.reason === "string" && value.reason.length > 0 ? { reason: value.reason } : {}),
  };
}

function summarizeCommonCost(costs) {
  const available = costs.filter((cost) => cost.value !== null);
  const units = new Set(available.map((cost) => cost.unit));
  if (available.length !== costs.length || units.size !== 1) {
    return {
      unit: "unavailable-or-mixed",
      mean: null,
      breakdown: summarizeTokenBreakdowns(costs),
      observed: available.length,
      assigned: costs.length,
    };
  }
  return {
    unit: available[0].unit,
    mean: mean(available.map((cost) => cost.value)),
    breakdown: summarizeTokenBreakdowns(costs),
    observed: available.length,
    assigned: costs.length,
  };
}

function summarizeTokenBreakdowns(costs) {
  const output = {};
  for (const field of [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ]) {
    const values = costs.map((cost) => cost.breakdown[field]);
    output[field] = values.every((value) => value !== null) ? mean(values) : null;
  }
  return output;
}

function compareCommonCost(off, on, analysisProtocol, automaticComparisons = []) {
  const unit = off.commonCost.unit === on.commonCost.unit ? off.commonCost.unit : "unavailable-or-mixed";
  const comparable =
    off.commonCost.mean !== null &&
    on.commonCost.mean !== null &&
    off.commonCost.unit === on.commonCost.unit &&
    off.commonCost.unit !== "unavailable-or-mixed";
  const bothVerified = off.successes === off.assigned && on.successes === on.assigned;
  const requiresBothVerified = analysisProtocol.requireBothVerifiedForTokenSavingsClaim === true;
  const verificationEligible = !requiresBothVerified || bothVerified;
  const routeEvidenceEligible = on.verifiedCounterlaneRoutes === on.assigned;
  const contaminationEligible = off.contaminated === 0 && on.contaminated === 0 &&
    automaticComparisons.every((comparison) => !comparison.contaminated);
  const complianceEligible = off.noncompliant === 0 && on.noncompliant === 0 &&
    automaticComparisons.every((comparison) => !comparison.noncompliant);
  const onMinusOff = comparable ? on.commonCost.mean - off.commonCost.mean : null;
  const savingsPct = comparable && off.commonCost.mean > 0
    ? ((off.commonCost.mean - on.commonCost.mean) / off.commonCost.mean) * 100
    : null;
  const thresholdPct = typeof analysisProtocol.practicalTokenSavingsThresholdPct === "number"
    ? analysisProtocol.practicalTokenSavingsThresholdPct
    : null;
  const thresholdMet = thresholdPct === null || savingsPct === null ? null : savingsPct >= thresholdPct;
  const claimEligible = comparable && verificationEligible && routeEvidenceEligible &&
    contaminationEligible && complianceEligible &&
    thresholdPct !== null && thresholdMet === true;
  const reason = !comparable
    ? "common cost is unavailable or uses mixed units"
    : !verificationEligible
      ? "protocol requires both arms to achieve verified success"
      : !routeEvidenceEligible
        ? "Counterlane ON effective route evidence is unavailable for one or more assigned trials"
      : !complianceEligible
        ? "one or more assigned trials or paired route comparisons are treatment-noncompliant"
      : !contaminationEligible
        ? "one or more assigned trials or paired quota/route comparisons are contaminated"
      : thresholdPct !== null && thresholdMet !== true
        ? `observed savings did not reach the preregistered ${thresholdPct}% threshold`
        : thresholdPct === null
          ? "descriptive comparable-cost effect only; no practical threshold was preregistered"
          : `both arms verified and observed savings reached the preregistered ${thresholdPct}% threshold`;
  return {
    comparable,
    unit,
    offMean: off.commonCost.mean,
    onMean: on.commonCost.mean,
    onMinusOff,
    savingsPct,
    bothVerified,
    requiresBothVerified,
    routeEvidenceEligible,
    contaminationEligible,
    complianceEligible,
    thresholdPct,
    thresholdMet,
    claimEligible,
    reason,
  };
}

function formatNullableNumber(value) {
  return value === null ? "unavailable" : value.toFixed(1);
}

function formatSignedNumber(value) {
  if (value === null) return "unavailable";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function formatNullablePercent(value) {
  return value === null ? "unavailable" : `${value.toFixed(1)}%`;
}

async function validateWorkWorkspace(study, assignment, workspace) {
  const repositoryRootResult = await runProcess("git", ["rev-parse", "--show-toplevel"], {
    cwd: workspace,
    timeoutMs: 30_000,
    env: process.env,
  });
  requireSuccessfulProcess(repositoryRootResult, "inspect seal-work Git repository");
  const repositoryRoot = await realpath(resolve(repositoryRootResult.stdout.trim()));
  if (!sameFilesystemPath(repositoryRoot, workspace)) {
    throw new Error("seal-work workspace must be the root of its Git repository");
  }

  const status = await runProcess(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: workspace, timeoutMs: 30_000, env: process.env },
  );
  requireSuccessfulProcess(status, "inspect seal-work workspace status");
  if (status.stdout.split("\0").some((entry) => entry.startsWith("?? "))) {
    throw new Error("seal-work workspace contains untracked files that final.patch cannot capture");
  }

  const task = findTask(study, assignment.taskId);
  const fixture = await resolveExistingWithin(study.studyDirectory, task.fixturePath, "fixturePath", "directory");
  const registeredSourceHash = await hashDirectory(fixture);
  expectEqual(registeredSourceHash, assignment.sourceHash, "seal-work registered fixture sourceHash");
  const baselineSourceHash = await hashGitHead(workspace);
  expectEqual(baselineSourceHash, assignment.sourceHash, "seal-work Git HEAD sourceHash");
}

async function hashGitHead(workspace) {
  const temporary = await mkdtemp(join(tmpdir(), "counterlane-work-head-"));
  const checkout = join(temporary, "checkout");
  const index = join(temporary, "index");
  const environment = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await mkdir(checkout);
    const readTree = await runProcess("git", ["read-tree", "HEAD"], {
      cwd: workspace,
      timeoutMs: 30_000,
      env: environment,
    });
    requireSuccessfulProcess(readTree, "read seal-work Git HEAD");
    const prefix = `${checkout.split(sep).join("/")}/`;
    const checkoutIndex = await runProcess("git", ["checkout-index", "--all", "--force", `--prefix=${prefix}`], {
      cwd: workspace,
      timeoutMs: 30_000,
      env: environment,
    });
    requireSuccessfulProcess(checkoutIndex, "materialize seal-work Git HEAD");
    return await hashDirectory(checkout);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function requireSuccessfulProcess(result, label) {
  if (result.exitCode !== 0 || result.spawnError !== null || result.timedOut || result.outputOverflow) {
    const detail = result.spawnError ?? (result.stderr || `exit ${result.exitCode}`);
    throw new Error(`Unable to ${label}: ${detail}`);
  }
}

async function requireLocalDirectory(candidate, label) {
  expectNonEmptyString(candidate, label);
  const absolute = resolve(candidate);
  const metadata = await lstat(absolute).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a local non-symlink directory: ${absolute}`);
  }
  return realpath(absolute);
}

async function requireLocalFile(candidate, label) {
  expectNonEmptyString(candidate, label);
  const absolute = resolve(candidate);
  const metadata = await lstat(absolute).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a local non-symlink file: ${absolute}`);
  }
  return realpath(absolute);
}

async function resolveNewOutputDirectory(candidate, workspace) {
  expectNonEmptyString(candidate, "seal-work output");
  const requested = resolve(candidate);
  const parent = await requireLocalDirectory(dirname(requested), "seal-work output parent");
  const output = join(parent, basename(requested));
  if (isWithinPath(workspace, output)) {
    throw new Error("seal-work output must remain outside the task workspace");
  }
  if (await lstat(output).catch(() => null) !== null) {
    throw new Error(`seal-work output already exists: ${output}`);
  }
  return output;
}

function isWithinPath(root, candidate) {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function sameFilesystemPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Unsupported fixture entry: ${from}`);
  }
}

async function readFixtureManifest(root) {
  const files = [];
  await collectFiles(resolve(root), resolve(root), new Set(), files);
  return Promise.all(
    files
      .sort((left, right) => left.relative.localeCompare(right.relative))
      .map(async (file) => {
        const content = await readFile(file.absolute);
        return {
          path: file.relative,
          sha256: sha256(content),
          encoding: "base64",
          content: content.toString("base64"),
        };
      }),
  );
}

export async function hashDirectory(root, excludedNames = []) {
  const files = [];
  await collectFiles(resolve(root), resolve(root), new Set(excludedNames), files);
  const hash = createHash("sha256");
  for (const file of files.sort((left, right) => left.relative.localeCompare(right.relative))) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(await readFile(file.absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function collectFiles(root, directory, excludedNames, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(root, path, excludedNames, output);
    else if (entry.isFile()) output.push({ absolute: path, relative: relativePortable(root, path) });
    else throw new Error(`Unsupported file type while hashing ${path}`);
  }
}

function findTask(study, taskId) {
  const task = study.tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) throw new Error(`Unknown taskId: ${taskId}`);
  return task;
}

function findAssignment(schedule, assignmentId) {
  expectNonEmptyString(assignmentId, "assignmentId");
  const assignment = schedule.assignments.find((candidate) => candidate.assignmentId === assignmentId);
  if (assignment === undefined) throw new Error(`Unknown assignmentId: ${assignmentId}`);
  return assignment;
}

function resolveWithin(root, candidate, label) {
  expectNonEmptyString(candidate, label);
  if (isAbsolute(candidate)) throw new Error(`${label} must be relative`);
  const absolute = resolve(root, candidate);
  const relativePath = relative(resolve(root), absolute);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} escapes ${root}`);
  }
  return absolute;
}

export async function resolveExistingWithin(root, candidate, label, expectedType) {
  const lexicalPath = resolveWithin(root, candidate, label);
  const metadata = await lstat(lexicalPath).catch(() => null);
  const typeMatches = expectedType === "directory"
    ? metadata?.isDirectory() === true
    : expectedType === "file"
      ? metadata?.isFile() === true
      : false;
  if (!typeMatches || metadata?.isSymbolicLink() === true) {
    throw new Error(`${label} must be an existing non-symlink ${expectedType}: ${lexicalPath}`);
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(resolve(root)),
    realpath(lexicalPath),
  ]);
  if (!isWithinPath(canonicalRoot, canonicalPath)) {
    throw new Error(`${label} escapes ${canonicalRoot} after resolving filesystem links`);
  }
  return canonicalPath;
}

function defaultArtifactRoot(study) {
  return join(REPOSITORY_ROOT, ".counterlane", "studies", study.protocol.studyId);
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}`);
    const name = token.slice(2).replaceAll("-", "_");
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    options[camelCase(name)] = value;
    index += 1;
  }
  return options;
}

function camelCase(value) {
  return value.replaceAll(/_([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

function requiredOption(options, name) {
  const value = options[name];
  expectNonEmptyString(value, `--${name}`);
  return value;
}

async function readJsonLines(path) {
  const raw = await readFile(path, "utf8");
  const output = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    output.push(parseJson(line, `${path}:${index + 1}`));
  }
  return output;
}

async function readJsonLinesIfPresent(path) {
  try {
    return await readJsonLines(path);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return [];
    throw error;
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tomlString(value) {
  return JSON.stringify(value);
}

function renderProcessEvidence(result) {
  return `${JSON.stringify({
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputOverflow: result.outputOverflow,
    spawnError: result.spawnError,
  })}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`;
}

function serializableResult(result) {
  if (result.study !== undefined) {
    const { study: _study, schedule: _schedule, ...rest } = result;
    return rest;
  }
  if (result.packet !== undefined) return { output: result.output, assignmentId: result.packet.assignment.assignmentId };
  if (result.analysis !== undefined) return { markdownPath: result.markdownPath, jsonPath: result.jsonPath, analysis: result.analysis };
  return result;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatRate(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedRate(value) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;
}

function relativePortable(root, path) {
  return relative(root, path).split(sep).join("/");
}

function displayPath(path) {
  const absolute = resolve(path);
  const relativePath = relative(REPOSITORY_ROOT, absolute);
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
    ? absolute
    : relativePortable(REPOSITORY_ROOT, absolute);
}

function sameSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((value) => actual.some((candidate) => Object.is(candidate, value)));
}

function expectRecord(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function expectNonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
}

function expectBoolean(value, path) {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
}

function expectPositiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${path} must be a positive integer`);
}

function expectNonNegativeNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
}

function expectEqual(actual, expected, path) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${path} must equal ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
  }
}

function printHelp() {
  process.stdout.write(
    "Counterlane Codex-app paired exploratory harness (Work protocol remains opt-in)\n\n" +
    "Commands:\n" +
    "  plan [--protocol FILE] [--tasks FILE] [--output FILE]\n" +
    "  packet --assignment ID [--protocol FILE] [--schedule FILE] [--output FILE]\n" +
    "  seal-work --assignment ID --workspace DIR --stdout FILE --stderr FILE --started-at ISO --completed-at ISO [--counterlane-result FILE] --output DIR [--protocol FILE]\n" +
    "  import --input ENVELOPE.json [--bundle DIRECTORY] [--protocol FILE] [--schedule FILE] [--trials FILE]\n" +
    "  run-codex --assignment ID [--protocol FILE] [--schedule FILE] [--trials FILE]\n" +
    "  analyze [--protocol FILE] [--schedule FILE] [--trials FILE] [--output REPORT.md]\n\n" +
    `Default protocol: ${relativePortable(REPOSITORY_ROOT, DEFAULT_PROTOCOL_PATH)}\n` +
    "The four-cell Work/Codex protocol must be selected explicitly with --protocol.\n\n" +
    "All child processes use executable-plus-argv spawning with shell=false.\n",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
