# Configuration

Counterlane searches from the selected working directory upward for `counterlane.config.json`. Use `--config` to select another file.

Generate the full default configuration:

```bash
counterlane init
```

Configuration accepts JSON with comments, but the generated file is ordinary JSON.

## Codex process

```json
{
  "codex": {
    "command": "codex",
    "args": ["app-server"],
    "startupTimeoutMs": 15000,
    "requestTimeoutMs": 30000,
    "turnTimeoutMs": 1800000,
    "approvalPolicy": "never",
    "sandbox": {
      "type": "workspaceWrite",
      "networkAccess": false
    },
    "extraTurnParams": {}
  }
}
```

`extraTurnParams` is an escape hatch for compatible App Server fields. Do not duplicate the fields Counterlane already controls.

Every millisecond timeout or hard deadline must be a positive integer no greater than `2147483647`, the largest delay Node.js can schedule without overflow.

## Static incumbent

```json
{
  "routing": {
    "static": {
      "family": "sol",
      "effort": "medium",
      "speed": "standard"
    }
  }
}
```

The static policy is the No-Auto control. Counterlane maps the family to the current visible model catalog and clamps unsupported effort or speed values.

## Model family matching

```json
{
  "routing": {
    "familyMatchers": {
      "luna": ["luna"],
      "terra": ["terra"],
      "sol": ["sol"]
    }
  }
}
```

Matching is case-insensitive against runtime model IDs and display names. Unknown models remain candidates with conservative economics.

## Reasoning efforts

```json
{
  "routing": {
    "candidateEfforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "enableMax": true,
    "enableUltra": false,
    "maxUsagePercentForMax": 45,
    "maxUsagePercentForUltra": 30
  }
}
```

Only effort values advertised by each model are enumerated. `ultra` is translated to topology `ultra`; all other efforts use topology `single`.

## Speed/service tier

```json
{
  "routing": {
    "speed": {
      "enabled": true,
      "candidateTiers": ["standard", "fast"],
      "defaultTier": "standard",
      "allowUnadvertisedTiers": false,
      "maxUsagePercentForPremium": 45,
      "minimumLatencySensitivityForPremium": 0.38,
      "profiles": {
        "standard": {
          "costMultiplier": 1,
          "latencyMultiplier": 1,
          "premium": false
        },
        "fast": {
          "costMultiplier": 2.5,
          "latencyMultiplier": 0.6666666667,
          "premium": true,
          "modelOverrides": [
            { "matcher": "gpt-5.4", "costMultiplier": 2 },
            { "matcher": "gpt-5.5", "costMultiplier": 2.5 }
          ]
        }
      }
    }
  }
}
```

Definitions:

- `candidateTiers`: logical speed IDs to consider;
- `defaultTier`: fallback local profile;
- `allowUnadvertisedTiers`: whether to send a tier not reported by `model/list`; default false;
- `maxUsagePercentForPremium`: rejects premium speed when the most constrained live bucket is at or above this usage;
- `minimumLatencySensitivityForPremium`: prompt/repository feature threshold;
- `costMultiplier`: local normalized marginal-cost estimate;
- `latencyMultiplier`: expected wall-clock multiplier, where lower is faster;
- `premium`: enables quota and urgency gates;
- `modelOverrides`: optional model-specific economics. `matcher` is a case-insensitive substring or `re:<pattern>`.

