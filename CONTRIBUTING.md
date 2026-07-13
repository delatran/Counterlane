# Contributing

## Development setup

```bash
npm ci
npm run check
```

Node.js 22 or newer is required. Runtime code should remain dependency-free unless a dependency provides a clear safety or correctness benefit that cannot reasonably be implemented and audited locally.

## Pull requests

A pull request should:

- explain the behavioral change and risk;
- include tests for new behavior;
- preserve strict TypeScript compilation;
- avoid weakening worktree, sandbox, approval, or verifier boundaries;
- update documentation and configuration examples when applicable;
- distinguish measured results from hypotheses;
- avoid claims that best-of-two performance proves router quality.

## Protocol changes

When changing the App Server adapter or route fields:

1. generate the schema from the target Codex build;
2. link the relevant protocol change in the pull request;
3. update the mock App Server;
4. add an integration regression test;
5. state which Codex builds were tested live.

## Research changes

Routing or utility changes should report:

- datasets/task slices;
- static and best-fixed baselines;
- total exploration cost;
- verified success and bad-escape outcomes;
- confidence intervals;
- calibration and held-out behavior;
- all changed coefficients;
- matched model/effort Standard-versus-Fast latency and marginal-cost results when speed routing changes.

Prefer preregistered gates and negative results over post-hoc narratives.

## Code style

- ESM and NodeNext modules;
- explicit types at external boundaries;
- `unknown` rather than unsafe `any`;
- argv arrays instead of shell strings;
- atomic writes for generated state;
- bounded output and timeouts for child processes;
- comments for invariants, not restatements.
