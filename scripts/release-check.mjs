#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_FILES, REQUIRED_RELEASE_DOCUMENTS, isPublicPackagePath, normalizePortablePath } from "./public-artifacts.mjs";
import { checkSourceManifest } from "./source-manifest.mjs";
import { validateReleaseStatus } from "./release-status.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const json = process.argv.slice(2).includes("--json");
const unsupported = process.argv.slice(2).filter((argument) => argument !== "--json");
if (unsupported.length > 0) throw new Error(`Usage: node scripts/release-check.mjs [--json] (unsupported: ${unsupported.join(", ")})`);

await checkSourceManifest({ root, quiet: true });
const releaseStatus = await validateReleaseStatus({ root });
const packageJson = await readJson(join(root, "package.json"));
const lockfile = await readJson(join(root, "package-lock.json"));
assertPackageMetadata(packageJson, lockfile);
await assertRequiredDocuments();
await assertLicenseAndNotice();
await assertSeededCanaries();
const packedPaths = await packedFilePaths();
assertPackedAllowlist(packedPaths);
await scanReleaseSurface(packedPaths);

const result = {
  schemaVersion: 1,
  releaseSurface: "local-open-source-release-candidate",
  releaseStatus: releaseStatus.status,
  sourceManifest: "verified",
  packageFileCount: packedPaths.length,
  runtimeDependencies: 0,
  deterministicScan: "zero detected by Counterlane release-check ruleset",
  requiredDocuments: REQUIRED_RELEASE_DOCUMENTS,
  supportedPlatforms: ["win32"],
  untestedPlatforms: ["darwin", "linux"],
};
if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  process.stdout.write("Counterlane release integrity check passed.\n");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function assertRequiredDocuments() {
  for (const document of REQUIRED_RELEASE_DOCUMENTS) {
    const metadata = await stat(join(root, document)).catch(() => null);
    assert.ok(metadata?.isFile(), `Required public document is missing: ${document}`);
  }
}

async function assertLicenseAndNotice() {
  const [license, notice, inventory] = await Promise.all([
    readFile(join(root, "LICENSE"), "utf8"),
    readFile(join(root, "NOTICE"), "utf8"),
    readFile(join(root, "DEPENDENCY_INVENTORY.md"), "utf8"),
  ]);
  assert.match(license, /Apache License\s+Version 2\.0/u, "LICENSE must contain Apache-2.0 text");
  assert.match(notice, /Counterlane/u, "NOTICE must identify Counterlane");
  assert.match(inventory, /Runtime dependencies:\s*none/u, "dependency inventory must state the runtime dependency boundary");
}

function assertPackageMetadata(packageJson, lockfile) {
  assert.equal(packageJson?.name, "counterlane");
  assert.equal(packageJson?.license, "Apache-2.0");
  assert.equal(packageJson?.private, undefined, "package.json must not block the release candidate with private: true");
  assert.equal(packageJson?.engines?.node, ">=22.0.0");
  assert.equal(packageJson?.bin?.counterlane, "./dist/cli.js");
  assert.equal(packageJson?.main, "./dist/index.js");
  assert.equal(packageJson?.types, "./dist/index.d.ts");
  assert.deepEqual(packageJson?.files, PACKAGE_FILES, "package.json files must match the explicit public allowlist");
  assert.equal(packageJson?.dependencies, undefined, "the packed runtime must remain dependency-free");
  for (const script of ["counterlane:doctor", "demo:judge", "package:judge", "release:check", "release:status"]) {
    assert.equal(typeof packageJson?.scripts?.[script], "string", `Missing release script: ${script}`);
  }
  const lockRoot = lockfile?.packages?.[""];
  assert.equal(lockRoot?.name, packageJson.name, "package lock root name must match package metadata");
  assert.equal(lockRoot?.version, packageJson.version, "package lock root version must match package metadata");
  assert.equal(lockRoot?.license, packageJson.license, "package lock root license must match package metadata");
  assert.equal(lockRoot?.private, undefined, "package lock must not retain private: true");
}

async function packedFilePaths() {
  const packed = await runNpm(["pack", "--dry-run", "--json"]);
  const records = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(records) && records.length === 1, "npm pack --dry-run must emit one package record");
  const files = records[0]?.files;
  assert.ok(Array.isArray(files), "npm pack --dry-run must report packaged files");
  return files.map((entry) => {
    assert.equal(typeof entry?.path, "string", "npm pack file entry must have a path");
    return normalizePortablePath(entry.path);
  }).sort();
}

