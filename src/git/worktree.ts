import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { errorMessage, SafetyError } from "../core/errors.js";
import { canonicalizeContainedPath, ensureContainedDirectory, resolveContainedPath } from "../core/path-safety.js";
import { runCommand } from "../core/process.js";
import type { DiffSummary } from "../core/types.js";
import { pathExists, removePath, sanitizeFileSegment, sha256, writeBufferAtomic } from "../core/utils.js";
import type { CounterlaneConfig } from "../config/types.js";
import { managedStatePrefixes } from "../config/managed-state.js";
import { GitRepository } from "./repository.js";
import { captureSnapshot, currentContentHash, currentWorkingStateHash, type SnapshotBundle, type UntrackedSnapshotEntry } from "./snapshot.js";

export interface WorktreeHandle {
  path: string;
  armName: string;
  baselineCommit: string;
}

interface DependencySnapshot {
  path: string;
  fingerprint: DependencyFingerprint;
}

interface DependencyFingerprint {
  digest: string;
  fileCount: number;
  totalBytes: number;
}

interface LocalBranchState {
  ref: string;
  objectId: string;
}

interface GitControlState {
  headCommit: string;
  branch: string | null;
  indexTree: string;
  specialIndexFlags: string[];
  indexPath: string;
  indexContents: Buffer;
  indexMode: number;
  localBranches: LocalBranchState[];
}

interface CandidateControlState {
  headCommit: string;
  branch: string | null;
  specialIndexFlags: string[];
  gitPointerHash: string;
  gitPointerMode: number;
}

interface SharedGitControlState {
  refs: LocalBranchState[];
  originalControl: GitControlState;
  configPath: string;
  configContents: Buffer;
  configMode: number;
}

interface ManagedStateEntry {
  relativePath: string;
  originalPath: string;
  backupPath: string | null;
  fingerprint: DependencyFingerprint | null;
}

interface ManagedStateSnapshot {
  stagingRoot: string;
  entries: ManagedStateEntry[];
}

const repositoryWorktreeMutationTails = new Map<string, Promise<void>>();

export class WorktreeManager {
  readonly #repository: GitRepository;
  readonly #config: CounterlaneConfig;
  readonly #base: string;
  readonly #configuredBase: string | null;
  readonly #root: string;
  readonly #handles: WorktreeHandle[] = [];
  readonly #dependencySnapshots = new Map<string, Promise<DependencySnapshot | null>>();
  readonly #candidateControlStates = new Map<string, CandidateControlState>();
  #sharedControlState: Promise<SharedGitControlState> | undefined;
  #canonicalBase: string | undefined;
  #canonicalRoot: string | undefined;
  #forcePreserve = false;

  public constructor(repository: GitRepository, config: CounterlaneConfig, experimentId: string) {
    this.#repository = repository;
    this.#config = config;
    assertSafeDependencyDirectories(repository.root, config);
    const configuredBase = config.twin.worktreeBaseDirectory;
    this.#configuredBase = configuredBase === null ? null : resolve(repository.root, configuredBase);
    this.#base = this.#configuredBase ?? join(tmpdir(), "counterlane");
    this.#root = join(this.#base, sanitizeFileSegment(sha256(repository.root).slice(0, 16)), sanitizeFileSegment(experimentId));
  }

  public get repository(): GitRepository {
    return this.#repository;
  }

