import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitRepository } from "../../src/git/repository.js";
import { Logger } from "../../src/core/logger.js";
import { CodexAppServer } from "../../src/codex/app-server.js";
import { writeExperimentArtifacts } from "../../src/report/certificate.js";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { TwinRunner } from "../../src/runner/twin.js";
import { WorktreeManager } from "../../src/git/worktree.js";
import type { JsonObject } from "../../src/core/json.js";
import { createTestRepository, git, mockAppServerPath, normalizeGitText, testConfig } from "../helpers.js";

void test("TwinRunner cannot execute an unsafe configured static control", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    routing: {
      ...base.routing,
      static: { family: "luna", effort: "high", speed: "standard" },
      minimumQuality: { ...base.routing.minimumQuality, critical: 0.9 },
    },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [
        { name: "critical-strong-1", command: [process.execPath, "answer.test.mjs"], required: true, minimumTier: "strong" },
        { name: "critical-strong-2", command: [process.execPath, "--check", "answer.test.mjs"], required: true, minimumTier: "strong" },
      ],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);

  await assert.rejects(
    new TwinRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Fix a production OAuth authorization bypass and verify every permission boundary.",
    }),
    /static policy violates current task safety or quota gates/u,
  );
});

void test("TwinRunner deletes every fulfilled delayed thread when its paired start or fork fails", async () => {
  await assertDelayedThreadCleanup("start");
  await assertDelayedThreadCleanup("fork");
});

void test("TwinRunner still removes worktrees when ephemeral thread deletion rejects", async () => {
  await assertDelayedThreadCleanup("start", true);
});

void test("TwinRunner preserves worktrees when abort-ignoring arms cannot be contained", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: {
      ...base.codex,
      command: process.execPath,
      args: [mockAppServerPath],
      shutdownTimeoutMs: 100,
    },
    twin: {
      ...base.twin,
      maximumDurationMs: 3_000,
      preserveWorktrees: "never",
      worktreeBaseDirectory: ".worktrees",
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const turnsStarted = deferredSignal();
  const releaseTurns = deferredSignal();
  const capturesCompleted = deferredSignal();
  let turnCount = 0;
  let captureCount = 0;
  const originalRunTurn = CodexAppServer.prototype.runTurn;
  const originalCapturePatch = WorktreeManager.prototype.capturePatch;

  CodexAppServer.prototype.runTurn = async function (): Promise<never> {
    turnCount += 1;
    if (turnCount === 2) turnsStarted.resolve();
    await releaseTurns.promise;
    throw new Error("released abort-ignoring turn");
  };
  WorktreeManager.prototype.capturePatch = async function (handle) {
    try {
      return await originalCapturePatch.call(this, handle);
    } finally {
      captureCount += 1;
      if (captureCount === 2) capturesCompleted.resolve();
    }
  };

  try {
    const execution = new TwinRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({ prompt: "Run an abort-ignoring paired task." });
    await turnsStarted.promise;
    await assert.rejects(
      execution,
      /Twin arms remained live after cancellation containment; preserving isolated worktrees/u,
    );
    const registered = await repository.git(["worktree", "list", "--porcelain"]);
    assert.equal((registered.match(/^worktree /gmu) ?? []).length, 3);
  } finally {
    releaseTurns.resolve();
    await capturesCompleted.promise;
    CodexAppServer.prototype.runTurn = originalRunTurn;
    WorktreeManager.prototype.capturePatch = originalCapturePatch;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const registered = await repository.git(["worktree", "list", "--porcelain"]);
    for (const line of registered.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice("worktree ".length);
      if (normalizePathText(path) === normalizePathText(repository.root)) continue;
      await repository.git(["worktree", "remove", "--force", path]);
    }
    await repository.git(["worktree", "prune"]);
    await rm(join(root, ".worktrees"), { recursive: true, force: true });
  }
});

