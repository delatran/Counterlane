import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runCommand } from "../../src/core/process.js";
import { GitRepository } from "../../src/git/repository.js";
import { captureSnapshot, currentWorkingStateHash } from "../../src/git/snapshot.js";
import { removeWorktreeRoot, WorktreeManager } from "../../src/git/worktree.js";
import { createTestRepository, git, normalizeGitText, testConfig } from "../helpers.js";

void test("temporary worktree cleanup accepts an operating-system temp alias", async () => {
  const repositoryRoot = await createTestRepository();
  const parent = await mkdtemp(join(tmpdir(), "counterlane-temp-alias-test-"));
  const realTemp = join(parent, "real");
  const aliasTemp = join(parent, "alias");
  await mkdir(realTemp);
  await symlink(realTemp, aliasTemp, process.platform === "win32" ? "junction" : "dir");
  const environmentKeys = process.platform === "win32" ? ["TEMP", "TMP"] : ["TMPDIR"];
  const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  let manager: WorktreeManager | null = null;
  try {
    for (const key of environmentKeys) process.env[key] = aliasTemp;
    const repository = await GitRepository.discover(repositoryRoot);
    const snapshot = await captureSnapshot(repository);
    const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
    manager = new WorktreeManager(repository, config, "temp_alias_cleanup_test");
    const handle = await manager.create("arm", snapshot);
    assert.ok(handle.path.startsWith(await realpath(realTemp)), "prepared worktree should use the canonical temp path");
    await manager.cleanup(true);
    manager = null;
  } finally {
    await manager?.cleanup(false).catch(() => undefined);
    for (const key of environmentKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(parent, { recursive: true, force: true });
  }
});

void test("paired worktrees reproduce dirty and untracked state without touching the original", async () => {
  const root = await createTestRepository({ dirty: true });
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "worktree_test");
  const [left, right] = await Promise.all([
    manager.create("left", snapshot),
    manager.create("right", snapshot),
  ]);
  try {
    assert.equal(left.baselineCommit, right.baselineCommit);
    assert.equal(normalizeGitText(await readFile(join(left.path, "src.ts"), "utf8")), "export const value = 2;\n");
    assert.equal(await readFile(join(right.path, "untracked.txt"), "utf8"), "untracked\n");
    await writeFile(join(left.path, "answer.txt"), "correct\n", "utf8");
    const patch = await manager.capturePatch(left);
    assert.match(patch.patch, /answer\.txt/u);
    assert.equal(patch.summary.filesChanged, 1);
    assert.equal(await currentWorkingStateHash(repository), snapshot.manifest.workingStateHash);
  } finally {
    await manager.cleanup(true);
  }
});

void test("paired worktree creation waits for a delayed sibling before reporting a fast failure", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "paired_create_settlement_test");
  const originalGit = repository.git.bind(repository);
  const delayedStarted = deferredSignal();
  const releaseDelayed = deferredSignal();
  let worktreeAdds = 0;

  repository.git = async (args, options = {}) => {
    if (args[0] === "worktree" && args[1] === "add") {
      worktreeAdds += 1;
      if (worktreeAdds === 1) throw new Error("simulated fast worktree creation failure");
      delayedStarted.resolve();
      await releaseDelayed.promise;
    }
    return originalGit(args, options);
  };

  const pairedCreation = manager.createPair("fast-failure", "delayed-success", snapshot);
  let pairSettled = false;
  const settlementObservation = pairedCreation.then(
    () => { pairSettled = true; },
    () => { pairSettled = true; },
  );
  try {
    await delayedStarted.promise;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pairSettled, false, "the paired operation must retain the delayed sibling before rejecting");
    releaseDelayed.resolve();
    await assert.rejects(pairedCreation, /simulated fast worktree creation failure/u);
    await settlementObservation;
  } finally {
    releaseDelayed.resolve();
    await pairedCreation.catch(() => undefined);
    repository.git = originalGit;
    await manager.cleanup(false);
  }

  const worktreeListing = await originalGit(["worktree", "list", "--porcelain"]);
  assert.equal((worktreeListing.match(/^worktree /gmu) ?? []).length, 1);
});

