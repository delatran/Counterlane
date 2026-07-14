# Build Week launch checklist

All external items below require owner action. No unchecked item is evidence of
publication, acceptance, or live readiness.

## Owner action required

- [ ] Re-run current platform rules, category guidance, deadlines, and
  eligibility from the authoritative event source.
- [ ] Run the package judge from a fresh owner-controlled Windows machine.
- [ ] Authorize one bounded, non-applying live MCP smoke with a host-owned
  immutable data-only task-specific verifier, bind it to the final source
  manifest and launcher digests, then retain its redacted receipt.
- [ ] Decide whether to run a separately preregistered evaluation study.
- [ ] Perform privacy, secret, license, and dependency review for the intended
  public artifact.
- [ ] Review the final working tree, commit history, repository access, and
  branch protections before any publication.
- [ ] Collect external feedback only through approved owner channels.
- [ ] Record or upload a video only after the owner approves its contents.
- [ ] Create or update any Devpost or other submission only after the owner
  approves the exact content.
- [ ] Add external URLs, screenshots, feedback identifiers, or deadlines only
  after they are observed and approved.

## Local deterministic evidence

- [ ] npm run check
- [ ] npm run release:check
- [ ] npm run release:status
- [ ] npm run counterlane:doctor -- --json
- [ ] npm run demo:judge
- [ ] npm run package:judge
- [ ] npm audit --omit=dev
- [ ] npm audit
