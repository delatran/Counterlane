import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { CounterlaneConfig } from "../src/config/types.js";
import { runCommand } from "../src/core/process.js";

export const projectRoot = process.cwd();
export const mockAppServerPath = resolve(projectRoot, "test", "fixtures", "mock-app-server.mjs");
process.env["COUNTERLANE_TRUST_HOME"] ??= join(tmpdir(), `counterlane-test-trust-${process.pid}`);

export function normalizeGitText(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

export function testConfig(overrides: Partial<CounterlaneConfig> = {}): CounterlaneConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  const merged = merge(config as unknown as Record<string, unknown>, overrides as unknown as Record<string, unknown>);
  return merged as unknown as CounterlaneConfig;
}

export async function createTestRepository(options: { dirty?: boolean; verifier?: boolean } = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "counterlane-test-repo-"));
  await writeFile(join(directory, "answer.txt"), "wrong\n", "utf8");
  await writeFile(join(directory, "src.ts"), "export const value = 1;\n", "utf8");
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, type: "module", scripts: options.verifier === false ? {} : { test: "node answer.test.mjs" } }, null, 2)}\n`,
    "utf8",
  );
  if (options.verifier !== false) {
    await writeFile(
      join(directory, "answer.test.mjs"),
      `import { readFile } from "node:fs/promises";\nconst text = await readFile(new URL("./answer.txt", import.meta.url), "utf8");\nif (text !== "correct\\n") { console.error("expected answer.txt to contain correct"); process.exit(1); }\n`,
      "utf8",
    );
  }
  await git(directory, ["init", "-q"]);
  await git(directory, ["add", "-A"]);
  await git(directory, ["-c", "user.name=Counterlane Test", "-c", "user.email=test@local.invalid", "commit", "-qm", "baseline"]);
  if (options.dirty === true) {
    await writeFile(join(directory, "src.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(directory, "untracked.txt"), "untracked\n", "utf8");
  }
  return directory;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd, timeoutMs: 30_000, maximumOutputBytes: 1_000_000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function merge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = merge(current, value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