void test("independent managers serialize Git worktree metadata mutations for the same repository", async () => {
  const root = await createTestRepository();
  const firstRepository = await GitRepository.discover(root);
  const secondRepository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(firstRepository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const firstManager = new WorktreeManager(firstRepository, config, "cross_manager_lock_a");
  const secondManager = new WorktreeManager(secondRepository, config, "cross_manager_lock_b");
  const firstGit = firstRepository.git.bind(firstRepository);
  const secondGit = secondRepository.git.bind(secondRepository);
  let activeAdds = 0;
  let maximumConcurrentAdds = 0;

  const delayedGit = (
    original: typeof firstRepository.git,
  ): typeof firstRepository.git => async (args, options = {}) => {
    if (args[0] !== "worktree" || args[1] !== "add") return original(args, options);
    activeAdds += 1;
    maximumConcurrentAdds = Math.max(maximumConcurrentAdds, activeAdds);
    try {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 40));
      return await original(args, options);
    } finally {
      activeAdds -= 1;
    }
  };
  firstRepository.git = delayedGit(firstGit);
  secondRepository.git = delayedGit(secondGit);

  try {
    await Promise.all([
      firstManager.create("arm-a", snapshot),
      secondManager.create("arm-b", snapshot),
    ]);
    assert.equal(maximumConcurrentAdds, 1);
  } finally {
    firstRepository.git = firstGit;
    secondRepository.git = secondGit;
    await Promise.all([
      firstManager.cleanup(false),
      secondManager.cleanup(false),
    ]);
  }
});

void test("worktree creation preserves cleanup failure and retains the provisional handle for retry", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "create_cleanup_failure_test");
  const originalGit = repository.git.bind(repository);
  let createdPath: string | undefined;
  let unregisterFailed = false;

  repository.git = async (args, options = {}) => {
    if (args[0] === "worktree" && args[1] === "add") {
      createdPath = args[3];
      await originalGit(args, options);
      throw new Error("simulated post-registration worktree creation failure");
    }
    if (!unregisterFailed && args[0] === "worktree" && args[1] === "remove") {
      unregisterFailed = true;
      throw new Error("simulated worktree unregister failure");
    }
    return originalGit(args, options);
  };

  try {
    await assert.rejects(
      manager.create("arm", snapshot),
      (error: unknown) => {
        assert.match(String(error), /partial worktree could not be unregistered/u);
        assert.match(JSON.stringify(error), /simulated post-registration worktree creation failure/u);
        assert.match(JSON.stringify(error), /simulated worktree unregister failure/u);
        return true;
      },
    );
    assert.notEqual(createdPath, undefined);
  } finally {
    repository.git = originalGit;
  }

  const registeredBeforeRetry = await originalGit(["worktree", "list", "--porcelain"]);
  assert.ok(normalizePathText(registeredBeforeRetry).includes(normalizePathText(createdPath as string)));
  await manager.cleanup(false);
  const registeredAfterRetry = await originalGit(["worktree", "list", "--porcelain"]);
  assert.equal(normalizePathText(registeredAfterRetry).includes(normalizePathText(createdPath as string)), false);
});

void test("candidate changes under managed roots are rejected before patch capture", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "managed_candidate_test");
  const handle = await manager.create("arm", snapshot);
  try {
    await mkdir(join(handle.path, config.dataDirectory), { recursive: true });
    await writeFile(join(handle.path, config.dataDirectory, "evil.txt"), "must-not-apply\n", "utf8");
    await assert.rejects(
      manager.capturePatch(handle),
      /Candidate changes touch Counterlane-managed state/u,
    );
    await assert.rejects(readFile(join(root, config.dataDirectory, "evil.txt"), "utf8"), /ENOENT/u);
  } finally {
    await manager.cleanup(false);
  }
});

void test("candidate commits are rejected as non-reproducible evidence", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "candidate_commit_test");
  const handle = await manager.create("arm", snapshot);
  try {
    await writeFile(join(handle.path, "answer.txt"), "correct\n", "utf8");
    await git(handle.path, ["add", "answer.txt"]);
    await git(handle.path, [
      "-c", "user.name=Counterlane Test",
      "-c", "user.email=test@local.invalid",
      "commit", "-qm", "candidate commit",
    ]);
    await assert.rejects(
      manager.capturePatch(handle),
      /Candidate Git control state changed/u,
    );
  } finally {
    await manager.cleanup(false);
  }
});

