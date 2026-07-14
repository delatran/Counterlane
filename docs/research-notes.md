# Research notes

## Intended contribution

Counterlane is built to test the hypothesis:

> A routing policy should be treated as an intervention over an incumbent no-routing policy, should jointly allocate model capability, reasoning depth, serving speed, execution breadth, and verification, and should selectively acquire paired counterfactual evidence before it is trusted.

The software does not itself establish novelty or superiority. Those remain literature-review and empirical claims.

## Reverse-thinking principles

1. **No-Auto is an action**, not merely the absence of a feature.
2. **The router must earn the right to route** through observed uplift.
3. **Speed is not intelligence**; lower latency is a separately priced control.
4. **Task difficulty is not the sole variable**; verification strength, reversibility, impact, and urgency matter.
5. **An unchosen arm is missing causal data**, not a known loss.
6. **Evaluation is a runtime primitive**, not an offline afterthought.
7. **Ultra is breadth**, while Max is depth.
8. **Best-of-two performance is a system effect**, not router accuracy.
9. **A self-falsifying policy may conclude that Static is better.**
10. **A speed-only change is still a causal intervention** and must be measured as such.

## Action spaces

Outer action:

```text
STATIC
AUTO
TWIN
ABSTAIN
```

Inner action:

```text
a_t = (m_t, e_t, s_t, z_t, v_t)

m_t  model capability
e_t  reasoning effort/depth
s_t  speed or service tier
z_t  execution topology
v_t  verifier policy
```

Speed is not folded into the model or effort. It changes latency, marginal cost, availability, and possibly timeout/reliability behavior, but receives no semantic-capability bonus.

Let `tau(x)` be conditional expected utility uplift of Auto over Static. A conservative decision rule is:

```text
AUTO    if LCB(tau(x)) > deployment margin
STATIC  if UCB(tau(x)) < -deployment margin
TWIN    if expected value of sample information exceeds paired cost
ABSTAIN if an acceptable escape-risk bound cannot be established
```


## Speed as a research axis

Service speed should be evaluated independently from model and effort. A valid speed experiment holds model, effort, topology, prompt, repository, and verifier constant while changing only service tier.

Key quantities:

```text
latency reduction
time-to-first-useful-action
total wall-clock completion
marginal credits
success and bad-escape non-inferiority
quota opportunity cost
```

A speed tier should not receive a success-probability bonus merely because it is faster. Its value enters through latency utility and possibly availability/reliability telemetry.

## Verification-first allocation

The long-term controller minimizes expected cost to verified completion under an upper bound on undetected failure. It may strengthen verification before escalating the solver.

Mutation auditing remains conditional. It is useful only when expected information or risk reduction exceeds generation and execution cost.

## Failure atlas

A useful learned representation is:

```text
task family × route × failure archetype × verifier -> detected or escaped
```

Here, route includes speed because service reliability or timeout behavior may create operational failure modes even when semantic capability is unchanged.

Candidate archetypes include missed call sites, symptom-only patches, concurrency-only failures, compatibility breaks, test overfitting, destructive migration, permission bypass, hallucinated API use, timeout truncation, and duplicated Ultra work.

## Baselines

A credible study should include:

- always Luna/medium/standard;
- always Terra/medium/standard;
- native or configured Sol/medium/standard;
- Sol/high/standard;
- matched-route Fast versus Standard;
- best fixed route selected on development data;
- prompt-only rule router;
- learned prompt-only router;
- weak-first cascade;
- temporal/trajectory router;
- model-effort joint router;
- model-effort-speed joint router;
- hindsight oracle.

All baselines must use the same harness, prompt, environment, verifier, timeout, and retry budget.

## Launch gates

Suggested preregistered gates:

- paired utility uplift meeting a preregistered uncertainty criterion;
- verified success non-inferior to the strong static baseline;
- at least 20% lower steady-state credits at matched verified success, or a declared latency-quality Pareto gain;
- no increase in bad-escape rate on high-risk slices;
- speed choices reduce wall-clock latency enough to justify marginal cost;
- router overhead below 5% in steady state;
- held-out repository generalization;
- materially lower Ultra waste than difficulty-gated Ultra;
- explicit evidence that the learned policy sometimes chooses Static and Standard speed.

## Publication hygiene

Before publication:

- repeat systematic searches across arXiv, OpenReview, ACL Anthology, ACM, IEEE, Semantic Scholar, and patents;
- inspect forward/backward citations of routing, adaptive compute, causal routing, coding agents, service-tier scheduling, verifier allocation, and mutation testing;
- freeze exact Codex/model/service-tier/pricing snapshots;
- regenerate App Server schemas;
- publish the novelty matrix, ablations, and negative results.
