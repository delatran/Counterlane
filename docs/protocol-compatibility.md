# Codex App Server compatibility

Counterlane targets the current App Server JSON-RPC control plane and intentionally uses a narrow adapter rather than copying the entire generated protocol into runtime code.

## Required methods

- `initialize` / `initialized`;
- `account/read` where available;
- `account/rateLimits/read` where available;
- `model/list`;
- `thread/start`;
- `thread/resume` and `thread/fork` for conversation branching;
- `thread/delete`;
- `turn/start`;
- `turn/interrupt`.

## Route fields

Counterlane depends on three independent turn controls:

```text
model
reasoning effort
service tier / speed
```

The adapter sends:

```json
{
  "model": "runtime-model-id",
  "effort": "runtime-supported-effort",
  "serviceTier": "runtime-tier-or-null"
}
```

`serviceTier: null` is semantically important because turn overrides can become defaults for subsequent turns. Standard explicitly clears an inherited premium tier.

## Model catalog fields

Counterlane reads:

- model ID and display name;
- default reasoning effort;
- supported reasoning efforts;
- `serviceTiers`;
- `defaultServiceTier`;
- `isDefault` and `hidden`;
- unknown raw fields for forward-compatible diagnostics.

Legacy `additionalSpeedTiers` is normalized when present, but `serviceTiers` is preferred.

## Consumed notifications

- `turn/diff/updated`;
- `item/agentMessage/delta`;
- `item/completed`;
- `thread/tokenUsage/updated`;
- `model/rerouted`;
- `warning`;
- `error`;
- `turn/completed`.

Unknown notifications are ignored. Required IDs and status fields are validated before use.

## Server-initiated requests

Unattended execution declines unsupported approvals and user-input requests. The adapter handles known approval envelopes narrowly and fails closed.

## Schema update process

1. Install the target Codex CLI build.
2. Run `npm run protocol:generate`.
3. Diff generated types against current adapter assumptions.
4. Check model, effort, service-tier, sandbox, approval, and usage schemas.
5. Update the narrow parser and mock fixture.
6. Add a regression test.
7. Run `npm run check`.
8. Test against a real authenticated App Server in a disposable repository.

Do not assume that service-tier IDs, effort names, or model names remain stable. The installed CLI and runtime catalog are the source of truth.

## Transport

Counterlane uses App Server stdio for production local control. The App Server's websocket mode is not required by Counterlane.

Counterlane's own MCP supports:

- stdio for the bundled local Codex plugin;
- a session-aware Streamable HTTP MCP surface for hosted integration, with optional static bearer authentication and an explicit OAuth boundary for production ChatGPT apps.

The MCP transport is not the Codex root control plane.

## Backend rerouting

`model/rerouted` events are recorded in run results and certificates. Scientific analysis should report:

- intention-to-treat by requested route;
- as-treated by effective route;
- contamination sensitivity analysis.
