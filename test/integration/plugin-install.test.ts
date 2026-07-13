import { strict as assert } from "node:assert";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runCommand } from "../../src/core/process.js";
import { projectRoot } from "../helpers.js";

interface InstallerModule {
  installLocalPlugin(options: Record<string, unknown>): Promise<unknown>;
  commitInstallation(...args: unknown[]): Promise<string | null>;
  validateInstalledSource(root: string): Promise<void>;
}

const installerPromise = import(
  pathToFileURL(resolve(projectRoot, "scripts", "install-local-plugin.mjs")).href
) as Promise<InstallerModule>;

void test("local plugin transaction restores both resources when marketplace commit fails", async () => {
  const installer = await installerPromise;
  const home = await mkdtemp(join(tmpdir(), "counterlane-plugin-rollback-"));
  const pluginParent = join(home, "plugins");
  const pluginTarget = join(pluginParent, "counterlane");
  const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
  const stagedPluginPath = `${pluginTarget}.staging-test`;
  const pluginBackup = `${pluginTarget}.backup-test`;
  const stagedMarketplacePath = `${marketplacePath}.staging-test`;
  const marketplaceRollback = `${marketplacePath}.rollback-test`;
  try {
    await Promise.all([
      mkdir(pluginTarget, { recursive: true }),
      mkdir(stagedPluginPath, { recursive: true }),
      mkdir(join(home, ".agents", "plugins"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(pluginTarget, "old.txt"), "old\n", "utf8"),
      writeFile(join(stagedPluginPath, "new.txt"), "new\n", "utf8"),
      writeFile(marketplacePath, "old marketplace\n", "utf8"),
      writeFile(stagedMarketplacePath, "new marketplace\n", "utf8"),
    ]);
    await assert.rejects(
      installer.commitInstallation(
        { pluginTarget, marketplacePath },
        { current: await lstat(pluginTarget), unchanged: false },
        { staging: stagedPluginPath, backup: pluginBackup },
        { existing: await lstat(marketplacePath) },
        { staging: stagedMarketplacePath, transactionBackup: marketplaceRollback },
        async () => { throw new Error("injected marketplace failure"); },
      ),
      /injected marketplace failure/u,
    );
    assert.equal(await readFile(join(pluginTarget, "old.txt"), "utf8"), "old\n");
    assert.equal(await fileExists(join(pluginTarget, "new.txt")), false);
    assert.equal(await readFile(marketplacePath, "utf8"), "old marketplace\n");
    assert.equal(await fileExists(pluginBackup), false);
    assert.equal(await fileExists(marketplaceRollback), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test("local plugin installer creates a portable personal marketplace entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "counterlane-plugin-home-"));
  const cli = join(projectRoot, "dist", "cli.js");
  const installerArgs = [
    process.execPath,
    cli,
    "plugin",
    "install-local",
    "--home",
    home,
  ];
  const result = await runCommand(installerArgs, {
    cwd: projectRoot,
    timeoutMs: 30_000,
    maximumOutputBytes: 1_000_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);

  const pluginPath = join(home, "plugins", "counterlane");
  const stat = await lstat(pluginPath);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal((await lstat(join(pluginPath, ".codex-plugin", "plugin.json"))).isFile(), true);
  assert.equal((await lstat(join(pluginPath, "dist", "cli.js"))).isFile(), true);
  assert.equal(await fileExists(join(pluginPath, "node_modules")), false);
  assert.equal(await fileExists(join(pluginPath, "counterlane.config.json")), false);
  assert.equal(await fileExists(join(pluginPath, ".env")), false);
  assert.match(result.stdout, /portable copy/u);

  const installer = await installerPromise;
  await writeFile(join(pluginPath, "dist", "cli.js"), "// tampered after staging\n", "utf8");
  await assert.rejects(
    installer.validateInstalledSource(pluginPath),
    /does not match SOURCE_MANIFEST/u,
  );

  const marketplace = JSON.parse(
    await readFile(join(home, ".agents", "plugins", "marketplace.json"), "utf8"),
  ) as { name: string; plugins: Array<{ name: string; source: { path: string } }> };
  assert.equal(marketplace.name, "personal");
  const entry = marketplace.plugins.find((candidate) => candidate.name === "counterlane");
  assert.equal(entry?.source.path, "./plugins/counterlane");
  assert.match(result.stdout, /codex plugin add counterlane@personal/u);

  const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
  const marketplaceDirectory = join(home, ".agents", "plugins");
  const marketplaceBeforeFailure = await readFile(marketplacePath, "utf8");
  const backupsBeforeFailure = (await readdir(marketplaceDirectory)).filter((name) => name.includes(".bak-"));
  const refused = await runCommand(installerArgs, {
    cwd: projectRoot,
    timeoutMs: 30_000,
    maximumOutputBytes: 1_000_000,
  });
  assert.notEqual(refused.exitCode, 0);
  assert.match(refused.stderr, /already exists/u);
  assert.equal(await readFile(marketplacePath, "utf8"), marketplaceBeforeFailure);
  assert.deepEqual(
    (await readdir(marketplaceDirectory)).filter((name) => name.includes(".bak-")),
    backupsBeforeFailure,
  );

  const sentinel = join(pluginPath, "preserve-on-rollback.txt");
  await writeFile(sentinel, "old plugin\n", "utf8");
  await assert.rejects(
    installer.installLocalPlugin({
      home,
      force: true,
      beforeMarketplaceInstall: async () => { throw new Error("injected marketplace failure"); },
    }),
    /injected marketplace failure/u,
  );
  assert.equal(await readFile(sentinel, "utf8"), "old plugin\n");
  assert.equal(await readFile(marketplacePath, "utf8"), marketplaceBeforeFailure);
  assert.ok((await readdir(join(home, "plugins"))).every((name) => !name.includes(".staging-") && !name.includes(".backup-")));
  assert.ok((await readdir(marketplaceDirectory)).every((name) => !name.includes(".staging-") && !name.includes(".rollback-")));

  await rm(home, { recursive: true, force: true });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
  }
}
