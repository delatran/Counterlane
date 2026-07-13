import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deriveQuotaState } from "../../src/routing/quota.js";

void test("quota controller selects the most constrained window", () => {
  const now = Date.UTC(2026, 6, 11, 0, 0, 0);
  const state = deriveQuotaState({
    primary: {
      limitId: "five-hour",
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: now / 1000 + 60 * 60 },
      secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: now / 1000 + 5 * 86400 },
    },
    byId: {},
    fetchedAt: new Date(now).toISOString(),
    raw: {},
  }, 20, now);
  assert.equal(state.sourceLimitId, "five-hour:secondary");
  assert.equal(state.known, true);
  assert.equal(state.usedPercent, 85);
  assert.equal(state.exhausted, false);
  assert.equal(state.rateLimitReachedType, null);
  assert.equal(state.healthy, false);
  assert.ok(state.pressure > 0.5);
});

void test("missing quota data fails closed without blocking a Standard single lane", () => {
  const state = deriveQuotaState({ byId: {}, fetchedAt: new Date().toISOString(), raw: {} }, 20);
  assert.equal(state.known, false);
  assert.equal(state.exhausted, false);
  assert.equal(state.rateLimitReachedType, null);
  assert.equal(state.usedPercent, null);
  assert.equal(state.pressure, 1);
  assert.equal(state.healthy, false);
});

void test("an explicit rate-limit-reached signal takes precedence over a slightly higher-pressure window", () => {
  const now = Date.UTC(2026, 6, 12, 0, 0, 0);
  const state = deriveQuotaState({
    primary: {
      limitId: "codex",
      primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: now / 1000 + 60 * 60 },
      rateLimitReachedType: "rate_limit_reached",
    },
    byId: {
      secondary: {
        limitId: "secondary",
        primary: { usedPercent: 99.5, windowDurationMins: 300, resetsAt: now / 1000 + 60 * 60 },
        rateLimitReachedType: null,
      },
    },
    fetchedAt: new Date(now).toISOString(),
    raw: {},
  }, 20, now);

  assert.equal(state.sourceLimitId, "codex");
  assert.equal(state.usedPercent, 99);
  assert.equal(state.exhausted, true);
  assert.equal(state.rateLimitReachedType, "rate_limit_reached");
  assert.equal(state.healthy, false);
});
