# Study amendment ledger

The v2 pilot is historical evidence only and must not be resumed as the v3 study.

- v2 protocol SHA-256: `46a0e14a43a72e682548e8119d735f5058f9f8a77282303f6a4a3790026d8f6c`
- v2 task hash before the verifier-tier amendment: `2cba874a382ed25120307c58b49a91ee6b1d2622481d04d986c830e4592d7134`
- amendment: `visibleVerifier.minimumTier` changed from implicit/unregistered to `standard`
- consequence: all v2 assignments and observed pilot output are excluded from v3 analysis
- v3 preregistration timestamp: `2026-07-12T05:42:11.511Z`

## v4 runtime-evidence contract

The v3 protocol is superseded before this evidence contract is used for a new paired run.

- v3 protocol SHA-256: `22f6a7f78dd1021506c9ab4c6e10f64a6b67d42c8efdacbb386da2e4aaa8fa93`
- replacement study: `counterlane-codex-app-long-token-v4`
- v4 preregistration timestamp: `2026-07-12T06:50:27.421Z`
- analysis change: the live model catalog is a strict parity gate; sequential quota snapshots are reported without an equality gate; a token-savings claim also requires an effective ON route derived from hashed runtime output
- token change: gross `total_tokens` remains the preregistered common metric; input, cached input, uncached input, output, and reasoning output are persisted and validated as components
- assurance gap: `[UNVERIFIED]` external-oracle placement is proven, but OS-level read denial from the model process is not

## v5 automatic contamination gates

The v4 protocol is superseded before a new paired run because its recorded quota/route evidence did not deterministically block a contaminated token-savings claim.

- v4 protocol SHA-256: `d57eda0ec5a8689728d0714d5cc2d0a4cd2c8c6296b48a7559c4de26ef35d743`
- replacement study: `counterlane-codex-app-long-token-v5`
- v5 preregistration timestamp: `2026-07-12T11:10:54.559Z`
- quota tolerance: matching windows may differ by at most two absolute used-percentage points; plan, bucket, reset-boundary, or larger usage drift is retained as `quota-interference`
- route tolerance: ON must exactly match the preregistered `gpt-5.6-sol`/`xhigh` model route and standard service tier/speed; mismatch is retained as `model-reroute` or `service-tier-drift` and treatment noncompliance
- claim gate: contaminated and noncompliant outcomes stay in intention-to-treat descriptive counts, but `compareCommonCost` cannot mark their comparison claim-eligible

## v6 route-intervention and crash-resume contract

The v5 protocol is superseded before execution because it incorrectly required Counterlane ON to match the native OFF route. That condition removed the routing intervention whose token effect the study is meant to measure.

- v5 protocol SHA-256: `d5fbab8162f52ff40986db20a7dd9ca1cf942ac06500cd22e0bcf6e92848d422`
- replacement study: `counterlane-codex-app-long-token-v6`
- v6 preregistration timestamp: `2026-07-12T12:13:49.560Z`
- intervention rule: an admissible, internally coherent Counterlane Auto selection may intentionally differ from native OFF in model, effort, service tier, speed, topology, or proof tier
- runtime compliance: any backend-reported reroute in either arm is retained as `model-reroute`, makes the pair noncompliant, and blocks token-savings claims
- crash rule: `attempt.json` is created with exclusive write semantics after runtime preflight and before model execution; a crash cannot silently authorize a rerun
- recovery rule: if post-run retention fails, the isolated workspace is preserved and its path is surfaced instead of being deleted in `finally`
