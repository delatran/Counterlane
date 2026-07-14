#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_MANIFEST_PATH = join(PROJECT_ROOT, "SOURCE_MANIFEST.sha256");

export const MANIFEST_ROOT_FILES = Object.freeze([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".mcp.json",
  ".npmrc",
  "AGENTS.md",
  "BUILD_WEEK.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "counterlane.config.example.json",
  "DEMO.md",
  "DEPENDENCY_INVENTORY.md",
  "JUDGE_FIXTURE_MANIFEST.json",
  "LICENSE",
  "NOTICE",
  "package-lock.json",
  "package.json",
  "README.md",
  "RELEASE_STATUS.json",
  "SECURITY.md",
  "SUBMISSION.md",
  "tsconfig.build.json",
  "tsconfig.json",
  "tsconfig.test.json",
]);

export const MANIFEST_DIRECTORIES = Object.freeze([
  ".agents",
  ".codex-plugin",
  ".github",
  "deploy",
  "dist",
  "docs",
  "experiments/work-codex-2x2",
  "scripts",
  "skills",
  "src",
  "test",
]);

export async function collectManifestEntries(root = PROJECT_ROOT, options = {}) {
  const canonicalRoot = resolve(root);
  const rootFiles = options.rootFiles ?? MANIFEST_ROOT_FILES;
  const directories = options.directories ?? MANIFEST_DIRECTORIES;
  const paths = [];

  for (const name of rootFiles) {
    const path = join(canonicalRoot, name);
    await requirePlainFile(path, `manifest root file ${name}`);
    paths.push(path);
  }
  for (const name of directories) {
    const path = join(canonicalRoot, name);
    await requirePlainDirectory(path, `manifest directory ${name}`);
    await collectFiles(canonicalRoot, path, paths);
  }

  const entries = [];
  for (const path of paths) {
    const portablePath = relative(canonicalRoot, path).split(sep).join("/");
    if (portablePath.includes("\n") || portablePath.includes("\r")) {
      throw new Error(`Source manifest cannot encode a path containing a newline: ${portablePath}`);
    }
    entries.push({
      path: portablePath,
      sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
    });
  }
  return entries.sort((left, right) => compareText(left.path, right.path));
}

export function renderSourceManifest(entries) {
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
}

export async function checkSourceManifest(options = {}) {
  const root = resolve(options.root ?? PROJECT_ROOT);
  const manifestPath = resolve(options.manifestPath ?? join(root, "SOURCE_MANIFEST.sha256"));
  const entries = await collectManifestEntries(root, options);
  const expected = renderSourceManifest(entries);
  const actual = await readFile(manifestPath, "utf8").catch((error) => {
    throw new Error(`Source manifest is unavailable at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (actual !== expected) {
    const expectedLines = expected.trimEnd().split("\n");
    const actualLines = actual.trimEnd().split(/\r?\n/u);
    const line = firstDifferentLine(actualLines, expectedLines);
    throw new Error(
      `SOURCE_MANIFEST.sha256 is stale or incomplete at line ${line + 1}. ` +
      `Run \`npm run source-manifest:generate\` after the final build.\n` +
      `actual: ${actualLines[line] ?? "<missing>"}\nexpected: ${expectedLines[line] ?? "<none>"}`,
    );
  }
  if (!options.quiet) process.stdout.write(`Source manifest verified (${entries.length} files).\n`);
  return entries;
}

export async function generateSourceManifest(options = {}) {
  const root = resolve(options.root ?? PROJECT_ROOT);
  const manifestPath = resolve(options.manifestPath ?? join(root, "SOURCE_MANIFEST.sha256"));
  const entries = await collectManifestEntries(root, options);
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, renderSourceManifest(entries), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  if (!options.quiet) process.stdout.write(`Source manifest generated (${entries.length} files).\n`);
  return entries;
}

async function collectFiles(root, directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const portablePath = relative(root, path).split(sep).join("/");
    // Live smoke evidence is produced only after the final source manifest is
    // frozen, so it can bind to that manifest without a hash cycle.
    if (portablePath === "docs/evidence" || portablePath.startsWith("docs/evidence/")) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Source manifest refuses symbolic links: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) await collectFiles(root, path, output);
    else if (entry.isFile()) output.push(path);
    else throw new Error(`Source manifest refuses unsupported filesystem entries: ${relative(root, path)}`);
  }
}

async function requirePlainFile(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
}

async function requirePlainDirectory(path, label) {
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink directory: ${path}`);
  }
}

function firstDifferentLine(actual, expected) {
  const count = Math.max(actual.length, expected.length);
  for (let index = 0; index < count; index += 1) {
    if (actual[index] !== expected[index]) return index;
  }
  return count;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function main(argv) {
  const command = argv[0];
  if (command === "generate") await generateSourceManifest();
  else if (command === "check") await checkSourceManifest();
  else throw new Error("Usage: node scripts/source-manifest.mjs <generate|check>");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