  public async createPair(
    controlArmName: string,
    treatmentArmName: string,
    snapshot: SnapshotBundle,
  ): Promise<readonly [WorktreeHandle, WorktreeHandle]> {
    const [control, treatment] = await Promise.allSettled([
      this.create(controlArmName, snapshot),
      this.create(treatmentArmName, snapshot),
    ]);
    const failures = [control, treatment]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Both paired worktrees failed during creation.");
    }
    if (control.status !== "fulfilled" || treatment.status !== "fulfilled") {
      throw new SafetyError("Paired worktree creation settled without two results.");
    }
    this.#sharedControlState = Promise.resolve(await this.#captureSharedGitControlState());
    return [control.value, treatment.value];
  }

  public async create(armName: string, snapshot: SnapshotBundle): Promise<WorktreeHandle> {
    const root = await this.#prepareRoot();
    const path = resolveContainedPath(root, sanitizeFileSegment(armName), {
      target: "worktree arm",
      boundary: "worktree root",
    });
    if (await pathExists(path)) {
      const safeExistingPath = await canonicalizeContainedPath(root, path, {
        target: "existing worktree arm",
        boundary: "worktree root",
      });
      await removePath(safeExistingPath);
    }

    const handle: WorktreeHandle = {
      path,
      armName,
      baselineCommit: snapshot.manifest.headCommit,
    };
    let worktreeAdded = false;
    try {
      await this.#withWorktreeMutation(() => this.#repository.git(
        ["worktree", "add", "--detach", path, snapshot.manifest.headCommit],
        { timeoutMs: 120_000, environment: deterministicGitEnvironment() },
      ));
      worktreeAdded = true;
      this.#handles.push(handle);
      if (snapshot.trackedPatch.length > 0) {
        await this.#repository.git(deterministicApplyArgs("--binary", "--whitespace=nowarn", "-"), {
          cwd: path,
          input: snapshot.trackedPatch,
          timeoutMs: 120_000,
        });
      }
      for (const entry of snapshot.untracked) {
        await restoreUntracked(path, entry);
      }
      await this.assertSafeSymlinks(path);

      await this.#repository.git(["add", "-A"], { cwd: path, timeoutMs: 120_000 });
      const commitDate = snapshot.manifest.createdAt;
      const message = `Counterlane baseline ${snapshot.manifest.workingStateHash.slice(0, 16)}`;
      await runGitCommit(this.#repository, path, message, commitDate);
      handle.baselineCommit = (await this.#repository.git(["rev-parse", "HEAD"], { cwd: path })).trim();
      await this.#materializeDependencies(path);
      await this.assertSafeSymlinks(path);
      this.#candidateControlStates.set(path, await this.#captureCandidateControlState(path));
      this.#sharedControlState ??= this.#captureSharedGitControlState();
      await this.#sharedControlState;
      return handle;
    } catch (error) {
      let partiallyCreated = worktreeAdded;
      if (!partiallyCreated) {
        try {
          partiallyCreated = (await pathExists(path)) || (await this.#isRegisteredWorktree(path));
        } catch (inspectionError) {
          if (!this.#handles.includes(handle)) this.#handles.push(handle);
          throw new SafetyError("Worktree creation failed and partial-state inspection also failed; preserving the bounded root for recovery.", {
            path,
            creationError: errorMessage(error),
            inspectionError: errorMessage(inspectionError),
          });
        }
      }
      if (!partiallyCreated) throw error;
      if (!this.#handles.includes(handle)) this.#handles.push(handle);
      try {
        await this.#removeWorktree(path, root);
        this.#forgetHandle(handle);
      } catch (cleanupError) {
        throw new SafetyError("Worktree creation failed and the partial worktree could not be unregistered; preserving it for recovery.", {
          path,
          creationError: errorMessage(error),
          cleanupError: errorMessage(cleanupError),
        });
      }
      throw error;
    }
  }

  async #isRegisteredWorktree(path: string): Promise<boolean> {
    const listing = await this.#repository.git(["worktree", "list", "--porcelain", "-z"], { timeoutMs: 120_000 });
    const target = resolve(path);
    return listing
      .split("\0")
      .some((field) => field.startsWith("worktree ") && resolve(field.slice("worktree ".length)) === target);
  }

  #forgetHandle(handle: WorktreeHandle): void {
    const index = this.#handles.indexOf(handle);
    if (index >= 0) this.#handles.splice(index, 1);
    this.#candidateControlStates.delete(handle.path);
  }

  public async capturePatch(handle: WorktreeHandle): Promise<{ patch: string; patchHash: string; summary: DiffSummary }> {
    await this.#assertCandidateControlState(handle);
    await this.#assertNoManagedCandidateChanges(handle.path);
    await this.assertSafeSymlinks(handle.path);
    await this.#repository.git(["add", "-N", "--", "."], { cwd: handle.path, timeoutMs: 120_000 });
    const patch = await this.#repository.git(["diff", "--binary", "--no-ext-diff", handle.baselineCommit], {
      cwd: handle.path,
      timeoutMs: 120_000,
    });
    await this.#assertCandidateControlState(handle);
    return { patch, patchHash: sha256(patch), summary: summarizeUnifiedDiff(patch) };
  }

  public forcePreserveForRecovery(): void {
    this.#forcePreserve = true;
  }

  public async assertExperimentControlState(handles: readonly WorktreeHandle[]): Promise<void> {
    const candidateFailures: unknown[] = [];
    for (const handle of handles) {
      try {
        await this.#assertCandidateControlState(handle);
        await this.#assertNoManagedCandidateChanges(handle.path);
      } catch (error) {
        candidateFailures.push(error);
      }
    }
    let sharedFailure: unknown;
    try {
      await this.#assertSharedGitControlsUnchanged();
    } catch (error) {
      sharedFailure = error;
    }
    const failures = [...candidateFailures, ...(sharedFailure === undefined ? [] : [sharedFailure])];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Candidate or shared Git control state changed during the experiment.");
    }
  }

  public async assertCandidateControlState(handle: WorktreeHandle): Promise<void> {
    await this.#assertCandidateControlState(handle);
  }

  async #captureCandidateControlState(worktreePath: string): Promise<CandidateControlState> {
    const gitPointerPath = join(worktreePath, ".git");
    const gitPointerMetadata = await lstat(gitPointerPath);
    if (!gitPointerMetadata.isFile() || gitPointerMetadata.isSymbolicLink()) {
      throw new SafetyError("Isolated worktree .git control pointer must be a regular non-symlink file.");
    }
    const gitPointerContents = await readFile(gitPointerPath);
    const [headCommit, branch, indexFlags] = await Promise.all([
      this.#repository.git(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 120_000 }),
      this.#repository.git(["branch", "--show-current"], { cwd: worktreePath, timeoutMs: 120_000 }),
      this.#repository.git(["ls-files", "-v", "-z"], { cwd: worktreePath, timeoutMs: 120_000 }),
    ]);
    return {
      headCommit: headCommit.trim(),
      branch: branch.trim().length === 0 ? null : branch.trim(),
      specialIndexFlags: parseSpecialIndexFlags(indexFlags),
      gitPointerHash: sha256(gitPointerContents),
      gitPointerMode: gitPointerMetadata.mode,
    };
  }

  async #assertCandidateControlState(handle: WorktreeHandle): Promise<void> {
    const expected = this.#candidateControlStates.get(handle.path);
    if (expected === undefined) {
      throw new SafetyError(`Candidate control baseline is unavailable for ${handle.armName}.`);
    }
    const gitPointerPath = join(handle.path, ".git");
    const pointerMetadata = await lstat(gitPointerPath).catch(() => null);
    if (pointerMetadata === null || !pointerMetadata.isFile() || pointerMetadata.isSymbolicLink()) {
      throw new SafetyError("Candidate worktree .git control pointer changed type or disappeared.", {
        armName: handle.armName,
      });
    }
    const pointerHash = sha256(await readFile(gitPointerPath));
    if (pointerHash !== expected.gitPointerHash || pointerMetadata.mode !== expected.gitPointerMode) {
      throw new SafetyError("Candidate worktree .git control pointer changed; refusing redirected Git operations.", {
        armName: handle.armName,
        pointerHashChanged: pointerHash !== expected.gitPointerHash,
        pointerModeChanged: pointerMetadata.mode !== expected.gitPointerMode,
      });
    }
    const [actual, unmerged] = await Promise.all([
      this.#captureCandidateControlState(handle.path),
      this.#repository.git(["ls-files", "--unmerged", "-z"], { cwd: handle.path, timeoutMs: 120_000 }),
    ]);
    if (
      actual.headCommit !== handle.baselineCommit ||
      actual.headCommit !== expected.headCommit ||
      actual.branch !== expected.branch ||
      !stringArrayEquals(actual.specialIndexFlags, expected.specialIndexFlags) ||
      actual.gitPointerHash !== expected.gitPointerHash ||
      actual.gitPointerMode !== expected.gitPointerMode ||
      unmerged.length > 0
    ) {
      throw new SafetyError("Candidate Git control state changed; committed, attached, or conflicted evidence is not reproducible.", {
        armName: handle.armName,
        expectedHeadCommit: handle.baselineCommit,
        actualHeadCommit: actual.headCommit,
        expectedBranch: expected.branch,
        actualBranch: actual.branch,
        specialIndexFlagsChanged: !stringArrayEquals(actual.specialIndexFlags, expected.specialIndexFlags),
        unresolvedMergeState: unmerged.length > 0,
      });
    }
  }

  async #assertNoManagedCandidateChanges(worktreePath: string): Promise<void> {
    const prefixes = minimalManagedPrefixes(managedStatePrefixes(this.#config));
    if (prefixes.length === 0) return;
    const status = await this.#repository.git([
      "--literal-pathspecs",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ...prefixes,
    ], { cwd: worktreePath, timeoutMs: 120_000 });
    if (status.length === 0) return;
    throw new SafetyError("Candidate changes touch Counterlane-managed state and cannot enter an experiment patch.", {
      managedPrefixes: prefixes,
    });
  }

  async #captureSharedGitControlState(): Promise<SharedGitControlState> {
    const [refs, originalControl, commonDirectory] = await Promise.all([
      this.#captureRefs(),
      this.#captureGitControlState(),
      this.#repository.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: this.#repository.root,
        timeoutMs: 120_000,
      }),
    ]);
    const rawCommonDirectory = commonDirectory.trim();
    const absoluteCommonDirectory = isAbsolute(rawCommonDirectory)
      ? resolve(rawCommonDirectory)
      : resolve(this.#repository.root, rawCommonDirectory);
    const configPath = join(absoluteCommonDirectory, "config");
    const metadata = await lstat(configPath);
    if (!metadata.isFile()) {
      throw new SafetyError("Repository-local Git config is not a regular file; refusing shared-control execution.");
    }
    return {
      refs,
      originalControl,
      configPath,
      configContents: await readFile(configPath),
      configMode: metadata.mode,
    };
  }

  async #captureRefs(): Promise<LocalBranchState[]> {
    return parseLocalBranches(await this.#repository.git(
      ["for-each-ref", "--format=%(refname)%09%(objectname)"],
      { cwd: this.#repository.root, timeoutMs: 120_000 },
    ));
  }

  async #assertSharedGitControlsUnchanged(): Promise<void> {
    const expectedPromise = this.#sharedControlState;
    if (expectedPromise === undefined) return;
    const expected = await expectedPromise;
    let actual: SharedGitControlState | undefined;
    let inspectionError: unknown;
    try {
      actual = await this.#captureSharedGitControlState();
    } catch (error) {
      inspectionError = error;
    }
    if (actual !== undefined && sharedGitControlStateSemanticallyEquals(expected, actual)) {
      if (!gitIndexStateEquals(expected.originalControl, actual.originalControl)) {
        try {
          // Read-only Git commands may refresh index stat-cache bytes without
          // changing the tree or any behavioral flag. Restore those bytes to
          // the caller's exact baseline, but do not misreport the refresh as a
          // candidate or verifier mutation.
          await this.#restoreGitIndexState(expected.originalControl);
        } catch (restorationError) {
          throw new SafetyError("Shared Git index metadata changed and exact restoration failed.", {
            restorationError: errorMessage(restorationError),
          });
        }
      }
      return;
    }

    try {
      await this.#restoreSharedGitControlState(expected);
      const restored = await this.#captureSharedGitControlState();
      if (!sharedGitControlStateEquals(expected, restored)) {
        throw new SafetyError("Shared Git control restoration did not reproduce the baseline.");
      }
    } catch (restorationError) {
      throw new SafetyError("Shared Git control state changed and exact restoration failed.", {
        inspectionError: inspectionError === undefined ? null : errorMessage(inspectionError),
        restorationError: errorMessage(restorationError),
      });
    }
    throw new SafetyError("Shared Git control state changed during isolated execution; changes were restored.", {
      refsChanged: actual === undefined || !localBranchStateEquals(expected.refs, actual.refs),
      originalControlChanged: actual === undefined || !gitControlStateEquals(expected.originalControl, actual.originalControl),
      configChanged: actual === undefined ||
        actual.configPath !== expected.configPath ||
        actual.configMode !== expected.configMode ||
        sha256(actual.configContents) !== sha256(expected.configContents),
      inspectionError: inspectionError === undefined ? null : errorMessage(inspectionError),
    });
  }

  async #restoreSharedGitControlState(expected: SharedGitControlState): Promise<void> {
    await chmod(expected.configPath, 0o600).catch((error: unknown) => {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    });
    await writeBufferAtomic(expected.configPath, expected.configContents);
    await chmod(expected.configPath, expected.configMode & 0o777);

    const currentRefs = await this.#captureRefs();
    if (expected.refs.length > 0) {
      await this.#repository.git(["update-ref", "--stdin"], {
        cwd: this.#repository.root,
        timeoutMs: 120_000,
        input: `${expected.refs.map((entry) => `update ${entry.ref} ${entry.objectId}`).join("\n")}\n`,
      });
    }
    const expectedNames = new Set(expected.refs.map((entry) => entry.ref));
    const addedRefs = currentRefs.filter((entry) => !expectedNames.has(entry.ref));
    if (addedRefs.length > 0) {
      await this.#repository.git(["update-ref", "--stdin"], {
        cwd: this.#repository.root,
        timeoutMs: 120_000,
        input: `${addedRefs.map((entry) => `delete ${entry.ref}`).join("\n")}\n`,
      });
    }
    await this.#restoreGitControlState(expected.originalControl);
  }

  public async applyPatchToOriginal(patch: string, verifyApplied?: () => Promise<boolean>): Promise<void> {
    if (patch.length === 0) {
      if (verifyApplied !== undefined && !(await verifyApplied())) {
        throw new SafetyError("Post-application verification failed for an empty patch.");
      }
      return;
    }
    const originalContentHash = await currentContentHash(
      this.#repository,
      managedStatePrefixes(this.#config),
    );
    await this.#repository.git(deterministicApplyArgs("--check", "--ignore-space-change", "--binary", "--whitespace=nowarn", "-"), {
      cwd: this.#repository.root,
      input: patch,
      timeoutMs: 120_000,
    });
    await this.#repository.git(deterministicApplyArgs("--ignore-space-change", "--binary", "--whitespace=nowarn", "-"), {
      cwd: this.#repository.root,
      input: patch,
      timeoutMs: 120_000,
    });
    if (verifyApplied === undefined) return;

    let verificationError: unknown;
    try {
      if (await verifyApplied()) return;
      verificationError = new SafetyError("Post-application verification did not pass.");
    } catch (error) {
      verificationError = error;
    }

    try {
      await this.#rollbackAppliedPatch(
        patch,
        async () => (await currentContentHash(this.#repository, managedStatePrefixes(this.#config))) === originalContentHash,
      );
    } catch (rollbackError) {
      throw new SafetyError("Post-application verification failed and the patch rollback also failed.", {
        verificationError: errorMessage(verificationError),
        rollbackError: errorMessage(rollbackError),
      });
    }
    throw new SafetyError("Post-application verification failed; the applied patch was rolled back.", {
      verificationError: errorMessage(verificationError),
    });
  }

  public async rollbackPatchFromOriginal(
    patch: string,
    verifyRestored: () => Promise<boolean>,
  ): Promise<void> {
    if (patch.length === 0) {
      if (!(await verifyRestored())) {
        throw new SafetyError("Winner patch rollback completed but exact original-state verification failed.");
      }
      return;
    }
    await this.#rollbackAppliedPatch(patch, verifyRestored);
  }

  async #rollbackAppliedPatch(patch: string, verifyRestored: () => Promise<boolean>): Promise<void> {
    let deterministicReverseSucceeded = false;
    let deterministicError: unknown;
    try {
      await this.#repository.git(deterministicApplyArgs("--check", "--reverse", "--ignore-space-change", "--binary", "--whitespace=nowarn", "-"), {
        cwd: this.#repository.root,
        input: patch,
        timeoutMs: 120_000,
      });
      await this.#repository.git(deterministicApplyArgs("--reverse", "--ignore-space-change", "--binary", "--whitespace=nowarn", "-"), {
        cwd: this.#repository.root,
        input: patch,
        timeoutMs: 120_000,
      });
      deterministicReverseSucceeded = true;
      if (await verifyRestored()) return;
    } catch (error) {
      deterministicError = error;
    }

    try {
      if (deterministicReverseSucceeded) {
        await this.#repository.git(deterministicApplyArgs("--check", "--ignore-space-change", "--binary", "--whitespace=nowarn", "-"), {
          cwd: this.#repository.root,
          input: patch,
          timeoutMs: 120_000,
        });
        await this.#repository.git(deterministicApplyArgs("--ignore-space-change", "--binary", "--whitespace=nowarn", "-"), {
          cwd: this.#repository.root,
          input: patch,
          timeoutMs: 120_000,
        });
      }
      await this.#repository.git(["apply", "--check", "--reverse", "--ignore-space-change", "--binary", "--whitespace=nowarn", "-"], {
        cwd: this.#repository.root,
        input: patch,
        timeoutMs: 120_000,
      });
      await this.#repository.git(["apply", "--reverse", "--ignore-space-change", "--binary", "--whitespace=nowarn", "-"], {
        cwd: this.#repository.root,
        input: patch,
        timeoutMs: 120_000,
      });
      if (await verifyRestored()) return;
    } catch (nativeError) {
      throw new SafetyError("Winner patch rollback could not restore the exact original byte state.", {
        deterministicError: deterministicError === undefined ? null : errorMessage(deterministicError),
        nativeError: errorMessage(nativeError),
      });
    }
    throw new SafetyError("Winner patch rollback completed but exact original-state verification failed.", {
      deterministicError: deterministicError === undefined ? null : errorMessage(deterministicError),
    });
  }

  /**
   * Runs a verifier against the real checkout, then restores and rejects any
   * Git-visible verifier mutation before the winner patch is rolled back.
   */
  public async verifyOriginalWithoutMutation(verify: () => Promise<boolean>): Promise<boolean> {
    const managedBefore = await this.#captureManagedState();
    try {
      return await this.#verifyOriginalTransaction(verify, managedBefore);
    } finally {
      await removePath(managedBefore.stagingRoot);
    }
  }

  async #verifyOriginalTransaction(
    verify: () => Promise<boolean>,
    managedBefore: ManagedStateSnapshot,
  ): Promise<boolean> {
    const ignored = managedStatePrefixes(this.#config);
    const before = await captureSnapshot(this.#repository, ignored);
    const beforeControl = await this.#captureGitControlState();
    const baseline = await this.#createWorkingTreeBaseline(beforeControl);
    let result: boolean;
    let verificationError: unknown;
    try {
      result = await verify();
    } catch (error) {
      result = false;
      verificationError = error;
    }
    let afterHash: string | undefined;
    let afterControl: GitControlState | undefined;
    let managedStateUnchanged: boolean | undefined;
    let inspectionError: unknown;
    try {
      [afterHash, afterControl, managedStateUnchanged] = await Promise.all([
        currentWorkingStateHash(this.#repository, ignored),
        this.#captureGitControlState(),
        this.#managedStateMatches(managedBefore),
      ]);
    } catch (error) {
      inspectionError = error;
    }
    const workingStateChanged = afterHash !== before.manifest.workingStateHash;
    const controlStateChanged = afterControl === undefined || !gitControlStateEquals(beforeControl, afterControl);
    const managedStateChanged = managedStateUnchanged !== true;
    if (inspectionError !== undefined || workingStateChanged || controlStateChanged || managedStateChanged) {
      try {
        await this.#restoreOriginalState(baseline, before);
        await this.#restoreGitControlState(beforeControl);
        await this.#restoreManagedState(managedBefore);
      } catch (restorationError) {
        throw new SafetyError("Verifier mutated the original repository and exact restoration failed.", {
          inspectionError: inspectionError === undefined ? null : errorMessage(inspectionError),
          restorationError: errorMessage(restorationError),
          verificationError: verificationError === undefined ? null : errorMessage(verificationError),
        });
      }

      let restoredHash: string;
      let restoredControl: GitControlState;
      let restoredManagedState: boolean;
      try {
        [restoredHash, restoredControl, restoredManagedState] = await Promise.all([
          currentWorkingStateHash(this.#repository, ignored),
          this.#captureGitControlState(),
          this.#managedStateMatches(managedBefore),
        ]);
      } catch (restorationInspectionError) {
        throw new SafetyError("Verifier mutated the original repository and restoration could not be verified.", {
          error: errorMessage(restorationInspectionError),
        });
      }
      if (
        restoredHash !== before.manifest.workingStateHash ||
        !gitControlStateEquals(beforeControl, restoredControl) ||
        !restoredManagedState
      ) {
        throw new SafetyError("Verifier mutated the original repository and exact restoration failed.", {
          expectedWorkingStateHash: before.manifest.workingStateHash,
          actualWorkingStateHash: restoredHash,
          expectedHeadCommit: beforeControl.headCommit,
          actualHeadCommit: restoredControl.headCommit,
          expectedBranch: beforeControl.branch,
          actualBranch: restoredControl.branch,
          expectedIndexTree: beforeControl.indexTree,
          actualIndexTree: restoredControl.indexTree,
          managedStateRestored: restoredManagedState,
        });
      }
      throw new SafetyError("Post-apply verifier mutated the original repository; its changes were restored.", {
        workingStateChanged,
        indexChanged: afterControl === undefined || afterControl.indexTree !== beforeControl.indexTree,
        headChanged: afterControl === undefined || afterControl.headCommit !== beforeControl.headCommit,
        branchChanged: afterControl === undefined || afterControl.branch !== beforeControl.branch,
        localBranchesChanged: afterControl === undefined || !localBranchStateEquals(beforeControl.localBranches, afterControl.localBranches),
        managedStateChanged,
        inspectionError: inspectionError === undefined ? null : errorMessage(inspectionError),
      });
    }
    if (verificationError !== undefined) throw verificationError;
    return result;
  }

  async #captureGitControlState(): Promise<GitControlState> {
    const [headCommit, branch, indexTree, indexFlags, indexPathOutput, branches] = await Promise.all([
      this.#repository.headCommit(),
      this.#repository.branch(),
      this.#repository.git(["write-tree"], { cwd: this.#repository.root, timeoutMs: 120_000 }),
      this.#repository.git(["ls-files", "-v", "-z"], { cwd: this.#repository.root, timeoutMs: 120_000 }),
      this.#repository.git(["rev-parse", "--path-format=absolute", "--git-path", "index"], {
        cwd: this.#repository.root,
        timeoutMs: 120_000,
      }),
      this.#repository.git(
        ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads"],
        { cwd: this.#repository.root, timeoutMs: 120_000 },
      ),
    ]);
    const rawIndexPath = indexPathOutput.trim();
    const indexPath = isAbsolute(rawIndexPath) ? resolve(rawIndexPath) : resolve(this.#repository.root, rawIndexPath);
    const indexMetadata = await lstat(indexPath);
    if (!indexMetadata.isFile() || indexMetadata.isSymbolicLink()) {
      throw new SafetyError("Original Git index must be a regular non-symlink file.", { indexPath });
    }
    return {
      headCommit,
      branch,
      indexTree: indexTree.trim(),
      specialIndexFlags: parseSpecialIndexFlags(indexFlags),
      indexPath,
      indexContents: await readFile(indexPath),
      indexMode: indexMetadata.mode,
      localBranches: parseLocalBranches(branches),
    };
  }

  async #createWorkingTreeBaseline(control: GitControlState): Promise<string> {
    const stagingRoot = await mkdtemp(join(tmpdir(), "counterlane-verifier-index-"));
    const temporaryIndexPath = join(stagingRoot, "index");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: temporaryIndexPath,
      GIT_AUTHOR_NAME: "Counterlane",
      GIT_AUTHOR_EMAIL: "counterlane@invalid.local",
      GIT_COMMITTER_NAME: "Counterlane",
      GIT_COMMITTER_EMAIL: "counterlane@invalid.local",
    };
    try {
      await writeFile(temporaryIndexPath, control.indexContents, { flag: "wx" });
      // Build a detached tree for the current tracked working contents without
      // touching the real index. Unlike `git stash create`, this also handles
      // a valid intent-to-add entry in the caller's original index.
      await this.#repository.git(["add", "-u", "--", "."], {
        cwd: this.#repository.root,
        environment,
        timeoutMs: 120_000,
      });
      const tree = (await this.#repository.git(["write-tree"], {
        cwd: this.#repository.root,
        environment,
        timeoutMs: 120_000,
      })).trim();
      return (await this.#repository.git(["commit-tree", tree, "-p", control.headCommit], {
        cwd: this.#repository.root,
        environment,
        input: "Counterlane verifier baseline\n",
        timeoutMs: 120_000,
      })).trim();
    } finally {
      await removePath(stagingRoot);
    }
  }

  async #restoreGitControlState(state: GitControlState): Promise<void> {
    const currentBranches = (await this.#captureLocalBranches()).map((entry) => entry.ref);
    if (state.localBranches.length > 0) {
      await this.#repository.git(["update-ref", "--stdin"], {
        cwd: this.#repository.root,
        timeoutMs: 120_000,
        input: `${state.localBranches.map((entry) => `update ${entry.ref} ${entry.objectId}`).join("\n")}\n`,
      });
    }
    if (state.branch === null) {
      await this.#repository.git(["update-ref", "--no-deref", "HEAD", state.headCommit], {
        cwd: this.#repository.root,
        timeoutMs: 120_000,
      });
    } else {
      await this.#repository.git(["symbolic-ref", "HEAD", `refs/heads/${state.branch}`], {
        cwd: this.#repository.root,
        timeoutMs: 120_000,
      });
    }
    const expectedRefs = new Set(state.localBranches.map((entry) => entry.ref));
    const addedRefs = currentBranches.filter((ref) => !expectedRefs.has(ref));
    if (addedRefs.length > 0) {
      await this.#repository.git(["update-ref", "--stdin"], {
        cwd: this.#repository.root,
        timeoutMs: 120_000,
        input: `${addedRefs.map((ref) => `delete ${ref}`).join("\n")}\n`,
      });
    }
    await this.#restoreGitIndexState(state);
  }

  async #restoreGitIndexState(state: GitControlState): Promise<void> {
    const currentIndexMetadata = await lstat(state.indexPath).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (currentIndexMetadata?.isFile() === true && !currentIndexMetadata.isSymbolicLink()) {
      await chmod(state.indexPath, 0o600);
    }
    await writeBufferAtomic(state.indexPath, state.indexContents);
    await chmod(state.indexPath, state.indexMode & 0o777);
  }

  async #captureLocalBranches(): Promise<LocalBranchState[]> {
    return parseLocalBranches(await this.#repository.git(
      ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads"],
      { cwd: this.#repository.root, timeoutMs: 120_000 },
    ));
  }

  async #captureManagedState(): Promise<ManagedStateSnapshot> {
    const stagingRoot = await mkdtemp(join(tmpdir(), "counterlane-managed-state-"));
    const entries: ManagedStateEntry[] = [];
    try {
      for (const relativePath of minimalManagedPrefixes(managedStatePrefixes(this.#config))) {
        const originalPath = safeJoin(this.#repository.root, relativePath);
        if (!(await pathExists(originalPath))) {
          entries.push({ relativePath, originalPath, backupPath: null, fingerprint: null });
          continue;
        }
        await canonicalizeContainedPath(this.#repository.root, originalPath, {
          target: "managed verifier state",
          boundary: "repository",
        });
        if ((await lstat(originalPath)).isSymbolicLink()) {
          throw new SafetyError(`Counterlane-managed root cannot be a symbolic link during verification: ${relativePath}`);
        }
        const fingerprint = await fingerprintDependencyTree(originalPath, this.#config);
        const backupPath = join(stagingRoot, sha256(relativePath).slice(0, 24));
        await copyDependencyTree(originalPath, backupPath);
        assertMatchingFingerprint(
          fingerprint,
          await fingerprintDependencyTree(backupPath, this.#config),
          `Managed-state backup does not match ${relativePath}`,
        );
        entries.push({ relativePath, originalPath, backupPath, fingerprint });
      }
      return { stagingRoot, entries };
    } catch (error) {
      await removePath(stagingRoot).catch(() => undefined);
      throw error;
    }
  }

  async #managedStateMatches(snapshot: ManagedStateSnapshot): Promise<boolean> {
    for (const entry of snapshot.entries) {
      if (!(await this.#managedEntryMatches(entry))) return false;
    }
    return true;
  }

  async #restoreManagedState(snapshot: ManagedStateSnapshot): Promise<void> {
    for (const entry of snapshot.entries) {
      if (await this.#managedEntryMatches(entry)) continue;
      await removePath(entry.originalPath);
      if (entry.backupPath === null || entry.fingerprint === null) continue;
      await copyDependencyTree(entry.backupPath, entry.originalPath);
      assertMatchingFingerprint(
        entry.fingerprint,
        await fingerprintDependencyTree(entry.originalPath, this.#config),
        `Managed-state restoration does not match ${entry.relativePath}`,
      );
    }
  }

  async #managedEntryMatches(entry: ManagedStateEntry): Promise<boolean> {
    const exists = await pathExists(entry.originalPath);
    if (entry.fingerprint === null) return !exists;
    if (!exists || (await lstat(entry.originalPath)).isSymbolicLink()) return false;
    return dependencyFingerprintEquals(
      entry.fingerprint,
      await fingerprintDependencyTree(entry.originalPath, this.#config),
    );
  }

  async #restoreOriginalState(baseline: string, snapshot: SnapshotBundle): Promise<void> {
    const mutationPatch = await this.#repository.git(
      ["diff", "--binary", "--no-ext-diff", baseline],
      { cwd: this.#repository.root, timeoutMs: 120_000 },
    );
    if (mutationPatch.length > 0) {
      await this.#repository.git(deterministicApplyArgs("--check", "--reverse", "--binary", "--whitespace=nowarn", "-"), {
        cwd: this.#repository.root,
        input: mutationPatch,
        timeoutMs: 120_000,
      });
      await this.#repository.git(deterministicApplyArgs("--reverse", "--binary", "--whitespace=nowarn", "-"), {
        cwd: this.#repository.root,
        input: mutationPatch,
        timeoutMs: 120_000,
      });
    }

    const beforeByPath = new Map(snapshot.untracked.map((entry) => [entry.path, entry]));
    const currentUntracked = await this.#repository.untrackedFiles(managedStatePrefixes(this.#config));
    for (const path of currentUntracked) {
      if (!beforeByPath.has(path)) await removePath(safeJoin(this.#repository.root, path));
    }
    for (const entry of snapshot.untracked) {
      await removePath(safeJoin(this.#repository.root, entry.path));
      await restoreUntracked(this.#repository.root, entry);
    }
  }

  async #prepareRoot(): Promise<string> {
    if (this.#configuredBase === null) {
      const canonicalBase = await ensureContainedDirectory(tmpdir(), this.#base, {
        target: "Counterlane temporary worktree base",
        boundary: "operating-system temporary directory",
      });
      const candidateRoot = resolveContainedPath(canonicalBase, relative(this.#base, this.#root), {
        target: "worktree root",
        boundary: "Counterlane temporary worktree base",
      });
      const root = await ensureContainedDirectory(canonicalBase, candidateRoot, {
        target: "worktree root",
        boundary: "Counterlane temporary worktree base",
      });
      this.#canonicalBase = canonicalBase;
      this.#canonicalRoot = root;
      return root;
    }

    const canonicalBase = await ensureContainedDirectory(this.#repository.root, this.#configuredBase, {
      target: "configured worktree base",
      boundary: "repository",
    });
    const candidateRoot = resolveContainedPath(canonicalBase, relative(this.#base, this.#root), {
      target: "worktree root",
      boundary: "configured worktree base",
    });
    const root = await ensureContainedDirectory(canonicalBase, candidateRoot, {
      target: "worktree root",
      boundary: "configured worktree base",
    });
    this.#canonicalBase = canonicalBase;
    this.#canonicalRoot = root;
    return root;
  }

  async #materializeDependencies(worktreePath: string): Promise<void> {
    for (const configuredPath of this.#config.twin.dependencyDirectories) {
      const normalizedPath = configuredPath.replaceAll("\\", "/");
      const destination = safeJoin(worktreePath, normalizedPath);
      if (await pathExists(destination)) continue;
      const snapshot = await this.#getDependencySnapshot(normalizedPath, worktreePath);
      if (snapshot === null) continue;
      await assertDependencyTreeSymlinks(snapshot.path, destination, worktreePath);
      assertMatchingFingerprint(
        snapshot.fingerprint,
        await fingerprintDependencyTree(snapshot.path, this.#config),
        `Dependency snapshot changed before materializing ${normalizedPath}`,
      );
      await mkdir(dirname(destination), { recursive: true });
      await copyDependencyTree(snapshot.path, destination);
      await assertDependencyTreeSymlinks(destination, destination, worktreePath);
      const [snapshotAfter, destinationFingerprint] = await Promise.all([
        fingerprintDependencyTree(snapshot.path, this.#config),
        fingerprintDependencyTree(destination, this.#config),
      ]);
      assertMatchingFingerprint(snapshot.fingerprint, snapshotAfter, `Dependency snapshot changed while materializing ${normalizedPath}`);
      assertMatchingFingerprint(snapshot.fingerprint, destinationFingerprint, `Dependency copy does not match shared snapshot: ${normalizedPath}`);
    }
  }

  async #getDependencySnapshot(normalizedPath: string, worktreePath: string): Promise<DependencySnapshot | null> {
    let snapshot = this.#dependencySnapshots.get(normalizedPath);
    if (snapshot === undefined) {
      snapshot = this.#createDependencySnapshot(normalizedPath, worktreePath);
      this.#dependencySnapshots.set(normalizedPath, snapshot);
    }
    return snapshot;
  }

  async #createDependencySnapshot(normalizedPath: string, worktreePath: string): Promise<DependencySnapshot | null> {
    const source = safeJoin(this.#repository.root, normalizedPath);
    if (!(await pathExists(source)) || !(await this.#isGitIgnored(normalizedPath))) return null;
    const metadata = await lstat(source);
    if (!metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new SafetyError(`Configured dependency path is not a directory: ${normalizedPath}`);
    }
    await assertDependencyTreeSymlinks(source, safeJoin(worktreePath, normalizedPath), worktreePath);
    const before = await fingerprintDependencyTree(source, this.#config);
    if (this.#canonicalRoot === undefined) throw new SafetyError("Worktree root is unavailable for dependency staging.");
    const stagingRoot = await ensureContainedDirectory(
      this.#canonicalRoot,
      join(this.#canonicalRoot, ".dependency-snapshots"),
      { target: "dependency snapshot root", boundary: "worktree root" },
    );
    const snapshotPath = resolveContainedPath(stagingRoot, sha256(normalizedPath).slice(0, 24), {
      target: "dependency snapshot",
      boundary: "dependency snapshot root",
    });
    await copyDependencyTree(source, snapshotPath);
    const [sourceAfter, snapshotFingerprint] = await Promise.all([
      fingerprintDependencyTree(source, this.#config),
      fingerprintDependencyTree(snapshotPath, this.#config),
    ]);
    assertMatchingFingerprint(before, sourceAfter, `Source dependency changed while snapshotting ${normalizedPath}`);
    assertMatchingFingerprint(before, snapshotFingerprint, `Dependency snapshot does not match source: ${normalizedPath}`);
    return { path: snapshotPath, fingerprint: snapshotFingerprint };
  }

  async #isGitIgnored(path: string): Promise<boolean> {
    const result = await runCommand(["git", "check-ignore", "-q", "-z", "--stdin"], {
      cwd: this.#repository.root,
      timeoutMs: 30_000,
      maximumOutputBytes: 64_000,
      input: `${path}\0`,
    });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new SafetyError(`Unable to determine whether dependency path is Git-ignored: ${path}`, {
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }

  async #removeWorktree(path: string, root: string): Promise<void> {
    const safePath = await canonicalizeContainedPath(root, path, {
      target: "worktree arm",
      boundary: "worktree root",
    });
    await this.#withWorktreeMutation(() => this.#repository.git(
      ["worktree", "remove", "--force", safePath],
      { timeoutMs: 120_000 },
    ));
  }

  async #withWorktreeMutation<T>(operation: () => Promise<T>): Promise<T> {
    return withRepositoryWorktreeMutation(this.#repository.root, operation);
  }

  public async assertSafeSymlinks(worktreePath: string): Promise<void> {
    const paths = new Set<string>();
    const tracked = await this.#repository.git(["ls-files", "-z"], { cwd: worktreePath });
    for (const path of tracked.split("\0").filter(Boolean)) {
      const absolute = safeJoin(worktreePath, path);
      try {
        if ((await lstat(absolute)).isSymbolicLink()) paths.add(path);
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    const untracked = await this.#repository.git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: worktreePath });
    for (const path of untracked.split("\0").filter(Boolean)) {
      const absolute = safeJoin(worktreePath, path);
      if ((await lstat(absolute)).isSymbolicLink()) {
        paths.add(path);
      }
    }

    for (const path of paths) {
      const absolute = safeJoin(worktreePath, path);
      const target = await readlink(absolute);
      assertSafeSymlinkTarget(worktreePath, path, target);
    }
    for (const dependencyPath of this.#config.twin.dependencyDirectories) {
      const dependencyRoot = safeJoin(worktreePath, dependencyPath);
      if (await pathExists(dependencyRoot)) {
        await assertDependencyTreeSymlinks(dependencyRoot, dependencyRoot, worktreePath);
      }
    }
  }

  public async cleanup(success: boolean): Promise<void> {
    if (this.#forcePreserve && this.#handles.length > 0) return;
    const cleanupErrors: unknown[] = [];
    try {
      await this.#assertSharedGitControlsUnchanged();
    } catch (error) {
      cleanupErrors.push(error);
    }
    const preserve = this.#config.twin.preserveWorktrees;
    const shouldPreserve = preserve === "always" || (preserve === "on-failure" && !success);
    if (shouldPreserve && this.#handles.length > 0) {
      throwCleanupErrors(cleanupErrors);
      return;
    }
    const root = await this.#safeCleanupRoot();
    if (root === null) {
      throwCleanupErrors(cleanupErrors);
      return;
    }
    const unregisterErrors: unknown[] = [];
    for (const handle of [...this.#handles].reverse()) {
      try {
        await this.#removeWorktree(handle.path, root);
      } catch (error) {
        unregisterErrors.push(error);
      }
    }
    await this.#withWorktreeMutation(() =>
      this.#repository.git(["worktree", "prune"], { timeoutMs: 120_000 }),
    ).catch(() => undefined);
    if (unregisterErrors.length > 0) {
      cleanupErrors.push(new SafetyError("Unable to unregister every isolated worktree; preserving the bounded worktree root for recovery.", {
        root,
        errors: unregisterErrors.map(errorMessage),
      }));
      throwCleanupErrors(cleanupErrors);
      return;
    }
    try {
      const safeRoot = await this.#safeCleanupRoot();
      if (safeRoot !== null) await removeWorktreeRoot(safeRoot);
    } catch (error) {
      cleanupErrors.push(error);
    }
    throwCleanupErrors(cleanupErrors);
  }

  async #safeCleanupRoot(): Promise<string | null> {
    if (this.#canonicalBase === undefined || this.#canonicalRoot === undefined || !(await pathExists(this.#canonicalRoot))) {
      return null;
    }
    const canonicalBase = await canonicalizeContainedPath(
      this.#configuredBase === null ? tmpdir() : this.#repository.root,
      this.#base,
      {
        target: this.#configuredBase === null ? "Counterlane temporary worktree base" : "configured worktree base",
        boundary: this.#configuredBase === null ? "operating-system temporary directory" : "repository",
      },
    );
    return canonicalizeContainedPath(canonicalBase, this.#canonicalRoot, {
      target: "worktree root",
      boundary: this.#configuredBase === null ? "Counterlane temporary worktree base" : "configured worktree base",
    });
  }
}

async function withRepositoryWorktreeMutation<T>(
  repositoryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedRoot = resolve(repositoryRoot);
  const key = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const previous = repositoryWorktreeMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  repositoryWorktreeMutationTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (repositoryWorktreeMutationTails.get(key) === tail) {
      repositoryWorktreeMutationTails.delete(key);
    }
  }
}

export async function removeWorktreeRoot(
  root: string,
  remove: (path: string) => Promise<void> = removePath,
): Promise<void> {
  try {
    await remove(root);
  } catch (error) {
    throw new SafetyError("Unable to remove the bounded worktree root; preserving it for recovery.", {
      root,
      error: errorMessage(error),
    });
  }
}

async function copyDependencyTree(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

async function fingerprintDependencyTree(
  root: string,
  config: CounterlaneConfig,
): Promise<DependencyFingerprint> {
  const hash = createHash("sha256");
  const pending = [{ absolute: root, relativePath: "" }];
  let fileCount = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const metadata = await lstat(current.absolute);
    fileCount += 1;
    if (fileCount > config.twin.maximumDependencyFiles) {
      throw new SafetyError(`Dependency snapshot exceeds ${config.twin.maximumDependencyFiles} filesystem entries.`);
    }
    const mode = metadata.mode & 0o777;
    if (metadata.isSymbolicLink()) {
      hash.update(`${JSON.stringify([current.relativePath, "symlink", mode, await readlink(current.absolute)])}\n`);
      continue;
    }
    if (metadata.isDirectory()) {
      hash.update(`${JSON.stringify([current.relativePath, "directory", mode])}\n`);
      const names = await readdir(current.absolute);
      names.sort(comparePathSegments);
      for (const name of names.reverse()) {
        pending.push({
          absolute: join(current.absolute, name),
          relativePath: current.relativePath.length === 0 ? name : `${current.relativePath}/${name}`,
        });
      }
      continue;
    }
    if (!metadata.isFile()) {
      throw new SafetyError(`Dependency snapshot contains an unsupported filesystem entry: ${current.relativePath}`);
    }
    totalBytes += metadata.size;
    if (totalBytes > config.twin.maximumDependencyBytes) {
      throw new SafetyError(`Dependency snapshot exceeds ${config.twin.maximumDependencyBytes} bytes.`);
    }
    hash.update(`${JSON.stringify([current.relativePath, "file", mode, metadata.size])}\n`);
    for await (const chunk of createReadStream(current.absolute)) hash.update(chunk as Buffer);
    hash.update("\n");
  }
  return { digest: hash.digest("hex"), fileCount, totalBytes };
}

function comparePathSegments(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseLocalBranches(value: string): LocalBranchState[] {
  return value
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator <= 0 || separator === line.length - 1) {
        throw new SafetyError("Git returned a malformed local-branch record while protecting verifier state.");
      }
      return { ref: line.slice(0, separator), objectId: line.slice(separator + 1) };
    })
    .sort((left, right) => comparePathSegments(left.ref, right.ref));
}

function localBranchStateEquals(left: readonly LocalBranchState[], right: readonly LocalBranchState[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined && entry.ref === candidate.ref && entry.objectId === candidate.objectId;
  });
}

function parseSpecialIndexFlags(value: string): string[] {
  return value
    .split("\0")
    .filter((record) => {
      const tag = record[0];
      return tag === "S" || (tag !== undefined && tag >= "a" && tag <= "z");
    })
    .sort(comparePathSegments);
}

function stringArrayEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function gitControlStateEquals(left: GitControlState, right: GitControlState): boolean {
  return gitControlStateSemanticallyEquals(left, right) && gitIndexStateEquals(left, right);
}

function gitControlStateSemanticallyEquals(left: GitControlState, right: GitControlState): boolean {
  return left.headCommit === right.headCommit &&
    left.branch === right.branch &&
    left.indexTree === right.indexTree &&
    stringArrayEquals(left.specialIndexFlags, right.specialIndexFlags) &&
    left.indexPath === right.indexPath &&
    localBranchStateEquals(left.localBranches, right.localBranches);
}

function gitIndexStateEquals(left: GitControlState, right: GitControlState): boolean {
  return left.indexPath === right.indexPath &&
    left.indexMode === right.indexMode &&
    sha256(left.indexContents) === sha256(right.indexContents);
}

function sharedGitControlStateEquals(left: SharedGitControlState, right: SharedGitControlState): boolean {
  return left.configPath === right.configPath &&
    left.configMode === right.configMode &&
    sha256(left.configContents) === sha256(right.configContents) &&
    localBranchStateEquals(left.refs, right.refs) &&
    gitControlStateEquals(left.originalControl, right.originalControl);
}

function sharedGitControlStateSemanticallyEquals(left: SharedGitControlState, right: SharedGitControlState): boolean {
  return left.configPath === right.configPath &&
    left.configMode === right.configMode &&
    sha256(left.configContents) === sha256(right.configContents) &&
    localBranchStateEquals(left.refs, right.refs) &&
    gitControlStateSemanticallyEquals(left.originalControl, right.originalControl);
}

function minimalManagedPrefixes(prefixes: readonly string[]): string[] {
  const normalized = [...new Set(prefixes
    .map((prefix) => prefix.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, ""))
    .filter((prefix) => prefix.length > 0))]
    .sort(comparePathSegments);
  return normalized.filter((prefix, index) => !normalized.some((candidate, candidateIndex) =>
    candidateIndex !== index && prefix.startsWith(`${candidate}/`),
  ));
}

function throwCleanupErrors(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Worktree cleanup encountered multiple failures.");
  }
}

function assertMatchingFingerprint(
  expected: DependencyFingerprint,
  actual: DependencyFingerprint,
  message: string,
): void {
  if (
    expected.digest === actual.digest &&
    expected.fileCount === actual.fileCount &&
    expected.totalBytes === actual.totalBytes
  ) {
    return;
  }
  throw new SafetyError(message, {
    expectedDigest: expected.digest,
    actualDigest: actual.digest,
    expectedFileCount: expected.fileCount,
    actualFileCount: actual.fileCount,
    expectedBytes: expected.totalBytes,
    actualBytes: actual.totalBytes,
  });
}

function dependencyFingerprintEquals(left: DependencyFingerprint, right: DependencyFingerprint): boolean {
  return left.digest === right.digest &&
    left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes;
}

async function assertDependencyTreeSymlinks(
  sourceRoot: string,
  destinationRoot: string,
  worktreeRoot: string,
): Promise<void> {
  const pending = [{ source: sourceRoot, destination: destinationRoot }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const metadata = await lstat(current.source);
    if (metadata.isSymbolicLink()) {
      const linkPath = relative(worktreeRoot, current.destination).replaceAll("\\", "/");
      assertSafeSymlinkTarget(worktreeRoot, linkPath, await readlink(current.source));
      continue;
    }
    if (!metadata.isDirectory()) continue;
    const names = await readdir(current.source);
    for (const name of names) {
      pending.push({
        source: join(current.source, name),
        destination: join(current.destination, name),
      });
    }
  }
}

async function restoreUntracked(worktreeRoot: string, entry: UntrackedSnapshotEntry): Promise<void> {
  const destination = safeJoin(worktreeRoot, entry.path);
  await mkdir(dirname(destination), { recursive: true });
  if (entry.kind === "symlink") {
    await symlink(entry.contents.toString("utf8"), destination);
  } else {
    await writeFile(destination, entry.contents);
    await chmod(destination, entry.mode & 0o777);
  }
}

function safeJoin(root: string, relativePath: string): string {
  const destination = resolve(root, relativePath);
  const rel = relative(root, destination);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new SafetyError(`Refusing to write path outside worktree: ${relativePath}`);
  }
  return destination;
}

function assertSafeDependencyDirectories(repositoryRoot: string, config: CounterlaneConfig): void {
  const dependencies = config.twin.dependencyDirectories.map((path) => resolve(repositoryRoot, path));
  const reserved = [
    resolve(repositoryRoot, config.dataDirectory),
    ...(config.twin.worktreeBaseDirectory === null
      ? []
      : [resolve(repositoryRoot, config.twin.worktreeBaseDirectory)]),
  ];
  for (const [index, dependency] of dependencies.entries()) {
    if (reserved.some((path) => absolutePathsOverlap(dependency, path))) {
      throw new SafetyError(`Dependency directory overlaps Counterlane-managed state: ${config.twin.dependencyDirectories[index]}`);
    }
    if (dependencies.slice(0, index).some((path) => absolutePathsOverlap(dependency, path))) {
      throw new SafetyError(`Dependency directories overlap: ${config.twin.dependencyDirectories[index]}`);
    }
  }
}

function absolutePathsOverlap(left: string, right: string): boolean {
  return pathIsWithin(left, right) || pathIsWithin(right, left);
}

function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertSafeSymlinkTarget(root: string, linkPath: string, target: string): void {
  if (isAbsolute(target)) {
    throw new SafetyError(`Refusing absolute symlink in isolated worktree: ${linkPath} -> ${target}`);
  }
  const linkDirectory = dirname(safeJoin(root, linkPath));
  const resolvedTarget = resolve(linkDirectory, target);
  const rel = relative(root, resolvedTarget);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new SafetyError(`Refusing symlink that escapes isolated worktree: ${linkPath} -> ${target}`);
  }
  const normalized = rel.replaceAll("\\", "/");
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    throw new SafetyError(`Refusing symlink into Git metadata: ${linkPath} -> ${target}`);
  }
}

function deterministicApplyArgs(...args: string[]): string[] {
  return deterministicGitArgs("apply", ...args);
}

function deterministicGitArgs(...args: string[]): string[] {
  return [
    "-c", "core.autocrlf=false",
    "-c", "core.safecrlf=false",
    ...args,
  ];
}

function deterministicGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.safecrlf",
    GIT_CONFIG_VALUE_1: "false",
  };
}

async function runGitCommit(repository: GitRepository, cwd: string, message: string, date: string): Promise<void> {
  const args = [
    "-c",
    "user.name=Counterlane",
    "-c",
    "user.email=counterlane@local.invalid",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "--no-verify",
    "-m",
    message,
  ];
  await repository.git(args, {
    cwd,
    timeoutMs: 120_000,
    environment: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
}

export function summarizeUnifiedDiff(diff: string): DiffSummary {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  let newFiles = 0;
  let deletedFiles = 0;
  let binaryFiles = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      filesChanged += 1;
    } else if (line.startsWith("new file mode ")) {
      newFiles += 1;
    } else if (line.startsWith("deleted file mode ")) {
      deletedFiles += 1;
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binaryFiles += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      insertions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }

  return { filesChanged, insertions, deletions, newFiles, deletedFiles, binaryFiles };
}
