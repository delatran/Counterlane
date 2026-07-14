import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const releaseStatusScript = resolve(fileURLToPath(new URL("../../../scripts/release-status.mjs", import.meta.url)));

void test("approval_required passes only without a live evidence pointer", async () => {
  const root = await fixtureRoot();
  try {
    await writeStatus(root, { status: "approval_required", liveEvidenceFile: null, reason: "fresh smoke requires approval" });
    const result = runStatus(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"status": "approval_required"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("production_ready fails without a public evidence file", async () => {
  const root = await fixtureRoot();
  try {
    await writeStatus(root, { status: "production_ready", liveEvidenceFile: "docs/evidence/missing.json" });
    const result = runStatus(root);
    assert.notEqual(result.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("simulated evidence cannot unlock production_ready", async () => {
  const root = await validProductionFixture();
  try {
    const evidencePath = join(root, "docs", "evidence", "live.json");
    const evidence = validEvidence(await hashText("fixture manifest\n"), await receiptHash());
    await writeFile(evidencePath, `${JSON.stringify({ ...evidence, evidenceKind: "simulated" })}\n`, "utf8");
    const result = runStatus(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires runtime evidence/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("stale source-manifest binding cannot unlock production_ready", async () => {
  const root = await validProductionFixture();
  try {
    const evidencePath = join(root, "docs", "evidence", "live.json");
    const evidence = validEvidence("0".repeat(64), await receiptHash());
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
    const result = runStatus(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stale for the current source manifest/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("runtime source-bound verified evidence unlocks the production_ready state", async () => {
  const root = await validProductionFixture();
  try {
    const result = runStatus(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /runtime-source-bound-and-verified/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "counterlane-release-status-"));
  await writeFile(join(root, "SOURCE_MANIFEST.sha256"), "fixture manifest\n", "utf8");
  return root;
}

async function validProductionFixture(): Promise<string> {
  const root = await fixtureRoot();
  await mkdir(join(root, "docs", "evidence"), { recursive: true });
  const receipt = "{\"public\":true}\n";
  await writeFile(join(root, "docs", "evidence", "receipt.json"), receipt, "utf8");
  const evidence = validEvidence(await hashText("fixture manifest\n"), await hashText(receipt));
  await writeFile(join(root, "docs", "evidence", "live.json"), `${JSON.stringify(evidence)}\n`, "utf8");
  await writeStatus(root, { status: "production_ready", liveEvidenceFile: "docs/evidence/live.json" });
  return root;
}

function validEvidence(sourceManifestSha256: string, publicReceiptSha256: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    evidenceKind: "runtime",
    sourceManifestSha256,
    modelTurnStarted: true,
    nonApplying: true,
    benchmark: false,
    cleanup: { fixtureRemoved: true, trustStateRemoved: true },
    verification: { passed: true, certifying: true, integrity: "intact" },
    attemptAccounting: { modelAttempts: 1, transportRequests: 1, verifierRuns: 1, unresolved: 0 },
    launcher: { executableSha256: "a".repeat(64), argumentsSha256: "b".repeat(64) },
    publicReceipt: { path: "docs/evidence/receipt.json", sha256: publicReceiptSha256 },
  };
}

async function writeStatus(root: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, "RELEASE_STATUS.json"), `${JSON.stringify({
    schemaVersion: 1,
    supportBoundary: "test-boundary",
    ...value,
  })}\n`, "utf8");
}

function runStatus(root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [releaseStatusScript, "--root", root, "--json"], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function receiptHash(): Promise<string> {
  return hashText("{\"public\":true}\n");
}

async function hashText(value: string): Promise<string> {
  return createHash("sha256").update(value).digest("hex");
}