void test("candidate worktree Git-pointer redirection is rejected before any redirected Git command", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "candidate_git_pointer_test");
  const handle = await manager.create("arm", snapshot);
  const pointerPath = join(handle.path, ".git");
  const backupPointerPath = join(handle.path, ".git.counterlane-test-original");
  const originalPointer = await readFile(pointerPath);
  try {
    await rename(pointerPath, backupPointerPath);
    await writeFile(pointerPath, "gitdir: C:/definitely-not-counterlane\n", "utf8");
    await assert.rejects(
      manager.capturePatch(handle),
      /control pointer changed/u,
    );
  } finally {
    await rm(pointerPath, { force: true });
    await rename(backupPointerPath, pointerPath);
    assert.deepEqual(await readFile(pointerPath), originalPointer);
    await manager.cleanup(false);
  }
});

void test("candidate assume-unchanged index flags cannot hide modified tracked content", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "candidate_index_flag_test");
  const handle = await manager.create("arm", snapshot);
  try {
    await git(handle.path, ["update-index", "--assume-unchanged", "answer.txt"]);
    await writeFile(join(handle.path, "answer.txt"), "hidden-change\n", "utf8");
    await assert.rejects(
      manager.capturePatch(handle),
      /Candidate Git control state changed/u,
    );
  } finally {
    await manager.cleanup(false);
  }
});

void test("shared refs and local Git config mutations are restored before rejection", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "shared_git_control_test");
  const handle = await manager.create("arm", snapshot);
  const refsBefore = await repository.git(["for-each-ref", "--format=%(refname)%09%(objectname)"]);
  const configBefore = await readFile(join(root, ".git", "config"));
  try {
    await git(handle.path, ["branch", "verifier-leaked-branch"]);
    await git(handle.path, ["config", "--local", "counterlane.leak", "true"]);
    await chmod(join(root, ".git", "config"), 0o444);
    await assert.rejects(
      manager.assertExperimentControlState([handle]),
      /Shared Git control state changed during isolated execution; changes were restored/u,
    );
    assert.equal(await repository.git(["for-each-ref", "--format=%(refname)%09%(objectname)"]), refsBefore);
    assert.deepEqual(await readFile(join(root, ".git", "config")), configBefore);
  } finally {
    await manager.cleanup(false);
  }
});

void test("shared-control checks restore original checkout index flags before rejection", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "original_index_control_test");
  const handle = await manager.create("arm", snapshot);
  try {
    await git(root, ["update-index", "--assume-unchanged", "answer.txt"]);
    await assert.rejects(
      manager.assertExperimentControlState([handle]),
      /Shared Git control state changed during isolated execution; changes were restored/u,
    );
    assert.match(await repository.git(["ls-files", "-v", "--", "answer.txt"]), /^H /u);
  } finally {
    await git(root, ["update-index", "--no-assume-unchanged", "answer.txt"]);
    await manager.cleanup(false);
  }
});

void test("post-apply verifier mutations under managed roots are restored before rejection", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "managed_verifier_restore_test");
  const managedRoot = join(root, config.dataDirectory);
  await mkdir(managedRoot, { recursive: true });
  await writeFile(join(managedRoot, "before.txt"), "before\n", "utf8");

  await assert.rejects(
    manager.verifyOriginalWithoutMutation(async () => {
      await writeFile(join(managedRoot, "before.txt"), "mutated\n", "utf8");
      await writeFile(join(managedRoot, "created.txt"), "created\n", "utf8");
      return true;
    }),
    /Post-apply verifier mutated the original repository; its changes were restored/u,
  );
  assert.equal(await readFile(join(managedRoot, "before.txt"), "utf8"), "before\n");
  await assert.rejects(readFile(join(managedRoot, "created.txt"), "utf8"), /ENOENT/u);
});

void test("post-apply verifier restoration preserves the exact original Git index bytes", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "raw_index_restore_test");
  await writeFile(join(root, "intent.txt"), "intent-to-add\n", "utf8");
  await git(root, ["add", "-N", "intent.txt"]);
  const indexPath = join(root, ".git", "index");
  const indexBefore = await readFile(indexPath);
  const statusBefore = await repository.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

  await assert.rejects(
    manager.verifyOriginalWithoutMutation(async () => {
      await git(root, ["add", "intent.txt"]);
      return true;
    }),
    /Post-apply verifier mutated the original repository; its changes were restored/u,
  );
  assert.deepEqual(await readFile(indexPath), indexBefore);
  assert.equal(await repository.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]), statusBefore);
});

