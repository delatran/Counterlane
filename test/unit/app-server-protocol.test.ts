import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseThreadTokenUsage, parseTurnCompletion } from "../../src/codex/app-server.js";
import { estimateCost } from "../../src/codex/cost.js";
import { testConfig } from "../helpers.js";

void test("invalid token counters are discarded instead of producing negative cost", () => {
  const invalid = {
    total: breakdown(10, 10, 20, 0, 0),
    last: breakdown(10, 10, 20, 0, 0),
    modelContextWindow: 256_000,
  };
  assert.equal(parseThreadTokenUsage(invalid), null);
  const cost = estimateCost(invalid, "sol", testConfig(), 60_000);
  assert.equal(cost.source, "fallback");
  assert.ok(Number.isFinite(cost.normalizedCredits));
  assert.ok(cost.normalizedCredits > 0);
});

void test("token counters must be integral and internally consistent", () => {
  for (const invalid of [
    breakdown(-1, -1, 0, 0, 0),
    breakdown(10.5, 5.5, 0, 5, 0),
    breakdown(11, 5, 0, 5, 0),
    breakdown(10, 5, 0, 5, 6),
  ]) {
    assert.equal(parseThreadTokenUsage({ total: invalid, last: invalid }), null);
  }
});

void test("malformed terminal notifications fail closed", () => {
  assert.equal(parseTurnCompletion({}).status, "failed");
  assert.equal(parseTurnCompletion({ status: "future-maybe" }).status, "failed");
  assert.equal(parseTurnCompletion({ status: "completed", unknownField: 1 }).status, "completed");
  const inconsistent = parseTurnCompletion({
    status: "completed",
    error: { name: "FatalTurnError", message: "the turn failed" },
  });
  assert.equal(inconsistent.status, "failed");
  assert.equal(inconsistent.error?.["name"], "CodexProtocolError");
  assert.equal(parseTurnCompletion({ status: "completed", error: "fatal" }).status, "failed");
});

function breakdown(
  totalTokens: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
) {
  return { totalTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}
