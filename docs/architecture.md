# Architecture

## Design invariants

Counterlane is designed around seven invariants:

1. Model, reasoning effort, and service tier are selected before `turn/start`.
2. Model capability, effort depth, speed, topology, and verification are separate controls.
3. Counterfactual arms receive the same causal starting state.
4. Arm side effects remain isolated until a winner is explicitly applied.
5. Verification is blind to policy identity.
6. Every reported saving includes the cost that produced it.
7. Auto is allowed to lose; the meta-controller may retain Static or Abstain.

## Control-plane layers

```text
Codex plugin / CLI / remote MCP
               │
               ▼
      self-falsifying controller
    STATIC / AUTO / TWIN / ABSTAIN
               │
               ▼
   cognitive-compute route planner
 model × effort × speed × topology
               │
               ▼
       Codex App Server adapter
               │
               ▼
  isolated worktree + blind verifier
```

### Root authority

The standalone CLI owns App Server `turn/start`, so it can set all root-route controls. A skill or MCP tool invoked from inside a parent turn can only advise or delegate because that parent route already exists.

## Codex App Server adapter

`CodexAppServer` starts `codex app-server` over stdio and performs the required initialize/initialized handshake. It exposes:

- runtime model catalog discovery;
- supported reasoning-effort discovery;
- service-tier discovery and default-tier handling;
- live rate-limit reads;
- thread start, resume, fork, and delete;
- turn start and interruption;
- streamed diff, message, token usage, warnings, reroutes, and completion events.

The adapter supplies explicit `model`, `effort`, `serviceTier`, `cwd`, sandbox policy, and approval policy. Sending `serviceTier: null` is intentional: it clears an inherited premium tier when Standard is selected.

The JSON-RPC layer accepts unknown fields, validates only required fields, handles server-initiated approvals, and retries overload errors with bounded exponential backoff and jitter.

## Runtime capability catalog

The catalog parser retains:

```text
model id
model display metadata
default effort
supported efforts
service tiers
default service tier
input modalities
unknown raw fields
```

Availability is catalog-driven. Configuration contains local economics, not capability truth. Unless `allowUnadvertisedTiers` is explicit, Counterlane never sends a speed tier absent from the chosen model's catalog.

## Cognitive-compute router

The controller treats a route as:

```text
a_t = (model, effort, speed/service tier, topology, verifier policy)
```

The inner candidate enumerator currently scores `(model, effort, speed, topology)`; the verifier policy is supplied by the verification plane and remains part of the end-to-end action.

### Capability model

Capability is estimated from model family, effort, task fit, task depth, risk, ambiguity, novelty, and verifiability. Speed is intentionally excluded from capability.

### Speed model

Each logical speed profile has:

```text
costMultiplier
latencyMultiplier
premium
```

Runtime service tiers map to those logical IDs. Standard is always represented locally and maps to `serviceTier: null`. Per-model overrides allow the same logical tier to have different estimated cost or latency without changing its semantic capability.

Premium speed must pass:

- model support;
- task latency-sensitivity threshold;
- live usage threshold;
- marginal-value optimization.

### Topology model

`single` represents one main trajectory. `ultra` represents proactive multi-agent breadth and is separately gated by parallelizability, breadth, quota, and configuration.

### Objective

The bootstrap objective combines:

```text
attempt cost
latency value
quota pressure
failure/escape risk
uncertainty
switching cost
```

It optimizes an approximation to expected verified-completion economics after hard safety and quality constraints.

Quota handling is monotonic. Low or unavailable quota removes expensive dimensions while preserving a safe Standard single lane; an explicit exhausted signal makes every delegated candidate inadmissible. When the App Server exposes several quota buckets without model-to-bucket metadata, the governor selects the most constrained window and does not infer a capability from a bucket name.

## Self-falsifying meta-controller

The outer controller receives:

- the static policy;
- the Auto route;
- task/repository/verifier context;
- live quota state;
- historical paired observations.

It estimates Auto-minus-static utility with conservative empirical-Bayes bounds. A treatment differs from static when **any** of model, effort, speed, or topology differs.

Actions:

```text
STATIC   incumbent remains preferable or evidence is insufficient
AUTO     positive lower-bound uplift earns deployment
TWIN     counterfactual information is worth its acquisition cost
ABSTAIN  impact is high and verification is inadequate
```

## Git isolation plane

`captureSnapshot` records:

- HEAD and branch;
- binary tracked patch relative to HEAD;
- untracked files and safe symlink targets;
- modes and content hashes;
- a stable working-state hash.

`WorktreeManager` creates detached worktrees at the same HEAD, reapplies dirty state, validates symlink confinement, and creates a deterministic baseline commit. Snapshot capture fails closed above 50,000 untracked paths or 512 MiB of cumulative untracked file and link-target content; file size is checked before allocation and probed again while reading so a growing file cannot bypass the memory bound. Repositories using `assume-unchanged` or `skip-worktree` index flags are rejected because those flags can hide working content from Git diffs. It snapshots each configured Git-ignored dependency tree once, rejects source drift with bounded pre/post content fingerprints, and independently materializes every arm from that shared snapshot. Relative links must remain inside the arm and absolute or escaping links fail closed. Configured worktree bases are canonically confined to the repository before creation and cleanup, while the default temporary-directory placement remains unchanged. Both arms therefore diff against equivalent starting states without writable links to dependencies in the original checkout.

Application to the original checkout requires:

1. a completed arm;
2. all required verifier checks passing;
3. a uniquely selected winner;
4. unchanged original source-state hash;
5. `git apply --check` success;
6. an explicit apply flag;
7. the selected verifier passes again in the original checkout after application; otherwise Counterlane reverses the patch.

## Verification plane

Verifier commands are argv arrays, not shell strings. They execute after the turn inside the arm worktree with bounded output and timeout controls.

The verifier is blind to arm identity. A future hidden verifier service can extend this plane without changing the runner contract.

Mutation support currently provides route-conditioned adequacy math and escape-risk bounds. Task-specific mutant generation is deliberately not run unconditionally.

## MCP and plugin plane

The repository includes:

```text
.codex-plugin/plugin.json
.mcp.json
skills/counterlane/SKILL.md
```

The local stdio MCP and hosted HTTP MCP expose the same tool registry. Execution tools are isolated and non-applying.

The plugin surface is an invocation layer, not the root routing authority. See [`integrations.md`](integrations.md).

## Telemetry and certificates

JSONL telemetry stores structured outcomes and route metadata. Raw prompts are opt-in. Certificates include:

- source snapshot identity;
- model, effort, speed/service tier, topology;
- cost and latency estimates;
- actual token usage and duration;
- verification outcomes;
- backend reroutes;
- winner and application status;
- remaining uncertainty.

## Failure containment

The architecture assumes model output, repository content, and verifier commands are untrusted. The practical boundary is OS/container sandboxing plus tool credentials. See [`threat-model.md`](threat-model.md).
