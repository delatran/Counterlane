# Build Week evidence note

## Scope and status

This note describes the source release candidate. It is not a release tag,
external acceptance, live-model quality result, or production-readiness claim.
The authoritative machine state is [`RELEASE_STATUS.json`](RELEASE_STATUS.json),
which is `approval_required` until fresh source-bound runtime evidence passes
the release-status validator.

Counterlane is the verification-gated compute governor for Codex: start with
the least expensive admissible route, prove the result, escalate only on
bounded evidence, and show the complete route receipt.

The product path is counterlane_execute: a no-spend preflight, frozen
task-specific verification, one isolated route, bounded sequential escalation,
and a non-applying receipt. It does not start Twin or Compare. Those paired
surfaces remain explicit Research tools.

## Observed local evidence

The deterministic evidence set is intended to be rerun from a clean,
owner-approved checkout:

~~~text
npm run counterlane:doctor -- --json
npm run demo:judge
npm run package:judge
npm run release:check
npm run release:status
npm run check
~~~

The doctor and judge scripts use a simulated fixture and must be labelled as
simulated evidence. They do not start a live Codex model turn, establish
provider billing, or stand in for an owner-authorized MCP smoke.

## Working-tree delta

Preexisting foundations include the App Server adapter, route models,
worktree isolation, verifier framework, plugin surface, Research comparison
tools, and protocol fixture infrastructure.

This Goal's observed working-tree delta adds or tightens the product
verification-gated controller, frozen execution envelopes, bounded retry and
escalation journaling, safe JSON-RPC retry rules, versioned redacted receipts,
package/install integrity checks, simulated judge coverage, claim discipline,
and release documentation. Existing owner pilot packets remain outside the
public package allowlist.

## Codex and GPT-5.6 wording

Counterlane reads the host Codex App Server catalog rather than hard-coding
model availability. References to GPT-5.6 identify a possible runtime family
when the host advertises it; they do not assert that a particular model created
this delta, that a live turn was run, or that a quality result was observed.

## Remaining owner evidence

The remaining live evidence is one bounded, non-applying MCP smoke on the
supported local host, with an immutable external host verifier that declares a
data-only candidate contract and produces a redacted receipt. It must bind to
the final source manifest and launcher digests, and requires explicit owner
authorization. Deterministic Build Week scripts never manufacture this state.
