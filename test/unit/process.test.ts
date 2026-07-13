import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveCommandForPlatform, runCommand } from "../../src/core/process.js";

void test("Windows npm shims resolve to node plus npm-cli without a shell", () => {
  const files = new Set([
    String.raw`C:\Node\node.exe`,
    String.raw`C:\Node\npm.cmd`,
    String.raw`C:\Node\node_modules\npm\bin\npm-cli.js`,
  ]);
  const resolved = resolveCommandForPlatform(["npm", "test"], {
    platform: "win32",
    environment: { Path: String.raw`C:\Node;D:\Other` },
    execPath: String.raw`D:\Runtime\node.exe`,
    exists: (path) => files.has(path),
  });

  assert.equal(resolved.executable, String.raw`C:\Node\node.exe`);
  assert.deepEqual(resolved.args, [String.raw`C:\Node\node_modules\npm\bin\npm-cli.js`, "test"]);
  assert.equal(resolved.environment?.["Path"], String.raw`C:\Node;D:\Other`);
});

void test("command resolution leaves non-npm executables unchanged", () => {
  const resolved = resolveCommandForPlatform(["git", "status", "--short"], {
    platform: "win32",
    environment: { Path: String.raw`C:\Tools` },
    execPath: String.raw`C:\Node\node.exe`,
    exists: () => false,
  });
  assert.deepEqual(resolved, { executable: "git", args: ["status", "--short"] });
});

void test(
  "runCommand executes npm through its JavaScript entry point on Windows",
  { skip: process.platform !== "win32" },
  async () => {
    const result = await runCommand(["npm", "--version"], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/u);
  },
);

void test(
  "Windows npm scripts inherit the selected Node directory when PATH omits it",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "counterlane-npm-path-"));
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ private: true, scripts: { test: "node verify.mjs" } })}\n`,
      "utf8",
    );
    await writeFile(join(directory, "verify.mjs"), `process.stdout.write("node-path-ok\\n");\n`, "utf8");
    const result = await runCommand(["npm", "test"], {
      cwd: directory,
      timeoutMs: 30_000,
      environment: { ...process.env, Path: "" },
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /node-path-ok/u);
  },
);

void test("caller cancellation terminates verifier process trees", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-process-abort-"));
  const marker = join(directory, "grandchild-ran.txt");
  const grandchild = join(directory, "grandchild.mjs");
  const parent = join(directory, "parent.mjs");
  await writeFile(
    grandchild,
    `import { writeFile } from "node:fs/promises";\nprocess.on("SIGTERM", () => {});\nawait new Promise((resolve) => setTimeout(resolve, 500));\nawait writeFile(${JSON.stringify(marker)}, "unexpected\\n");\n`,
    "utf8",
  );
  await writeFile(
    parent,
    `import { spawn } from "node:child_process";\nspawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });\nawait new Promise((resolve) => setTimeout(resolve, 5000));\n`,
    "utf8",
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("stop test tree")), 50);
  const result = await runCommand([process.execPath, parent], {
    cwd: directory,
    timeoutMs: 10_000,
    signal: controller.signal,
  });
  clearTimeout(timer);
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  await new Promise((resolve) => setTimeout(resolve, 700));
  await assert.rejects(readFile(marker, "utf8"), /ENOENT/u);
});

void test("timeouts are distinct from caller cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-process-timeout-"));
  const result = await runCommand([process.execPath, "-e", "setTimeout(() => {}, 5000)"], {
    cwd: directory,
    timeoutMs: 40,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
});

void test("output is marked truncated only when bytes were actually discarded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-process-output-"));
  const exact = await runCommand([process.execPath, "-e", "process.stdout.write('1234'); process.stderr.write('abcd')"], {
    cwd: directory,
    timeoutMs: 5_000,
    maximumOutputBytes: 4,
  });
  assert.equal(exact.stdout, "1234");
  assert.equal(exact.stderr, "abcd");
  assert.equal(exact.stdoutTruncated, false);
  assert.equal(exact.stderrTruncated, false);

  const overflow = await runCommand([process.execPath, "-e", "process.stdout.write('12345'); process.stderr.write('abcde')"], {
    cwd: directory,
    timeoutMs: 5_000,
    maximumOutputBytes: 4,
  });
  assert.match(overflow.stdout, /^1234\n… <stdout truncated>$/u);
  assert.match(overflow.stderr, /^abcd\n… <stderr truncated>$/u);
  assert.equal(overflow.stdoutTruncated, true);
  assert.equal(overflow.stderrTruncated, true);
});

void test("UTF-8 output split across pipe chunks is decoded without replacement characters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-process-utf8-"));
  const script = [
    "process.stdout.write(Buffer.from([0xe2]));",
    "setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 20);",
  ].join("");
  const result = await runCommand([process.execPath, "-e", script], {
    cwd: directory,
    timeoutMs: 5_000,
    maximumOutputBytes: 3,
  });
  assert.equal(result.stdout, "€");
  assert.equal(result.stdoutTruncated, false);
});

void test("command resource bounds reject invalid numeric values before spawning", async () => {
  await assert.rejects(
    runCommand([process.execPath, "--version"], { cwd: process.cwd(), timeoutMs: 0 }),
    /timeoutMs must be a positive safe integer/u,
  );
  await assert.rejects(
    runCommand([process.execPath, "--version"], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maximumOutputBytes: -1,
    }),
    /maximumOutputBytes must be a non-negative safe integer/u,
  );
});

void test("a child that exits before consuming stdin cannot crash Counterlane", async () => {
  const result = await runCommand([process.execPath, "-e", "process.exit(0)"], {
    cwd: process.cwd(),
    timeoutMs: 5_000,
    input: "x".repeat(10_000_000),
  });
  assert.equal(result.exitCode, 0);
});
