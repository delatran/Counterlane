# GitHub repository setup

## Repository identity

- **Name:** Counterlane
- **Slug:** `counterlane`
- **Description:** Self-falsifying cognitive-compute routing for Codex across model, reasoning effort, speed tier, topology, and verification.
- **Visibility:** Public for reproducibility, or private while collecting proprietary task outcomes.
- **License:** Apache-2.0

Suggested topics:

```text
codex openai coding-agent llm-router model-routing reasoning-effort
fast-mode service-tier mcp codex-plugin chatgpt-work verification
counterfactual causal-inference git-worktree typescript
```

## Create and push

After extracting the source ZIP:

```bash
cd counterlane
git init -b main
git add -A
git commit -m "feat: initial Counterlane source"
git remote add origin git@github.com:YOUR_USERNAME/counterlane.git
git push -u origin main
```

Before the first push:

```bash
npm ci
npm run check
node dist/cli.js help
```

## Recommended GitHub settings

- protect `main`;
- require the `CI` workflow on pull requests;
- require one approving review;
- enable Dependabot security updates;
- enable secret scanning and push protection where available;
- disable force pushes and branch deletion on `main`;
- use environments and required reviewers before adding a hosted MCP, remote verifier, or deployment integration.

Do not commit `.counterlane/`; it can contain patches, experiment outcomes, route certificates, and optional prompts.

## Repository tagline

```text
Route intelligence, depth, and speed—then prove the route earned its cost.
```

## Source archive checklist

1. Run `npm ci` and `npm run build`.
2. Run `npm run source-manifest:generate`, then `npm run check`; the check fails if source or build output drifted after generation.
3. Run `npm audit --omit=dev` and the full audit.
4. Validate a clean `npm ci` installation from the extracted archive.
5. Test the local plugin installer in a temporary home directory.
6. Run a live `counterlane doctor` against the target Codex CLI build.
7. Record the exact Codex build, model catalog, service tiers, plan/quota state, and pricing snapshot.
8. Publish the ZIP checksum and corresponding source commit.
