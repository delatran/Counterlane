import { createHash } from "node:crypto";
import { lstat, open, readlink } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { SafetyError } from "../core/errors.js";
import type { SnapshotManifest } from "../core/types.js";
import { sha256, stableStringify, unique } from "../core/utils.js";
import { GitRepository } from "./repository.js";

export interface SnapshotCaptureLimits {
  maximumUntrackedFiles: number;
  maximumUntrackedBytes: number;
}

export const DEFAULT_SNAPSHOT_CAPTURE_LIMITS: Readonly<SnapshotCaptureLimits> = Object.freeze({
  maximumUntrackedFiles: 50_000,
  maximumUntrackedBytes: 512 * 1024 * 1024,
});

export interface ContentHashLimits {
  maximumFiles: number;
  maximumBytes: number;
}

export const DEFAULT_CONTENT_HASH_LIMITS: Readonly<ContentHashLimits> = Object.freeze({
  maximumFiles: 250_000,
  maximumBytes: 1024 * 1024 * 1024,
});

export interface UntrackedSnapshotEntry {
  path: string;
  kind: "file" | "symlink";
  mode: number;
  contents: Buffer;
  contentHash: string;
  size: number;
}

export interface SnapshotBundle {
  manifest: SnapshotManifest;
  trackedPatch: string;
  untracked: UntrackedSnapshotEntry[];
}

type SnapshotIdentityEntry = Omit<UntrackedSnapshotEntry, "contents">;
type FileMetadata = Awaited<ReturnType<typeof lstat>>;

export async function captureSnapshot(
  repository: GitRepository,
  ignoredPrefixes: readonly string[] = [],
  limits: Readonly<SnapshotCaptureLimits> = DEFAULT_SNAPSHOT_CAPTURE_LIMITS,
): Promise<SnapshotBundle> {
  validateSnapshotLimits(limits);
  await assertManagedPrefixesUntracked(repository, ignoredPrefixes, repository.root);
  await assertNoSpecialIndexFlags(repository, repository.root);
  const unmerged = await repository.git(["ls-files", "--unmerged", "-z"]);
  if (unmerged.length > 0) {
    const paths = unique(unmerged.split("\0").filter(Boolean).map((record) => record.slice(record.indexOf("\t") + 1)));
    throw new SafetyError("Counterlane cannot snapshot a repository with unresolved merge conflicts.", {
      paths: paths.slice(0, 20),
      additionalPathCount: Math.max(0, paths.length - 20),
    });
  }
  const [headCommit, branch, trackedPatch, untrackedPaths, treeHash] = await Promise.all([
    repository.headCommit(),
    repository.branch(),
    repository.git(["diff", "--binary", "--no-ext-diff", "HEAD"]),
    repository.untrackedFiles(ignoredPrefixes),
    repository.git(["rev-parse", "HEAD^{tree}"]),
  ]);

  assertUntrackedFileCount(untrackedPaths, limits);

  const untracked: UntrackedSnapshotEntry[] = [];
  let capturedBytes = 0;
  for (const path of untrackedPaths.sort()) {
    const absolute = repository.resolveRelative(path);
    const captured = await readUntrackedEntry(absolute, path, limits.maximumUntrackedBytes - capturedBytes, limits);
    if (captured === null) continue;
    capturedBytes += captured.identity.size;
    untracked.push({ ...captured.identity, contents: captured.contents });
  }

  const workingStateHash = hashWorkingState(trackedPatch, untracked);
  const createdAt = new Date().toISOString();
  const manifest: SnapshotManifest = {
    repositoryRoot: repository.root,
    headCommit,
    branch,
    baselineTreeHash: treeHash.trim(),
    workingStateHash,
    trackedPatchHash: sha256(trackedPatch),
    untrackedFiles: untracked.map(({ path, kind, mode, contentHash, size }) => ({
      path,
      kind,
      mode,
      contentHash,
      size,
    })),
    createdAt,
  };

  const [currentHash, currentHead, currentBranch, currentTree, currentUnmerged] = await Promise.all([
    currentWorkingStateHash(repository, ignoredPrefixes, repository.root, limits),
    repository.headCommit(),
    repository.branch(),
    repository.git(["rev-parse", "HEAD^{tree}"]),
    repository.git(["ls-files", "--unmerged", "-z"]),
  ]);
  if (
    currentHash !== workingStateHash ||
    currentHead !== headCommit ||
    currentBranch !== branch ||
    currentTree.trim() !== treeHash.trim() ||
    currentUnmerged.length > 0
  ) {
    throw new SafetyError("Repository state changed while Counterlane was capturing its snapshot; retry from a stable checkout.", {
      expectedWorkingStateHash: workingStateHash,
      actualWorkingStateHash: currentHash,
      expectedHeadCommit: headCommit,
      actualHeadCommit: currentHead,
      expectedBranch: branch,
      actualBranch: currentBranch,
      unresolvedMergeStateAppeared: currentUnmerged.length > 0,
    });
  }

  return { manifest, trackedPatch, untracked };
}

