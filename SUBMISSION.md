# Counterlane submission draft

## Recommended category

Developer Tools is the recommended category because Counterlane is a local
verification-gated compute governor for Codex. This is a recommendation, not a
statement of event eligibility, acceptance, prize status, or platform review.

## Problem

Delegated coding work can spend more compute than necessary, silently choose
unadvertised service tiers, and accept patches without a task-specific
verification contract. A faster route is not automatically a more capable
route, and a best-of-two comparison does not prove a router predicted the
winner in advance.

## Solution

Counterlane starts with the least expensive admissible route, freezes the
verification requirements, runs in an isolated worktree, escalates only after
bounded observed failure, and produces a route receipt. The preferred product
tool, counterlane_execute, does not apply source changes and does not start
hidden paired exploration.

## Technical design

- Node.js 22 and strict TypeScript runtime with no runtime dependencies.
- Versioned Codex App Server payload handling that preserves unknown fields.
- Independent controls for model, reasoning effort, speed/service tier,
  topology, and verification.
- Immutable external, host-owned, data-only task-specific verifier policy for product MCP execution.
- A frozen execution envelope, atomic VGCL journal, bounded two-attempt
  escalation, non-applying execution, and deterministic receipt redaction.
- Offline fresh-consumer package judge and a release-integrity allowlist.

## Impact and novelty

The intended benefit is inspectable governance of delegated Codex work: the
route, verifier, retry boundary, timing, accounting boundary, and reroute
observation are visible in a receipt. This draft makes no measured savings,
provider billing, live model quality, causal improvement, external feedback,
or deployment claim.

## Reproduce locally

~~~powershell
npm ci
npm run check
npm run release:check
npm run release:status
npm run counterlane:doctor -- --json
npm run demo:judge
npm run package:judge
~~~

The committed release state remains `approval_required`; deterministic and
simulated evidence cannot unlock it. One fresh owner-authorized, source-bound,
bounded live MCP smoke remains required before a production-ready claim. No external URL,
feedback identifier, video, commit identifier, or submission result is
invented by this draft.
