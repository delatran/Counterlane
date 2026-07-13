import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { projectRoot } from "../helpers.js";

interface ManifestHelper {
  generateSourceManifest(options: Record<string, unknown>): Promise<Array<{ path: string; sha256: string }>>;
  checkSourceManifest(options: Record<string, unknown>): Promise<Array<{ path: string; sha256: string }>>;
}

const helperPromise = import(
  pathToFileURL(resolve(projectRoot, "scripts", "source-manifest.mjs")).href
) as Promise<ManifestHelper>;

void test("source manifest generation is deterministic and check fails closed on drift", async () => {
  const helper = await helperPromise;
  const root = await mkdtemp(join(tmpdir(), "counterlane-source-manifest-"));
  const manifestPath = join(root, "SOURCE_MANIFEST.sha256");
  const options = {
    root,
    manifestPath,
    rootFiles: ["package.json"],
    directories: ["dist", "src"],
    quiet: true,
  };
  try {
    await Promise.all([
      mkdir(join(root, "dist")),
      mkdir(join(root, "src")),
    ]);
    await Promise.all([
      writeFile(join(root, "package.json"), "{}\n", "utf8"),
      writeFile(join(root, "dist", "index.js"), "export {};\n", "utf8"),
      writeFile(join(root, "src", "index.ts"), "export {};\n", "utf8"),
    ]);

    const first = await helper.generateSourceManifest(options);
    const firstBytes = await readFile(manifestPath, "utf8");
    const second = await helper.generateSourceManifest(options);
    assert.deepEqual(second, first);
    assert.equal(await readFile(manifestPath, "utf8"), firstBytes);
    const [concurrentLeft, concurrentRight] = await Promise.all([
      helper.generateSourceManifest(options),
      helper.generateSourceManifest(options),
    ]);
    assert.deepEqual(concurrentLeft, first);
    assert.deepEqual(concurrentRight, first);
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp-")), []);
    assert.deepEqual(first.map((entry) => entry.path), ["dist/index.js", "package.json", "src/index.ts"]);
    await helper.checkSourceManifest(options);

    await writeFile(join(root, "src", "index.ts"), "export const changed = true;\n", "utf8");
    await assert.rejects(helper.checkSourceManifest(options), /stale or incomplete/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
