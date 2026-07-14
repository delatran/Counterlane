import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { httpToolContext, runMcpHttpServer } from "../../src/mcp/server.js";
import {
  callCounterlaneTool,
  MCP_TRUSTED_CODEX_ARGS_ENV,
  MCP_TRUSTED_CODEX_COMMAND_ENV,
  MCP_TRUSTED_VERIFICATION_FILE_ENV,
} from "../../src/mcp/tools.js";
import { createTestRepository, git, mockAppServerPath, testConfig } from "../helpers.js";

void test("remote MCP tool policy blocks repository paths outside allowed roots", async () => {
  const allowed = await mkdtemp(join(tmpdir(), "counterlane-allowed-"));
  const outside = await mkdtemp(join(tmpdir(), "counterlane-outside-"));
  const result = await callCounterlaneTool(
    "counterlane_models",
    { cwd: outside },
    { allowedRoots: [allowed], allowConfigOverride: false },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /outside.*allowed repository roots/iu);
});

void test("remote MCP policy rejects per-request configuration overrides", async () => {
  const allowed = await mkdtemp(join(tmpdir(), "counterlane-config-policy-"));
  const config = join(allowed, "counterlane.config.json");
  await writeFile(config, "{}\n", "utf8");
  const result = await callCounterlaneTool(
    "counterlane_models",
    { cwd: allowed, config },
    { allowedRoots: [allowed], allowConfigOverride: false },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /configuration overrides are disabled/iu);
});

void test("implicit config discovery cannot escape remote MCP allowed roots", async () => {
  const outer = await mkdtemp(join(tmpdir(), "counterlane-config-ancestor-"));
  const allowed = join(outer, "allowed");
  const repository = join(allowed, "repository");
  await mkdir(repository, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: repository, stdio: "pipe" });
  await writeFile(join(outer, "counterlane.config.json"), "{}\n", "utf8");

  const result = await callCounterlaneTool(
    "counterlane_models",
    { cwd: repository },
    { allowedRoots: [allowed], allowConfigOverride: false },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /resolved config.*outside.*allowed repository roots/iu);
});

void test("MCP execution rejects lastTurnId without threadId before opening a workspace", async () => {
  const result = await callCounterlaneTool(
    "counterlane_execute",
    { prompt: "Continue the prior task.", lastTurnId: "orphan-turn" },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /lastTurnId requires threadId/u);
});

void test("counterlane_execute returns configuration_required before any model turn without a trusted task verifier", async () => {
  const repository = await createTestRepository({ verifier: false });
  const logDirectory = await mkdtemp(join(tmpdir(), "counterlane-mcp-execute-preflight-"));
  const requestLog = join(logDirectory, "requests.jsonl");
  const previousLog = process.env["MOCK_REQUEST_LOG"];
  process.env["MOCK_REQUEST_LOG"] = requestLog;
  try {
    const result = await callCounterlaneTool(
      "counterlane_execute",
      { cwd: repository, prompt: "Correct the fixture answer exactly." },
      { trustedCodexLaunch: { command: process.execPath, args: [mockAppServerPath] } },
    );
    assert.equal(result.isError, undefined, result.content[0]?.text);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured["state"], "configuration_required");
    assert.equal(structured["modelTurnStarted"], false);
    assert.equal(structured["reservedAttempts"], 0);
    assert.equal(structured["spentAttempts"], 0);
    const requests = await readFile(requestLog, "utf8");
    assert.match(requests, /"method":"model\/list"/u);
    assert.doesNotMatch(requests, /"method":"thread\/(?:start|fork)"|"method":"turn\/start"/u);
  } finally {
    restoreEnvironment("MOCK_REQUEST_LOG", previousLog);
  }
});

