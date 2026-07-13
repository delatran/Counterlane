import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "counterlane-demo-"));
await writeFile(join(directory, "answer.txt"), "wrong\n", "utf8");
await writeFile(
  join(directory, "verify.mjs"),
  `import { readFile } from "node:fs/promises";\nconst value = await readFile(new URL("./answer.txt", import.meta.url), "utf8");\nif (value !== "correct\\n") { console.error("answer.txt must contain correct"); process.exit(1); }\n`,
  "utf8",
);
await writeFile(
  join(directory, "package.json"),
  JSON.stringify({ name: "counterlane-demo", private: true, type: "module", scripts: { test: "node verify.mjs" } }, null, 2) + "\n",
  "utf8",
);
for (const command of [
  ["git", "init", "-q"],
  ["git", "add", "-A"],
  ["git", "-c", "user.name=Counterlane Demo", "-c", "user.email=demo@local.invalid", "commit", "-qm", "demo baseline"],
]) {
  const result = spawnSync(command[0], command.slice(1), { cwd: directory, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(directory);
