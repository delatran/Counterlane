import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = resolve(root, "generated", "codex-protocol");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const child = spawn("codex", ["app-server", "generate-ts", "--out", out], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
child.on("error", (error) => {
  console.error(`Unable to execute codex: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`codex was terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
