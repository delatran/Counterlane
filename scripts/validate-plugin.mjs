#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const root = process.argv[2] === undefined ? PACKAGE_ROOT : resolve(process.argv[2]);
const requiredFiles = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "skills/counterlane/SKILL.md",
  "skills/counterlane/agents/openai.yaml",
  "dist/cli.js",
];
for (const file of requiredFiles) {
  await access(resolve(root, file));
}

const manifest = JSON.parse(await readFile(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
for (const key of ["name", "description", "author", "interface"]) {
  if (manifest[key] === undefined) throw new Error(`plugin.json is missing ${key}`);
}
if (manifest.name !== "counterlane") throw new Error("plugin.json name must be counterlane");
if (manifest.mcpServers !== "./.mcp.json") throw new Error("plugin.json must reference ./.mcp.json");
if (manifest.skills !== "./skills/") throw new Error("plugin.json must reference ./skills/");

const mcp = JSON.parse(await readFile(resolve(root, ".mcp.json"), "utf8"));
const server = mcp?.mcpServers?.counterlane;
if (server?.command !== "node") throw new Error("Counterlane MCP command must be node");
if (!Array.isArray(server.args) || server.args.join(" ") !== "dist/cli.js mcp --stdio") {
  throw new Error("Counterlane MCP args are invalid");
}
if (server.cwd !== ".") throw new Error("Counterlane MCP cwd must remain inside the plugin root");

const skill = await readFile(resolve(root, "skills/counterlane/SKILL.md"), "utf8");
if (!skill.startsWith("---\nname: counterlane\n")) throw new Error("Skill frontmatter is invalid");
if (/\[TODO:/u.test(skill) || /REPLACE_WITH/u.test(skill)) throw new Error("Skill contains an unresolved placeholder");

const skillMetadata = await readFile(resolve(root, "skills/counterlane/agents/openai.yaml"), "utf8");
if (!/display_name:\s*"Counterlane"/u.test(skillMetadata)) throw new Error("Skill UI metadata is missing display_name");
if (!/allow_implicit_invocation:\s*false/u.test(skillMetadata)) {
  throw new Error("Counterlane must require explicit skill invocation to avoid accidental quota spend");
}
if (!/default_prompt:.*\$counterlane/u.test(skillMetadata)) throw new Error("Skill UI metadata must mention $counterlane");

process.stdout.write("Counterlane plugin manifest validated.\n");