function assertPackedAllowlist(paths) {
  assert.ok(paths.includes("package.json"), "package.json must be included in the package");
  assert.ok(paths.includes("dist/cli.js"), "compiled CLI must be included in the package");
  assert.ok(paths.includes("test/fixtures/mock-app-server.mjs"), "judge fixture must be included in the package");
  assert.ok(paths.includes("JUDGE_FIXTURE_MANIFEST.json"), "judge fixture manifest must be included in the package");
  for (const path of paths) {
    assert.ok(isPublicPackagePath(path), `Unexpected non-public package artifact: ${path}`);
  }
  for (const forbidden of ["src/", "experiments/", ".codex/", "node_modules/", "dist-test/"]) {
    assert.equal(paths.some((path) => path.startsWith(forbidden)), false, `Forbidden package artifact prefix: ${forbidden}`);
  }
}

async function scanReleaseSurface(packedPaths) {
  const sourceEntries = await manifestPaths();
  const packageEntries = packedPaths.map((path) => ({ label: `package:${path}`, path: join(root, path) }));
  const sourceFiles = sourceEntries.map((path) => ({ label: `source:${path}`, path: join(root, path) }));
  const findings = [];
  for (const entry of [...sourceFiles, ...packageEntries]) {
    findings.push(...(await scanFile(entry)));
  }
  assert.deepEqual(findings, [], `Release scan found blocker(s):\n${findings.join("\n")}`);
}

async function manifestPaths() {
  const text = await readFile(join(root, "SOURCE_MANIFEST.sha256"), "utf8");
  return text.trimEnd().split(/\r?\n/u).map((line) => {
    const match = /^[a-f0-9]{64}  (.+)$/u.exec(line);
    assert.ok(match?.[1] !== undefined, `Malformed source manifest entry: ${line}`);
    return normalizePortablePath(match[1]);
  });
}

async function scanFile(entry) {
  const portablePath = entry.label.replace(/^[^:]+:/u, "").replaceAll("\\", "/");
  const findings = [];
  const rootNpmrc = portablePath === ".npmrc";
  if (
    /(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|node_modules\/|dist-test\/|coverage\/|\.codex\/|\.git\/|\.counterlane\/|outputs\/)/iu.test(portablePath) &&
    !rootNpmrc
  ) {
    findings.push(`${entry.label}: generated, ignored, or private path`);
  }
  if (/(^|\/)(?:raw[-_]?prompt|private[-_]?prompt|secret|credential|token|password|\.pem$|\.key$|\.p12$|\.pfx$)/iu.test(portablePath)) {
    findings.push(`${entry.label}: sensitive artifact name`);
  }
  const content = await readFile(entry.path, "utf8");
  const contentRules = [
    [/(?:-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----)/u, "private-key material"],
    [/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16})\b/u, "credential-shaped token"],
    [/\bsk-[A-Za-z0-9_-]{24,}\b/u, "API-key-shaped token"],
    [/\b(?:_authToken|_auth)\s*=\s*[^\s]+/iu, "npm credential"],
    [/[A-Za-z]:\\Users\\(?!<[^>]+>)[^\r\n"']+/u, "absolute Windows user path"],
    [/\/Users\/(?!<[^>]+>)[^\r\n"']+/u, "absolute macOS user path"],
    [/\/home\/(?!<[^>]+>)[^\r\n"']+/u, "absolute Linux user path"],
  ];
  for (const [rule, description] of contentRules) {
    if (rule.test(content)) findings.push(`${entry.label}: ${description}`);
  }
  return findings;
}

async function assertSeededCanaries() {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-release-canary-"));
  try {
    const credential = "sk-" + "release_integrity_canary_0123456789abcdef";
    const privatePath = "C:" + "\\Users\\ReleaseCanary\\private.txt";
    const npmCredential = "//registry.example/:" + "_auth" + "Token=release-canary\n";
    await writeFile(join(directory, "clean.txt"), "safe fixture\n", "utf8");
    await writeFile(join(directory, "credential.txt"), `${credential}\n`, "utf8");
    await writeFile(join(directory, "private-path.txt"), `${privatePath}\n`, "utf8");
    await writeFile(join(directory, ".npmrc"), npmCredential, "utf8");
    const cleanFindings = await scanFile({ label: "canary:clean.txt", path: join(directory, "clean.txt") });
    const credentialFindings = await scanFile({ label: "canary:credential.txt", path: join(directory, "credential.txt") });
    const privatePathFindings = await scanFile({ label: "canary:private-path.txt", path: join(directory, "private-path.txt") });
    const npmCredentialFindings = await scanFile({ label: "canary:.npmrc", path: join(directory, ".npmrc") });
    assert.deepEqual(cleanFindings, [], "release scanner must not flag a clean fixture");
    assert.ok(credentialFindings.some((finding) => finding.includes("API-key-shaped token")), "release scanner must detect a credential canary");
    assert.ok(privatePathFindings.some((finding) => finding.includes("absolute Windows user path")), "release scanner must detect a private-path canary");
    assert.ok(npmCredentialFindings.some((finding) => finding.includes("npm credential")), "release scanner must detect an npm credential canary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function runNpm(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [npmCliPath, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`npm ${args.join(" ")} failed (${String(code)}): ${stderr || stdout}`));
    });
  });
}