void test("post-apply verifier HEAD and branch changes are restored exactly before rejection", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "head_restore_test");
  const statusBefore = await repository.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const indexTreeBefore = await repository.git(["write-tree"]);
  const [headBefore, branchBefore, branchesBefore] = await Promise.all([
    repository.headCommit(),
    repository.branch(),
    repository.git(["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads"]),
  ]);

  await assert.rejects(
    manager.verifyOriginalWithoutMutation(async () => {
      await git(root, ["checkout", "-qb", "verifier-created-branch"]);
      await writeFile(join(root, "src.ts"), "export const value = 999;\n", "utf8");
      await git(root, ["add", "src.ts"]);
      await git(root, [
        "-c", "user.name=Counterlane Test",
        "-c", "user.email=test@local.invalid",
        "commit", "-qm", "verifier mutation",
      ]);
      return true;
    }),
    /Post-apply verifier mutated the original repository; its changes were restored/u,
  );

  const statusAfter = await repository.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const indexTreeAfter = await repository.git(["write-tree"]);
  const [headAfter, branchAfter, branchesAfter] = await Promise.all([
    repository.headCommit(),
    repository.branch(),
    repository.git(["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads"]),
  ]);
  assert.equal(statusAfter, statusBefore);
  assert.equal(indexTreeAfter, indexTreeBefore);
  assert.equal(headAfter, headBefore);
  assert.equal(branchAfter, branchBefore);
  assert.equal(branchesAfter, branchesBefore);
  assert.equal(normalizeGitText(await readFile(join(root, "src.ts"), "utf8")), "export const value = 1;\n");
});

void test(
  "winner patch apply and rollback preserve LF bytes under Windows autocrlf",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await createTestRepository();
    await git(root, ["config", "core.autocrlf", "true"]);
    const repository = await GitRepository.discover(root);
    const snapshot = await captureSnapshot(repository);
    const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
    const manager = new WorktreeManager(repository, config, "autocrlf_apply_rollback_test");
    const handle = await manager.create("arm", snapshot);
    const originalBytes = await readFile(join(root, "answer.txt"));
    const originalStatus = await repository.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    try {
      await writeFile(join(handle.path, "answer.txt"), "correct\n", "utf8");
      const captured = await manager.capturePatch(handle);
      await assert.rejects(
        manager.applyPatchToOriginal(captured.patch, async () => false),
        /Post-application verification failed; the applied patch was rolled back/u,
      );
      assert.deepEqual(await readFile(join(root, "answer.txt")), originalBytes);
      assert.equal(
        await repository.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        originalStatus,
      );
    } finally {
      await manager.cleanup(false);
    }
  },
);

void test("snapshotting fails closed while the repository has unresolved merge conflicts", async () => {
  const root = await createTestRepository();
  const originalBranch = (await git(root, ["branch", "--show-current"])).trim();
  await git(root, ["checkout", "-qb", "counterlane-conflict"]);
  await writeFile(join(root, "answer.txt"), "branch-value\n", "utf8");
  await git(root, ["add", "answer.txt"]);
  await git(root, ["-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid", "commit", "-qm", "branch"]);
  await git(root, ["checkout", "-q", originalBranch]);
  await writeFile(join(root, "answer.txt"), "main-value\n", "utf8");
  await git(root, ["add", "answer.txt"]);
  await git(root, ["-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid", "commit", "-qm", "main"]);
  const merge = await runCommand([
    "git",
    "-c",
    "user.name=Counterlane Test",
    "-c",
    "user.email=test@local.invalid",
    "merge",
    "counterlane-conflict",
  ], {
    cwd: root,
    timeoutMs: 30_000,
    maximumOutputBytes: 1_000_000,
  });
  assert.notEqual(merge.exitCode, 0);
  const repository = await GitRepository.discover(root);
  await assert.rejects(captureSnapshot(repository), /unresolved merge conflicts/u);
});

void test("snapshot identity rejects original assume-unchanged flags that hide working content", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  await git(root, ["update-index", "--assume-unchanged", "answer.txt"]);
  await writeFile(join(root, "answer.txt"), "hidden-user-change\n", "utf8");
  try {
    await assert.rejects(
      captureSnapshot(repository),
      /assume-unchanged or skip-worktree index flags/u,
    );
    await assert.rejects(
      currentWorkingStateHash(repository),
      /assume-unchanged or skip-worktree index flags/u,
    );
    await assert.rejects(
      repository.profile(),
      /assume-unchanged or skip-worktree index flags/u,
    );
  } finally {
    await git(root, ["update-index", "--no-assume-unchanged", "answer.txt"]);
  }
});