void test("counterlane_execute uses one bounded product attempt and never acquires a Twin", async () => {
  const repository = await createTestRepository({ verifier: false });
  const logDirectory = await mkdtemp(join(tmpdir(), "counterlane-mcp-product-execute-"));
  const requestLog = join(logDirectory, "requests.jsonl");
  const hostVerifier = join(logDirectory, "host-task-contract.mjs");
  const previousLog = process.env["MOCK_REQUEST_LOG"];
  process.env["MOCK_REQUEST_LOG"] = requestLog;
  const base = testConfig().verification;
  try {
    await writeFile(
      hostVerifier,
      "import { readFileSync } from 'node:fs'; process.exit(readFileSync('answer.txt', 'utf8') === 'correct\\n' ? 0 : 1);\n",
      "utf8",
    );
    const result = await callCounterlaneTool(
      "counterlane_execute",
      {
        cwd: repository,
        prompt: "Correct the fixture answer exactly.",
        speedMode: "off",
        executionContext: "foreground",
      },
      {
        trustedCodexLaunch: { command: process.execPath, args: [mockAppServerPath] },
        evidenceKind: "simulated",
        trustedVerification: {
          ...base,
          autoDetect: false,
          commands: [{
            name: "host-task-contract",
            command: [process.execPath, hostVerifier],
            required: true,
            taskSpecific: true,
            candidateCodePolicy: "data-only",
            minimumTier: "standard",
          }],
        },
      },
    );
    assert.equal(result.isError, undefined, result.content[0]?.text);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured["state"], "verified", JSON.stringify(structured));
    assert.equal(structured["modelTurnStarted"], true);
    assert.equal(structured["maxExpensiveTurns"], 2);
    assert.equal(structured["reservedAttempts"], 1);
    assert.equal(structured["spentAttempts"], 1);
    assert.equal(structured["unknownAttempts"], 0);
    const receipt = structured["receipt"] as Record<string, unknown>;
    const attempts = receipt["attempts"] as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 1);
    const verification = attempts[0]?.["verification"] as Record<string, unknown>;
    assert.equal(verification["integrity"], "intact");
    assert.equal((verification["containment"] as Record<string, unknown>)["environment"], "minimal-allowlist");
    assert.equal((verification["containment"] as Record<string, unknown>)["network"], "unverified");
    assert.equal((receipt["evidence"] as Record<string, unknown>)["kind"], "simulated");
    const receiptArtifacts = structured["receiptArtifacts"] as Record<string, unknown>;
    const runId = String(receiptArtifacts["runId"]);
    const persistedReceipt = await readFile(join(repository, ".counterlane", "receipts", `${runId}.json`), "utf8");
    const persistedPublicReceipt = await readFile(join(repository, ".counterlane", "receipts", `${runId}.public.json`), "utf8");
    assert.match(persistedReceipt, /"receiptHash"/u);
    assert.match(persistedPublicReceipt, /"publicReceiptHash"/u);
    assert.equal(receiptArtifacts["localReceiptHash"], (receipt["receiptHash"] as string));
    const requests = await readFile(requestLog, "utf8");
    assert.equal((requests.match(/"method":"thread\/start"/gu) ?? []).length, 1);
    assert.equal((requests.match(/"method":"turn\/start"/gu) ?? []).length, 1);
    assert.doesNotMatch(requests, /"method":"thread\/fork"/u);
  } finally {
    restoreEnvironment("MOCK_REQUEST_LOG", previousLog);
  }
});

void test("MCP decide propagates cancellation into its meta-plan App Server calls", async () => {
  const repository = await createTestRepository({ verifier: false });
  const logDirectory = await mkdtemp(join(tmpdir(), "counterlane-mcp-decide-cancel-"));
  const requestLog = join(logDirectory, "requests.jsonl");
  const previousLog = process.env["MOCK_REQUEST_LOG"];
  const previousDelay = process.env["MOCK_MODEL_LIST_DELAY_MS"];
  process.env["MOCK_REQUEST_LOG"] = requestLog;
  process.env["MOCK_MODEL_LIST_DELAY_MS"] = "30000";
  const controller = new AbortController();
  try {
    const pending = callCounterlaneTool(
      "counterlane_decide",
      { cwd: repository, prompt: "Inspect this task." },
      {
        trustedCodexLaunch: { command: process.execPath, args: [mockAppServerPath] },
        signal: controller.signal,
      },
    );
    await waitForRequest(requestLog, "model/list");
    const reason = new Error("cancelled MCP decide regression");
    reason.name = "AbortError";
    controller.abort(reason);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /cancelled MCP decide regression/u);
  } finally {
    restoreEnvironment("MOCK_REQUEST_LOG", previousLog);
    restoreEnvironment("MOCK_MODEL_LIST_DELAY_MS", previousDelay);
  }
});

