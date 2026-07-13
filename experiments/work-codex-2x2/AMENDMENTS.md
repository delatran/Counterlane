# Study amendment ledger

The shared task verifier acquired an explicit `minimumTier: basic` declaration. This changes the registered task and verifier hashes, so both v1 studies are invalid for the current task definition.

- prior stable task hash without `minimumTier`: `652816956d52b3ee12a4da90cbf0d3297bdac180bda507babe44e3725b2ab9c5`
- current stable task hash: `64a4cddc3ca706b8308b474f1ab420afa3dcd7902a2b6b8d574e868433d8e733`
- superseded studies: `counterlane-work-codex-2x2-smoke-v1`, `counterlane-codex-app-ab-smoke-v1`
- replacement studies: `counterlane-work-codex-2x2-smoke-v2`, `counterlane-codex-app-ab-smoke-v2`
- v2 preregistration timestamp: `2026-07-12T05:56:51.273Z`

## Codex app-only v3 evidence contract

The four-cell Work/Codex protocol remains v2. The app-only v2 protocol is superseded because its runtime evidence did not bind the live model catalog, per-arm quota snapshot, effective ON route, or structured token components to hashed artifacts.

- superseded app-only study: `counterlane-codex-app-ab-smoke-v2`
- v2 protocol SHA-256: `3cf5cc38039760dda3d7ef90bacb2a062d2059ca9a4fefeede048526a046eb2b`
- replacement app-only study: `counterlane-codex-app-ab-smoke-v3`
- v3 preregistration timestamp: `2026-07-12T06:50:27.421Z`
- analysis change: model catalog is a strict parity gate; sequential quota snapshots are reported without an equality gate; ON route must be derived from hashed runtime output; OFF route is `not-applicable`
- token change: gross `total_tokens` remains the common metric and its input/cached/uncached/output/reasoning components are now structured and validated
- assurance gap: `[UNVERIFIED]` external-oracle placement is proven, but OS-level read denial from the model process is not

## Automatic contamination gates

The four-cell v2 and app-only v3 protocols are superseded before a new run because merely reporting quota and route drift still allowed a contaminated token comparison to appear claim-eligible.

- superseded four-cell protocol SHA-256: `385ac2bd2ecea6913adc31bee2573d146a465fc8f5e002fc3f3ca5a44c0fd22c`
- superseded app-only protocol SHA-256: `6ed0640822e793303ebff6d05231a1393fd1fdd90be00dace39ce62787cd278c`
- replacement studies: `counterlane-work-codex-2x2-smoke-v3`, `counterlane-codex-app-ab-smoke-v4`
- preregistration timestamp: `2026-07-12T11:10:54.559Z`
- quota tolerance: matching windows may differ by at most two absolute used-percentage points; plan, bucket, reset-boundary, or larger usage drift is retained as `quota-interference`
- route tolerance: ON must exactly match the preregistered model/effort and standard service tier/speed; mismatch is retained as `model-reroute` or `service-tier-drift` and treatment noncompliance
- claim gate: every assigned outcome remains in descriptive intention-to-treat counts, while any cell or paired contamination/noncompliance makes `claimEligible=false`

## Auto-route intervention and crash-resume contract

The four-cell v3 and app-only v4 protocols are superseded before execution. Their exact-match route gate incorrectly treated a legitimate Counterlane Auto choice as noncompliance, biasing the comparison toward a null routing treatment.

- superseded four-cell protocol SHA-256: `971a85c30561b6eddcc0323a5d67f8d05881a344a8979f8a67200dde88f24e51`
- superseded app-only protocol SHA-256: `b179cc01f0d4c4c2ed3591a453eb42dfb737346328dd4a0c5c29ebfe2fa17d7f`
- replacement studies: `counterlane-work-codex-2x2-smoke-v4`, `counterlane-codex-app-ab-smoke-v5`
- preregistration timestamp: `2026-07-12T12:13:49.560Z`
- intervention rule: the ON route must be admissible and match its sealed Auto-router decision; differences from native OFF are measured treatment dimensions
- runtime rule: backend-reported reroutes in either Codex arm are noncompliant evidence and block cost claims
- crash rule: every Codex model start is preceded by an exclusive write-once `attempt.json`; failed evidence retention preserves the recovery workspace