void test("TwinRunner evaluates the same task in isolated arms and selects the cheaper verified route", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, execution: "parallel", preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: true, includePrompt: false },
  });
  const repository = await GitRepository.discover(root);
  const telemetry = new TelemetryStore(root, config);
  const runner = new TwinRunner({
    repository,
    config,
    telemetry,
    logger: new Logger({ level: "error", json: false }),
  });

  const result = await runner.run({
    prompt: "Replace the exact typo in answer.txt with correct and run the existing test.",
  });
  assert.equal(result.control.successful, true);
  assert.equal(result.treatment.successful, true);
  assert.equal(result.winner.winner, "treatment");
  assert.ok(result.treatment.cost.normalizedCredits < result.control.cost.normalizedCredits);
  assert.equal(result.originalStateUnchanged, true);
  assert.equal(result.appliedWinner, false);
  assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "wrong\n");
  const certificate = await readFile(result.certificatePath, "utf8");
  assert.match(certificate, /Counterlane experiment certificate/u);
  assert.match(certificate, /Total tokens/u);
  const taintedResult = {
    ...result,
    winner: {
      ...result.winner,
      reason: "unsafe\u0000reason \u001B[31mred\u001B[0m",
    },
    treatment: {
      ...result.treatment,
      policy: {
        ...result.treatment.policy,
        modelId: "gpt-\u001B[31mred\u001B[0m\u0085tail",
      },
      turn: {
        ...result.treatment.turn,
        warnings: ["warning\u001B]0;owned\u0007safe"],
      },
    },
  };
  await writeExperimentArtifacts(taintedResult, config);
  const sanitizedCertificate = await readFile(result.certificatePath, "utf8");
  assert.match(sanitizedCertificate, /unsafe reason red/u);
  assert.match(sanitizedCertificate, /gpt-red tail/u);
  assert.doesNotMatch(sanitizedCertificate, /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/u);
  assert.ok((await telemetry.readRecent(10)).some((event) => event.type === "experiment.completed"));
});

void test("TwinRunner refuses to certify a non-applying run after original source drift", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, execution: "parallel", preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const turnsStarted = deferredSignal();
  const releaseTurns = deferredSignal();
  const originalRunTurn = CodexAppServer.prototype.runTurn;
  let turnCount = 0;
  CodexAppServer.prototype.runTurn = async function (request) {
    turnCount += 1;
    if (turnCount === 2) turnsStarted.resolve();
    await releaseTurns.promise;
    return originalRunTurn.call(this, request);
  };

  try {
    const execution = new TwinRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({ prompt: "Replace the exact typo in answer.txt with correct and run the existing test." });
    await turnsStarted.promise;
    await writeFile(join(root, "src.ts"), "export const value = 77;\n", "utf8");
    releaseTurns.resolve();
    await assert.rejects(
      execution,
      /Original repository changed while the twin experiment was running; refusing to certify or apply/u,
    );
    assert.equal(await readFile(join(root, "src.ts"), "utf8"), "export const value = 77;\n");
  } finally {
    releaseTurns.resolve();
    CodexAppServer.prototype.runTurn = originalRunTurn;
  }
});

void test("TwinRunner can explicitly apply the uniquely verified winner", async () => {
  const root = await createTestRepository();
  await git(root, ["config", "core.autocrlf", "false"]);
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const result = await new TwinRunner({
    repository,
    config,
    telemetry: new TelemetryStore(root, config),
    logger: new Logger({ level: "error", json: false }),
  }).run({
    prompt: "Replace the exact typo in answer.txt with correct and run the test.",
    applyWinner: true,
  });
  assert.equal(result.appliedWinner, true);
  assert.equal(result.postApplyVerification?.passed, true);
  assert.equal(normalizeGitText(await readFile(join(root, "answer.txt"), "utf8")), "correct\n");
  assert.match(await readFile(result.certificatePath, "utf8"), /Post-apply verification: yes/u);
});

void test("TwinRunner restores truthful preliminary artifacts when the final applied artifact commit fails", async () => {
  const root = await createTestRepository();
  await git(root, ["config", "core.autocrlf", "false"]);
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  let artifactWrites = 0;
  let experimentId = "";
  const artifactWriter: typeof writeExperimentArtifacts = async (result, writerConfig) => {
    artifactWrites += 1;
    experimentId = result.experimentId;
    const path = await writeExperimentArtifacts(result, writerConfig);
    if (artifactWrites === 2) throw new Error("simulated final artifact commit failure");
    return path;
  };

  await assert.rejects(
    new TwinRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
      artifactWriter,
    }).run({
      prompt: "Replace the exact typo in answer.txt with correct and run the test.",
      applyWinner: true,
    }),
    /rolled back because its durable result artifact could not be committed/u,
  );

  assert.equal(artifactWrites, 3);
  assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "wrong\n");
  const artifactDirectory = join(root, ".counterlane", "experiments", experimentId);
  const persisted = JSON.parse(await readFile(join(artifactDirectory, "result.json"), "utf8")) as {
    appliedWinner?: boolean;
  };
  assert.equal(persisted.appliedWinner, false);
  assert.match(await readFile(join(artifactDirectory, "certificate.md"), "utf8"), /Winner applied: no/u);
});

void test("post-commit Twin telemetry failure cannot turn a durable winner apply into failure", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const telemetry = new CompletionFailingTelemetry(root, config);
  const result = await new TwinRunner({
    repository,
    config,
    telemetry,
    logger: new Logger({ level: "error", json: false }),
  }).run({
    prompt: "Replace the exact typo in answer.txt with correct and run the existing test.",
    applyWinner: true,
  });

  assert.equal(result.appliedWinner, true);
  assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "correct\n");
  assert.match(result.bookkeepingWarnings?.join("\n") ?? "", /telemetry/iu);
  const persisted = JSON.parse(await readFile(join(root, ".counterlane", "experiments", result.experimentId, "result.json"), "utf8")) as {
    appliedWinner?: boolean;
  };
  assert.equal(persisted.appliedWinner, true);
});

