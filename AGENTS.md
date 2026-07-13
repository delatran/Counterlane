# Counterlane contributor instructions

- Keep the runtime dependency-free unless a dependency materially improves safety or correctness.
- Preserve Node.js 22 compatibility and strict TypeScript settings.
- Treat Codex App Server payloads as versioned external data: validate required fields and preserve unknown fields.
- Keep model, reasoning effort, speed/service tier, topology, and verification as independent control dimensions.
- Never grant a speed tier a capability bonus merely because it is faster.
- Never send an unadvertised service tier unless configuration explicitly permits it.
- Never weaken sandbox, approval, worktree-isolation, verifier, or non-applying MCP boundaries for convenience.
- Add or update tests for every behavior change.
- Do not claim causal improvement from best-of-two outcomes; report router, system, learning, and speed-ablation effects separately.
