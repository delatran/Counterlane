#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SHA256 = /^[a-f0-9]{64}$/u;

export async function validateReleaseStatus(options = {}) {
  const root = resolve(options.root ?? PROJECT_ROOT);
  const status = await readJson(join(root, "RELEASE_STATUS.json"));
  assert.equal(status?.schemaVersion, 1, "RELEASE_STATUS.json schemaVersion must be 1");
  assert.ok(
    status?.status === "approval_required" || status?.status === "production_ready",
    "release status must be approval_required or production_ready",
  );
  assert.equal(typeof status?.supportBoundary, "string", "release status must declare a supportBoundary");
  assert.ok(status.supportBoundary.length > 0, "release supportBoundary must not be empty");

  if (status.status === "approval_required") {
    assert.equal(status.liveEvidenceFile, null, "approval_required must not point at live production evidence");
    assert.equal(typeof status.reason, "string", "approval_required must explain the missing authorization/evidence");
    return {
      schemaVersion: 1,
      status: status.status,
      supportBoundary: status.supportBoundary,
      liveEvidence: "not-present-by-contract",
    };
  }

  const evidencePath = publicEvidencePath(root, status.liveEvidenceFile, "liveEvidenceFile");
  const evidence = await readJson(evidencePath);
  const manifestHash = await hashFile(join(root, "SOURCE_MANIFEST.sha256"));
  assert.equal(evidence?.schemaVersion, 1, "live evidence schemaVersion must be 1");
  assert.equal(evidence?.evidenceKind, "runtime", "production_ready requires runtime evidence");
  assert.equal(evidence?.sourceManifestSha256, manifestHash, "live evidence is stale for the current source manifest");
  assert.equal(evidence?.modelTurnStarted, true, "live evidence must observe a model turn");
  assert.equal(evidence?.nonApplying, true, "live evidence must be non-applying");
  assert.equal(evidence?.benchmark, false, "a live smoke must not be represented as a benchmark");
  assert.equal(evidence?.cleanup?.fixtureRemoved, true, "live smoke fixture cleanup must be observed");
  assert.equal(evidence?.cleanup?.trustStateRemoved, true, "temporary trust-state cleanup must be observed");
  assert.equal(evidence?.verification?.passed, true, "live evidence must pass its verifier");
  assert.equal(evidence?.verification?.certifying, true, "live evidence must use a certifying verifier plan");
  assert.equal(evidence?.verification?.integrity, "intact", "live verifier integrity must remain intact");
  assertBoundedCount(evidence?.attemptAccounting?.modelAttempts, "modelAttempts", 1, 2);
  assertBoundedCount(evidence?.attemptAccounting?.transportRequests, "transportRequests", 1, 2);
  assertBoundedCount(evidence?.attemptAccounting?.verifierRuns, "verifierRuns", 1, 2);
  assert.equal(evidence?.attemptAccounting?.unresolved, 0, "production evidence cannot retain unresolved attempts");
  assert.match(evidence?.launcher?.executableSha256 ?? "", SHA256, "launcher executable digest is required");
  assert.match(evidence?.launcher?.argumentsSha256 ?? "", SHA256, "launcher argument digest is required");

  const publicReceiptPath = publicEvidencePath(root, evidence?.publicReceipt?.path, "publicReceipt.path");
  assert.match(evidence?.publicReceipt?.sha256 ?? "", SHA256, "public receipt digest is required");
  assert.equal(await hashFile(publicReceiptPath), evidence.publicReceipt.sha256, "public receipt digest does not match");
  return {
    schemaVersion: 1,
    status: status.status,
    supportBoundary: status.supportBoundary,
    liveEvidence: "runtime-source-bound-and-verified",
    sourceManifestSha256: manifestHash,
  };
}

function publicEvidencePath(root, value, label) {
  assert.equal(typeof value, "string", `${label} must be a public relative JSON path`);
  const portable = value.replaceAll("\\", "/");
  assert.equal(isAbsolute(value), false, `${label} must be relative`);
  assert.ok(!portable.startsWith("/") && !portable.split("/").includes(".."), `${label} escapes the release root`);
  assert.match(portable, /^docs\/evidence\/[A-Za-z0-9._/-]+\.json$/u, `${label} must remain under docs/evidence`);
  return join(root, ...portable.split("/"));
}

function assertBoundedCount(value, label, minimum, maximum) {
  assert.ok(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label} must be an integer from ${minimum} to ${maximum}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function parseCli(argv) {
  let root = PROJECT_ROOT;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--root") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--root requires a path");
      root = resolve(value);
      index += 1;
    } else throw new Error("Usage: node scripts/release-status.mjs [--root <path>] [--json]");
  }
  return { root, json };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  const options = parseCli(process.argv.slice(2));
  validateReleaseStatus({ root: options.root }).then((result) => {
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `Counterlane release status: ${result.status}\n`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