void test("post-commit Twin cleanup warnings are persisted without undoing a durable winner", async () => {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const originalDeleteThread = CodexAppServer.prototype.deleteThread;
  CodexAppServer.prototype.deleteThread = async function (threadId): Promise<void> {
    await originalDeleteThread.call(this, threadId);
    throw new Error("simulated post-commit Twin thread cleanup failure");
  };

  try {
    const result = await new TwinRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Replace the exact typo in answer.txt with correct and run the existing test.",
      applyWinner: true,
    });

    assert.equal(result.appliedWinner, true);
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "correct\n");
    assert.match(result.bookkeepingWarnings?.join("\n") ?? "", /cleanup failure/iu);
    const persisted = JSON.parse(await readFile(
      join(root, ".counterlane", "experiments", result.experimentId, "result.json"),
      "utf8",
    )) as { appliedWinner?: boolean; bookkeepingWarnings?: string[] };
    assert.equal(persisted.appliedWinner, true);
    assert.match(persisted.bookkeepingWarnings?.join("\n") ?? "", /cleanup failure/iu);
  } finally {
    CodexAppServer.prototype.deleteThread = originalDeleteThread;
  }
});

void test("TwinRunner restores the original index when a post-apply verifier stages user changes", async () => {
  const root = await createTestRepository({ dirty: true });
  const base = testConfig();
  const verifier = [
    "const fs=require('node:fs');",
    "const cp=require('node:child_process');",
    "if(fs.statSync('.git').isDirectory()) cp.execFileSync('git',['add','-A']);",
    "if(fs.readFileSync('answer.txt','utf8')!=='correct\\n') process.exit(8);",
  ].join("");
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "stage-original", command: [process.execPath, "-e", verifier], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const statusBefore = sourceStatus(await repository.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const indexTreeBefore = await repository.git(["write-tree"]);
  const [headBefore, branchBefore] = await Promise.all([
    repository.headCommit(),
    repository.branch(),
  ]);

  await assert.rejects(
    new TwinRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Replace the exact typo in answer.txt with correct and run the test.",
      applyWinner: true,
    }),
    (error: unknown) => {
      const nested = error instanceof AggregateError ? error.errors.map((item) => JSON.stringify(item)).join(" | ") : "";
      assert.match(
        String(error),
        /Post-application verification failed; the applied patch was rolled back/u,
        nested,
      );
      return true;
    },
  );

  const statusAfter = sourceStatus(await repository.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const indexTreeAfter = await repository.git(["write-tree"]);
  const [headAfter, branchAfter] = await Promise.all([
    repository.headCommit(),
    repository.branch(),
  ]);
  assert.equal(statusAfter, statusBefore);
  assert.equal(indexTreeAfter, indexTreeBefore);
  assert.equal(headAfter, headBefore);
  assert.equal(branchAfter, branchBefore);
  assert.equal(normalizeGitText(await readFile(join(root, "answer.txt"), "utf8")), "wrong\n");
});

void test(
  "TwinRunner rolls back an applied winner when the original checkout fails verification",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await createTestRepository();
    await git(root, ["config", "core.autocrlf", "true"]);
    await writeFile(join(root, "answer.txt"), "wrong\r\n", "utf8");
    const base = testConfig();
    const verifier = [
      "const fs=require('node:fs');",
      "if(fs.statSync('.git').isDirectory()) process.exit(7);",
      "if(fs.readFileSync('answer.txt','utf8')!=='correct\\n') process.exit(8);",
    ].join("");
    const config = testConfig({
      codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
      twin: { ...base.twin, preserveWorktrees: "never" },
      verification: {
        ...base.verification,
        autoDetect: false,
        commands: [{ name: "original-failure", command: [process.execPath, "-e", verifier], required: true }],
      },
      telemetry: { ...base.telemetry, enabled: false },
    });
    const repository = await GitRepository.discover(root);

    await assert.rejects(
      new TwinRunner({
        repository,
        config,
        telemetry: new TelemetryStore(root, config),
        logger: new Logger({ level: "error", json: false }),
      }).run({
        prompt: "Replace the exact typo in answer.txt with correct and run the test.",
        applyWinner: true,
      }),
      /Post-application verification failed; the applied patch was rolled back/u,
    );
    assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "wrong\r\n");
  },
);

void test("TwinRunner verifies the applied original checkout and rolls back when ignored local state fails", async () => {
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
      commands: [{ name: "original-local-state", command: [process.execPath, "original.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  await assert.rejects(
    new TwinRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Replace the exact typo in answer.txt with correct and run the test.",
      applyWinner: true,
    }),
    /Post-application verification failed; the applied patch was rolled back/u,
  );
  assert.equal(normalizeGitText(await readFile(join(root, "answer.txt"), "utf8")), "wrong\n");
  await access(join(root, "poison.flag"));
});

