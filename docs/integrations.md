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

> [!IMPORTANT]
> Hosted and multi-tenant operation are not a supported boundary for this local release candidate. The examples below are deployment templates that require separate ownership, authentication, tenant-isolation, and security review. They are not evidence that a hosted service is running.

For a separately owned **ChatGPT web or remote workspace** deployment, connect Counterlane through either:

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
| `counterlane_decide` | none | Research-only inspection of Static, Auto, Twin, or Abstain; no model turn |
| `counterlane_execute` | isolated | Preferred product path: bounded verification-gated execution with Off, Auto, or Fast speed permission; no hidden Twin or Compare |
| `counterlane_run` | isolated | Advanced execution of one explicit static or Auto arm |
| `counterlane_compare` | isolated | Research-only paired comparison that starts exactly two expensive arms |

MCP execution never applies a patch to the original repository. Use the CLI after reviewing artifacts when application is desired.

MCP treats repository verifier configuration as untrusted executable content.
The product execution tool ignores repository verification commands and
auto-detection. It requires a host-owned task-specific verifier policy with an
absolute external immutable entrypoint and an explicit data-only candidate
contract before starting a delegated model turn. Without that policy, counterlane_execute
returns configuration_required with zero model turns rather than running a
draft path. Research and advanced surfaces must still report their verifier
posture honestly; a simulated or host-local check is not external adjudication.

### Routing arguments exposed to skills and MCP clients

The product execute tool accepts these bounded controls:

~~~text
model             exact runtime model ID
family            luna | terra | sol
effort            exact advertised reasoning effort
speedMode         off | auto | fast
executionContext  foreground | background
topology          single | ultra
latencyPriority   economy | balanced | urgent
~~~

For counterlane_execute, speedMode is the only speed input. Off forces Standard;
Auto may choose a permitted advertised premium tier only when its foreground
and latency gates pass; Fast requests an advertised configured premium tier or
fails closed. Raw speed is retained only by advanced or Research tools. A
parent ChatGPT/Codex turn can delegate a new run with these controls, but the
tool call cannot mutate the route already used by the parent.

Examples:

~~~text
@Counterlane Preview this task with latencyPriority=urgent, then explain the quota trade-off.
$counterlane Execute this task with speedMode=auto and a host-provided trusted verifier.
~~~

### Product receipts

counterlane_execute returns a versioned structured result, receipt metadata,
and a public receipt. The authoritative local receipt is persisted below the
configured Counterlane data directory; its filesystem path is not returned to
the MCP caller. The public receipt is deterministically redacted. It records
observed timing and normalized token-cost proxy data but labels provider
economics, external adjudication, and any parent-turn usage as unavailable or
excluded when they were not observed.

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
`McpToolContext.trustedVerification` policy. Alternatively, the bundled stdio
and HTTP launchers accept this host-owned environment variable at process
startup:

```text
COUNTERLANE_MCP_TRUSTED_VERIFICATION_FILE=/absolute/path/to/host-counterlane.config.json
```

Minimal certifying policy shape (both command paths must be absolute and remain
outside the candidate repository):

```json
{
  "verification": {
    "autoDetect": false,
    "requireAtLeastOne": true,
    "failOnNoVerifier": true,
    "commands": [{
      "name": "task-contract",
      "command": ["/absolute/path/to/node", "/absolute/path/to/task-verifier.mjs"],
      "required": true,
      "taskSpecific": true,
      "candidateCodePolicy": "data-only",
      "minimumTier": "standard"
    }]
  }
}
```

The path must be absolute. Counterlane loads and validates that config, then
uses only its `verification` policy; it replaces, rather than merges with, the
repository verification section. Tool arguments and repository configuration
still cannot supply verifier commands. Setting `autoDetect: true` in the host
policy may authorize detected repository scripts as supporting checks, but
those candidate-controlled commands cannot certify product execution. Leave it
false and list a reviewed external argv command for the product path.

MCP always enables `requireTaskSpecificCheck`, including for a trusted policy.
A certifying command must set `taskSpecific: true` and
`candidateCodePolicy: "data-only"` at an appropriate proof tier. Its executable
and interpreter entrypoint must resolve to immutable files outside the
candidate repository. Inline interpreter programs and repository wrappers are
non-certifying. Generic or candidate-executing checks may remain supporting
evidence, but they cannot turn a delegated arm into verified success. Use a
separate, reviewed host policy for each task contract rather than reusing a
verifier for an unrelated task.

Receipt evidence defaults to `unverified`. A host may set
`COUNTERLANE_EVIDENCE_KIND` to `runtime`, `simulated`, or `unverified`, but that
label alone never unlocks release status; `npm run release:status` independently
validates source binding, launcher digests, verifier result, attempt accounting,
public receipt integrity, and cleanup evidence.

The MCP result reports `hostVerified` and retains `verified` only as a
backward-compatible alias for that host-scoped result. It separately reports
`externalAdjudication: "not-performed"`; Counterlane does not imply that a
hidden oracle ran. `taskSpecific` is a host assertion and must not be presented
as oracle secrecy or external adjudication. Use the local CLI when
repository-owned verification is intentional.

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
