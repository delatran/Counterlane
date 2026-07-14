import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG_FILE, loadConfig, writeDefaultConfig } from "../../src/config/load.js";
import { deepMerge } from "../../src/config/schema.js";
import type { JsonObject } from "../../src/core/json.js";
import { parseJsonc } from "../../src/core/utils.js";

void test("JSONC parsing preserves comment-like text inside strings", () => {
  const value = parseJsonc(`{
    // comment
    "url": "https://example.test/a//b",
    "pattern": "/* literal */",
  }`) as Record<string, unknown>;
  assert.equal(value["url"], "https://example.test/a//b");
  assert.equal(value["pattern"], "/* literal */");
});

void test("JSONC trailing-comma removal never rewrites comma-bracket text inside strings", () => {
  const value = parseJsonc(`{
    "objectText": "x,}",
    "arrayText": "y,]",
    "nested": [1, 2,],
  }`) as Record<string, unknown>;
  assert.equal(value["objectText"], "x,}");
  assert.equal(value["arrayText"], "y,]");
  assert.deepEqual(value["nested"], [1, 2]);
});

void test("JSONC parsing rejects an unterminated block comment", () => {
  assert.throws(
    () => parseJsonc('{"valid":true} /* accidentally truncated'),
    /Unterminated JSONC block comment/u,
  );
});

void test("configuration overlays merge recursively and validate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-"));
  const path = join(directory, "custom.jsonc");
  await writeFile(path, `{
    "routing": {
      "profile": "economy",
      "reservePercent": 35,
      "minimumCompletion": {
        "normal": 0.8,
        "elevated": 0.91,
        "critical": 0.98,
      },
    },
    "verification": {
      "requireTaskSpecificCheck": true,
      "commands": [
        { "name": "custom", "command": ["node", "verify.mjs"], "required": true, "taskSpecific": true }
      ]
    }
  }`, "utf8");
  const { config, configPath } = await loadConfig({ cwd: directory, configPath: "custom.jsonc" });
  assert.equal(configPath, path);
  assert.equal(config.routing.profile, "economy");
  assert.equal(config.routing.reservePercent, 35);
  assert.equal(config.routing.minimumCompletion.elevated, 0.91);
  assert.equal(config.routing.static.family, "sol");
  assert.equal(config.verification.commands[0]?.name, "custom");
  assert.equal(config.verification.commands[0]?.taskSpecific, true);
  assert.equal(config.verification.requireTaskSpecificCheck, true);
});

void test("legacy badEscapePenalty migrates only to the detected verification failure penalty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-legacy-utility-"));
  const path = join(directory, "legacy.json");
  await writeFile(path, JSON.stringify({ utility: { badEscapePenalty: 73 } }), "utf8");
  const { config } = await loadConfig({ cwd: directory, configPath: path });
  assert.equal(config.utility.detectedVerificationFailurePenalty, 73);

  const contradictory = join(directory, "contradictory.json");
  await writeFile(contradictory, JSON.stringify({
    utility: { badEscapePenalty: 73, detectedVerificationFailurePenalty: 9 },
  }), "utf8");
  await assert.rejects(
    loadConfig({ cwd: directory, configPath: contradictory }),
    /contradictory utility\.badEscapePenalty/u,
  );
});

void test("implicit configuration discovery searches upward from a nested non-Git directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-discovery-"));
  const nestedDirectory = join(directory, "workspace", "src", "feature");
  const configPath = join(directory, DEFAULT_CONFIG_FILE);
  await mkdir(nestedDirectory, { recursive: true });
  await writeFile(configPath, JSON.stringify({ routing: { profile: "economy" } }), "utf8");

  const loaded = await loadConfig({ cwd: nestedDirectory });

  assert.equal(loaded.configPath, configPath);
  assert.equal(loaded.config.routing.profile, "economy");
});

void test("implicit configuration discovery selects the nearest ancestor configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-nearest-"));
  const projectDirectory = join(directory, "project");
  const nestedDirectory = join(projectDirectory, "src", "feature");
  const rootConfigPath = join(directory, DEFAULT_CONFIG_FILE);
  const nearestConfigPath = join(projectDirectory, DEFAULT_CONFIG_FILE);
  await mkdir(nestedDirectory, { recursive: true });
  await writeFile(rootConfigPath, JSON.stringify({ routing: { profile: "economy" } }), "utf8");
  await writeFile(nearestConfigPath, JSON.stringify({ routing: { profile: "quality" } }), "utf8");

  const loaded = await loadConfig({ cwd: nestedDirectory });

  assert.equal(loaded.configPath, nearestConfigPath);
  assert.equal(loaded.config.routing.profile, "quality");
});

void test("invalid configuration is rejected with a useful path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-bad-"));
  await writeFile(join(directory, "bad.json"), `{ "routing": { "reservePercent": 101 } }`, "utf8");
  await assert.rejects(
    loadConfig({ cwd: directory, configPath: "bad.json" }),
    /routing\.reservePercent/u,
  );
});

void test("artifact and worktree paths cannot escape the repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-path-"));
  for (const [name, overlay, expectedPath] of [
    ["parent", { dataDirectory: "../outside" }, /dataDirectory/u],
    ["drive-relative-data", { dataDirectory: "D:outside" }, /dataDirectory/u],
    ["drive-relative-worktree", { twin: { worktreeBaseDirectory: "D:outside" } }, /worktreeBaseDirectory/u],
    ["drive-relative-telemetry", { telemetry: { file: "D:events.jsonl" } }, /telemetry\.file/u],
  ] as const) {
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify(overlay), "utf8");
    await assert.rejects(loadConfig({ cwd: directory, configPath: path }), expectedPath);
  }
});

