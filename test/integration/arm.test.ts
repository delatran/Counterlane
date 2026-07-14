import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { GitRepository } from "../../src/git/repository.js";
import { Logger } from "../../src/core/logger.js";
import { CodexAppServer } from "../../src/codex/app-server.js";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { SingleRunner } from "../../src/runner/single.js";
import { createTestRepository, git, mockAppServerPath, normalizeGitText, testConfig } from "../helpers.js";

void test("SingleRunner rejects an orphan lastTurnId before execution", async () => {
  const root = await createTestRepository();
  const config = testConfig();
  const repository = await GitRepository.discover(root);
  await assert.rejects(
    new SingleRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({ prompt: "noop", mode: "auto", lastTurnId: "orphan-turn" }),
    /lastTurnId requires parentThreadId/u,
  );
});

void test("a server-cancelled turn is recorded as cancelled rather than failure", async () => {
  const root = await createTestRepository();
  const wrapperDirectory = await mkdtemp(join(tmpdir(), "counterlane-cancelled-turn-"));
  const wrapper = join(wrapperDirectory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_CANCEL_TURN = "1";\nawait import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [wrapper] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const result = await new SingleRunner({
    repository,
    config,
    telemetry: new TelemetryStore(root, config),
    logger: new Logger({ level: "error", json: false }),
  }).run({
    prompt: "Replace the exact typo in answer.txt with correct and run the existing test.",
    mode: "auto",
  });

  assert.equal(result.arm.turn.status, "cancelled");
  assert.equal(result.arm.outcome, "cancelled");
  assert.equal(result.arm.successful, false);
});

void test("SingleRunner static mode cannot bypass the critical-task safety floor", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    routing: {
      ...base.routing,
      static: { family: "luna", effort: "high", speed: "standard" },
    },
    twin: { ...base.twin, preserveWorktrees: "never" },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);

  await assert.rejects(
    new SingleRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Fix a production OAuth authorization bypass and verify every permission boundary.",
      mode: "static",
    }),
    /static policy violates current task safety or quota gates/u,
  );
});

void test("an in-repository worktree base is excluded from source-state parity", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: {
      ...base.twin,
      preserveWorktrees: "never",
      worktreeBaseDirectory: ".worktrees",
    },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true, minimumTier: "basic" }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const result = await new SingleRunner({
    repository,
    config,
    telemetry: new TelemetryStore(root, config),
    logger: new Logger({ level: "error", json: false }),
  }).run({
    prompt: "Replace the exact typo in answer.txt with correct and run the existing test.",
    mode: "auto",
    constraints: { modelFamily: "terra", effort: "medium", speedId: "standard", proofTier: "basic" },
  });

  assert.equal(result.arm.successful, true);
  assert.equal(result.originalStateUnchanged, true);
});

void test("apply-requested failures remain non-applying evidence with real usage and cost", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [
        {
          name: "missing-verifier",
          command: ["__counterlane_command_that_must_not_exist__"],
          required: true,
          minimumTier: "basic",
        },
      ],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const result = await new SingleRunner({
    repository,
    config,
    telemetry: new TelemetryStore(root, config),
    logger: new Logger({ level: "error", json: false }),
  }).run({
    prompt: "Replace answer.txt with correct.",
    mode: "auto",
    apply: true,
    constraints: { modelFamily: "terra", effort: "medium", proofTier: "basic" },
  });

  assert.equal(result.arm.successful, false);
  assert.equal(result.arm.outcome, "failure");
  assert.equal(result.applied, false);
  assert.ok(result.arm.utility < 0, "post-turn processing failures must not earn verified-success utility");
  assert.ok((result.arm.turn.tokenUsage?.last.totalTokens ?? 0) > 0, "real usage must survive post-turn failure");
  assert.ok(result.arm.cost.normalizedCredits > 0, "failed work must never look free");
  assert.match(result.arm.error?.["message"] as string, /ENOENT|not found|spawn/iu);
});