The runtime catalog decides whether a tier exists. Profiles decide how Counterlane values it. These multipliers are not billing guarantees. As of the `2026-07-13` documentation snapshot, OpenAI documents [GPT-5.6 availability in Codex](https://help.openai.com/en/articles/20001354-gpt-56-in-chatgpt) and discusses [Fast mode in the GPT-5.6 Codex context](https://openai.com/index/previewing-gpt-5-6-sol/), but those public descriptions do not replace the per-model runtime catalog. Counterlane therefore still refuses to send any unadvertised Fast tier unless configuration explicitly opts in.

## Product MCP speed mode

The product MCP tool uses a bounded permission instead of a raw service-tier
string:

~~~text
off   force Standard
auto  permit a configured advertised premium tier only when foreground and latency gates pass
fast  request a configured advertised premium tier or fail closed
~~~

The host catalog and local configuration remain authoritative. A speed mode
never upgrades model capability, reasoning effort, topology, verifier strength,
or approval authority.


## Per-run route controls

The config defines defaults and policy gates. CLI/MCP requests may additionally constrain one run:

```text
model / --model
family / --family
effort / --effort
speed / --speed
topology / --topology
latencyPriority / --latency-priority
```

The first five are hard constraints. Unsupported combinations return an error rather than silently falling back. `latencyPriority` is soft and changes the latency value used by Auto. Hard pins never override catalog support, critical-task capability floors, premium-speed quota gates, or verifier requirements.

## Quality and route objective

```json
{
  "routing": {
    "profile": "balanced",
    "reservePercent": 20,
    "minimumCompletion": {
      "normal": 0.78,
      "elevated": 0.9,
      "critical": 0.97
    },
    "minimumQuality": {
      "normal": 0.78,
      "elevated": 0.9,
      "critical": 0.97
    },
    "weights": {
      "cost": 0.9,
      "latency": 0.25,
      "quota": 0.8,
      "failure": 2.4,
      "uncertainty": 0.7,
      "switching": 0.1
    }
  }
}
```

`minimumCompletion` is an independent first-pass completion gate. A route whose
completion estimate is below the task's normal, elevated, or critical floor is
not executable merely because a strong verifier is likely to catch its errors.
Before matching telemetry exists, this estimate is explicitly a heuristic prior,
not a calibrated probability. `minimumQuality` separately bounds the estimated
chance that an incorrect artifact escapes verification.

Among routes that clear completion, verification, catalog, quota, and hard
request constraints, Auto chooses the lowest predicted normalized token-cost
proxy. An explicit urgent latency priority may trade cost for latency; a hard
deadline first rejects routes whose predicted p90 misses it. `economy`,
`balanced`, and `quality` change the remaining objective penalties, not either
safety floor. Speed and effort retain separate cost/latency models.

`reservePercent` is a degradation threshold, not an on/off switch. As live quota pressure rises, Counterlane first removes expensive route dimensions such as Twin, premium speed, Max, and Ultra. A safe Standard single route remains eligible. Unknown quota telemetry also permits only this conservative single-lane posture. A known exhausted window (`usedPercent >= 100`, `remainingPercent <= 0`, or `rateLimitReachedType == "rate_limit_reached"`) is a hard abstention condition for all delegated execution.

Rate-limit payloads can expose multiple buckets, but the model catalog currently provides no authoritative model-to-bucket mapping. Counterlane therefore evaluates the most constrained observed window. A separately available bucket is reported by `counterlane doctor`, but it is not assigned to a model by inference.

## Normalized token economics

```json
{
  "routing": {
    "costModel": {
      "inputCreditsPerMillionAtLuna": 25,
      "cachedInputCreditsPerMillionAtLuna": 2.5,
      "outputCreditsPerMillionAtLuna": 150,
      "familyWeights": {
        "luna": 1,
        "terra": 2.5,
        "sol": 5,
        "unknown": 5
      }
    }
  }
}
```

Token economics and speed-tier multipliers are composed. Update both when pricing or entitlement behavior changes.

## Utility compatibility

The utility configuration uses detectedVerificationFailurePenalty for an
observed visible verifier failure. It is not a success credit and cannot make a
failed arm eligible for selection. Older configuration files may provide
badEscapePenalty; Counterlane maps that legacy input only when the new key is
absent and rejects contradictory values. Use the new key in public
configuration examples.

## Meta-controller

```json
{
  "meta": {
    "enabled": true,
    "minimumExactSamples": 4,
    "minimumFallbackSamples": 8,
    "maximumTwinSamplesPerContext": 24,
    "confidenceZ": 1.645,
    "upliftMargin": 0.5,
    "expectedFutureSimilarTasks": 12,
    "maximumQuotaPressureForTwin": 0.62,
    "maximumUsedPercentForTwin": 55,
    "minimumCriticalVerifierStrength": 0.55
  }
}
```

The meta-controller can treat a speed-only change as a treatment. It buys a twin only when expected information value exceeds estimated paired cost and quota permits exploration. This is a Research surface, not the product execute path. The retained confidenceZ field scales a heuristic posterior band for compatibility; it is not a calibrated confidence claim.

## Verification

```json
{
  "verification": {
    "autoDetect": true,
    "requireAtLeastOne": true,
    "failOnNoVerifier": true,
    "requireTaskSpecificCheck": false,
    "defaultTimeoutMs": 600000,
    "maximumOutputBytes": 1000000,
    "commands": [
      {
        "name": "repository-tests",
        "command": ["npm", "test"],
        "required": true,
        "candidateCodePolicy": "executes-candidate-code",
        "minimumTier": "standard"
      }
    ]
  }
}
```

Explicit verifier commands use argv arrays. They are executable code and must be reviewed.

`candidateCodePolicy` is an explicit verifier-authority assertion:

- `executes-candidate-code` is appropriate for repository tests, linters, and wrappers that import or execute candidate files.
- `data-only` is reserved for a verifier that parses candidate artifacts as untrusted data without importing or executing candidate code.

For product MCP certification, `taskSpecific: true` is necessary but not sufficient. The command must come from host authority, use an absolute external immutable entrypoint, declare `candidateCodePolicy: "data-only"`, and remain outside the candidate repository. Inline `node -e`, shell `-c`, PowerShell command strings, and repository wrappers are non-certifying. Repository-owned checks can still support CLI and Research evidence.

Set `requireTaskSpecificCheck` to `true` when proof must include a check of the
delegated task contract. At least one command appropriate for the selected tier
must then declare `taskSpecific: true`; auto-detected and undeclared commands
remain supporting repository-health evidence only. Every declared task-specific
check must pass. The declaration is a trusted policy assertion, not evidence
that an external or hidden oracle ran.

## Twin execution

```json
{
  "twin": {
    "execution": "parallel",
    "preserveWorktrees": "on-failure",
    "maximumDurationMs": 3600000,
    "applyWinnerByDefault": false,
    "requireOriginalStateUnchanged": true,
    "worktreeBaseDirectory": null,
    "dependencyDirectories": ["node_modules"],
    "maximumDependencyFiles": 250000,
    "maximumDependencyBytes": 5000000000
  }
}
```

Parallel twins reduce experiment wall time but can increase concurrent quota pressure. Sequential mode is useful for constrained environments.

Before an arm runs, Counterlane creates one content-fingerprinted dependency snapshot and independently copies each existing Git-ignored `dependencyDirectories` tree from that immutable source into every worktree. Source, snapshot, and arm fingerprints must agree within `maximumDependencyFiles` and `maximumDependencyBytes`; drift fails the experiment instead of giving paired arms different dependencies. Copy-on-write cloning is used when the filesystem supports it, with a regular copy fallback. Counterlane never links an arm to the original dependency tree, and rejects absolute or escaping symlinks and junctions. Dependency entries may not overlap one another, `dataDirectory`, or a configured `worktreeBaseDirectory`. Set the array to `[]` to disable materialization or narrow it when large dependency trees make copy cost unacceptable.

`.venv` is not a cross-platform default because common POSIX environments contain absolute interpreter links and non-relocatable launchers. Add it explicitly only when the environment is relocatable and contains no escaping links; otherwise recreate the virtual environment through a project-specific isolated workflow.

When `worktreeBaseDirectory` is configured, its canonical path must remain inside the repository. The default `null` continues to place isolated worktrees under the operating-system temporary directory.

## Telemetry

```json
{
  "telemetry": {
    "enabled": true,
    "includePrompt": false,
    "allowHostLedgerLearning": false,
    "file": "events.jsonl"
  }
}
```

The repository-local telemetry file is an audit mirror and is never trusted as routing or uplift evidence. Counterlane stores a second ledger under the operating-system state directory (or `COUNTERLANE_TRUST_HOME` when the host explicitly sets it), keyed by canonical repository path, and requires that path to resolve outside the repository. Existing repository-local history is intentionally not imported.

`allowHostLedgerLearning` defaults to `false`. This fail-closed default prevents any historical event from changing Auto scoring or Static/Auto/Twin decisions. Enable it only when every repository verifier and executable hook is trusted: they run as the same operating-system user and can still target the host ledger, so external placement is not cryptographic authentication. Reusing the same canonical path for a different repository also reuses its ledger; delete or relocate that ledger before opting in for the replacement repository.

Raw prompts are disabled by default. Patch artifacts remain sensitive even when prompt logging is off.
