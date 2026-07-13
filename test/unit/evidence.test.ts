import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../../src/core/json.js";
import type { TelemetryEvent } from "../../src/core/types.js";
import { parsePairedObservations } from "../../src/meta/evidence.js";

void test("user-cancelled twin runs do not enter causal uplift learning", () => {
  const cancelled = experimentEvent("cancelled", "success", "cancelled");
  const timeout = experimentEvent("timeout", "success", "timeout");
  const legacy = experimentEvent(undefined, undefined, "legacy");
  const observations = parsePairedObservations([cancelled, timeout, legacy]);
  assert.deepEqual(observations.map((entry) => entry.experimentId), ["timeout", "legacy"]);
});

void test("one experiment cannot be replayed into multiple uplift samples", () => {
  const first = experimentEvent("success", "success", "one");
  const duplicate = structuredClone(first);
  duplicate.id = "evt-one-replay";
  const observations = parsePairedObservations(Array.from({ length: 8 }, (_, index) => ({
    ...structuredClone(index === 0 ? first : duplicate),
    id: `evt-replay-${index}`,
  })));
  assert.equal(observations.length, 1);

  const conflict = structuredClone(first);
  conflict.id = "evt-one-conflict";
  conflict.payload["utilityDelta"] = -99;
  assert.deepEqual(parsePairedObservations([first, conflict]), []);
});

void test("backend-rerouted Twin pairs remain auditable but cannot enter uplift learning", () => {
  const rerouted = experimentEvent("failure", "success", "rerouted");
  rerouted.payload["controlRouteCompliant"] = false;
  assert.deepEqual(parsePairedObservations([rerouted]), []);
});

void test("extreme numeric and context payloads cannot destabilize uplift learning", () => {
  const hugeUtility = experimentEvent("success", "success", "huge-utility");
  hugeUtility.payload["utilityDelta"] = Number.MAX_VALUE;
  const invalidSuccessDelta = experimentEvent("success", "success", "invalid-delta");
  invalidSuccessDelta.payload["verifiedSuccessDelta"] = 2;
  const excessiveContexts = experimentEvent("success", "success", "many-contexts");
  excessiveContexts.payload["contextKeys"] = Array.from({ length: 17 }, (_value, index) => `context-${index}`);
  assert.deepEqual(parsePairedObservations([hugeUtility, invalidSuccessDelta, excessiveContexts]), []);
});

void test("overly deep experiment telemetry is ignored instead of denying meta planning", () => {
  const event = experimentEvent("success", "success", "deep");
  let cursor: JsonObject = {};
  event.payload["untrusted"] = cursor;
  for (let depth = 0; depth < 140; depth += 1) {
    const next: JsonObject = {};
    cursor["next"] = next;
    cursor = next;
  }
  assert.deepEqual(parsePairedObservations([event]), []);
});

function experimentEvent(
  controlOutcome: string | undefined,
  treatmentOutcome: string | undefined,
  id: string,
): TelemetryEvent {
  return {
    id: `evt-${id}`,
    type: "experiment.completed",
    timestamp: new Date().toISOString(),
    experimentId: id,
    payload: {
      contextKeys: ["task|route:*"],
      utilityDelta: 1,
      verifiedSuccessDelta: 0,
      controlSuccessful: false,
      treatmentSuccessful: false,
      controlRouteCompliant: true,
      treatmentRouteCompliant: true,
      ...(controlOutcome === undefined ? {} : { controlOutcome }),
      ...(treatmentOutcome === undefined ? {} : { treatmentOutcome }),
    },
  };
}