void test("SingleRunner verifies the applied original checkout and rolls back on ignored local-state failure", async () => {
  const root = await createTestRepository();
  await Promise.all([
    writeFile(join(root, ".gitignore"), "poison.flag\n", "utf8"),
    writeFile(join(root, "poison.flag"), "original-only\n", "utf8"),
    writeFile(
      join(root, "original.test.mjs"),
      `import { access, readFile } from "node:fs/promises";\n` +
        `try { await access(new URL("./poison.flag", import.meta.url)); process.exit(9); } catch {}\n` +
        `if (await readFile(new URL("./answer.txt", import.meta.url), "utf8") !== "correct\\n") process.exit(8);\n`,
      "utf8",
    ),
  ]);
  await git(root, ["add", ".gitignore", "original.test.mjs"]);
  await git(root, ["-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid", "commit", "-qm", "verifier"]);
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "original-local-state", command: [process.execPath, "original.test.mjs"], required: true, minimumTier: "basic" }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  await assert.rejects(
    new SingleRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Replace answer.txt with correct.",
      mode: "auto",
      apply: true,
      constraints: { modelFamily: "terra", effort: "medium", speedId: "standard", proofTier: "basic" },
    }),
    /Post-application verification failed; the applied patch was rolled back/u,
  );
  assert.equal(normalizeGitText(await readFile(join(root, "answer.txt"), "utf8")), "wrong\n");
  await access(join(root, "poison.flag"));
});

void test("post-apply verifier mutations are restored before the winner patch is rolled back", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const verifier = [
    "const fs=require('node:fs');",
    "if(fs.statSync('.git').isDirectory()) fs.writeFileSync('src.ts','export const value = 999;\\n');",
    "if(fs.readFileSync('answer.txt','utf8')!=='correct\\n') process.exit(8);",
  ].join("");
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "original-mutator", command: [process.execPath, "-e", verifier], required: true, minimumTier: "basic" }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  await assert.rejects(
    new SingleRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Replace answer.txt with correct.",
      mode: "auto",
      apply: true,
      constraints: { modelFamily: "terra", effort: "medium", speedId: "standard", proofTier: "basic" },
    }),
    /Post-application verification failed; the applied patch was rolled back/u,
  );
  assert.equal(normalizeGitText(await readFile(join(root, "answer.txt"), "utf8")), "wrong\n");
  assert.equal(normalizeGitText(await readFile(join(root, "src.ts"), "utf8")), "export const value = 1;\n");
});

void test("a passing verifier cannot mutate files outside the certified candidate patch", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{
        name: "mutating-verifier",
        command: [process.execPath, "-e", "require('node:fs').writeFileSync('verifier-leak.txt','leak\\n')"],
        required: true,
        minimumTier: "basic",
      }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const result = await new SingleRunner({
    repository,
    config,
    telemetry: new TelemetryStore(root, config),
    logger: new Logger({ level: "error", json: false }),
  }).run({
    prompt: "Replace answer.txt with correct.",
    mode: "auto",
    apply: true,
    constraints: { modelFamily: "terra", effort: "medium", proofTier: "basic" },
  });
  assert.equal(result.arm.successful, false);
  assert.equal(result.arm.outcome, "failure");
  assert.equal(result.applied, false);
  assert.ok(result.arm.utility < 0, "verifier-mutation failures must not earn verified-success utility");
  assert.match(String(result.arm.error?.["message"]), /Verifier commands mutated/u);
  assert.doesNotMatch(result.arm.patch, /verifier-leak/u);
});

void test("post-commit telemetry failure cannot turn a durable apply into a reported run failure", async () => {
  const root = await createTestRepository();
  await mkdir(join(root, ".counterlane", "blocked-telemetry"), { recursive: true });
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{
        name: "fixture",
        command: [process.execPath, "answer.test.mjs"],
        required: true,
        minimumTier: "basic",
      }],
    },
    telemetry: {
      ...base.telemetry,
      enabled: true,
      allowHostLedgerLearning: false,
      file: "blocked-telemetry",
    },
  });
  const repository = await GitRepository.discover(root);
  const result = await new SingleRunner({
    repository,
    config,
    telemetry: new TelemetryStore(root, config),
    logger: new Logger({ level: "error", json: false }),
  }).run({
    prompt: "Replace answer.txt with correct.",
    mode: "auto",
    apply: true,
    constraints: { modelFamily: "terra", effort: "medium", speedId: "standard", proofTier: "basic" },
  });

  assert.equal(result.applied, true);
  assert.equal(normalizeGitText(await readFile(join(root, "answer.txt"), "utf8")), "correct\n");
  assert.match(result.bookkeepingWarnings?.join("\n") ?? "", /telemetry/iu);
  const persisted = JSON.parse(await readFile(join(result.artifactDirectory, "result.json"), "utf8")) as { applied?: boolean };
  assert.equal(persisted.applied, true);
});

