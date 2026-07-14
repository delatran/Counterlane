#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCliPath = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const temporaryRoot = await mkdtemp(join(tmpdir(), "counterlane-package-judge-"));
const parentBefore = await checkoutFingerprint(root);

try {
  await access(join(root, "dist", "cli.js"));
  const packDirectory = join(temporaryRoot, "pack");
  await mkdir(packDirectory, { recursive: true });
  const packed = await runNpm(["pack", "--json", "--pack-destination", packDirectory], root, packageEnvironment(temporaryRoot));
  const records = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(records) && records.length === 1, "npm pack must emit one package record");
  const filename = records[0]?.filename;
  assert.equal(typeof filename, "string");
  const tarball = join(packDirectory, filename);
  const tarballHash = await hashFile(tarball);

  const consumer = join(temporaryRoot, "consumer");
  const home = join(temporaryRoot, "home");
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ name: "counterlane-fresh-consumer", private: true }, null, 2)}\n`, "utf8");
  const env = packageEnvironment(home);
  await runNpm(["install", "--ignore-scripts", "--omit=dev", "--offline", "--no-audit", "--no-fund", tarball], consumer, env);

  const installedPackage = join(consumer, "node_modules", "counterlane");
  const canonicalInstalledPackage = await realpath(installedPackage);
  assert.notEqual(canonicalInstalledPackage, root, "fresh consumer must use the packed artifact, not the source checkout");
  const doctor = await run(process.execPath, ["scripts/counterlane-doctor.mjs", "--json"], canonicalInstalledPackage, env);
  const doctorResult = JSON.parse(doctor.stdout);
  assert.equal(doctorResult.ok, true, doctor.stdout);
  assert.equal(doctorResult.mode, "simulated-no-account");

  const evidencePath = join(temporaryRoot, "packaged-judge-evidence.json");
  const judge = await run(process.execPath, ["scripts/demo-judge.mjs", "--output", evidencePath], canonicalInstalledPackage, {
    ...env,
    NODE_PATH: "",
    COUNTERLANE_JUDGE_REQUIRE_PACKAGED: "1",
  });
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  assert.equal(evidence.evidenceKind, "simulated");
  assert.equal(evidence.liveModelTurns, 0);
  assert.equal(evidence.parentCheckout.unchanged, true);
  assert.match(judge.stdout, /Counterlane simulated MCP judge passed/u);

  await runNpm(["uninstall", "--offline", "--no-audit", "--no-fund", "counterlane"], consumer, env);
  await assert.rejects(access(installedPackage));
  const parentAfter = await checkoutFingerprint(root);
  assert.equal(parentAfter, parentBefore, "packaging and fresh-consumer checks must not mutate the source checkout");

  process.stdout.write("Counterlane portable package judge passed from a fresh temporary consumer.\n");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    evidenceKind: "simulated",
    packageTarballSha256: tarballHash,
    judgeEvidenceHash: evidence.evidenceHash,
    doctorMode: doctorResult.mode,
    freshConsumerOnly: true,
    parentCheckoutUnchanged: true,
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function packageEnvironment(home) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: join(home, "npm-cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

async function checkoutFingerprint(directory) {
  const [status, diff] = await Promise.all([
    run("git", ["status", "--porcelain=v1", "-uno"], directory, process.env),
    run("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], directory, process.env),
  ]);
  return createHash("sha256").update(`${status.stdout}\u0000${diff.stdout}`).digest("hex");
}

async function hashFile(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function runNpm(args, cwd, env) {
  await access(npmCliPath);
  return run(process.execPath, [npmCliPath, ...args], cwd, env);
}

async function run(command, args, cwd, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        rejectPromise(new Error(`${command} ${args.join(" ")} failed (${String(code)}): ${stderr || stdout}`));
      }
    });
  });
}
