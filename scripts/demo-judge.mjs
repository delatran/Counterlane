#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = join(root, "dist", "cli.js");
const mockAppServerPath = join(root, "test", "fixtures", "mock-app-server.mjs");
const outputPathArgument = parseOutputPath(process.argv.slice(2));

await verifyJudgeInputs();
const temporaryRoot = await mkdtemp(join(tmpdir(), "counterlane-simulated-judge-"));
const temporaryHome = join(temporaryRoot, "home");
const requestedOutputPath = outputPathArgument ?? join(temporaryRoot, "counterlane-judge-evidence.json");
const parentBefore = await checkoutFingerprint(root);
const parentBoundary = process.env.COUNTERLANE_JUDGE_REQUIRE_PACKAGED === "1" ? "packaged-artifact-root" : "owner-checkout";

try {
  await mkdir(temporaryHome, { recursive: true });
  const trustedVerificationPath = join(temporaryRoot, "trusted-verification.json");
  const trustedVerifierEntrypoint = join(temporaryRoot, "trusted-task-verifier.mjs");
  await writeFile(
    trustedVerifierEntrypoint,
    "import { readFileSync } from 'node:fs'; process.exit(readFileSync('answer.txt', 'utf8') === 'correct\\n' ? 0 : 1);\n",
    "utf8",
  );
  await writeFile(trustedVerificationPath, `${JSON.stringify(hostVerificationPolicy(trustedVerifierEntrypoint), null, 2)}\n`, "utf8");

  const configurationRequired = await runConfigurationRequiredScenario({
    temporaryRoot,
    temporaryHome,
  });
  const firstPass = await runProductScenario({
    name: "first-pass",
    temporaryRoot,
    temporaryHome,
    trustedVerificationPath,
    expectedTurns: 1,
  });
  const escalation = await runProductScenario({
    name: "verifier-gated-escalation",
    temporaryRoot,
    temporaryHome,
    trustedVerificationPath,
    expectedTurns: 2,
    turnOutcomes: ["fail", "pass"],
  });

  const parentAfter = await checkoutFingerprint(root);
  assert.equal(parentAfter, parentBefore, "the simulated judge must not mutate the owner checkout");
  const evidenceBase = {
    schemaVersion: 1,
    evidenceKind: "simulated",
    executionBoundary: "no-quota-local-mcp-judge",
    liveModelTurns: 0,
    networkAccess: "not-used-by-judge-fixture",
    inputManifestHash: await hashFile("JUDGE_FIXTURE_MANIFEST.json"),
    parentCheckout: {
      boundary: parentBoundary,
      sourceFingerprint: parentBefore,
      unchanged: true,
    },
    scenarios: {
      configurationRequired,
      firstPass,
      escalation,
    },
  };
  const evidence = {
    ...evidenceBase,
    evidenceHash: sha256(JSON.stringify(evidenceBase)),
  };
  await mkdir(resolve(requestedOutputPath, ".."), { recursive: true });
  await writeFile(requestedOutputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const reread = JSON.parse(await readFile(requestedOutputPath, "utf8"));
  assert.equal(reread.evidenceHash, evidence.evidenceHash, "generated judge evidence must be self-consistent");

  process.stdout.write("Counterlane simulated MCP judge passed: configuration_required, first-pass, verifier-gated escalation.\n");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    evidenceKind: "simulated",
    evidenceHash: evidence.evidenceHash,
    configurationRequiredTurns: configurationRequired.turnStarts,
    firstPassTurns: firstPass.turnStarts,
    escalationTurns: escalation.turnStarts,
    parentCheckoutUnchanged: true,
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runConfigurationRequiredScenario(options) {
  const repository = await createFixtureRepository(join(options.temporaryRoot, "configuration-required"));
  const requestLog = join(options.temporaryRoot, "configuration-required.requests.jsonl");
  const before = await fixtureFingerprint(repository);
  const structured = await withMcp({
    temporaryHome: options.temporaryHome,
    requestLog,
    includeTrustedVerification: false,
  }, async (client) => client.callExecute(repository));
  const requests = await readRequests(requestLog);
  assert.equal(structured.state, "configuration_required");
  assert.equal(structured.modelTurnStarted, false);
  assert.equal(countMethod(requests, "thread/start"), 0);
  assert.equal(countMethod(requests, "thread/fork"), 0);
  assert.equal(countMethod(requests, "turn/start"), 0);
  await assertFixtureUnchanged(repository, before);
  return {
    state: structured.state,
    modelTurnStarted: structured.modelTurnStarted,
    threadStarts: 0,
    turnStarts: 0,
    nonApplying: structured.nonApplying,
  };
}

async function runProductScenario(options) {
  const repository = await createFixtureRepository(join(options.temporaryRoot, options.name));
  const requestLog = join(options.temporaryRoot, `${options.name}.requests.jsonl`);
  const before = await fixtureFingerprint(repository);
  let sequencePath;
  if (options.turnOutcomes !== undefined) {
    sequencePath = join(options.temporaryRoot, `${options.name}.turn-outcomes.json`);
    await writeFile(sequencePath, JSON.stringify(options.turnOutcomes), "utf8");
  }
  const structured = await withMcp({
    temporaryHome: options.temporaryHome,
    requestLog,
    trustedVerificationPath: options.trustedVerificationPath,
    ...(sequencePath === undefined ? {} : { sequencePath }),
  }, async (client) => client.callExecute(repository));
  const requests = await readRequests(requestLog);
  const turnStarts = countMethod(requests, "turn/start");
  assert.equal(structured.state, "verified", JSON.stringify(structured));
  assert.equal(structured.nonApplying, true);
  assert.equal(structured.modelTurnStarted, true);
  assert.equal(turnStarts, options.expectedTurns);
  assert.equal(countMethod(requests, "thread/start"), options.expectedTurns);
  assert.equal(countMethod(requests, "thread/fork"), 0);
  assert.equal(structured.spentAttempts, options.expectedTurns);
  assert.equal(structured.reservedAttempts, options.expectedTurns);
  const receipt = structured.receipt;
  assert.equal(receipt.evidence.kind, "simulated");
  assert.equal(receipt.attempts.length, options.expectedTurns);
  assert.equal(structured.publicReceipt.evidence.kind, "simulated");

  const runId = structured.receiptArtifacts.runId;
  const localReceipt = JSON.parse(await readFile(join(repository, ".counterlane", "receipts", `${runId}.json`), "utf8"));
  const publicReceipt = JSON.parse(await readFile(join(repository, ".counterlane", "receipts", `${runId}.public.json`), "utf8"));
  assert.equal(localReceipt.receiptHash, structured.receiptArtifacts.localReceiptHash);
  assert.equal(publicReceipt.publicReceiptHash, structured.receiptArtifacts.publicReceiptHash);
  assert.equal(publicReceipt.evidence.kind, "simulated");
  await assertFixtureUnchanged(repository, before);

  const turnModels = requests
    .filter((request) => request.method === "turn/start")
    .map((request) => request.params?.model);
  if (options.expectedTurns === 2) {
    assert.deepEqual(await readJson(sequencePath), []);
    assert.ok(receipt.failureCapsule !== undefined, "the escalation receipt must retain a bounded failure capsule");
    const firstRoute = receipt.attempts[0]?.route;
    const secondRoute = receipt.attempts[1]?.route;
    assert.notDeepEqual(secondRoute, firstRoute, "the second attempt must use a fresh route");
    assert.ok(
      capabilityOrder(secondRoute) > capabilityOrder(firstRoute),
      "the second selected route must be strictly stronger than the failed first route",
    );
  }
  return {
    state: structured.state,
    nonApplying: structured.nonApplying,
    modelTurnStarted: structured.modelTurnStarted,
    threadStarts: countMethod(requests, "thread/start"),
    turnStarts,
    turnModels,
    receiptHash: structured.receiptArtifacts.localReceiptHash,
    publicReceiptHash: structured.receiptArtifacts.publicReceiptHash,
    attempts: receipt.attempts.map((attempt) => ({
      outcome: attempt.outcome,
      route: attempt.route,
      verification: attempt.verification,
    })),
  };
}

function capabilityOrder(route) {
  const family = String(route?.modelId ?? "").includes("sol") ? 3 : String(route?.modelId ?? "").includes("terra") ? 2 : 1;
  const effort = ["none", "minimal", "low", "light", "medium", "high", "xhigh", "max", "ultra"].indexOf(String(route?.effort));
  const topology = route?.topology === "ultra" ? 1 : 0;
  return family * 100 + Math.max(0, effort) * 2 + topology;
}

async function withMcp(options, action) {
  const env = {
    ...process.env,
    HOME: options.temporaryHome,
    USERPROFILE: options.temporaryHome,
    COUNTERLANE_TRUST_HOME: join(options.temporaryHome, "trust"),
    COUNTERLANE_MCP_TRUSTED_CODEX_COMMAND: process.execPath,
    COUNTERLANE_MCP_TRUSTED_CODEX_ARGS_JSON: JSON.stringify([mockAppServerPath]),
    COUNTERLANE_EVIDENCE_KIND: "simulated",
    MOCK_REQUEST_LOG: options.requestLog,
    ...(options.sequencePath === undefined ? {} : { MOCK_TURN_OUTCOME_SEQUENCE_FILE: options.sequencePath }),
  };
  if (options.includeTrustedVerification === false) {
    delete env.COUNTERLANE_MCP_TRUSTED_VERIFICATION_FILE;
  } else {
    env.COUNTERLANE_MCP_TRUSTED_VERIFICATION_FILE = options.trustedVerificationPath;
  }
  const child = spawn(process.execPath, [cliPath, "mcp", "--stdio"], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let nextId = 1;
  const request = async (method, params) => {
    const id = nextId;
    nextId += 1;
    send(child, { jsonrpc: "2.0", id, method, params });
    return nextResponse(iterator, id);
  };
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "counterlane-simulated-judge", version: "1" },
    });
    assert.equal(initialized.error, undefined, JSON.stringify(initialized));
    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await request("tools/list", {});
    const tools = listed.result?.tools;
    assert.ok(Array.isArray(tools), "MCP tools/list must return the product tool definitions");
    const execute = tools.find((tool) => tool?.name === "counterlane_execute");
    assert.ok(execute?.outputSchema?.required?.includes("modelTurnStarted"));
    assert.deepEqual(execute?.inputSchema?.properties?.speedMode?.enum, ["off", "auto", "fast"]);
    return await action({
      callExecute: async (cwd) => {
        const result = await request("tools/call", {
          name: "counterlane_execute",
          arguments: {
            cwd,
            prompt: "Correct answer.txt exactly and satisfy the trusted task contract verifier.",
            speedMode: "off",
            executionContext: "foreground",
          },
        });
        assert.equal(result.error, undefined, JSON.stringify(result));
        assert.equal(result.result?.isError, undefined, JSON.stringify(result.result));
        assert.ok(result.result?.structuredContent !== undefined, "counterlane_execute must expose structured content");
        return result.result.structuredContent;
      },
    });
  } catch (error) {
    const suffix = stderr.trim().length === 0 ? "" : `\nMCP stderr: ${stderr}`;
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
  } finally {
    lines.close();
    child.kill();
    await once(child, "exit").catch(() => undefined);
  }
}