void test("snapshotting fails before execution when the checkout changes during capture", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const originalGit = repository.git.bind(repository);
  let trackedDiffReads = 0;
  repository.git = async (args, options = {}) => {
    const result = await originalGit(args, options);
    if (args[0] === "diff" && args.includes("HEAD") && trackedDiffReads++ === 0) {
      await writeFile(join(root, "src.ts"), "export const value = 99;\n", "utf8");
    }
    return result;
  };

  await assert.rejects(
    captureSnapshot(repository),
    /Repository state changed while Counterlane was capturing its snapshot/u,
  );
});

void test("tracked Counterlane-managed state is rejected instead of entering a source snapshot", async () => {
  const root = await createTestRepository();
  await mkdir(join(root, ".counterlane"), { recursive: true });
  await writeFile(join(root, ".counterlane", "events.jsonl"), "tracked-managed-state\n", "utf8");
  await git(root, ["add", ".counterlane/events.jsonl"]);
  await git(root, ["-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid", "commit", "-qm", "track managed state"]);
  const repository = await GitRepository.discover(root);

  await assert.rejects(
    captureSnapshot(repository, [".counterlane"]),
    /Counterlane-managed repository paths must not contain tracked source files/u,
  );
  await assert.rejects(
    repository.profile([".counterlane"]),
    /Counterlane-managed repository paths must not contain tracked source files/u,
  );
});

void test(
  "worktree creation rejects symlinks that escape the isolated repository",
  { skip: process.platform === "win32" },
  async () => {
    const { symlink } = await import("node:fs/promises");
    const root = await createTestRepository();
    await symlink("/tmp", join(root, "escape-link"));
    const repository = await GitRepository.discover(root);
    const snapshot = await captureSnapshot(repository);
    const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
    const manager = new WorktreeManager(repository, config, "unsafe_symlink_test");
    await assert.rejects(manager.create("arm", snapshot), /absolute symlink|escapes isolated worktree/u);
    await manager.cleanup(false);
  },
);

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

void test("paired worktrees share one immutable copy of ignored local dependencies", async () => {
  const root = await createTestRepository();
  const dependencyDirectory = join(root, "node_modules", "local-dependency");
  await mkdir(dependencyDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8"),
    writeFile(
      join(dependencyDirectory, "package.json"),
      `${JSON.stringify({ name: "local-dependency", type: "module", exports: "./index.js" })}\n`,
      "utf8",
    ),
    writeFile(join(dependencyDirectory, "index.js"), "export const value = 42;\n", "utf8"),
    writeFile(
      join(root, "dependency.test.mjs"),
      `import { value } from "local-dependency";\nif (value !== 42) process.exit(2);\n`,
      "utf8",
    ),
  ]);
  await git(root, ["add", ".gitignore", "dependency.test.mjs"]);
  await git(root, ["-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid", "commit", "-qm", "dependency fixture"]);
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "dependency_materialization_test");
  const left = await manager.create("left", snapshot);
  await writeFile(join(dependencyDirectory, "index.js"), "export const value = 99;\n", "utf8");
  const right = await manager.create("right", snapshot);
  try {
    for (const handle of [left, right]) {
      const verifier = await runCommand([process.execPath, "dependency.test.mjs"], {
        cwd: handle.path,
        timeoutMs: 30_000,
        maximumOutputBytes: 1_000_000,
      });
      assert.equal(verifier.exitCode, 0, verifier.stderr);
    }
    const copiedDependency = join(left.path, "node_modules", "local-dependency", "index.js");
    await writeFile(copiedDependency, "export const value = 7;\n", "utf8");
    assert.equal(await readFile(join(dependencyDirectory, "index.js"), "utf8"), "export const value = 99;\n");
    assert.equal(
      await readFile(join(right.path, "node_modules", "local-dependency", "index.js"), "utf8"),
      "export const value = 42;\n",
    );
  } finally {
    await manager.cleanup(true);
  }
});

void test("dependency materialization rejects links or junctions that would escape the worktree", async () => {
  const root = await createTestRepository();
  const outside = await mkdtemp(join(tmpdir(), "counterlane-dependency-outside-"));
  await mkdir(join(root, "node_modules"), { recursive: true });
  await Promise.all([
    writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8"),
    writeFile(join(outside, "marker.txt"), "outside\n", "utf8"),
  ]);
  await symlink(
    outside,
    join(root, "node_modules", "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await git(root, ["add", ".gitignore"]);
  await git(root, ["-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid", "commit", "-qm", "dependency fixture"]);
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "dependency_escape_test");

  await assert.rejects(manager.create("arm", snapshot), /absolute symlink|escapes isolated worktree/u);
  assert.equal(await readFile(join(outside, "marker.txt"), "utf8"), "outside\n");
  await manager.cleanup(false);
});

void test("dependency directories cannot overlap Counterlane-managed state", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const config = testConfig({
    twin: {
      ...testConfig().twin,
      dependencyDirectories: [".counterlane"],
    },
  });
  assert.throws(
    () => new WorktreeManager(repository, config, "dependency_overlap_test"),
    /overlaps Counterlane-managed state/u,
  );
});

