# Integrations

Counterlane supports three invocation layers. They have different control authority and should not be conflated.

## 1. Counterlane CLI — root control

Use this when Counterlane must truly choose the top-level Codex route before execution:

```bash
counterlane auto --prompt "TASK"
counterlane run --mode auto --prompt "TASK"
counterlane compare --prompt "TASK"
```

The CLI owns the App Server connection and supplies `model`, `effort`, and `serviceTier` to `turn/start`. This is the only bundled path that transparently controls the initial root turn.

## 2. Codex plugin — direct composer invocation

The repository is itself a Codex plugin:

```text
.codex-plugin/plugin.json
skills/counterlane/SKILL.md
.mcp.json
```

Install it into the default personal marketplace:

```bash
npm run build
counterlane plugin install-local
codex plugin add counterlane@personal
```

Start a new thread after installation or refresh.

ChatGPT and Work use `@` mentions; Codex CLI/TUI uses `$` skill mentions. Invoke the syntax for the active surface:

```text
@Counterlane Route this task and explain the selected route.
```

In Codex CLI/TUI:

```text
$counterlane Compare Auto and static for this task.
```

The plugin exposes the local stdio MCP server declared in `.mcp.json` and the `counterlane` skill. The skill instructs Codex to call live Counterlane tools rather than guessing model availability, effort support, speed tiers, or quota.

### Important parent-turn limitation

When the skill is invoked, a parent Codex turn has already started. An MCP call cannot retroactively replace that parent turn's root model, effort, or service tier.

The direct plugin can therefore:

- preview a route;
- explain a route;
- inspect the live model/speed catalog and quota;
- delegate a new isolated Counterlane-owned Codex run;
- execute paired Auto-vs-static twins.

It cannot silently mutate the route of the current parent turn. A native client integration that intercepts before `turn/start` would be required for that behavior.

## 3. ChatGPT Work or remote integration

For **Work in the desktop app**, the personal marketplace plugin is the simplest route: install it locally and invoke `@Counterlane`.

For **ChatGPT web or a remote workspace**, create a developer-mode app and connect Counterlane through either:

- OpenAI Secure MCP Tunnel, preferably using the bundled stdio server; or
- a public HTTPS `/mcp` endpoint.

Private tunnel example:

```bash
tunnel-client init \
  --profile counterlane-local \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-command "node /absolute/path/to/counterlane/dist/cli.js mcp --stdio"
tunnel-client run --profile counterlane-local
```

Public endpoint example:

```bash
counterlane mcp --http --host 127.0.0.1 --port 8787 --path /mcp
```

Put public traffic behind HTTPS. Authenticated production ChatGPT apps that expose customer-specific data or write actions require an OAuth 2.1 resource-server/authentication layer. Counterlane's optional static bearer token is intended for generic MCP clients and reverse-proxy deployments; it is not a substitute for ChatGPT Apps OAuth.

The included examples are:

```text
deploy/chatgpt-work/remote-mcp.example.json
deploy/chatgpt-work/app.example.json
```

A remote integration only sees repositories and execution environments reachable from the hosted Counterlane process. It does not gain access to a user's local checkout automatically. See [`deploy/chatgpt-work/README.md`](../deploy/chatgpt-work/README.md).

## MCP tools

| Tool | Side effects | Purpose |
|---|---:|---|
| `counterlane_models` | none | Live model, effort, speed-tier, and quota capabilities |
| `counterlane_route` | none | Preview `model × effort × speed × topology` |
| `counterlane_decide` | none | Choose Static, Auto, Twin, or Abstain |
| `counterlane_execute` | isolated | Delegate to the complete meta-controller |
| `counterlane_run` | isolated | Execute one static or Auto arm |
| `counterlane_compare` | isolated | Execute paired counterfactual arms |

MCP execution never applies a patch to the original repository. Use the CLI after reviewing artifacts when application is desired.

MCP also treats repository verifier configuration as untrusted executable
content. It ignores both `verification.commands` and `verification.autoDetect`
from `counterlane.config.json`. Without a verifier policy supplied directly by
the MCP host, execution uses an explicit `no-verifier` posture: only the
`basic` tier is available, zero checks are reported, and the existing elevated
and critical risk floors remain unavailable. The structured tool result exposes
this as `verification.posture: "no-verifier"`, `verified: false`, and a
non-success outcome even when the delegated turn produced a patch. It must not
be presented as independent test evidence. Isolation makes this useful for
reviewable draft artifacts, not for unattended application or a strong-proof
claim.

### Routing arguments exposed to skills and MCP clients

The routing, decision, and execution tools accept optional controls:

```text
model             exact runtime model ID
family            luna | terra | sol
effort            exact advertised reasoning effort
speed             logical service-tier ID, such as standard or fast
topology          single | ultra
latencyPriority   economy | balanced | urgent
```

`speed` is a hard pin. `latencyPriority` is a soft objective. A parent ChatGPT/Codex turn can ask Counterlane to delegate a new run with these controls, but the tool call cannot mutate the route already used by the parent.

Examples:

```text
@Counterlane Preview this task with latencyPriority=urgent, then explain the quota trade-off.
$counterlane Delegate this task with family=terra, effort=high, speed=standard.
```

## Manual MCP configuration

Without the plugin, a local host can launch the MCP server directly:

```json
{
  "mcpServers": {
    "counterlane": {
      "command": "node",
      "args": ["/absolute/path/to/counterlane/dist/cli.js", "mcp", "--stdio"],
      "cwd": "/absolute/path/to/counterlane"
    }
  }
}
```

The plugin-relative `.mcp.json` uses `cwd: "."`, which Codex resolves inside the plugin root.

The local MCP server never accepts the Codex launch executable or arguments
from a repository `counterlane.config.json`. Hosts that need a non-default
launcher must set both host-owned environment variables before starting MCP:

```text
COUNTERLANE_MCP_TRUSTED_CODEX_COMMAND=/absolute/path/to/codex-or-node
COUNTERLANE_MCP_TRUSTED_CODEX_ARGS_JSON=["app-server"]
```

If neither variable is present, MCP uses the built-in `codex app-server`
launcher. Supplying only one or malformed JSON fails closed. MCP also prevents
repository configuration from enabling Codex network access, changing approval
semantics, or injecting extra turn parameters; use the standalone local CLI
when the owner intentionally needs those broader settings.

Repository configuration likewise cannot authorize verifier execution. An MCP
host embedding `callCounterlaneTool` may supply a fully validated, host-owned
`McpToolContext.trustedVerification` policy. That policy replaces, rather than
merges with, the repository verification section. Setting `autoDetect: true`
there is an explicit host authorization to execute detected repository scripts;
leaving it false and listing reviewed argv commands is the safer deployment
default. The bundled stdio and HTTP launchers do not accept verifier commands as
tool arguments. Use the local CLI when repository-owned verification is
intentional, or provide the trusted policy in a host wrapper whose configuration
is outside repository control.

## Plugin update loop

After modifying a linked source checkout:

```bash
npm run check
codex plugin add counterlane@personal
```

Open a new thread to load updated skills and MCP tools. The local installer preserves a backup before changing an existing personal marketplace file.

## Control matrix

| Invocation path | Sees local repo | Owns root `turn/start` | Can apply original patch |
|---|---:|---:|---:|
| `counterlane` CLI | yes | yes | only with explicit apply flag |
| local Codex plugin | yes | delegated run only | no through MCP |
| hosted Work MCP | only hosted/reachable repo | delegated run only | no through MCP |
| hypothetical native pre-turn integration | depends on client | yes | client policy dependent |
