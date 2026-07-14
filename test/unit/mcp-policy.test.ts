import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { secureMcpConfig } from "../../src/mcp/tools.js";
import { testConfig } from "../helpers.js";

void test("MCP repository config cannot broaden host Codex launch or sandbox authority", () => {
  const config = testConfig({
    codex: {
      ...DEFAULT_CONFIG.codex,
      command: "repo-controlled-command",
      args: ["--repo-controlled"],
      approvalPolicy: "on-request",
      sandbox: { type: "workspaceWrite", networkAccess: true },
      extraTurnParams: { dangerousUnknownField: true },
    },
    verification: {
      ...DEFAULT_CONFIG.verification,
      autoDetect: true,
      commands: [{ name: "repo-controlled", command: ["repo-controlled-verifier"], required: true, minimumTier: "adversarial" }],
    },
  });
  const secured = secureMcpConfig(config, { command: "host-command", args: ["app-server"] });
  assert.equal(secured.codex.command, "host-command");
  assert.deepEqual(secured.codex.args, ["app-server"]);
  assert.equal(secured.codex.approvalPolicy, "never");
  assert.deepEqual(secured.codex.sandbox, { type: "workspaceWrite", networkAccess: false });
  assert.deepEqual(secured.codex.extraTurnParams, {});
  assert.equal(secured.verification.autoDetect, false);
  assert.equal(secured.verification.routing.enabled, false);
  assert.deepEqual(secured.verification.routing.candidateTiers, ["basic"]);
  assert.equal(secured.verification.routing.defaultTier, "basic");
  assert.equal(secured.verification.routing.minimumIndependentChecks.basic, 0);
  assert.equal(secured.verification.routing.minimumTierByRisk.elevated, "standard");
  assert.equal(secured.verification.routing.minimumTierByRisk.critical, "strong");
  assert.equal(secured.verification.requireAtLeastOne, false);
  assert.equal(secured.verification.failOnNoVerifier, false);
  assert.equal(secured.verification.requireTaskSpecificCheck, true);
  assert.deepEqual(secured.verification.commands, []);
  assert.equal(secured.meta.enabled, false, "unverified remote execution must not buy a second arm");
});

void test("MCP preserves a repository's stricter read-only sandbox", () => {
  const config = testConfig({
    codex: { ...DEFAULT_CONFIG.codex, sandbox: { type: "readOnly", networkAccess: false } },
  });
  const secured = secureMcpConfig(config, { command: "codex", args: ["app-server"] });
  assert.equal(secured.codex.sandbox.type, "readOnly");
});

void test("MCP accepts verifier authority only from an explicit host-owned policy", () => {
  const config = testConfig({
    verification: {
      ...DEFAULT_CONFIG.verification,
      commands: [{ name: "repo", command: ["repo-verifier"], required: true }],
    },
  });
  const trustedVerification = structuredClone(DEFAULT_CONFIG.verification);
  trustedVerification.autoDetect = false;
  trustedVerification.commands = [{
    name: "host",
    command: ["host-verifier", "--check"],
    required: true,
    taskSpecific: true,
    minimumTier: "standard",
    environment: { HOST_POLICY: "1" },
  }];

  const secured = secureMcpConfig(
    config,
    { command: "codex", args: ["app-server"] },
    trustedVerification,
  );
  assert.deepEqual(secured.verification, {
    ...trustedVerification,
    requireTaskSpecificCheck: true,
  });
  assert.equal(trustedVerification.requireTaskSpecificCheck, false);
  assert.notEqual(secured.verification, trustedVerification);
  assert.notEqual(secured.verification.routing, trustedVerification.routing);
  assert.notEqual(secured.verification.commands[0], trustedVerification.commands[0]);
  assert.equal(secured.meta.enabled, config.meta.enabled);
});
