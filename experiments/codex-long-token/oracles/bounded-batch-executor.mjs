import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = process.argv[2] === undefined ? null : resolve(process.argv[2]);
if (workspace === null) {
  console.error("usage: node bounded-batch-executor.mjs WORKSPACE");
  process.exit(2);
}

try {
  await verifyFileScope(workspace);
  const moduleUrl = pathToFileURL(join(workspace, "src", "bounded-batch.mjs"));
  moduleUrl.searchParams.set("oracle", `${Date.now()}`);
  const { runBoundedBatch } = await import(moduleUrl.href);
  assert.equal(typeof runBoundedBatch, "function");

  await verifyValidation(runBoundedBatch);
  await verifyEmptyAndSnapshot(runBoundedBatch);
  await verifyConcurrencyAndOrder(runBoundedBatch);
  await verifyRetryAndNormalization(runBoundedBatch);
  await verifyTimeoutSignals(runBoundedBatch);
  await verifyAbortBeforeStart(runBoundedBatch);
  await verifyAbortDuringWork(runBoundedBatch);
  console.log("hidden bounded-batch oracle passed");
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exit(1);
}

async function verifyValidation(runBoundedBatch) {
  await assert.rejects(() => runBoundedBatch(null, () => {}), TypeError);
  await assert.rejects(() => runBoundedBatch([], null), TypeError);
  for (const concurrency of [0, 1.5, 65, "2"]) {
    await assert.rejects(() => runBoundedBatch([], () => {}, { concurrency }));
  }
  for (const retries of [-1, 0.5, "1"]) {
    await assert.rejects(() => runBoundedBatch([], () => {}, { retries }));
  }
  for (const timeoutMs of [0, -1, 1.5, "10"]) {
    await assert.rejects(() => runBoundedBatch([], () => {}, { timeoutMs }));
  }
  await assert.rejects(() => runBoundedBatch([], () => {}, { signal: {} }), TypeError);
}

async function verifyEmptyAndSnapshot(runBoundedBatch) {
  let called = false;
  assert.deepEqual(await runBoundedBatch([], () => { called = true; }), []);
  assert.equal(called, false);

  const items = [1, 2];
  const run = runBoundedBatch(items, async (item) => item * 2, { concurrency: 1 });
  items.push(3);
  assert.deepEqual(await run, [
    { status: "fulfilled", value: 2, attempts: 1 },
    { status: "fulfilled", value: 4, attempts: 1 },
  ]);
}

async function verifyConcurrencyAndOrder(runBoundedBatch) {
  let active = 0;
  let maximum = 0;
  const completion = [];
  const results = await runBoundedBatch([45, 5, 25, 1, 15, 10], async (delay, { index, attempt, signal }) => {
    assert.equal(attempt, 1);
    assert.equal(signal.aborted, false);
    active += 1;
    maximum = Math.max(maximum, active);
    await sleep(delay);
    completion.push(index);
    active -= 1;
    return index;
  }, { concurrency: 3 });

  assert.equal(maximum, 3);
  assert.notDeepEqual(completion, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(results.map((result) => result.value), [0, 1, 2, 3, 4, 5]);
}

async function verifyRetryAndNormalization(runBoundedBatch) {
  const calls = new Map();
  const results = await runBoundedBatch(["eventual", "string", "sync"], (item, { attempt }) => {
    calls.set(item, (calls.get(item) ?? 0) + 1);
    if (item === "eventual" && attempt < 3) return Promise.reject(new Error(`attempt-${attempt}`));
    if (item === "string") return Promise.reject("plain failure");
    if (item === "sync") throw new TypeError("sync failure");
    return "done";
  }, { concurrency: 2, retries: 2 });

  assert.deepEqual(results[0], { status: "fulfilled", value: "done", attempts: 3 });
  assert.deepEqual(results[1], {
    status: "rejected",
    reason: { name: "Error", message: "plain failure" },
    attempts: 3,
  });
  assert.deepEqual(results[2], {
    status: "rejected",
    reason: { name: "TypeError", message: "sync failure" },
    attempts: 3,
  });
  assert.deepEqual(Object.fromEntries(calls), { eventual: 3, string: 3, sync: 3 });
}

async function verifyTimeoutSignals(runBoundedBatch) {
  const observedAborts = [];
  const results = await runBoundedBatch([0], async (_item, { signal, attempt }) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    observedAborts.push({ attempt, aborted: signal.aborted });
    throw new Error("late rejection after timeout");
  }, { retries: 1, timeoutMs: 20 });

  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason.name, "TimeoutError");
  assert.equal(results[0].attempts, 2);
  assert.deepEqual(observedAborts, [
    { attempt: 1, aborted: true },
    { attempt: 2, aborted: true },
  ]);
}

async function verifyAbortBeforeStart(runBoundedBatch) {
  const controller = new AbortController();
  controller.abort("already stopped");
  let calls = 0;
  const results = await runBoundedBatch([1, 2], () => { calls += 1; }, {
    concurrency: 2,
    retries: 4,
    signal: controller.signal,
  });
  assert.equal(calls, 0);
  assert.deepEqual(results.map((result) => result.attempts), [0, 0]);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.name === "AbortError"));
}

async function verifyAbortDuringWork(runBoundedBatch) {
  const controller = new AbortController();
  const started = [];
  const run = runBoundedBatch([0, 1, 2, 3], async (item, { signal }) => {
    started.push(item);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("worker observed abort");
  }, { concurrency: 2, retries: 5, signal: controller.signal });

  await waitFor(() => started.length === 2);
  controller.abort("stop now");
  const results = await run;
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(results.map((result) => result.attempts), [1, 1, 0, 0]);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.name === "AbortError"));
}

async function verifyFileScope(workspace) {
  const oracleDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
  const template = resolve(oracleDirectory, "..", "fixtures", "bounded-batch-executor");
  const expectedFiles = await listFiles(template, []);
  const actualFiles = await listFiles(workspace, [".git", ".counterlane-study"]);
  assert.deepEqual(actualFiles, expectedFiles, "task file set changed");

  for (const path of expectedFiles) {
    if (path === "src/bounded-batch.mjs") continue;
    const [expected, actual] = await Promise.all([
      readFile(join(template, path)),
      readFile(join(workspace, path)),
    ]);
    assert.ok(actual.equals(expected), `unexpected modification to ${path}`);
  }
}

async function listFiles(root, excludedNames) {
  const output = [];
  await visit(root, root, excludedNames, output);
  return output.sort();
}

async function visit(root, directory, excludedNames, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedNames.includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(root, path, excludedNames, output);
      continue;
    }
    if (!entry.isFile()) throw new Error(`unsupported fixture entry: ${basename(path)}`);
    output.push(relative(root, path).split(sep).join("/"));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("oracle timed out waiting for state");
    await sleep(1);
  }
}
