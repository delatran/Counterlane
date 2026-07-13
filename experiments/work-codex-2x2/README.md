# Work/Codex x Counterlane exploratory smoke study

This preregistered packet exercises four cells:

| Host surface | Counterlane off | Counterlane on |
|---|---|---|
| Codex | Direct `codex exec` with plugins disabled and a pinned model/effort | Built Counterlane CLI `run --mode auto --apply` |
| ChatGPT Work | Native Work without invoking Counterlane | Work invokes the connected Counterlane app |

The task fixture and visible verifier are identical in every cell. The hidden oracle remains outside the disposable fixture and is not included in the task prompt or copied workspace. `[UNVERIFIED]` The current Codex `workspace-write` sandbox evidence does not provide a deterministic OS-level read-deny oracle for the study directory, so this packet does not claim that the model process was technically unable to discover or read the external oracle. High-assurance secrecy requires a separate evaluator/service boundary or a verified read-deny sandbox. The single tracked task makes this a harness smoke test, not efficacy evidence.

## Codex application paired study

`protocol.codex-app.json` narrows the same harness to the owner's clarified two-arm comparison on the current Codex application runtime:

| Arm | Execution |
|---|---|
| Counterlane OFF | Native `codex exec`, pinned to `gpt-5.6-sol`, `xhigh`, standard speed, with plugins disabled |
| Counterlane ON | Counterlane Auto delegating to the same local Codex runtime and account |

The package experiment shortcuts and the harness default target this app-only protocol. The explicit form is:

```text
node scripts/experiment-2x2.mjs plan --protocol experiments/work-codex-2x2/protocol.codex-app.json
node scripts/experiment-2x2.mjs run-codex --protocol experiments/work-codex-2x2/protocol.codex-app.json --assignment ASSIGNMENT_ID
node scripts/experiment-2x2.mjs analyze --protocol experiments/work-codex-2x2/protocol.codex-app.json
```

The randomized schedule contains exactly the two Codex arms. The report therefore emits only the Codex on-minus-off descriptive effect and marks the cross-host interaction as not applicable.

Immediately before each Codex arm, the harness queries the same live Codex App Server for `model/list` and `account/rateLimits/read`. The normalized model-catalog artifact is a strict cross-arm parity gate. Each quota snapshot is retained with its own capture time and hash. The protocol preregisters a two-percentage-point maximum absolute change for matching quota windows; a larger delta, changed plan, missing window, or crossed reset boundary is retained as `quota-interference` and makes the paired token claim ineligible.

The ON arm's model, effort, service tier, speed, topology, and proof tier are derived from the hashed Counterlane `run.stdout.log`. Differences from native OFF are the Auto-routing intervention being measured. Compliance requires an admissible Auto route whose requested policy matches the sealed router decision. Reported backend reroutes are extracted from both ON and native OFF output; any reroute makes the cell noncompliant and blocks a token claim. Native OFF still has no Counterlane route, so that field remains `not-applicable`. Before either Codex arm starts, the harness writes `attempt.json` exclusively; crashes and evidence-retention failures cannot silently authorize a rerun, and a recovery workspace is preserved if retention itself fails.

`[UNVERIFIED]` The current App Server exposes the selected/requested service tier but not an independent attestation of the backend's effective tier. The harness can reject reported model reroutes; it cannot detect a silent tier substitution.

## Commands

Build Counterlane before a Codex-on trial. To run the optional four-cell Work/Codex study, select its protocol explicitly:

```text
npm run build
node scripts/experiment-2x2.mjs plan --protocol experiments/work-codex-2x2/protocol.json
```

The planner writes a deterministic blocked schedule below `.counterlane/studies/`. Use the emitted assignment id with one of:

```text
node scripts/experiment-2x2.mjs run-codex --protocol experiments/work-codex-2x2/protocol.json --assignment ASSIGNMENT_ID
node scripts/experiment-2x2.mjs packet --protocol experiments/work-codex-2x2/protocol.json --assignment ASSIGNMENT_ID --output work-packet.json
node scripts/experiment-2x2.mjs seal-work --protocol experiments/work-codex-2x2/protocol.json --assignment ASSIGNMENT_ID --workspace WORKSPACE --stdout RUN_STDOUT --stderr RUN_STDERR --started-at ISO_8601 --completed-at ISO_8601 --output SEALED_OUTPUT
node scripts/experiment-2x2.mjs import --protocol experiments/work-codex-2x2/protocol.json --input work-import-envelope.json --bundle sealed-bundle-directory
node scripts/experiment-2x2.mjs analyze --protocol experiments/work-codex-2x2/protocol.json
```

`packet` accepts only ChatGPT Work assignments. Work execution is deliberately manual or connected because this repository has no authority to automate the parent Work UI.

The Work importer does not accept a completed trial. It accepts only assignment/timestamp/contamination metadata plus a local sealed bundle containing `bundle.json`, `final.patch`, `run.stdout.log`, and `run.stderr.log`. `bundle.json` must hash every payload file. The importer recomputes those hashes, applies the patch to a fresh fixture with argv-only Git, reruns the common visible verifier and external hidden oracle, derives all outcome booleans, and appends the validated trial. Counterlane-on bundles should also contain raw `counterlane-result.json`; otherwise treatment noncompliance is retained in ITT.

`seal-work` removes the error-prone local packaging steps without automating the Work UI. The workspace must be a Git repository whose `HEAD` exactly matches the registered fixture, with no untracked files; its tracked Work edits remain dirty so `git diff --binary HEAD` can capture them. The stdout, stderr, optional `--counterlane-result FILE`, and output paths must remain outside that workspace. The output parent must already exist as a local non-symlink directory, and the output directory itself must not already exist. The command copies the supplied evidence byte-for-byte into `OUTPUT/bundle/`, hashes every payload into `bundle.json`, and writes `OUTPUT/work-import-envelope.json` with an empty contamination list. Record any intervention in that envelope before importing it:

```text
node scripts/experiment-2x2.mjs import --protocol experiments/work-codex-2x2/protocol.json --input OUTPUT/work-import-envelope.json
```

The sealer never supplies or derives success, cost, or compliance. The existing importer remains the outcome oracle and still replays the patch and runs both verifiers.

Every Codex trial binds `SOURCE_MANIFEST.sha256`, built `dist/cli.js`, the generated Counterlane config when applicable, Node and Codex versions, the live model catalog, the per-arm quota snapshot, the effective ON route (or OFF `not-applicable` status), and an environment hash. Gross `total_tokens` plus input, cached input, uncached input, output, and reasoning output counts are persisted and validated against the hashed stdout artifact. Work imports bind locally observable build/evaluator evidence and mark remote Node, Codex, model-catalog, quota, route, and Counterlane-config values unavailable rather than inventing them.

Analysis is descriptive intention-to-treat. It retains contaminated and noncompliant trials, reports each host's on-minus-off delta and their interaction, and refuses statistical-confidence language for this one-task smoke study. `claimEligible` is always false when either cell or its automatic paired quota/route comparison is contaminated or noncompliant.

The shared task now declares `visibleVerifier.minimumTier: basic`. Because that field changes the registered task and verifier hashes, the earlier v1 schedules are historical only. The four-cell protocol is v3 and the app-only protocol is v4 because automatic preregistered quota/route contamination gates materially changed the analysis contract; older trials must not be mixed into these versions.