void test("probability tables and p90 predictions stay inside their semantic bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-bounds-"));
  for (const [name, overlay, expectedPath] of [
    ["detection-floor", { verification: { routing: { detectionFloors: { basic: 2 } } } }, /detectionFloors\.basic/u],
    ["detection-boost", { verification: { routing: { detectionBoosts: { basic: 1.01 } } } }, /detectionBoosts\.basic/u],
    ["minimum-completion", { routing: { minimumCompletion: { elevated: 1.01 } } }, /minimumCompletion\.elevated/u],
    ["p90", { routing: { prediction: { p90Multiplier: 0.1 } } }, /p90Multiplier/u],
  ] as const) {
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify(overlay), "utf8");
    await assert.rejects(loadConfig({ cwd: directory, configPath: path }), expectedPath);
  }
});

void test("speed profiles accept model-specific economics and reject empty overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-speed-"));
  const validPath = join(directory, "valid.json");
  await writeFile(validPath, JSON.stringify({
    routing: {
      speed: {
        profiles: {
          fast: {
            modelOverrides: [
              { matcher: "gpt-5.4", costMultiplier: 2 },
              { matcher: "re:^gpt-5\\.5", latencyMultiplier: 0.5 },
            ],
          },
        },
      },
    },
  }), "utf8");
  const { config } = await loadConfig({ cwd: directory, configPath: validPath });
  assert.equal(config.routing.speed.profiles["fast"]?.modelOverrides?.length, 2);

  const invalidPath = join(directory, "invalid.json");
  await writeFile(invalidPath, JSON.stringify({
    routing: {
      speed: {
        profiles: {
          fast: { modelOverrides: [{ matcher: "gpt-5.6" }] },
        },
      },
    },
  }), "utf8");
  await assert.rejects(
    loadConfig({ cwd: directory, configPath: invalidPath }),
    /modelOverrides\[0\].*must override/u,
  );
});

void test("invalid speed override regular expressions fail configuration validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-speed-regex-"));
  const path = join(directory, "invalid-regex.json");
  await writeFile(path, JSON.stringify({
    routing: {
      speed: {
        profiles: {
          fast: { modelOverrides: [{ matcher: "re:[", costMultiplier: 2 }] },
        },
      },
    },
  }), "utf8");
  await assert.rejects(
    loadConfig({ cwd: directory, configPath: path }),
    /modelOverrides\[0\]\.matcher.*valid regular expression/u,
  );
});

void test("configuration merge treats prototype-named keys as data without mutating object prototypes", () => {
  const overlay = JSON.parse('{"__proto__":{"polluted":true}}') as JsonObject;
  const merged = deepMerge({ version: 1 }, overlay);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(Object.hasOwn(merged, "__proto__"), true);
  assert.equal((merged["__proto__"] as JsonObject)["polluted"], true);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

void test("configuration loading rejects excessive byte size and nesting before recursive merge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-resource-bound-"));
  const oversizedPath = join(directory, "oversized.json");
  await writeFile(oversizedPath, JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }), "utf8");
  await assert.rejects(
    loadConfig({ cwd: directory, configPath: oversizedPath }),
    /Configuration file exceeds the .*byte safety limit/u,
  );

  let nested: JsonObject = {};
  const root: JsonObject = { nested };
  for (let depth = 0; depth < 70; depth += 1) {
    const next: JsonObject = {};
    nested["next"] = next;
    nested = next;
  }
  const nestedPath = join(directory, "nested.json");
  await writeFile(nestedPath, JSON.stringify(root), "utf8");
  await assert.rejects(
    loadConfig({ cwd: directory, configPath: nestedPath }),
    /exceeds the 64-level depth safety limit/u,
  );
});

void test("configuration rejects fractional or overflowing timer and byte bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-numeric-bound-"));
  for (const [name, overlay, expectedPath] of [
    ["request-timeout-fraction", { codex: { requestTimeoutMs: 1.5 } }, /codex\.requestTimeoutMs/u],
    ["twin-timeout-overflow", { twin: { maximumDurationMs: 2_147_483_648 } }, /twin\.maximumDurationMs/u],
    ["verifier-timeout-overflow", {
      verification: {
        commands: [{ name: "bad", command: ["node", "verify.mjs"], required: true, timeoutMs: 2_147_483_648 }],
      },
    }, /verification\.commands\[0\]\.timeoutMs/u],
    ["output-byte-fraction", { verification: { maximumOutputBytes: 1.5 } }, /verification\.maximumOutputBytes/u],
  ] as const) {
    const path = join(directory, `${name}.json`);
    await writeFile(path, JSON.stringify(overlay), "utf8");
    await assert.rejects(loadConfig({ cwd: directory, configPath: path }), expectedPath);
  }
});

void test("concurrent default-config creation has exactly one winner and never overwrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-config-create-race-"));
  const path = join(directory, DEFAULT_CONFIG_FILE);
  const results = await Promise.allSettled([
    writeDefaultConfig(path),
    writeDefaultConfig(path),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.match(String(rejection?.reason), /Refusing to overwrite existing configuration/u);
  assert.equal((await loadConfig({ cwd: directory, configPath: path })).config.version, 1);
});
