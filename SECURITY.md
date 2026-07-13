# Security policy

## Supported version

Only the latest release line is supported during the research phase.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose source code, credentials, Codex authentication, or external systems. Send a private report to the repository maintainers and include:

- affected revision;
- reproduction steps;
- impact and preconditions;
- whether the issue crosses the worktree, sandbox, verifier, telemetry, or protocol boundary;
- a minimal proof of concept;
- suggested mitigations if available.

Maintainers should acknowledge reports promptly, reproduce them in an isolated environment, and publish a coordinated advisory after a fix is available.

## High-priority areas

- writes outside an arm worktree;
- automatic application without verified completion;
- hidden verifier leakage;
- shell injection or unsafe command construction;
- symlink/path traversal;
- credential exposure through telemetry;
- approval bypass;
- external irreversible effects in twin mode;
- source-state integrity false negatives;
- App Server request/notification confusion across arms;
- unauthorized hosted MCP calls or bearer-token leakage;
- premium speed/service-tier cost amplification.

See `docs/threat-model.md` for the current threat model and residual risks.
