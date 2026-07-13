import { extname, relative, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import { GitError } from "../core/errors.js";
import { runCommand } from "../core/process.js";
import type { RepoProfile } from "../core/types.js";
import { sha256, stableStringify, unique } from "../core/utils.js";

const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "Package.swift",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".kts": "Kotlin",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".cpp": "C++",
  ".cc": "C++",
  ".cxx": "C++",
  ".c": "C",
  ".h": "C/C++ Header",
  ".hpp": "C++ Header",
  ".swift": "Swift",
  ".scala": "Scala",
  ".sh": "Shell",
  ".sql": "SQL",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(auth|authentication|authorization|permissions?|rbac|acl)(\/|$)/iu,
  /(^|\/)(payments?|billing|checkout|ledger|wallet)(\/|$)/iu,
  /(^|\/)(migrations?|schema|database|db)(\/|$)/iu,
  /(^|\/)(crypto|cryptography|secrets?|tokens?|sessions?)(\/|$)/iu,
  /(^|\/)(security|iam|oauth|sso)(\/|$)/iu,
];

export class GitRepository {
  public readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  public static async discover(startDirectory = process.cwd()): Promise<GitRepository> {
    const result = await runCommand(["git", "rev-parse", "--show-toplevel"], {
      cwd: startDirectory,
      timeoutMs: 10_000,
      maximumOutputBytes: 64_000,
    });
    if (result.exitCode !== 0) {
      throw new GitError("The current directory is not inside a Git repository.", {
        cwd: startDirectory,
        stderr: result.stderr,
      });
    }
    assertCompleteGitOutput(result, ["rev-parse", "--show-toplevel"], startDirectory);
    return new GitRepository(resolve(result.stdout.trim()));
  }

  public async git(
    args: readonly string[],
    options: {
      input?: string;
      timeoutMs?: number;
      cwd?: string;
      environment?: NodeJS.ProcessEnv;
      maximumOutputBytes?: number;
    } = {},
  ): Promise<string> {
    const result = await runCommand(["git", ...args], {
      cwd: options.cwd ?? this.root,
      timeoutMs: options.timeoutMs ?? 60_000,
      maximumOutputBytes: options.maximumOutputBytes ?? 20_000_000,
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    });
    if (result.exitCode !== 0) {
      throw new GitError(`Git command failed: git ${args.join(" ")}`, {
        cwd: options.cwd ?? this.root,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    assertCompleteGitOutput(result, args, options.cwd ?? this.root);
    return result.stdout;
  }

  public async headCommit(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  public async branch(): Promise<string | null> {
    const branch = (await this.git(["branch", "--show-current"])).trim();
    return branch.length === 0 ? null : branch;
  }

  public async trackedFiles(): Promise<string[]> {
    return splitNull(await this.git(["ls-files", "-z"]));
  }

  public async untrackedFiles(ignoredPrefixes: readonly string[] = [], cwd = this.root): Promise<string[]> {
    return splitNull(await this.git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd }))
      .filter((path) => !isIgnoredPath(path, ignoredPrefixes));
  }

  public async changedFiles(ignoredPrefixes: readonly string[] = []): Promise<string[]> {
    const records = parsePorcelainV1Z(await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    return unique(
      records
        .filter((path) => !isIgnoredPath(path, ignoredPrefixes)),
    );
  }

  public async profile(ignoredPrefixes: readonly string[] = []): Promise<RepoProfile> {
    const stateBefore = await this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    const [headCommit, branch, trackedFiles, untrackedFiles, changedFiles, indexFlags] = await Promise.all([
      this.headCommit(),
      this.branch(),
      this.trackedFiles(),
      this.untrackedFiles(ignoredPrefixes),
      this.changedFiles(ignoredPrefixes),
      this.git(["ls-files", "-v", "-z"]),
    ]);
    const stateAfter = await this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
    if (stateBefore !== stateAfter) {
      throw new GitError("Repository source changed while its routing profile was being captured.");
    }
    const specialIndexFlags = indexFlags.split("\0").filter((record) => {
      const tag = record[0];
      return tag === "S" || (tag !== undefined && tag >= "a" && tag <= "z");
    });
    if (specialIndexFlags.length > 0) {
      throw new GitError("Counterlane cannot profile a repository with assume-unchanged or skip-worktree index flags.", {
        paths: specialIndexFlags.slice(0, 20).map((record) => record.slice(2)),
        additionalPathCount: Math.max(0, specialIndexFlags.length - 20),
      });
    }

    const trackedManagedPaths = trackedFiles.filter((path) => isIgnoredPath(path, ignoredPrefixes));
    if (trackedManagedPaths.length > 0) {
      throw new GitError("Counterlane-managed repository paths must not contain tracked source files.", {
        paths: trackedManagedPaths.slice(0, 20),
        additionalPathCount: Math.max(0, trackedManagedPaths.length - 20),
      });
    }

    const languages: Record<string, number> = {};
    const manifests: string[] = [];
    const sensitivePathHits: string[] = [];
    let testFileCount = 0;

    const semanticFiles = unique([...trackedFiles, ...untrackedFiles]);
    for (const path of semanticFiles) {
      const extension = extname(path).toLowerCase();
      const language = LANGUAGE_BY_EXTENSION[extension];
      if (language !== undefined) {
        languages[language] = (languages[language] ?? 0) + 1;
      }
      const name = path.split("/").at(-1) ?? path;
      if (MANIFEST_NAMES.has(name)) {
        manifests.push(path);
      }
      if (/(^|\/)(__tests__|tests?|spec)(\/|\.|$)/iu.test(path) || /\.(test|spec)\.[^.]+$/iu.test(path)) {
        testFileCount += 1;
      }
      if (SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path))) {
        sensitivePathHits.push(path);
      }
    }

    const verifierHints = detectVerifierHints(manifests, semanticFiles);
    const packageCount = manifests.filter((path) => /(^|\/)package\.json$/u.test(path)).length;
    const profileSeed = {
      headCommit,
      branch,
      trackedFileCount: trackedFiles.length,
      untrackedFileCount: untrackedFiles.length,
      changedFiles,
      languages,
      manifests,
      testFileCount,
      sensitivePathHits: sensitivePathHits.slice(0, 100),
    };

    return {
      root: this.root,
      headCommit,
      branch,
      dirty: changedFiles.length > 0,
      trackedFileCount: trackedFiles.length,
      untrackedFileCount: untrackedFiles.length,
      changedFileCount: changedFiles.length,
      packageCount,
      testFileCount,
      languages,
      sensitivePathHits: sensitivePathHits.slice(0, 100),
      manifests,
      verifierHints,
      profileHash: sha256(stableStringify(profileSeed)),
    };
  }

  public resolveRelative(path: string): string {
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel.startsWith(`..${sep}`) || rel === ".." || resolve(absolute) !== absolute) {
      throw new GitError(`Path escapes repository root: ${path}`);
    }
    return absolute;
  }