export async function currentWorkingStateHash(
  repository: GitRepository,
  ignoredPrefixes: readonly string[] = [],
  cwd = repository.root,
  limits: Readonly<SnapshotCaptureLimits> = DEFAULT_SNAPSHOT_CAPTURE_LIMITS,
): Promise<string> {
  validateSnapshotLimits(limits);
  await assertManagedPrefixesUntracked(repository, ignoredPrefixes, cwd);
  await assertNoSpecialIndexFlags(repository, cwd);
  const trackedPatch = await repository.git(["diff", "--binary", "--no-ext-diff", "HEAD"], { cwd });
  const untrackedPaths = await repository.untrackedFiles(ignoredPrefixes, cwd);
  assertUntrackedFileCount(untrackedPaths, limits);
  const entries: SnapshotIdentityEntry[] = [];
  let capturedBytes = 0;
  for (const path of untrackedPaths.sort()) {
    const absolute = resolve(cwd, path);
    const captured = await readUntrackedEntry(absolute, path, limits.maximumUntrackedBytes - capturedBytes, limits);
    if (captured === null) continue;
    capturedBytes += captured.identity.size;
    entries.push(captured.identity);
  }
  return hashWorkingState(trackedPatch, entries);
}

export async function currentContentHash(
  repository: GitRepository,
  ignoredPrefixes: readonly string[] = [],
  cwd = repository.root,
  limits: Readonly<ContentHashLimits> = DEFAULT_CONTENT_HASH_LIMITS,
): Promise<string> {
  validateContentHashLimits(limits);
  const [listed, staged] = await Promise.all([
    repository.git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd }),
    repository.git(["ls-files", "--stage", "-z"], { cwd }),
  ]);
  const gitlinks = parseGitlinks(staged);
  const paths = unique(listed.split("\0").filter(Boolean))
    .filter((path) => !isIgnoredSnapshotPath(path, ignoredPrefixes))
    .sort();
  if (paths.length > limits.maximumFiles) {
    throw new SafetyError(`Content identity exceeds the ${limits.maximumFiles}-file safety limit.`, {
      maximumFiles: limits.maximumFiles,
      observedFiles: paths.length,
    });
  }
  const entries: Array<Record<string, unknown>> = [];
  let hashedBytes = 0;
  for (const path of paths) {
    const gitlinkObjectId = gitlinks.get(path);
    if (gitlinkObjectId !== undefined) {
      entries.push({ path, kind: "gitlink", objectId: gitlinkObjectId });
      continue;
    }
    const absolute = resolve(cwd, path);
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        const contents = Buffer.from(await readlink(absolute), "utf8");
        assertContentBytesWithinLimit(path, contents.length, limits.maximumBytes - hashedBytes, limits);
        hashedBytes += contents.length;
        entries.push({ path, kind: "symlink", executable: false, contentHash: sha256(contents) });
      } else if (metadata.isFile()) {
        assertContentBytesWithinLimit(path, metadata.size, limits.maximumBytes - hashedBytes, limits);
        const hashed = await hashRegularFileWithinLimit(
          absolute,
          path,
          limits.maximumBytes - hashedBytes,
          limits,
          metadata,
        );
        hashedBytes += hashed.size;
        entries.push({
          path,
          kind: "file",
          executable: hashed.executable,
          contentHash: hashed.contentHash,
        });
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        entries.push({ path, kind: "missing", executable: false, contentHash: null });
      } else {
        throw error;
      }
    }
  }
  return sha256(stableStringify(entries));
}

