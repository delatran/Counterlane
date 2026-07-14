# Three-minute local simulated demo

## Boundary

This demo is for a Windows host with Node.js 22 and Git. It is deterministic
and simulated: it does not start a live Codex model turn, publish anything, or
claim real provider economics or live model quality.

## Run

~~~powershell
npm ci
npm run counterlane:doctor -- --json
npm run demo:judge
npm run package:judge
~~~

The doctor verifies local prerequisites and reports a simulated-no-account
mode. The judge drives the packaged MCP server against a local fixture and
checks three paths:

1. Missing trusted verifier returns configuration_required before a model turn.
2. A trusted fixture verifier permits one isolated successful product attempt.
3. A forced verifier failure permits one strict escalation and then verifies
   the successor attempt.

The package judge creates a fresh temporary consumer, packs the current
artifact, installs it offline, runs the doctor and simulated judge from that
consumer, uninstalls it, and checks that the parent checkout fingerprint is
unchanged.

## Explain while running

- The product MCP tool is counterlane_execute.
- Off forces Standard; Auto is gated; Fast fails closed unless an advertised
  configured premium tier is available.
- No hidden Twin or Compare occurs on the product path.
- A receipt distinguishes observed local timing and normalized token-cost
  proxy from unavailable provider economics and external adjudication.

For the exact timed narration and expected labels, see
docs/build-week-demo-script.md.