  public async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(this.resolveRelative(path))).isFile();
    } catch {
      return false;
    }
  }
}

function assertCompleteGitOutput(
  result: { stdout: string; stderr: string; stdoutTruncated: boolean; stderrTruncated: boolean },
  args: readonly string[],
  cwd: string,
): void {
  if (!result.stdoutTruncated && !result.stderrTruncated) return;
  throw new GitError(`Git command output was truncated: git ${args.join(" ")}`, {
    cwd,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

export function parsePorcelainV1Z(value: string): string[] {
  const records = value.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 3) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path.length > 0) paths.push(path);
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }
  return paths;
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function detectVerifierHints(manifests: readonly string[], trackedFiles: readonly string[]): string[] {
  const hints: string[] = [];
  if (manifests.some((path) => path.endsWith("package.json"))) {
    hints.push("node");
  }
  if (manifests.some((path) => path.endsWith("pyproject.toml") || path.endsWith("requirements.txt"))) {
    hints.push("python");
  }
  if (manifests.some((path) => path.endsWith("Cargo.toml"))) {
    hints.push("rust");
  }
  if (manifests.some((path) => path.endsWith("go.mod"))) {
    hints.push("go");
  }
  if (manifests.some((path) => path.endsWith("pom.xml") || path.endsWith("build.gradle") || path.endsWith("build.gradle.kts"))) {
    hints.push("jvm");
  }
  if (trackedFiles.some((path) => path === "Makefile" || path.endsWith("/Makefile"))) {
    hints.push("make");
  }
  return hints;
}

function isIgnoredPath(path: string, prefixes: readonly string[]): boolean {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (normalizedPrefix.length === 0 || normalizedPrefix === "." || normalizedPrefix.startsWith("../") || normalizedPrefix.startsWith("/")) {
      return false;
    }
    return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
  });
}