void test("TwinRunner rejects certificate writes through an escaping experiments junction", async () => {
  const root = await createTestRepository();
  const outside = await mkdtemp(join(tmpdir(), "counterlane-certificate-outside-"));
  await mkdir(join(root, ".counterlane"), { recursive: true });
  await symlink(
    outside,
    join(root, ".counterlane", "experiments"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, execution: "parallel", preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const runner = new TwinRunner({
    repository,
    config,
    telemetry: new TelemetryStore(root, config),
    logger: new Logger({ level: "error", json: false }),
  });

  await assert.rejects(
    runner.run({ prompt: "Replace the exact typo in answer.txt with correct and run the existing test." }),
    /outside (?:the )?(?:repository|configured data directory)/u,
  );
  assert.deepEqual(await readdir(outside), []);
});

async function assertDelayedThreadCleanup(operation: "start" | "fork", failDeletion = false): Promise<void> {
  const root = await createTestRepository();
  const base = testConfig();
  const config = testConfig({
    codex: { ...base.codex, command: process.execPath, args: [mockAppServerPath] },
    twin: { ...base.twin, execution: "parallel", preserveWorktrees: "never" },
    verification: {
      ...base.verification,
      autoDetect: false,
      commands: [{ name: "fixture", command: [process.execPath, "answer.test.mjs"], required: true }],
    },
    telemetry: { ...base.telemetry, enabled: false },
  });
  const repository = await GitRepository.discover(root);
  const delayedStarted = deferredSignal();
  const releaseDelayed = deferredSignal();
  const delayedThreadId = `${operation}-delayed-thread`;
  const deletedThreadIds: string[] = [];
  let calls = 0;

  const originalStartThread = CodexAppServer.prototype.startThread;
  const originalResumeThread = CodexAppServer.prototype.resumeThread;
  const originalForkThread = CodexAppServer.prototype.forkThread;
  const originalDeleteThread = CodexAppServer.prototype.deleteThread;
  const pairedThreadOperation = async (): Promise<string> => {
    calls += 1;
    if (calls === 1) {
      await delayedStarted.promise;
      throw new Error(`simulated fast thread/${operation} failure`);
    }
    delayedStarted.resolve();
    await releaseDelayed.promise;
    return delayedThreadId;
  };

  if (operation === "start") {
    CodexAppServer.prototype.startThread = async function (): Promise<string> {
      return pairedThreadOperation();
    };
  } else {
    CodexAppServer.prototype.resumeThread = async function (): Promise<void> {};
    CodexAppServer.prototype.forkThread = async function (): Promise<string> {
      return pairedThreadOperation();
    };
  }
  CodexAppServer.prototype.deleteThread = async function (threadId: string): Promise<void> {
    deletedThreadIds.push(threadId);
    if (failDeletion) throw new Error("simulated ephemeral thread deletion failure");
  };

  try {
    const execution = new TwinRunner({
      repository,
      config,
      telemetry: new TelemetryStore(root, config),
      logger: new Logger({ level: "error", json: false }),
    }).run({
      prompt: "Replace the exact typo in answer.txt with correct and run the existing test.",
      ...(operation === "fork" ? { parentThreadId: "parent-thread" } : {}),
    });
    await delayedStarted.promise;
    releaseDelayed.resolve();
    await assert.rejects(
      execution,
      new RegExp(`simulated fast thread/${operation} failure`, "u"),
    );
    assert.deepEqual(deletedThreadIds, [delayedThreadId]);
    const worktreeListing = await repository.git(["worktree", "list", "--porcelain"]);
    assert.equal((worktreeListing.match(/^worktree /gmu) ?? []).length, 1);
  } finally {
    releaseDelayed.resolve();
    CodexAppServer.prototype.startThread = originalStartThread;
    CodexAppServer.prototype.resumeThread = originalResumeThread;
    CodexAppServer.prototype.forkThread = originalForkThread;
    CodexAppServer.prototype.deleteThread = originalDeleteThread;
  }
}

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

function normalizePathText(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function sourceStatus(status: string): string {
  return status
    .split("\0")
    .filter((entry) => entry.length > 0 && !entry.slice(3).replaceAll("\\", "/").startsWith(".counterlane/"))
    .map((entry) => `${entry}\0`)
    .join("");
}

class CompletionFailingTelemetry extends TelemetryStore {
  public override append(type: string, payload: JsonObject, experimentId?: string): Promise<void> {
    if (type === "experiment.completed") return Promise.reject(new Error("simulated Twin telemetry failure"));
    return super.append(type, payload, experimentId);
  }
}
