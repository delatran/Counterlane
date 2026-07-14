#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const json = process.argv.slice(2).includes("--json");
const unsupported = process.argv.slice(2).filter((argument) => argument !== "--json");
if (unsupported.length > 0) {
  throw new Error(`Unsupported doctor argument(s): ${unsupported.join(", ")}`);
}

const checks = [];
const addCheck = (label, ok, detail) => checks.push({ label, ok, detail });
const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
addCheck("Node.js", major >= 22, process.version);
addCheck("Supported platform", process.platform === "win32", process.platform === "win32"
  ? "Windows is the exercised local/self-hosted support boundary."
  : "This release candidate has only been exercised on Windows; do not treat this platform as supported.");

const git = spawnSync("git", ["--version"], { encoding: "utf8" });
addCheck("Git executable", git.status === 0, (git.stdout || git.stderr || "not executable").trim());

const packageJson = await readJson("package.json");
addCheck(
  "Package metadata",
  packageJson?.name === "counterlane" && packageJson?.license === "Apache-2.0" && packageJson?.bin?.counterlane === "./dist/cli.js",
  packageJson === null ? "package.json is missing or invalid" : `${String(packageJson.name)}@${String(packageJson.version)}`,
);
await addFileCheck("Compiled CLI", "dist/cli.js");
await addFileCheck("Judge runner", "scripts/demo-judge.mjs");

const manifest = await readJson("JUDGE_FIXTURE_MANIFEST.json");
let manifestOk = manifest?.schemaVersion === 1 && manifest?.files !== null && typeof manifest?.files === "object";
if (manifestOk) {
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    if (typeof expectedHash !== "string") {
      manifestOk = false;
      break;
    }
    const actualHash = await hashFile(relativePath).catch(() => null);
    if (actualHash !== expectedHash) {
      manifestOk = false;
      break;
    }
  }
}
addCheck(
  "Judge fixture integrity",
  manifestOk,
  manifestOk ? `${Object.keys(manifest.files).length} fixture input(s) match JUDGE_FIXTURE_MANIFEST.json.` : "fixture manifest is missing, stale, or inconsistent",
);

const result = {
  schemaVersion: 1,
  mode: "simulated-no-account",
  modelTurnsStarted: 0,
  networkAccess: "not-used-by-doctor",
  supportedPlatforms: ["win32"],
  untestedPlatforms: ["darwin", "linux"],
  livePrerequisites: [
    "A host-owned Codex App Server launch command.",
    "A host-owned task-specific verifier policy.",
    "Explicit owner authorization for one benign non-applying live MCP smoke with at most two expensive turns.",
  ],
  checks,
  ok: checks.every((check) => check.ok),
};

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write("Counterlane simulated doctor (no account, no model turn)\n");
  for (const check of checks) {
    process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.label}: ${check.detail}\n`);
  }
  process.stdout.write(`Live prerequisites: ${result.livePrerequisites.length} owner-controlled requirement(s).\n`);
}
process.exitCode = result.ok ? 0 : 1;

async function addFileCheck(label, relativePath) {
  try {
    await access(resolve(root, relativePath));
    addCheck(label, true, relativePath);
  } catch {
    addCheck(label, false, `${relativePath} is missing`);
  }
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
  } catch {
    return null;
  }
}

async function hashFile(relativePath) {
  return createHash("sha256").update(await readFile(resolve(root, relativePath))).digest("hex");
}
