# Security policy

## Supported version

Only the current local release-candidate line is in scope. The supported host
boundary is Windows with Node.js 22 and Git. Linux, macOS, hosted, and
multi-tenant deployments are not supported claims for this release candidate.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose source code, credentials, Codex authentication, or external systems. Use the repository's private reporting channel when the owner has configured one; otherwise contact the repository maintainer through the repository's established private channel before disclosing details. An owner must configure a public security contact before publication. Include:

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
- receipt redaction, artifact-path disclosure, or accounting-boundary misstatement;
- VGCL retry, escalation, or reconciliation that exceeds the bounded attempt contract.

See `docs/threat-model.md` for the current threat model and residual risks.
