import { strict as assert } from "node:assert";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { runCommand } from "../../src/core/process.js";
import { createTestRepository, mockAppServerPath, projectRoot } from "../helpers.js";

void test("CLI exits cleanly when a downstream pipe closes early", { skip: process.platform === "win32" }, async () => {
  const cli = join(projectRoot, "dist", "cli.js");
  const quotedCli = cli.replaceAll("'", "'\"'\"'");
  const result = await runCommand(
    ["bash", "-o", "pipefail", "-c", `node '${quotedCli}' help | head -n 1`],
    { cwd: projectRoot, timeoutMs: 30_000, maximumOutputBytes: 1_000_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, "Counterlane\n");
  assert.doesNotMatch(result.stderr, /EPIPE|Unhandled 'error'/u);
});

void test("CLI propagates model, effort, speed, and latency controls into the route", async () => {
  const repository = await createTestRepository();
  await writeFile(
    join(repository, "counterlane.config.json"),
    `${JSON.stringify({ codex: { command: process.execPath, args: [mockAppServerPath] } }, null, 2)}\n`,
    "utf8",
  );
  const cli = join(projectRoot, "dist", "cli.js");
  const result = await runCommand(
    [
      process.execPath,
      cli,
      "route",
      "--cwd",
      repository,
      "--json",
      "--family",
      "terra",
      "--effort",
      "medium",
      "--speed",
      "fast",
      "--latency-priority",
      "urgent",
      "--prompt",
      "Urgent: fix the deterministic typo and run tests.",
    ],
    { cwd: projectRoot, timeoutMs: 30_000, maximumOutputBytes: 1_000_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const route = JSON.parse(result.stdout) as Record<string, unknown>;
  const selected = route["selected"] as Record<string, unknown>;
  assert.equal(selected["modelFamily"], "terra");
  assert.equal(selected["effort"], "medium");
  assert.equal(selected["speedId"], "fast");
  assert.deepEqual(route["constraints"], {
    modelFamily: "terra",
    effort: "medium",
    speedId: "fast",
    latencyPriority: "urgent",
  });
});

void test("static mode rejects Auto route constraints", async () => {
  const repository = await createTestRepository();
  const cli = join(projectRoot, "dist", "cli.js");
  const result = await runCommand(
    [process.execPath, cli, "run", "--cwd", repository, "--mode", "static", "--speed", "fast", "--prompt", "noop"],
    { cwd: projectRoot, timeoutMs: 30_000, maximumOutputBytes: 1_000_000 },
  );
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Route constraint flags apply to Auto/u);
});

void test("CLI rejects malformed integer tails and conflicting installer modes", async () => {
  const cli = join(projectRoot, "dist", "cli.js");
  for (const [args, message] of [
    [["mcp", "--http", "--port", "8787oops"], /--port must be an integer/u],
    [["history", "--limit", "1.9"], /--limit must be a non-negative integer/u],
    [["history", "--limit", ""], /--limit must be a non-negative integer/u],
    [["history", "--limit", "   "], /--limit must be a non-negative integer/u],
    [["plugin", "install-local", "--link", "--copy"], /either --link or --copy/u],
    [["run", "--last-turn-id", "orphan-turn", "--prompt", "noop"], /--last-turn-id requires --thread-id/u],
  ] as const) {
    const result = await runCommand([process.execPath, cli, ...args], {
      cwd: projectRoot,
      timeoutMs: 30_000,
      maximumOutputBytes: 1_000_000,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, message);
  }
});

void test("CLI metadata commands propagate cancellation and exit 130", async () => {
  const repository = await createTestRepository();
  await writeFile(
    join(repository, "counterlane.config.json"),
    `${JSON.stringify({ codex: { command: process.execPath, args: [mockAppServerPath] } }, null, 2)}\n`,
    "utf8",
  );
  const logDirectory = await mkdtemp(join(tmpdir(), "counterlane-cli-cancel-"));
  const cli = join(projectRoot, "dist", "cli.js");
  const cliUrl = pathToFileURL(cli).href;
  const wrapper = `
import { readFile } from "node:fs/promises";
const args = JSON.parse(process.env.COUNTERLANE_TEST_CLI_ARGS);
process.argv = [process.execPath, ${JSON.stringify(cli)}, ...args];
void (async () => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const requests = await readFile(process.env.MOCK_REQUEST_LOG, "utf8");
      if (requests.includes('"method":"model/list"')) {
        process.emit("SIGINT", "SIGINT");
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.stderr.write("test wrapper did not observe model/list before cancellation deadline\\n");
  process.exitCode = 99;
})();
await import(${JSON.stringify(cliUrl)});
`;

  for (const [command, args] of [
    ["models", ["models", "--cwd", repository, "--json"]],
    ["route", ["route", "--cwd", repository, "--json", "--prompt", "Inspect this task."]],
    ["decide", ["decide", "--cwd", repository, "--json", "--prompt", "Inspect this task."]],
    ["doctor", ["doctor", "--cwd", repository, "--json"]],
  ] as const) {
    const result = await runCommand(
      [process.execPath, "--input-type=module", "--eval", wrapper],
      {
        cwd: projectRoot,
        timeoutMs: 30_000,
        maximumOutputBytes: 1_000_000,
        environment: {
          ...process.env,
          COUNTERLANE_TEST_CLI_ARGS: JSON.stringify(args),
          MOCK_REQUEST_LOG: join(logDirectory, `${command}.jsonl`),
          MOCK_MODEL_LIST_DELAY_MS: "30000",
        },
      },
    );
    assert.equal(result.exitCode, 130, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /Cancelling Counterlane \(SIGINT\)/u, command);
  }
});
