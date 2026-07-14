# Open-source release checklist

## Scope and platform

- [ ] Confirm the release scope is the local Windows, Node.js 22, and Git
  boundary. Do not imply Linux, macOS, hosted, or multi-tenant support.
- [ ] Confirm counterlane_execute remains non-applying, verifier-gated, and
  free of hidden Twin or Compare execution.
- [ ] Confirm Research tools are labelled separately from product evidence.

## Build and install integrity

- [ ] Run npm run check after the final build and source-manifest generation.
- [ ] Run npm run release:check and inspect the explicit package allowlist.
- [ ] Run npm run release:status and confirm the machine state matches the
  available runtime evidence; deterministic fixtures cannot unlock it.
- [ ] Run npm run package:judge to pack, offline-install, run, uninstall, and
  verify the parent checkout boundary.
- [ ] Confirm package install and uninstall leave no source checkout mutation.

## Documentation and compatibility

- [ ] Confirm README, configuration example, integration guide, security
  policy, dependency inventory, and submission draft match the shipped
  behavior.
- [ ] Confirm public configuration accepts the supported utility key and
  rejects contradictory legacy compatibility input.
- [ ] Confirm receipts label simulated evidence, unavailable economics, and
  excluded parent usage honestly.

## Security and licensing

- [ ] Run dependency and vulnerability review against the intended lockfile.
- [ ] Review package surface for credentials, private paths, raw prompts, and
  generated artifacts.
- [ ] Confirm Apache-2.0 LICENSE, NOTICE, and dependency inventory are packed.
- [ ] Review sandbox, approval, worktree, verifier, non-applying MCP, retry,
  escalation, and redaction boundaries.

## Owner publication and rollback

- [ ] Obtain explicit owner approval for any commit, tag, push, publish,
  release, repository mutation, or external announcement.
- [ ] Preserve a known-good package hash and receipt evidence before publish.
- [ ] Define the owner-controlled unpublish, deprecation, or rollback action
  allowed by the target registry and repository policy.
