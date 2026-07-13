import { strict as assert } from "node:assert";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { captureSnapshot, currentContentHash } from "../../src/git/snapshot.js";
import { GitRepository, parsePorcelainV1Z } from "../../src/git/repository.js";
import { createTestRepository, git } from "../helpers.js";

void test("porcelain v1 -z parsing keeps rename destinations and literal arrows", () => {
  const status = [
    "R  renamed file.ts",
    "old file.ts",
    " M stable.ts",
    "?? fresh -> literal.ts",
    "",
  ].join("\0");
  assert.deepEqual(parsePorcelainV1Z(status), [
    "renamed file.ts",
    "stable.ts",
    "fresh -> literal.ts",
  ]);
});

void test("content identity includes cached gitlink object ids", async () => {
  const root = await createTestRepository({ verifier: false });
  const firstCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, [
    "-c",
    "user.name=Counterlane Test",
    "-c",
    "user.email=test@local.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "second gitlink target",
  ]);
  const secondCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, ["update-index", "--add", "--cacheinfo", `160000,${firstCommit},vendor/submodule`]);
  const repository = await GitRepository.discover(root);
  const firstHash = await currentContentHash(repository);
  await git(root, ["update-index", "--cacheinfo", `160000,${secondCommit},vendor/submodule`]);
  const secondHash = await currentContentHash(repository);
  assert.notEqual(firstHash, secondHash);
});

void test("repository profiles include untracked source, tests, manifests, and sensitive paths", async () => {
  const root = await createTestRepository();
  const feature = join(root, "features", "auth");
  await mkdir(feature, { recursive: true });
  await Promise.all([
    writeFile(join(feature, "oauth.ts"), "export const sensitive = true;\n", "utf8"),
    writeFile(join(feature, "oauth.test.ts"), "export const covered = true;\n", "utf8"),
    writeFile(join(feature, "package.json"), '{"name":"untracked-auth"}\n', "utf8"),
  ]);
  const profile = await (await GitRepository.discover(root)).profile();

  assert.equal(profile.untrackedFileCount, 3);
  assert.ok((profile.languages["TypeScript"] ?? 0) >= 2);
  assert.ok(profile.testFileCount >= 2);
  assert.equal(profile.packageCount, 2);
  assert.ok(profile.manifests.includes("features/auth/package.json"));
  assert.ok(profile.sensitivePathHits.includes("features/auth/oauth.ts"));
});

void test("repository profiling fails closed when source changes during capture", async () => {
  const root = await createTestRepository();
  const repository = await GitRepository.discover(root);
  const originalGit = repository.git.bind(repository);
  let profileStateReads = 0;
  repository.git = async (args, options = {}) => {
    const output = await originalGit(args, options);
    if (args[0] === "status" && args.includes("--porcelain=v2")) {
      profileStateReads += 1;
      if (profileStateReads === 1) {
        await writeFile(join(root, "profile-drift.ts"), "export const drift = true;\n", "utf8");
      }
    }
    return output;
  };

  try {
    await assert.rejects(repository.profile(), /source changed while its routing profile was being captured/u);
  } finally {
    repository.git = originalGit;
  }
});

void test("GitRepository rejects structurally truncated exact command output", async () => {
  const root = await createTestRepository({ verifier: false });
  const repository = await GitRepository.discover(root);

  await assert.rejects(
    repository.git(["show", "HEAD:answer.txt"], { maximumOutputBytes: 4 }),
    (error: unknown) => {
      assert.match(String(error), /Git command output was truncated/u);
      assert.equal((error as { details?: { stdoutTruncated?: boolean } }).details?.stdoutTruncated, true);
      return true;
    },
  );
});

void test("snapshot capture rejects excess untracked file count before reading contents", async () => {
  const root = await createTestRepository({ verifier: false });
  await Promise.all([
    writeFile(join(root, "first-untracked.txt"), "a", "utf8"),
    writeFile(join(root, "second-untracked.txt"), "b", "utf8"),
  ]);
  const repository = await GitRepository.discover(root);

  await assert.rejects(
    captureSnapshot(repository, [], { maximumUntrackedFiles: 1, maximumUntrackedBytes: 100 }),
    /Untracked snapshot exceeds the 1-file safety limit/u,
  );
});

void test("snapshot capture rejects cumulative untracked bytes before an oversized read", async () => {
  const root = await createTestRepository({ verifier: false });
  await Promise.all([
    writeFile(join(root, "first-untracked.txt"), "12", "utf8"),
    writeFile(join(root, "second-untracked.txt"), "345", "utf8"),
  ]);
  const repository = await GitRepository.discover(root);

  await assert.rejects(
    captureSnapshot(repository, [], { maximumUntrackedFiles: 10, maximumUntrackedBytes: 4 }),
    /Untracked snapshot exceeds the 4-byte safety limit/u,
  );
});

void test("content identity rejects an oversized sparse file before allocating its contents", async () => {
  const root = await createTestRepository({ verifier: false });
  const sparsePath = join(root, "oversized-sparse.bin");
  const handle = await open(sparsePath, "w");
  try {
    await handle.truncate(16 * 1024);
  } finally {
    await handle.close();
  }
  const repository = await GitRepository.discover(root);

  await assert.rejects(
    currentContentHash(repository, [], root, { maximumFiles: 100, maximumBytes: 8 * 1024 }),
    /Content identity exceeds the 8192-byte safety limit/u,
  );
});
