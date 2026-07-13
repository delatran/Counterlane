import { strict as assert } from "node:assert";
import { test } from "node:test";
import { validateThreadProvenance } from "../../src/core/thread-provenance.js";

void test("thread provenance rejects orphan and blank identifiers", () => {
  assert.throws(() => validateThreadProvenance({ lastTurnId: "orphan-turn" }), /lastTurnId requires parentThreadId/u);
  assert.throws(() => validateThreadProvenance({ parentThreadId: " " }), /parentThreadId must be a non-empty string/u);
  assert.throws(
    () => validateThreadProvenance({ parentThreadId: "thread", lastTurnId: " " }),
    /lastTurnId must be a non-empty string/u,
  );
  assert.doesNotThrow(() => validateThreadProvenance({ parentThreadId: "thread", lastTurnId: "turn" }));
});
