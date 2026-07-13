import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseModelCatalog, parseRateLimits } from "../../src/codex/catalog.js";
import { deriveQuotaState } from "../../src/routing/quota.js";

void test("malformed reasoning-effort entries never fabricate an advertised effort", () => {
  const catalog = parseModelCatalog({
    data: [{
      id: "gpt-invalid",
      model: "gpt-invalid",
      supportedReasoningEfforts: [{ description: "missing identifier" }],
    }],
  });
  assert.deepEqual(catalog.models, []);
});

void test("malformed quota windows produce a fail-closed unknown-quota state", () => {
  const snapshot = parseRateLimits({ rateLimits: { limitId: "codex", primary: {} } });
  const quota = deriveQuotaState(snapshot, 25);
  assert.equal(quota.usedPercent, null);
  assert.equal(quota.remainingPercent, null);
  assert.equal(quota.sourceLimitId, null);
  assert.equal(quota.known, false);
  assert.equal(quota.pressure, 1);
});

void test("rate-limit plan type falls back to the live rate-limit payload", () => {
  const snapshot = parseRateLimits({
    rateLimits: {
      limitId: "codex",
      planType: "prolite",
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2_000_000_000 },
    },
  }, null);
  assert.equal(snapshot.planType, "prolite");
});
