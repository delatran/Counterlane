# Build Week demo script

## Goal

Show the local product boundary in under three minutes without presenting a
fixture as live evidence.

## Setup

Use a Windows host with Node.js 22 and Git. Open a terminal in the repository.
State that the session is simulated and non-applying before running commands.

## Timeline

### 0:00 to 0:25 — prerequisites

~~~powershell
npm run counterlane:doctor -- --json
~~~

Say: "This confirms the local Windows, Node, Git, package, fixture-manifest,
and built-artifact prerequisites. It does not authenticate an account or start
a model."

### 0:25 to 1:35 — product guard and bounded escalation

~~~powershell
npm run demo:judge
~~~

Say: "The first fixture path has no host-owned verifier and returns
configuration_required with zero model turns. The second path permits one
isolated verified attempt. The third forces a verifier failure, then observes
one strict escalation. The fixture is simulated, so it is not a live model
claim."

### 1:35 to 2:25 — portable artifact

~~~powershell
npm run package:judge
~~~

Say: "This packs the public allowlist, installs it offline into a fresh
temporary consumer, reruns the doctor and judge from that package, uninstalls
it, and confirms the parent checkout was unchanged."

### 2:25 to 3:00 — receipt and limits

Point to the receipt fields reported by the judge:

- versioned execution state and envelope hash;
- attempt accounting, observed reroute status, and verifier result;
- monotonic local elapsed timing and normalized token-cost proxy;
- unavailable provider economics and external adjudication;
- non-applying original checkout boundary.

Close with: "The release state remains approval_required until one fresh,
source-bound runtime smoke uses an immutable external data-only verifier and
passes the mechanical release-status gate."
