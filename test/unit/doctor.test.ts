import { strict as assert } from "node:assert";
import { test } from "node:test";
import { summarizeRateLimitReadiness } from "../../src/cli/doctor.js";

void test("doctor reports a known exhausted primary quota as No-Go while retaining other buckets", () => {
  const now = Date.UTC(2026, 6, 12, 11, 30, 0);
  const readiness = summarizeRateLimitReadiness({
    primary: {
      limitId: "codex",
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: now / 1000 + 604800 },
      rateLimitReachedType: "rate_limit_reached",
    },
    byId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: now / 1000 + 604800 },
        rateLimitReachedType: "rate_limit_reached",
      },
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      },
    },
    fetchedAt: new Date(now).toISOString(),
    raw: {},
  }, 20, now);

  assert.equal(readiness.apiAvailable, true);
  assert.equal(readiness.executionReady, false);
  assert.match(readiness.detail, /selected=codex.*used=100%.*reached=rate_limit_reached/u);
  assert.match(readiness.detail, /codex_bengalfox\{primary:0%/u);
  assert.equal(readiness.detail.match(/codex\{/gu)?.length, 1);
});
