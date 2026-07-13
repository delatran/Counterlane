# Paired experiment protocol

This document defines the minimum protocol for claiming that Auto changes outcomes for the same task.

## Experimental unit

```text
(prompt, conversation prefix, repository working state, environment snapshot)
```

A prompt alone is not an experimental unit. Repository state, dependencies, tools, previous conversation, model catalog, service-tier availability, and quota can all change the outcome.

## Arms

### Control

A frozen static policy such as:

```text
Sol / medium / standard / single
```

Record exact runtime model ID, effort, service tier, topology, and verifier.

### Treatment

Counterlane Auto with a frozen source revision and configuration.

Additional baselines should include best-fixed, strong-static, prompt-only routing, temporal routing, and matched Standard/Fast comparisons.

## State matching

Both arms receive:

- identical HEAD and dirty tracked patch;
- identical untracked files and safe symlink targets;
- identical parent conversation prefix;
- identical task prompt and execution contract;
- equivalent sandbox and approval rules;
- identical verifier commands;
- pinned or recorded external environment;
- the same runtime model catalog snapshot;
- the same initial quota snapshot where simultaneous execution is impossible.

Verifiers do not receive policy metadata.

## Nondeterminism

A paired run is one stochastic sample. Publication-quality evaluation should:

- repeat each arm independently;
- randomize sequential execution order;
- randomize A/B labels;
- cluster uncertainty by repository/task;
- use paired bootstrap intervals for continuous metrics;
- use exact paired tests for binary verified success;
- record backend reroutes;
- report intention-to-treat and as-treated analyses.

## Primary metrics

### Verified success rate

An arm succeeds only when the turn completes and all required hidden/frozen checks pass.

### Credits per verified completion

```text
total generation + routing + verification + exploration credits
--------------------------------------------------------------
                    verified completions
```

### Bad escape rate

Incorrect artifacts accepted by the online verification envelope. This requires a stronger hidden oracle than the verifier visible to the agent system.

### Paired utility delta

```text
U(auto) - U(static)
```

Always expose success, cost, latency, and error components; utility alone can hide trade-offs.

## Speed-specific metrics

A clean speed ablation fixes model, effort, topology, and verifier and changes only service tier.

Report:

- time to first agent message;
- time to first tool call;
- time to first useful patch;
- total turn duration;
- total verified completion duration;
- marginal normalized credits;
- success non-inferiority;
- timeout/error rate;
- premium-tier selection precision and recall for truly urgent tasks.

A Fast tier should win only when the latency utility exceeds marginal cost and quota opportunity cost.

## Cost views

Report:

1. experiment cost: both arms plus routing and verification;
2. amortized policy cost: exploration spread over future exploitation;
3. steady-state route cost: selected single policy after calibration;
4. speed premium: marginal cost of the selected service tier;
5. discarded-arm cost for any best-of-two system.

## Source-state integrity

Counterlane hashes source state before and after execution. Product-owned untracked telemetry is excluded. Any other difference blocks application when safety enforcement is enabled.

For high-assurance studies, run the parent checkout read-only and store artifacts outside it.

## Hidden oracle separation

Visible verifier commands can influence agent behavior. A bad-escape study also needs evaluation unavailable to the agent:

- held-out regression tests;
- independent property checks;
- mutation kill matrices;
- security assertions;
- blinded human adjudication.

## Contamination labels

Record at least:

- service-side `model/rerouted` events;
- unsupported or changed service tier;
- verifier flakiness;
- external network changes;
- dependency drift;
- human intervention;
- timeout or approval denial;
- parent source-state changes;
- concurrent quota depletion;
- service incident or tier availability change.

Do not silently discard contaminated samples.