async function hashRegularFileWithinLimit(
  absolute: string,
  path: string,
  remainingBytes: number,
  limits: Readonly<ContentHashLimits>,
  expectedMetadata: FileMetadata,
): Promise<{ contentHash: string; size: number; executable: boolean }> {
  const handle = await open(absolute, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new SafetyError(`Content identity path changed type while being read: ${path}`, { path });
    assertSameOpenedFile(path, expectedMetadata, before);
    assertContentBytesWithinLimit(path, before.size, remainingBytes, limits);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.length, before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const { bytesRead: overflowBytes } = await handle.read(overflowProbe, 0, 1, offset);
    const after = await handle.stat();
    if (
      overflowBytes > 0 ||
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode
    ) {
      throw new SafetyError(`File changed while Counterlane was computing content identity: ${path}`, {
        path,
        beforeSize: before.size,
        afterSize: after.size,
        bytesRead: offset,
      });
    }
    return { contentHash: hash.digest("hex"), size: offset, executable: (before.mode & 0o111) !== 0 };
  } finally {
    await handle.close();
  }
}

function assertContentBytesWithinLimit(
  path: string,
  nextBytes: number,
  remainingBytes: number,
  limits: Readonly<ContentHashLimits>,
): void {
  if (Number.isSafeInteger(nextBytes) && nextBytes >= 0 && nextBytes <= remainingBytes) return;
  throw new SafetyError(`Content identity exceeds the ${limits.maximumBytes}-byte safety limit.`, {
    path,
    maximumBytes: limits.maximumBytes,
    remainingBytes,
    observedNextBytes: Number.isFinite(nextBytes) ? nextBytes : null,
  });
}

function validateContentHashLimits(limits: Readonly<ContentHashLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SafetyError(`Content identity limit ${name} must be a non-negative safe integer.`, { name, value });
    }
  }
}

function parseGitlinks(value: string): Map<string, string> {
  const gitlinks = new Map<string, string>();
  for (const record of value.split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const metadata = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    const [mode, objectId, stage] = metadata;
    if (mode === "160000" && objectId !== undefined && stage === "0") {
      gitlinks.set(path, objectId);
    }
  }
  return gitlinks;
}

