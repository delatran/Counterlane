# Threat model

## Assets

- source code and local secrets;
- Git working state;
- Codex authentication and quota;
- verifier integrity;
- experiment validity;
- telemetry confidentiality;
- hosted MCP bearer credentials;
- external systems reachable by tools.

## Trust boundaries

### Codex model and tool trajectory

Model output is untrusted. It may attempt overly broad edits, network access, external actions, verifier manipulation, or route-policy manipulation.

Controls:

- isolated worktree;
- no network by default;
- approval policy `never` by default;
- bounded turn timeout;
- post-turn diff capture and verification;
- no automatic commit or push;
- no patch application through MCP.

### Repository content

Repository files may contain prompt injection, malicious package scripts, symlink traps, or verifier commands that exfiltrate data.

Controls and limitations:

- Counterlane never evaluates shell strings; commands are argv arrays;
- verifier commands are executable code and must be reviewed;
- untracked paths and symlinks are confined to the worktree;
- network should be enforced below the process layer;
- untrusted repositories should run in a container or VM;
- do not inherit high-value environment secrets into agent or verifier processes.

The current verifier inherits the parent environment plus explicit overrides. A hardened deployment should use an allowlist.

### Codex App Server protocol

App Server messages remain external input.

Controls:

- JSON object checks;
- required-field parsing;
- bounded request timeouts;
- overload retry limits;
- unsupported server requests rejected;
- unknown notifications ignored;
- model/effort/service-tier values derived from the runtime catalog;
- no eval or dynamic code loading.

### Plugin and local MCP

A local plugin launches `node dist/cli.js mcp --stdio` from the plugin root. A malicious replacement of the linked plugin directory or build output would execute with the user's local permissions.

Controls:

- local installer refuses to replace an existing plugin source unless `--force` is explicit;
- marketplace files are backed up before modification;
- plugin manifest and MCP configuration are validated during `npm run check`;
- the project has no production npm dependencies;
- users should inspect source and checksum source archives before installation.

### Hosted HTTP MCP

A hosted endpoint expands the trust boundary to the network.

Controls:

- loopback binding by default;
- optional bearer token from `COUNTERLANE_MCP_TOKEN` or another configured environment variable;
- health endpoints separate from the MCP path;
- deployment documentation requires HTTPS termination;
- execution tools remain non-applying.

Residual risks:

- bearer-token theft;
- reverse-proxy misconfiguration;
- replay or unauthorized tool calls;
- denial of service and quota exhaustion;
- repository exposure from the hosted workspace.

Production deployments should add TLS, network allowlists, secret rotation, request-size limits, structured audit logs, and per-tenant isolation.

### Git paths

Malicious paths or symlinks could attempt writes outside the worktree.

Controls:

- all untracked paths pass a root-bound check;
- only files and symlinks are restored;
- symlink targets that escape the worktree are rejected;
- patch application uses `git apply` without shell expansion;
- artifact and worktree configuration paths cannot escape the repository without an explicit absolute external base.

Residual risk: an agent may follow an existing tracked symlink during execution if the OS sandbox allows it. Container isolation remains necessary.

### Telemetry

Prompts and patches may be sensitive.

Controls:

- prompt storage opt-in;
- telemetry file mode `0600` where supported;
- local-only default;
- event rows omit full patches;
- `.counterlane/` ignored by the Git template.

Residual risk: experiment patches contain source. Encrypt or relocate the data directory for sensitive projects.

## Speed and quota abuse

Premium speed can amplify cost without improving semantic quality.

Controls:

- speed is independent from capability in the router;
- premium tiers require latency-sensitivity evidence;
- live usage gates premium speed;
- unadvertised tiers are rejected by default;
- cost and latency multipliers are visible in config and certificates;
- speed-only experiments account for marginal cost.

Residual risk: stale local economics may underestimate cost. Treat the runtime catalog as availability truth and update profiles when plan economics change.

## Irreversible actions

Counterlane twins must not execute actions that cannot be independently rolled back, including:

- production deploys;
- external database mutations;
- money movement;
- email or chat sending;
- account or permission changes;
- remote branch pushes;
- destructive cloud operations.

The prompt contract is not a sufficient control. Disable corresponding tools and credentials.

## Verifier attacks

An agent can game visible tests, weaken tests, or modify verifier files.

Recommended controls:

- hidden tests outside the worktree;
- verifier code mounted read-only;
- protected-path checks;
- independent semantic checks;
- pre/post verifier behavior comparison;
- task-specific mutants to estimate detection adequacy.

These remain stronger-deployment extensions beyond the basic local verifier.

## Denial of service

Risks include token exhaustion, premium-tier abuse, endless commands, huge output, and worktree accumulation.

Controls:

- request, turn, command, and experiment timeouts;
- bounded stdout/stderr capture;
- quota-aware routing;
- separate Max, Ultra, and premium-speed gates;
- automatic worktree cleanup;
- manual preservation only by policy.
