import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { JsonObject } from "../../src/core/json.js";
import type { SingleRunResult } from "../../src/core/types.js";
import { buildProductReceipt, redactPublicReceipt } from "../../src/receipt/receipt.js";
import type { VgclExecutionResult } from "../../src/runner/vgcl.js";

void test("product receipt keeps cumulative attempt accounting separate from unavailable external economics", () => {
  const receipt = buildProductReceipt({
    execution: {
      runId: "vgcl_receipt",
      journalPath: "ignored-by-receipt",
      terminalState: "verified",
      attempts: [fakeResult()],
      accounting: {
        maximumAttempts: 2,
        reserved: 1,
        completed: 1,
        unresolved: 0,
        transportRequests: 1,
        modelAttempts: 1,
        verifierRuns: 1,
        sequentialEscalations: 0,
      },
    } as VgclExecutionResult,
    envelopeHash: "envelope-canary",
    nonApplying: true,
    evidenceKind: "simulated",
    timing: { preflightAndDiscoveryMs: 8, endToEndMs: 70 },
  });

  const attempts = receipt["attempts"] as Array<Record<string, unknown>>;
  const accounting = receipt["attemptAccounting"] as Record<string, unknown>;
  const cumulative = receipt["cumulative"] as Record<string, unknown>;
  const evidence = receipt["evidence"] as Record<string, unknown>;
  const timing = receipt["timing"] as Record<string, unknown>;
  const boundary = receipt["accountingBoundary"] as Record<string, unknown>;
  const actualRoute = attempts[0]?.["actualRoute"] as Record<string, unknown>;

  assert.equal(attempts.length, 1);
  assert.equal(accounting["maximumExpensiveTurns"], 2);
  assert.equal(accounting["transportRequestRetries"], 0);
  assert.equal(accounting["modelAttempts"], 1);
  assert.equal(accounting["verifierRuns"], 1);
  assert.equal(cumulative["totalTokens"], 13);
  assert.equal(cumulative["normalizedTokenCostProxy"], 1.25);
  assert.equal(cumulative["actualEconomics"], "unavailable");
  assert.equal(cumulative["controllerOverheadMs"], 43);
  assert.equal(timing["preflightAndDiscoveryMs"], 8);
  assert.equal(timing["endToEndMs"], 70);
  assert.equal(timing["phasesOverlap"], false);
  assert.equal(boundary["scope"], "root-pre-turn");
  assert.equal(evidence["kind"], "simulated");
  assert.equal(actualRoute["backendAttestation"], "unavailable");
  assert.equal(actualRoute["compliance"], "not-attested");
  assert.equal(typeof receipt["receiptHash"], "string");
});

void test("public receipt redaction removes seeded private canaries without mutating the authoritative receipt", () => {
  const embeddedWindowsPath = ["C:", "Users", "embedded-user-canary", "private.txt"].join("\\");
  const embeddedWorkspacePath = ["D:", "private-workspace-canary", "artifact.json"].join("\\");
  const embeddedCredential = "sk-" + "embeddedCredentialCanary123";
  const authoritative: JsonObject = {
    schemaVersion: 1,
    receiptHash: "authoritative-hash",
    route: { modelId: "gpt-5.6-terra", effort: "medium" },
    prompt: "PROMPT_CANARY",
    nested: {
      verifierOutput: "VERIFIER_CANARY",
      userProfilePath: "C:\\Users\\receipt-user-canary\\private.txt",
      accountId: "ACCOUNT_CANARY",
      quotaId: "QUOTA_CANARY",
      threadId: "THREAD_CANARY",
      turnId: "TURN_CANARY",
      sessionId: "SESSION_CANARY",
      apiKey: "KEY_CANARY",
      accessToken: "TOKEN_CANARY",
      rawAppServerPayload: "RAW_CANARY",
      checks: [{
        name: `task contract at ${embeddedWindowsPath}; artifact ${embeddedWorkspacePath}; using ${embeddedCredential}`,
        passed: false,
      }],
    },
  };
  const before = JSON.stringify(authoritative);
  const publicReceipt = redactPublicReceipt(authoritative);
  const exported = JSON.stringify(publicReceipt);

  assert.equal(JSON.stringify(authoritative), before, "redaction must not rewrite the local authoritative artifact");
  for (const canary of [
    "PROMPT_CANARY",
    "VERIFIER_CANARY",
    "receipt-user-canary",
    "ACCOUNT_CANARY",
    "QUOTA_CANARY",
    "THREAD_CANARY",
    "TURN_CANARY",
    "SESSION_CANARY",
    "KEY_CANARY",
    "TOKEN_CANARY",
    "RAW_CANARY",
    "embedded-user-canary",
    "embeddedCredentialCanary123",
    "private-workspace-canary",
  ]) {
    assert.doesNotMatch(exported, new RegExp(canary, "u"));
  }
  assert.equal(publicReceipt["receiptHash"], "authoritative-hash");
  assert.equal(typeof publicReceipt["publicReceiptHash"], "string");
  assert.equal((publicReceipt["route"] as Record<string, unknown>)["modelId"], "gpt-5.6-terra");
});

function fakeResult(): SingleRunResult {
  return {
    runId: "single_receipt",
    mode: "auto",
    arm: {
      outcome: "success",
      policy: {
        modelId: "gpt-5.6-terra",
        modelFamily: "terra",
        effort: "medium",
        speedId: "standard",
        serviceTier: null,
        topology: "single",
        proofTier: "standard",
      },
      turn: {
        reroutes: [],
        tokenUsage: {
          last: {
            inputTokens: 3,
            cachedInputTokens: 2,
            outputTokens: 5,
            reasoningOutputTokens: 3,
            totalTokens: 13,
          },
        },
        durationMs: 20,
      },
      verification: {
        passed: true,
        adequate: true,
        integrity: "intact",
        taskSpecificPassed: 1,
        taskSpecificTotal: 1,
        durationMs: 7,
        checks: [{ name: "task-contract", passed: true }],
      },
      cost: { normalizedCredits: 1.25, source: "token-derived" },
    },
    durationMs: 62,
    timing: {
      isolationAndMaterializationMs: 3,
      discoveryMs: 4,
      routingAndPolicyMs: 5,
      delegationSetupMs: 6,
      modelMs: 20,
      verifierMs: 7,
      attemptLocalOverheadMs: 8,
      cleanupAndReconciliationMs: 9,
    },
    accountingBoundary: {
      scope: "root-pre-turn",
      parentOrCallerUsage: "not-applicable",
    },
  } as unknown as SingleRunResult;
}
