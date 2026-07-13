import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = process.argv[2] === undefined ? null : resolve(process.argv[2]);
if (workspace === null) {
  console.error("usage: node tiny-exact-edit.mjs WORKSPACE");
  process.exit(2);
}

const oracleDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const template = resolve(oracleDirectory, "..", "fixtures", "tiny-exact-edit");
const expectedFiles = await listFiles(template, []);
const actualFiles = await listFiles(workspace, [".git", ".counterlane-study"]);

if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  console.error(`task file set changed: expected ${expectedFiles.join(", ")}; got ${actualFiles.join(", ")}`);
  process.exit(1);
}

for (const path of expectedFiles) {
  const actual = await readFile(join(workspace, path));
  if (path === "answer.txt") {
    if (actual.toString("utf8") !== "counterlane-smoke\n") {
      console.error("answer.txt does not contain the hidden expected value");
      process.exit(1);
    }
    continue;
  }
  const expected = await readFile(join(template, path));
  if (!actual.equals(expected)) {
    console.error(`unexpected modification to ${path}`);
    process.exit(1);
  }
}

async function listFiles(root, excludedNames) {
  const output = [];
  await visit(root, root, excludedNames, output);
  return output.sort();
}

async function visit(root, directory, excludedNames, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedNames.includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(root, path, excludedNames, output);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`unsupported fixture entry: ${basename(path)}`);
    }
    const candidate = relative(root, path).split(sep).join("/");
    output.push(candidate);
  }
}