void test("configured worktree base rejects an escaping Windows-capable junction", async () => {
  const root = await createTestRepository();
  const outside = await mkdtemp(join(tmpdir(), "counterlane-worktree-outside-"));
  await symlink(outside, join(root, ".worktrees"), process.platform === "win32" ? "junction" : "dir");
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({
    twin: {
      ...testConfig().twin,
      preserveWorktrees: "never",
      worktreeBaseDirectory: ".worktrees",
    },
  });
  const manager = new WorktreeManager(repository, config, "unsafe_base_test");

  await assert.rejects(manager.create("arm", snapshot), /outside the repository/u);
  assert.deepEqual(await readdir(outside), []);
});

void test("cleanup rejects a configured worktree root replaced by an escaping junction", async () => {
  const root = await createTestRepository();
  const outside = await mkdtemp(join(tmpdir(), "counterlane-worktree-cleanup-outside-"));
  await writeFile(join(outside, "marker.txt"), "outside\n", "utf8");
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({
    twin: {
      ...testConfig().twin,
      preserveWorktrees: "never",
      worktreeBaseDirectory: ".worktrees",
    },
  });
  const manager = new WorktreeManager(repository, config, "unsafe_cleanup_test");
  const handle = await manager.create("arm", snapshot);
  const managerRoot = dirname(handle.path);
  await git(root, ["worktree", "remove", "--force", handle.path]);
  await rm(managerRoot, { recursive: true, force: true });
  await symlink(outside, managerRoot, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(manager.cleanup(true), /outside the configured worktree base/u);
  assert.equal(await readFile(join(outside, "marker.txt"), "utf8"), "outside\n");
});

void test("cleanup preserves the bounded root when Git cannot unregister a worktree", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const snapshot = await captureSnapshot(repository);
  const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
  const manager = new WorktreeManager(repository, config, "unregister_failure_test");
  const handle = await manager.create("arm", snapshot);
  const managerRoot = dirname(handle.path);
  const marker = join(managerRoot, "recovery.marker");
  await writeFile(marker, "preserve\n", "utf8");

  const originalGit = repository.git.bind(repository);
  repository.git = async (args, options = {}) => {
    if (args[0] === "worktree" && args[1] === "remove") {
      throw new Error("simulated worktree unregister failure");
    }
    return originalGit(args, options);
  };

  try {
    await assert.rejects(
      manager.cleanup(true),
      /Unable to unregister every isolated worktree; preserving the bounded worktree root/u,
    );
    assert.equal(await readFile(marker, "utf8"), "preserve\n");
  } finally {
    repository.git = originalGit;
    await manager.cleanup(true);
  }
});

void test("bounded-root deletion failures remain observable for recovery", async () => {
  await assert.rejects(
    removeWorktreeRoot("C:/bounded/counterlane/root", async () => {
      const error = new Error("simulated lock") as Error & { code: string };
      error.code = "EBUSY";
      throw error;
    }),
    (error: unknown) => {
      assert.match(String(error), /Unable to remove the bounded worktree root/u);
      assert.match(JSON.stringify(error), /simulated lock/u);
      return true;
    },
  );
});

void test(
  "worktree creation rejects a dirty tracked file converted into an escaping symlink",
  { skip: process.platform === "win32" },
  async () => {
    const { rm, symlink } = await import("node:fs/promises");
    const root = await createTestRepository();
    await rm(join(root, "src.ts"));
    await symlink("../../outside", join(root, "src.ts"));
    const repository = await GitRepository.discover(root);
    const snapshot = await captureSnapshot(repository);
    const config = testConfig({ twin: { ...testConfig().twin, preserveWorktrees: "never" } });
    const manager = new WorktreeManager(repository, config, "tracked_unsafe_symlink_test");
    await assert.rejects(manager.create("arm", snapshot), /escapes isolated worktree/u);
    await manager.cleanup(false);
  },
);
