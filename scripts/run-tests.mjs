import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testRoot = resolve(root, "dist-test", "test");
const tests = await collect(testRoot);
if (tests.length === 0) {
  throw new Error(`No compiled tests found under ${testRoot}`);
}

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", ...tests], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

async function collect(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await collect(path)));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      output.push(path);
    }
  }
  return output.sort();
}
