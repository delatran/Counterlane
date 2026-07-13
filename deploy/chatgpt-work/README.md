# ChatGPT Work / hosted integration

Counterlane supports two direct Work paths:

1. **Local desktop plugin** — install the bundled marketplace plugin and invoke `@Counterlane` in Work.
2. **ChatGPT developer-mode app** — connect the bundled MCP server through OpenAI Secure MCP Tunnel or a public HTTPS `/mcp` endpoint.

The local Codex plugin uses `.mcp.json` and starts Counterlane over stdio. ChatGPT web cannot reach a local stdio process directly, so use a tunnel or hosted endpoint there.

Both MCP transports ignore verifier commands and auto-detected package scripts
from repository configuration. Their default is an isolated, basic
`no-verifier` posture with zero executed checks. Such a run reports
`verified: false` and a non-success outcome even if it returns a patch; elevated
or critical work still fails its proof floor. Treat returned patches as
reviewable drafts, not verified or apply-ready changes. A custom MCP host may inject a reviewed
`McpToolContext.trustedVerification` policy from configuration kept outside the
repository. Do not enable verifier auto-detection in a hosted deployment unless
the mounted repository and every detected script are trusted executable code.

## Preferred private path: OpenAI Secure MCP Tunnel

Keep Counterlane private and let `tunnel-client` reach it over stdio:

```bash
npm run build

tunnel-client init \
  --profile counterlane-local \
  --tunnel-id tunnel_REPLACE_ME \
  --mcp-command "node /absolute/path/to/counterlane/dist/cli.js mcp --stdio"

tunnel-client doctor --profile counterlane-local --explain
tunnel-client run --profile counterlane-local
```

Then create a developer-mode app in ChatGPT, choose **Tunnel**, and select the configured tunnel. This avoids exposing a local repository service to inbound public traffic.

## Public HTTPS path

Start the HTTP MCP server:

```bash
counterlane mcp --http \
  --host 127.0.0.1 \
  --port 8787 \
  --path /mcp
```

Place it behind an HTTPS reverse proxy. For a development app with no private user data, it can run anonymously inside a tightly controlled environment. For customer-specific data or write-capable production use, place an OAuth 2.1 resource-server/authentication layer in front of Counterlane as required by ChatGPT Apps.

Counterlane also supports a static bearer token for generic MCP clients that can send one:

```bash
export COUNTERLANE_MCP_TOKEN='a-long-random-secret'
counterlane mcp --http --host 127.0.0.1 --port 8787 --path /mcp
```

A static bearer token is **not** a replacement for the OAuth 2.1 flow expected by an authenticated production ChatGPT app.

## Create the developer-mode app

1. Enable Developer mode in ChatGPT if the workspace permits it.
2. Open Settings → Plugins and create a developer-mode app.
3. Choose the configured Tunnel, or provide the public HTTPS `/mcp` endpoint.
4. Confirm the six Counterlane tools are discovered.
5. Open a new task and invoke `@Counterlane` or select the app from the composer.

The included examples are:

```text
deploy/chatgpt-work/remote-mcp.example.json
deploy/chatgpt-work/app.example.json
```

`remote-mcp.example.json` is useful for MCP hosts that accept a static bearer-token environment variable. `app.example.json` is a publisher-specific placeholder and is deliberately not referenced by the shipping plugin manifest.

## Repository access

The hosted process can operate only on repositories mounted, checked out, or otherwise reachable in its own execution environment. It does not gain access to a user's local checkout automatically.

## Root-route limitation

A hosted MCP tool can delegate a new Counterlane-controlled Codex run. It cannot retroactively switch the model, effort, or speed tier of the parent ChatGPT turn that invoked it. Transparent root routing requires the Counterlane CLI or another client that owns App Server `turn/start`.