void test("post-commit cleanup warnings are returned and persisted without undoing a durable apply", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{
        name: "fixture",
        command: [process.execPath, "answer.test.mjs"],
        required: true,
        minimumTier: "basic",
      }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const originalDeleteThread = CodexAppServer.prototype.deleteThread;
  CodexAppServer.prototype.deleteThread = async function (threadId): Promise<void> {
    await originalDeleteThread.call(this, threadId);
    throw new Error("simulated post-commit thread cleanup failure");
  };

  try {
    const result = await new SingleRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Replace answer.txt with correct.",
      mode: "auto",
      apply: true,
      constraints: { modelFamily: "terra", effort: "medium", speedId: "standard", proofTier: "basic" },
    });

    assert.equal(result.applied, true);
    assert.equal(normalizeGitText(await readFile(join(root, "answer.txt"), "utf8")), "correct\n");
    assert.match(result.bookkeepingWarnings?.join("\n") ?? "", /cleanup failure/iu);
    const persisted = JSON.parse(await readFile(join(result.artifactDirectory, "result.json"), "utf8")) as {
      applied?: boolean;
      bookkeepingWarnings?: string[];
    };
    assert.equal(persisted.applied, true);
    assert.match(persisted.bookkeepingWarnings?.join("\n") ?? "", /cleanup failure/iu);
  } finally {
    CodexAppServer.prototype.deleteThread = originalDeleteThread;
  }
});

void test("post-run cleanup warnings preserve an isolated non-applying result", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{
        name: "fixture",
        command: [process.execPath, "answer.test.mjs"],
        required: true,
        minimumTier: "basic",
      }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const originalDeleteThread = CodexAppServer.prototype.deleteThread;
  CodexAppServer.prototype.deleteThread = async function (threadId): Promise<void> {
    await originalDeleteThread.call(this, threadId);
    throw new Error("simulated isolated cleanup failure");
  };

  try {
    const result = await new SingleRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Replace answer.txt with correct.",
      mode: "auto",
      apply: false,
      constraints: { modelFamily: "terra", effort: "medium", speedId: "standard", proofTier: "basic" },
    });

    assert.equal(result.applied, false);
    assert.equal(result.originalStateUnchanged, true);
    assert.match(result.bookkeepingWarnings?.join("\n") ?? "", /isolated cleanup failure/iu);
    assert.equal(normalizeGitText(await readFile(join(root, "answer.txt"), "utf8")), "wrong\n");
    const persisted = JSON.parse(await readFile(join(result.artifactDirectory, "result.json"), "utf8")) as {
      applied?: boolean;
      bookkeepingWarnings?: string[];
    };
    assert.equal(persisted.applied, false);
    assert.match(persisted.bookkeepingWarnings?.join("\n") ?? "", /isolated cleanup failure/iu);
  } finally {
    CodexAppServer.prototype.deleteThread = originalDeleteThread;
  }
});

void test("a backend model reroute is noncompliant and cannot enter route calibration", async () => {
  const root = await createTestRepository();
  const wrapperDirectory = await mkdtemp(join(tmpdir(), "counterlane-rerouted-arm-"));
  const wrapper = join(wrapperDirectory, "mock-wrapper.mjs");
  await writeFile(
    wrapper,
    `process.env.MOCK_REROUTE_TO_MODEL = "gpt-5.6-luna";\n` +
      `await import(${JSON.stringify(pathToFileURL(mockAppServerPath).href)});\n`,
    "utf8",
  );
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [wrapper] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{
        name: "fixture",
        command: [process.execPath, "answer.test.mjs"],
        required: true,
        minimumTier: "basic",
      }],
    },
    telemetry: { ...base.telemetry, enabled: true, includePrompt: false },
  });
  const repository = await GitRepository.discover(root);
  const telemetry = new TelemetryStore(root, config);
  const result = await new SingleRunner({
    repository,
    config,
    telemetry,
    logger: new Logger({ level: "error", json: false }),
  }).run({
    prompt: "Replace answer.txt with correct.",
    mode: "auto",
    constraints: { modelFamily: "terra", effort: "medium", speedId: "standard", proofTier: "basic" },
  });

  assert.equal(result.arm.successful, false);
  assert.equal(result.arm.outcome, "failure");
  assert.equal(result.arm.turn.reroutes.length, 1);
  assert.match(String(result.arm.error?.["message"]), /rerouted.*noncompliant/iu);
  const events = await telemetry.readAll();
  assert.equal(events.some((event) => event.type === "route.observed"), false);
  assert.equal(events.find((event) => event.type === "run.completed")?.payload["routeCompliant"], false);
});