void test("repository configuration cannot replace the host-owned Codex launcher", async () => {
  const repository = await createTestRepository({ verifier: false });
  const marker = join(repository, "untrusted-launch.marker");
  const payload = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.exit(1);`;
  await writeFile(join(repository, "counterlane.config.json"), `${JSON.stringify({
    codex: { command: process.execPath, args: ["-e", payload] },
  })}\n`, "utf8");

  const previousCommand = process.env[MCP_TRUSTED_CODEX_COMMAND_ENV];
  const previousArgs = process.env[MCP_TRUSTED_CODEX_ARGS_ENV];
  process.env[MCP_TRUSTED_CODEX_COMMAND_ENV] = process.execPath;
  process.env[MCP_TRUSTED_CODEX_ARGS_ENV] = JSON.stringify([mockAppServerPath]);
  try {
    const result = await callCounterlaneTool(
      "counterlane_models",
      { cwd: repository },
      { allowConfigOverride: false },
    );
    assert.equal(result.isError, undefined, result.content[0]?.text);
    await assert.rejects(access(marker), (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
    );
  } finally {
    restoreEnvironment(MCP_TRUSTED_CODEX_COMMAND_ENV, previousCommand);
    restoreEnvironment(MCP_TRUSTED_CODEX_ARGS_ENV, previousArgs);
  }
});

void test("MCP ignores repository-controlled explicit and auto-detected verifiers", async () => {
  const repository = await createTestRepository({ verifier: false });
  const markerDirectory = await mkdtemp(join(tmpdir(), "counterlane-mcp-verifier-boundary-"));
  const explicitMarker = join(markerDirectory, "explicit.marker");
  const detectedMarker = join(markerDirectory, "detected.marker");
  const explicitPayload = `require('node:fs').writeFileSync(${JSON.stringify(explicitMarker)}, 'spawned')`;
  const detectedPayload = `require('node:fs').writeFileSync(${JSON.stringify(detectedMarker)}, 'spawned')`;
  await writeFile(
    join(repository, "package.json"),
    `${JSON.stringify({
      name: "untrusted-fixture",
      private: true,
      scripts: { test: `node -e ${JSON.stringify(detectedPayload)}` },
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(repository, "counterlane.config.json"),
    `${JSON.stringify({
      verification: {
        autoDetect: true,
        commands: [{
          name: "repo-controlled-verifier",
          command: [process.execPath, "-e", explicitPayload],
          required: true,
          minimumTier: "adversarial",
        }],
      },
    }, null, 2)}\n`,
    "utf8",
  );
  await git(repository, ["add", "package.json", "counterlane.config.json"]);
  await git(repository, [
    "-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid",
    "commit", "-qm", "untrusted verifier fixture",
  ]);
  const context = {
    trustedCodexLaunch: { command: process.execPath, args: [mockAppServerPath] },
  };

  const routed = await callCounterlaneTool(
    "counterlane_route",
    { cwd: repository, prompt: "Correct the fixture answer exactly." },
    context,
  );
  assert.equal(routed.isError, undefined, routed.content[0]?.text);
  const routeVerification = routed.structuredContent?.["verification"] as Record<string, unknown>;
  assert.equal(routeVerification["posture"], "no-verifier");
  assert.deepEqual(routeVerification["availableTiers"], ["basic"]);
  assert.equal(routeVerification["selectedCommandCount"], 0);

  const strong = await callCounterlaneTool(
    "counterlane_route",
    { cwd: repository, prompt: "Correct the fixture answer exactly.", proofTier: "strong" },
    context,
  );
  assert.equal(strong.isError, true);
  assert.match(strong.content[0]?.text ?? "", /proof tier strong is unavailable/iu);

  const executed = await callCounterlaneTool(
    "counterlane_run",
    { cwd: repository, prompt: "Correct the fixture answer exactly.", mode: "auto" },
    context,
  );
  assert.equal(executed.isError, undefined, executed.content[0]?.text);
  assert.equal(executed.structuredContent?.["successful"], false);
  assert.notEqual(executed.structuredContent?.["outcome"], "success");
  const verification = executed.structuredContent?.["verification"] as Record<string, unknown>;
  assert.equal(verification["posture"], "no-verifier");
  assert.equal(verification["checkCount"], 0);
  assert.equal(verification["verified"], false);
  assert.equal(verification["passed"], false);
  assert.equal(verification["adequate"], false);
  assert.equal(verification["proofTier"], "basic");
  assert.equal(verification["score"], 0);
  assert.equal(verification["requiredTotal"], 0);
  await assert.rejects(access(explicitMarker), isMissingPath);
  await assert.rejects(access(detectedMarker), isMissingPath);
});

void test("MCP accepts a standard verifier only from an absolute host-owned policy file", async () => {
  const repository = await createTestRepository({ verifier: false });
  const policyDirectory = await mkdtemp(join(tmpdir(), "counterlane-mcp-host-policy-"));
  const policyPath = join(policyDirectory, "counterlane.config.json");
  const hostVerifier = join(policyDirectory, "host-standard.mjs");
  await writeFile(
    hostVerifier,
    "import { readFileSync } from 'node:fs'; process.exit(readFileSync('answer.txt', 'utf8') === 'correct\\n' ? 0 : 1);\n",
    "utf8",
  );
  await writeFile(policyPath, `${JSON.stringify({
    verification: {
      autoDetect: false,
      commands: [{
        name: "host-standard",
        command: [process.execPath, hostVerifier],
        required: true,
        taskSpecific: true,
        candidateCodePolicy: "data-only",
        minimumTier: "standard",
      }],
    },
  })}\n`, "utf8");
  const previous = process.env[MCP_TRUSTED_VERIFICATION_FILE_ENV];
  process.env[MCP_TRUSTED_VERIFICATION_FILE_ENV] = policyPath;
  try {
    const result = await callCounterlaneTool(
      "counterlane_route",
      { cwd: repository, prompt: "Correct the fixture answer exactly.", proofTier: "standard" },
      { trustedCodexLaunch: { command: process.execPath, args: [mockAppServerPath] } },
    );
    assert.equal(result.isError, undefined, result.content[0]?.text);
    const verification = result.structuredContent?.["verification"] as Record<string, unknown>;
    assert.deepEqual(verification["availableTiers"], ["standard"]);
    assert.equal(verification["selectedCommandCount"], 1);
    assert.equal(verification["selectedTaskSpecificCommandCount"], 1);
    assert.equal(verification["taskSpecificRequired"], true);
    assert.equal(verification["coverage"], "task-specific-declared");
    assert.equal(verification["hostVerification"], "not-run");
    assert.equal(verification["externalAdjudication"], "not-performed");

    const executed = await callCounterlaneTool(
      "counterlane_run",
      { cwd: repository, prompt: "Correct the fixture answer exactly.", mode: "auto" },
      { trustedCodexLaunch: { command: process.execPath, args: [mockAppServerPath] } },
    );
    assert.equal(executed.isError, undefined, executed.content[0]?.text);
    assert.equal(executed.structuredContent?.["successful"], true);
    const executedVerification = executed.structuredContent?.["verification"] as Record<string, unknown>;
    assert.equal(executedVerification["hostVerified"], true);
    assert.equal(executedVerification["verified"], true, "legacy alias remains host-scoped");
    assert.equal(executedVerification["taskSpecificPassed"], 1);
    assert.equal(executedVerification["taskSpecificTotal"], 1);
    assert.equal(executedVerification["externalAdjudication"], "not-performed");
  } finally {
    restoreEnvironment(MCP_TRUSTED_VERIFICATION_FILE_ENV, previous);
  }
});

void test("MCP refuses proof credit when a host verifier lacks task-specific coverage", async () => {
  const repository = await createTestRepository({ verifier: false });
  const policyDirectory = await mkdtemp(join(tmpdir(), "counterlane-mcp-generic-policy-"));
  const policyPath = join(policyDirectory, "counterlane.config.json");
  await writeFile(policyPath, `${JSON.stringify({
    verification: {
      autoDetect: false,
      commands: [{
        name: "generic-repository-check",
        command: [process.execPath, "--version"],
        required: true,
        minimumTier: "standard",
      }],
    },
  })}\n`, "utf8");
  const previous = process.env[MCP_TRUSTED_VERIFICATION_FILE_ENV];
  process.env[MCP_TRUSTED_VERIFICATION_FILE_ENV] = policyPath;
  try {
    const result = await callCounterlaneTool(
      "counterlane_route",
      { cwd: repository, prompt: "Correct the fixture answer exactly.", proofTier: "standard" },
      { trustedCodexLaunch: { command: process.execPath, args: [mockAppServerPath] } },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /proof tier standard is unavailable/iu);
  } finally {
    restoreEnvironment(MCP_TRUSTED_VERIFICATION_FILE_ENV, previous);
  }
});

void test("MCP rejects a relative trusted verifier policy path", async () => {
  const repository = await createTestRepository({ verifier: false });
  const previous = process.env[MCP_TRUSTED_VERIFICATION_FILE_ENV];
  process.env[MCP_TRUSTED_VERIFICATION_FILE_ENV] = "counterlane.config.json";
  try {
    const result = await callCounterlaneTool(
      "counterlane_route",
      { cwd: repository, prompt: "Correct the fixture answer exactly." },
      { trustedCodexLaunch: { command: process.execPath, args: [mockAppServerPath] } },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /must be an absolute host-owned config path/iu);
  } finally {
    restoreEnvironment(MCP_TRUSTED_VERIFICATION_FILE_ENV, previous);
  }
});

void test("loopback HTTP does not enable configuration overrides without explicit opt-in", () => {
  assert.equal(httpToolContext({ host: "127.0.0.1", port: 8787, path: "/mcp" }).allowConfigOverride, false);
  assert.equal(httpToolContext({
    host: "127.0.0.1",
    port: 8787,
    path: "/mcp",
    allowConfigOverride: true,
  }).allowConfigOverride, true);
});

void test("an allowed subdirectory cannot make MCP ascend into an out-of-scope repository", async () => {
  const repository = await mkdtemp(join(tmpdir(), "counterlane-parent-repo-"));
  const allowed = join(repository, "allowed-child");
  await mkdir(allowed);
  execFileSync("git", ["init", "--quiet"], { cwd: repository, stdio: "pipe" });

  const result = await callCounterlaneTool(
    "counterlane_route",
    { cwd: allowed, prompt: "Inspect this repository." },
    { allowedRoots: [allowed], allowConfigOverride: false },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /repository root.*outside.*allowed repository roots/iu);
});

void test("non-loopback HTTP MCP fails closed without token and repository boundaries", async () => {
  await assert.rejects(
    runMcpHttpServer({ host: "0.0.0.0", port: 1, path: "/mcp" }),
    /requires a bearer token/iu,
  );
  await assert.rejects(
    runMcpHttpServer({
      host: "0.0.0.0",
      port: 1,
      path: "/mcp",
      bearerToken: "0123456789abcdef",
    }),
    /requires at least one --allow-root/iu,
  );
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitForRequest(path: string, method: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).includes(`"method":"${method}"`)) return;
    } catch {
      // The request log is created lazily by the mock App Server.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for mock App Server request ${method}`);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
