---
name: counterlane
description: Use Counterlane when a user asks ChatGPT Work or Codex to automatically choose, pin, explain, or compare a Codex model, reasoning effort, speed/service tier, execution topology, or verification policy; optimize quota, latency, and verified completion; or run an Auto-vs-static twin. Invoke the bundled Counterlane MCP tools rather than guessing live model capabilities.
---

# Counterlane

Invoke this skill explicitly as `@Counterlane` in ChatGPT or Work, and as `$counterlane` in Codex CLI/TUI. Implicit invocation is disabled so Counterlane cannot spend quota or launch paired runs unexpectedly.

Counterlane is an evidence-driven adaptive-compute control plane for Codex. Its routing engine keeps five decisions separate:

1. **Model** — Luna, Terra, Sol, or another model advertised by `model/list`.
2. **Reasoning effort** — the depth of inference for the phase or turn.
3. **Speed** — the service tier, such as Standard or Fast. Speed changes latency and economics, not capability.
4. **Topology** — single-agent depth versus Ultra/multi-agent breadth.
5. **Verification** — the evidence required before a result is accepted.

The research controller can retain Static, use Auto, buy a paired Twin, or Abstain. Every route shift must earn the right to intervene from verified paired evidence.

## Choose the MCP tool

- Call `counterlane_route` to inspect the recommended route without executing anything.
- Call `counterlane_decide` to ask whether the controller should keep Static, use Auto, buy a paired Twin, or Abstain.
- Call `counterlane_execute` to delegate the task to the full meta-controller. It never applies source changes to the original repository.
- Call `counterlane_run` for one explicit `auto` or `static` arm.
- Call `counterlane_compare` to run the same task through paired Auto and static arms, blind-verify both, and report the winner.
- Call `counterlane_models` to inspect live model, effort, speed-tier, and quota capabilities.

Always pass the user's task verbatim in `prompt`. Pass `cwd` when the active repository is not the MCP server's current directory. Pass `threadId` and optionally `lastTurnId` only when the user explicitly wants the delegated run to fork an existing Codex conversation.

## Route hints

Every routing or execution tool accepts optional hints:

- `model`: exact runtime model id.
- `family`: `luna`, `terra`, or `sol`.
- `effort`: exact effort supported by that model.
- `speed`: exact logical service tier such as `standard` or `fast`.
- `topology`: `single` or `ultra`.
- `latencyPriority`: `economy`, `balanced`, or `urgent`.

Use `speed` only when the user wants to **pin** a tier. Use `latencyPriority` when the user wants Counterlane to decide whether lower latency is worth the additional quota cost. Hard hints remain subject to risk, verification, availability, and quota gates; unsupported or unsafe combinations fail closed.

## Interpretation rules

- Treat speed as independent from model and effort. Fast is not smarter; it buys lower latency at a higher estimated cost.
- Use `model/list` as the source of truth. Do not invent unsupported model names, effort values, or service tiers. A tier available on one model may be absent on another.
- Do not assume that GPT-5.6 supports a premium speed tier merely because another Codex model does. Capability detection must happen at runtime.
- Do not call Ultra merely because a task is difficult. Ultra requires independent workstreams and separable verification; Max is the depth option for a hard linear bottleneck.
- Do not present a paired best-of-two result as proof that the router itself chose correctly. Distinguish route quality from selective-ensemble value.
- Do not claim that invoking this skill retroactively changes the model, effort, or speed of the parent turn. The parent model is already running. `counterlane_execute` delegates a new Counterlane-owned root run; transparent top-level routing requires invoking the `counterlane` CLI before `turn/start`.
- MCP execution is non-applying by design. Report artifact and certificate paths so the user can inspect results before applying a patch through the CLI.