async function createFixtureRepository(directory) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "answer.txt"), "wrong\n", "utf8");
  await writeFile(join(directory, "source.mjs"), "export const fixture = true;\n", "utf8");
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name: "counterlane-simulated-fixture", private: true, type: "module" }, null, 2)}\n`, "utf8");
  await runCommand("git", ["init", "-q"], directory);
  await runCommand("git", ["add", "-A"], directory);
  await runCommand("git", ["-c", "user.name=Counterlane Judge", "-c", "user.email=judge@local.invalid", "commit", "-qm", "fixture-baseline"], directory);
  return directory;
}

function hostVerificationPolicy(verifierEntrypoint) {
  return {
    version: 1,
    verification: {
      autoDetect: false,
      requireAtLeastOne: true,
      failOnNoVerifier: true,
      requireTaskSpecificCheck: true,
      commands: [{
        name: "simulated-host-task-contract",
        command: [process.execPath, verifierEntrypoint],
        required: true,
        taskSpecific: true,
        candidateCodePolicy: "data-only",
        minimumTier: "standard",
      }],
    },
  };
}

async function assertFixtureUnchanged(repository, before) {
  assert.equal(await fixtureFingerprint(repository), before, "counterlane_execute must leave the fixture checkout source state unchanged");
  assert.equal(await readFile(join(repository, "answer.txt"), "utf8"), "wrong\n");
}

async function fixtureFingerprint(directory) {
  const [status, diff] = await Promise.all([
    runCommand("git", ["status", "--porcelain=v1", "-uno"], directory),
    runCommand("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], directory),
  ]);
  return sha256(`${status.stdout}\u0000${diff.stdout}`);
}

async function checkoutFingerprint(directory) {
  try {
    return await fixtureFingerprint(directory);
  } catch (error) {
    if (process.env.COUNTERLANE_JUDGE_REQUIRE_PACKAGED !== "1") throw error;
    return packagedArtifactFingerprint(directory);
  }
}

async function packagedArtifactFingerprint(directory) {
  const paths = [
    "package.json",
    "dist/cli.js",
    "scripts/counterlane-doctor.mjs",
    "scripts/demo-judge.mjs",
    "JUDGE_FIXTURE_MANIFEST.json",
    "test/fixtures/mock-app-server.mjs",
  ];
  const parts = await Promise.all(paths.map(async (relativePath) => `${relativePath}:${await hashFile(join(directory, relativePath))}`));
  return sha256(parts.join("\n"));
}

async function readRequests(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split(/\r?\n/u).filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

function countMethod(requests, method) {
  return requests.filter((request) => request.method === method).length;
}

async function verifyJudgeInputs() {
  await access(cliPath);
  await access(mockAppServerPath);
  const manifest = await readJson(join(root, "JUDGE_FIXTURE_MANIFEST.json"));
  assert.equal(manifest?.schemaVersion, 1, "JUDGE_FIXTURE_MANIFEST.json must use schema version 1");
  assert.ok(manifest.files !== null && typeof manifest.files === "object" && !Array.isArray(manifest.files));
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    assert.equal(typeof expectedHash, "string");
    assert.equal(await hashFile(relativePath), expectedHash, `judge fixture input is stale: ${relativePath}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function hashFile(relativePath) {
  const path = isAbsolute(relativePath) ? relativePath : join(root, relativePath);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseOutputPath(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--output" && isAbsolute(args[1])) return args[1];
  throw new Error("Usage: node scripts/demo-judge.mjs [--output ABSOLUTE_PATH]");
}

async function nextResponse(iterator, expectedId) {
  for (;;) {
    const next = await withTimeout(iterator.next(), 60_000, "Timed out waiting for MCP response.");
    if (next.done) throw new Error("MCP stdout closed before a response arrived.");
    const message = JSON.parse(next.value);
    if (message.id === expectedId) return message;
  }
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function runCommand(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(new Error(`${command} ${args.join(" ")} failed (${String(code)}): ${stderr || stdout}`));
      }
    });
  });
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}
