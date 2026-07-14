# Changelog

## Unreleased

This section describes working-tree changes. It is not a tag, release date, or
published package announcement.

### Product path changes in this Goal

- Added product MCP preflight that requires an immutable external host-owned,
  data-only task-specific verifier before a delegated model turn can start.
- Added frozen verification plans and execution-envelope drift detection.
- Added bounded VGCL attempt journaling, reconciliation, and strict successor
  escalation after observed failure, with the durable send boundary immediately
  before `turn/start`.
- Replaced scalar-score escalation with a frozen explicit capability graph and
  added fail-closed host-verifier ownership plus candidate-code provenance.
- Restricted JSON-RPC overload retry to designated read-safe operations.
- Added versioned local and redacted public route receipts with attempt,
  timing, reroute, and accounting-boundary evidence.
- Added simulated MCP judge, fresh-consumer package judge, explicit public
  package allowlist, source-manifest coverage, and release-integrity check.
- Added a machine-readable release-status gate that keeps the final source at
  `approval_required` until fresh runtime evidence is source-bound and verified.
- Separated product execution claims from Research comparison claims.

### Preexisting foundations retained

- Codex App Server adapter and runtime catalog discovery.
- Route construction across model, reasoning effort, speed, topology, and
  verification.
- Isolated worktrees, verifier framework, telemetry, CLI, plugin, and MCP
  surfaces.
- Explicit paired Research comparison and protocol fixture infrastructure.

No version tag, package publication, production-ready state, live quality
result, or external review is implied by this file.
