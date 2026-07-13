import { strict as assert } from "node:assert";
import { test } from "node:test";
import { calculateMutationAdequacy, minimumDetectionRate } from "../../src/verification/mutation.js";

void test("mutation adequacy is weighted and reports escaped archetypes", () => {
  const result = calculateMutationAdequacy([
    { id: "a", archetype: "missed-call-site", weight: 2, detected: true },
    { id: "b", archetype: "race", weight: 3, detected: false },
    { id: "c", archetype: "race", weight: 1, detected: false },
  ]);
  assert.equal(result.detectedWeight, 2);
  assert.equal(result.totalWeight, 6);
  assert.equal(result.weightedDetectionRate, 1 / 3);
  assert.deepEqual(result.undetectedArchetypes, ["race"]);
});

void test("minimum detection rate enforces an escape-risk bound", () => {
  assert.equal(minimumDetectionRate(0.8, 0.01), 0.95);
  assert.equal(minimumDetectionRate(1, 0.01), 0);
  assert.equal(minimumDetectionRate(0, 0), 1);
});