function isIgnoredSnapshotPath(path: string, ignoredPrefixes: readonly string[]): boolean {
  const normalized = path.replaceAll("\\", "/");
  return ignoredPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return normalizedPrefix.length > 0 && (normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`));
  });
}

function hashWorkingState(trackedPatch: string, untracked: readonly SnapshotIdentityEntry[]): string {
  return sha256(
    stableStringify({
      trackedPatchHash: sha256(trackedPatch),
      untracked: untracked.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        contentHash: entry.contentHash,
        size: entry.size,
      })),
    }),
  );
}

async function readUntrackedEntry(
  absolute: string,
  path: string,
  remainingBytes: number,
  limits: Readonly<SnapshotCaptureLimits>,
): Promise<{ identity: SnapshotIdentityEntry; contents: Buffer } | null> {
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(absolute);
    const size = Buffer.byteLength(target, "utf8");
    assertUntrackedBytesWithinLimit(path, size, remainingBytes, limits, "while reading a symbolic-link target");
    const contents = Buffer.from(target, "utf8");
    return {
      identity: { path, kind: "symlink", mode: metadata.mode, contentHash: sha256(contents), size },
      contents,
    };
  }
  if (!metadata.isFile()) return null;

  assertUntrackedBytesWithinLimit(path, metadata.size, remainingBytes, limits, "before reading file contents");
  const contents = await readRegularFileWithinLimit(absolute, path, remainingBytes, limits, metadata);
  return {
    identity: {
      path,
      kind: "file",
      mode: metadata.mode,
      contentHash: sha256(contents),
      size: contents.length,
    },
    contents,
  };
}

async function readRegularFileWithinLimit(
  absolute: string,
  path: string,
  remainingBytes: number,
  limits: Readonly<SnapshotCaptureLimits>,
  expectedMetadata: FileMetadata,
): Promise<Buffer> {
  const handle = await open(absolute, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new SafetyError(`Untracked snapshot path changed type while being read: ${path}`, { path });
    }
    assertSameOpenedFile(path, expectedMetadata, metadata);
    assertUntrackedBytesWithinLimit(path, metadata.size, remainingBytes, limits, "after opening file contents");

    const contents = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < contents.length) {
      const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    const overflowProbe = Buffer.allocUnsafe(1);
    const { bytesRead: overflowBytes } = await handle.read(overflowProbe, 0, 1, offset);
    if (overflowBytes > 0) {
      throw new SafetyError(`Untracked file grew while Counterlane was capturing its snapshot: ${path}`, {
        path,
        maximumUntrackedBytes: limits.maximumUntrackedBytes,
        remainingBytes,
        phase: "while reading file contents",
      });
    }
    // Do not retain the original allocation if the file shrank after stat();
    // otherwise its backing store would no longer match the cumulative byte
    // accounting used to bound the retained snapshot.
    return offset === contents.length ? contents : Buffer.from(contents.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

function assertSameOpenedFile(path: string, expected: FileMetadata, actual: FileMetadata): void {
  const expectedDevice = String(expected.dev);
  const expectedInode = String(expected.ino);
  const actualDevice = String(actual.dev);
  const actualInode = String(actual.ino);
  if (expectedDevice === actualDevice && expectedInode === actualInode) return;
  throw new SafetyError(`Snapshot path was replaced between inspection and open: ${path}`, {
    path,
    expectedDevice,
    expectedInode,
    actualDevice,
    actualInode,
  });
}

function assertUntrackedFileCount(
  paths: readonly string[],
  limits: Readonly<SnapshotCaptureLimits>,
): void {
  if (paths.length <= limits.maximumUntrackedFiles) return;
  throw new SafetyError(`Untracked snapshot exceeds the ${limits.maximumUntrackedFiles}-file safety limit.`, {
    maximumUntrackedFiles: limits.maximumUntrackedFiles,
    observedUntrackedFiles: paths.length,
  });
}

function assertUntrackedBytesWithinLimit(
  path: string,
  nextBytes: number,
  remainingBytes: number,
  limits: Readonly<SnapshotCaptureLimits>,
  phase: string,
): void {
  if (Number.isSafeInteger(nextBytes) && nextBytes >= 0 && nextBytes <= remainingBytes) return;
  throw new SafetyError(`Untracked snapshot exceeds the ${limits.maximumUntrackedBytes}-byte safety limit.`, {
    path,
    maximumUntrackedBytes: limits.maximumUntrackedBytes,
    remainingBytes,
    observedNextBytes: Number.isFinite(nextBytes) ? nextBytes : null,
    phase,
  });
}

function validateSnapshotLimits(limits: Readonly<SnapshotCaptureLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SafetyError(`Snapshot limit ${name} must be a non-negative safe integer.`, { name, value });
    }
  }
}

async function assertManagedPrefixesUntracked(
  repository: GitRepository,
  ignoredPrefixes: readonly string[],
  cwd: string,
): Promise<void> {
  if (ignoredPrefixes.length === 0) return;
  const tracked = (await repository.git(["--literal-pathspecs", "ls-files", "-z", "--", ...ignoredPrefixes], { cwd }))
    .split("\0")
    .filter(Boolean);
  if (tracked.length === 0) return;
  throw new SafetyError("Counterlane-managed repository paths must not contain tracked source files.", {
    paths: tracked.slice(0, 20),
    additionalPathCount: Math.max(0, tracked.length - 20),
  });
}

async function assertNoSpecialIndexFlags(repository: GitRepository, cwd: string): Promise<void> {
  const records = (await repository.git(["ls-files", "-v", "-z"], { cwd }))
    .split("\0")
    .filter(Boolean);
  const special = records.filter((record) => {
    const tag = record[0];
    return tag === "S" || (tag !== undefined && tag >= "a" && tag <= "z");
  });
  if (special.length === 0) return;
  throw new SafetyError("Counterlane cannot certify a repository with assume-unchanged or skip-worktree index flags.", {
    paths: special.slice(0, 20).map((record) => record.slice(2)),
    additionalPathCount: Math.max(0, special.length - 20),
  });
}

export function relativeSnapshotPath(repository: GitRepository, absolutePath: string): string {
  return relative(repository.root, absolutePath).replaceAll("\\", "/");
}
