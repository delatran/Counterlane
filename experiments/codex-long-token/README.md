# Codex application long-task token study

This preregistered exploratory packet compares two executions of one longer implementation task on the current local Codex application runtime.

| Arm | Execution |
|---|---|
| Counterlane OFF | Native `codex exec`, pinned to `gpt-5.6-sol`, `xhigh`, standard speed, plugins disabled |
| Counterlane ON | Counterlane Auto delegating through the same local Codex runtime and account |

The preregistered common metric is gross runtime `total_tokens` (`input_tokens + output_tokens`). Token savings are interpreted only if both arms pass the visible verifier and external hidden oracle, the ON effective Counterlane route is present in hashed runtime output, and neither cell nor the paired automatic checks are contaminated or noncompliant. A descriptive reduction below 10% is not treated as practically material. Input, cached-input, uncached-input, output, and reasoning-output counts are persisted as structured secondary evidence rather than substituted for the gross primary metric.

The task source, prompt, visible verifier, hidden oracle, runtime build, live model catalog, sequential per-arm quota snapshot, effective ON route, backend reroute stream, write-once attempt marker, and randomized order are bound into the evidence packet. Model-catalog equality is a strict cross-arm gate. Quota snapshots are time-stamped and compared by plan, bucket/window identity, reset boundary, and used percentage; an absolute change above the preregistered two-point tolerance is retained as `quota-interference`. A Counterlane Auto model/effort/tier choice that differs from native OFF is the treatment being measured, not contamination; the ON policy must instead match an admissible sealed Auto-router decision. Any backend-reported reroute in either arm is retained as `model-reroute` and makes the pair noncompliant. Each arm may start only once in a fresh copied fixture. Outcomes remain in intention-to-treat descriptive counts, but any contamination or noncompliance forbids a token-savings claim.

The hidden oracle is outside the copied fixture and undisclosed in the task prompt. `[UNVERIFIED]` The current Codex `workspace-write` sandbox evidence does not deterministically prove OS-level read denial for the study/oracle directory. This study therefore claims an external evaluator, not proven secret-oracle isolation. High-assurance secrecy requires a separate evaluator/service boundary or a verified read-deny sandbox.

`[UNVERIFIED]` Runtime output binds the selected/requested service tier, while the current App Server does not independently attest the backend's effective tier. Model reroute notifications are bound explicitly; a silent tier substitution would remain outside this harness's oracle.

Commands:

```text
node scripts/experiment-2x2.mjs plan --protocol experiments/codex-long-token/protocol.json
node scripts/experiment-2x2.mjs run-codex --protocol experiments/codex-long-token/protocol.json --assignment ASSIGNMENT_ID
node scripts/experiment-2x2.mjs analyze --protocol experiments/codex-long-token/protocol.json
```

This is one exploratory task, not statistical evidence of general token efficiency. Order effects, cache state, service variance, and account quota state remain rival explanations for observed differences.

The original v1 schedule was invalidated after its native control process returned but before a trial could be created: a malformed relative `counterlane.cli` path failed during runtime-evidence collection. The v2 pilot then exposed a verifier-tier mismatch. V3 predated the stronger runtime-evidence contract, and v4 did not deterministically gate contaminated claims. V5 added gates but incorrectly required ON to equal the native route, eliminating the intended routing treatment. The current v6 contract validates the Auto decision itself, binds backend reroutes for both arms, and creates a durable pre-execution attempt marker; v1-v5 output is not mixed into v6 analysis.
