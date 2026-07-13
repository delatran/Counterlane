import assert from "node:assert/strict";
import { runBoundedBatch } from "./src/bounded-batch.mjs";

await verifiesBoundedConcurrencyAndStableOrder();
await verifiesRetriesAndTimeouts();
await verifiesOuterAbort();
console.log("visible bounded-batch checks passed");

async function verifiesBoundedConcurrencyAndStableOrder() {
  let active = 0;
  let maximum = 0;
  const results = await runBoundedBatch([30, 5, 20, 1], async (delay, { index, attempt, signal }) => {
    assert.equal(attempt, 1);
    assert.equal(signal.aborted, false);
    active += 1;
    maximum = Math.max(maximum, active);
    await sleep(delay);
    active -= 1;
    return `item-${index}`;
  }, { concurrency: 2 });

  assert.equal(maximum, 2);
  assert.deepEqual(results, [
    { status: "fulfilled", value: "item-0", attempts: 1 },
    { status: "fulfilled", value: "item-1", attempts: 1 },
    { status: "fulfilled", value: "item-2", attempts: 1 },
    { status: "fulfilled", value: "item-3", attempts: 1 },
  ]);
}

async function verifiesRetriesAndTimeouts() {
  const attempts = new Map();
  const results = await runBoundedBatch(["retry", "timeout"], async (item, context) => {
    attempts.set(item, context.attempt);
    if (item === "retry" && context.attempt === 1) throw new Error("try again");
    if (item === "timeout") await new Promise((resolve) => context.signal.addEventListener("abort", resolve, { once: true }));
    return "ok";
  }, { concurrency: 2, retries: 1, timeoutMs: 25 });

  assert.deepEqual(results[0], { status: "fulfilled", value: "ok", attempts: 2 });
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.name, "TimeoutError");
  assert.equal(results[1].attempts, 2);
  assert.equal(attempts.get("timeout"), 2);
}

async function verifiesOuterAbort() {
  const controller = new AbortController();
  const started = [];
  const run = runBoundedBatch([0, 1, 2], async (item, { signal }) => {
    started.push(item);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return item;
  }, { concurrency: 1, retries: 3, signal: controller.signal });

  await waitFor(() => started.length === 1);
  controller.abort("stop");
  const results = await run;
  assert.deepEqual(started, [0]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected", "rejected"]);
  assert.ok(results.every((result) => result.reason.name === "AbortError"));
  assert.deepEqual(results.map((result) => result.attempts), [1, 0, 0]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("visible check timed out waiting for state");
    await sleep(1);
  }
}
