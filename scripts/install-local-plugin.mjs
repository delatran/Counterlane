#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPublicPackagePathOrAncestor } from "./public-artifacts.mjs";
import { checkSourceManifest } from "./source-manifest.mjs";

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");

export async function installLocalPlugin(options = {}) {
  const args = options.args ?? {
    home: options.home,
    force: options.force === true,
    link: options.link === true,
    copy: options.copy === true,
  };
  if (args.link && args.copy) throw new Error("Choose either --link or --copy, not both.");
  const home = resolve(args.home ?? homedir());
  const pluginParent = join(home, "plugins");
  const pluginTarget = join(pluginParent, "counterlane");
  const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
  const context = { args, home, pluginParent, pluginTarget, marketplacePath };

  await assertBuilt();
  const pluginState = await inspectPluginTarget(context);
  const marketplaceState = await prepareMarketplace(marketplacePath);
  const stagedPlugin = await stagePluginSource(context, pluginState);
  let stagedMarketplace;
  let marketplaceBackup;
  try {
    stagedMarketplace = await stageMarketplace(marketplacePath, marketplaceState.marketplace);
    marketplaceBackup = await commitInstallation(
      context,
      pluginState,
      stagedPlugin,
      marketplaceState,
      stagedMarketplace,
      options.beforeMarketplaceInstall,
    );
  } catch (error) {
    if (stagedPlugin !== null) {
      await rm(stagedPlugin.staging, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
  return {
    ...context,
    marketplace: marketplaceState.marketplace,
    marketplaceBackup,
  };
}

async function assertBuilt() {
  for (const path of [
    join(PROJECT_ROOT, "dist", "cli.js"),
    join(PROJECT_ROOT, ".codex-plugin", "plugin.json"),
    join(PROJECT_ROOT, ".mcp.json"),
    join(PROJECT_ROOT, "skills", "counterlane", "SKILL.md"),
  ]) {
    const entry = await statOrNull(path);
    if (entry === null || !entry.isFile()) {
      throw new Error(`${path} is missing. Run \`npm run build\` and \`npm run plugin:validate\` before installation.`);
    }
  }
  const sourceDirectory = await statOrNull(join(PROJECT_ROOT, "src"));
  if (sourceDirectory?.isDirectory() === true) {
    await checkSourceManifest({ root: PROJECT_ROOT, quiet: true });
  }
}

async function inspectPluginTarget(context) {
  const current = await statOrNull(context.pluginTarget);
  if (current?.isSymbolicLink() === true && context.args.link) {
    const target = await readlink(context.pluginTarget);
    const resolvedTarget = resolve(dirname(context.pluginTarget), target);
    if (resolvedTarget === PROJECT_ROOT) return { current, unchanged: true };
  }
  if (current !== null && !context.args.force) {
    throw new Error(
      `${context.pluginTarget} already exists. Re-run with --force to replace it after inspection.`,
    );
  }
  return { current, unchanged: false };
}

async function stagePluginSource(context, pluginState) {
  if (pluginState.unchanged) return null;
  await mkdir(context.pluginParent, { recursive: true });
  const suffix = `${process.pid}-${randomUUID()}`;
  const staging = `${context.pluginTarget}.staging-${suffix}`;
  const backup = `${context.pluginTarget}.backup-${suffix}`;
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  try {
    if (context.args.link) {
      const type = process.platform === "win32" ? "junction" : "dir";
      await symlink(PROJECT_ROOT, staging, type);
    } else {
      await cp(PROJECT_ROOT, staging, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter(source) {
          const rel = relative(PROJECT_ROOT, source);
          return !isExcluded(rel);
        },
      });
    }
    await validateInstalledSource(staging);
    return { staging, backup };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function validateInstalledSource(root) {
  const required = [
    join(root, "dist", "cli.js"),
    join(root, ".codex-plugin", "plugin.json"),
    join(root, ".mcp.json"),
    join(root, "skills", "counterlane", "SKILL.md"),
  ];
  for (const path of required) {
    const entry = await statOrNull(path);
    if (entry === null || !entry.isFile()) throw new Error(`Incomplete plugin installation: missing ${path}`);
  }
  await assertInstalledFilesMatchSourceManifest(root);
}

async function assertInstalledFilesMatchSourceManifest(root) {
  const manifestPath = join(root, "SOURCE_MANIFEST.sha256");
  const expected = parseSourceManifest(await readFile(manifestPath, "utf8"), manifestPath);
  const files = [];
  await collectInstalledFiles(root, root, files);
  for (const path of files) {
    const portablePath = relative(root, path).replaceAll("\\", "/");
    if (portablePath === "SOURCE_MANIFEST.sha256") continue;
    const expectedHash = expected.get(portablePath);
    if (expectedHash === undefined) {
      throw new Error(`Installed plugin contains a file absent from SOURCE_MANIFEST.sha256: ${portablePath}`);
    }
    const actualHash = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Installed plugin file does not match SOURCE_MANIFEST.sha256: ${portablePath}`);
    }
  }
}

function parseSourceManifest(raw, manifestPath) {
  const entries = new Map();
  for (const [index, line] of raw.trimEnd().split(/\r?\n/u).entries()) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (match === null) throw new Error(`Malformed source manifest line ${index + 1}: ${manifestPath}`);
    const [, hash, path] = match;
    if (hash === undefined || path === undefined || entries.has(path)) {
      throw new Error(`Duplicate or malformed source manifest path at line ${index + 1}: ${manifestPath}`);
    }
    entries.set(path, hash);
  }
  return entries;
}

async function collectInstalledFiles(root, directory, output) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Installed plugin contains an unsupported symbolic link: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) await collectInstalledFiles(root, path, output);
    else if (entry.isFile()) output.push(path);
    else throw new Error(`Installed plugin contains an unsupported filesystem entry: ${relative(root, path)}`);
  }
}

async function prepareMarketplace(marketplacePath) {
  let marketplace;
  const existing = await statOrNull(marketplacePath);
  if (existing === null) {
    marketplace = {
      name: "personal",
      interface: { displayName: "Personal plugins" },
      plugins: [],
    };
  } else {
    const raw = await readFile(marketplacePath, "utf8");
    try {
      marketplace = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Cannot parse ${marketplacePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isObject(marketplace)) throw new Error(`${marketplacePath} must contain a JSON object.`);
  }

  if (typeof marketplace.name !== "string" || marketplace.name.trim().length === 0) {
    throw new Error(`${marketplacePath} must contain a non-empty marketplace name.`);
  }
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error(`${marketplacePath} field "plugins" must be an array.`);
  }

  const entry = {
    name: "counterlane",
    source: { source: "local", path: "./plugins/counterlane" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };
  const index = marketplace.plugins.findIndex(
    (candidate) => isObject(candidate) && candidate.name === "counterlane",
  );
  if (index >= 0) marketplace.plugins[index] = entry;
  else marketplace.plugins.push(entry);

  return { marketplace, existing };
}

async function stageMarketplace(marketplacePath, marketplace) {
  await mkdir(dirname(marketplacePath), { recursive: true });
  const transactionId = `${process.pid}-${randomUUID()}`;
  const staging = `${marketplacePath}.staging-${transactionId}`;
  const transactionBackup = `${marketplacePath}.rollback-${transactionId}`;
  await rm(staging, { force: true });
  await rm(transactionBackup, { force: true });
  await writeFile(staging, `${JSON.stringify(marketplace, null, 2)}\n`, { mode: 0o600 });
  return { staging, transactionBackup };
}

export async function commitInstallation(
  context,
  pluginState,
  stagedPlugin,
  marketplaceState,
  stagedMarketplace,
  beforeMarketplaceInstall,
) {
  let pluginBackedUp = false;
  let pluginInstalled = false;
  let marketplaceBackedUp = false;
  let marketplaceInstalled = false;
  try {
    if (stagedPlugin !== null) {
      if (pluginState.current !== null) {
        await rename(context.pluginTarget, stagedPlugin.backup);
        pluginBackedUp = true;
      }
      await rename(stagedPlugin.staging, context.pluginTarget);
      pluginInstalled = true;
    }
    if (marketplaceState.existing !== null) {
      await rename(context.marketplacePath, stagedMarketplace.transactionBackup);
      marketplaceBackedUp = true;
    }
    if (beforeMarketplaceInstall !== undefined) await beforeMarketplaceInstall();
    await rename(stagedMarketplace.staging, context.marketplacePath);
    marketplaceInstalled = true;
  } catch (error) {
    const rollbackErrors = await rollbackInstallation({
      context,
      stagedPlugin,
      stagedMarketplace,
      pluginBackedUp,
      pluginInstalled,
      marketplaceBackedUp,
      marketplaceInstalled,
    });
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Plugin installation failed and rollback was incomplete");
    }
    throw error;
  }

  let persistentMarketplaceBackup = null;
  if (marketplaceBackedUp) {
    persistentMarketplaceBackup = `${context.marketplacePath}.bak-${utcStamp()}-${process.pid}-${randomUUID()}`;
    try {
      await rename(stagedMarketplace.transactionBackup, persistentMarketplaceBackup);
    } catch {
      persistentMarketplaceBackup = stagedMarketplace.transactionBackup;
    }
  }
  if (pluginBackedUp) {
    await rm(stagedPlugin.backup, { recursive: true, force: true }).catch(() => undefined);
  }
  return persistentMarketplaceBackup;
}

async function rollbackInstallation(state) {
  const errors = [];
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  };
  if (state.marketplaceInstalled) {
    await attempt(() => rm(state.context.marketplacePath, { force: true }));
  }
  if (state.marketplaceBackedUp) {
    await attempt(() => rename(state.stagedMarketplace.transactionBackup, state.context.marketplacePath));
  }
  if (state.pluginInstalled) {
    await attempt(() => rm(state.context.pluginTarget, { recursive: true, force: true }));
  }
  if (state.pluginBackedUp) {
    await attempt(() => rename(state.stagedPlugin.backup, state.context.pluginTarget));
  }
  if (state.stagedPlugin !== null) {
    await attempt(() => rm(state.stagedPlugin.staging, { recursive: true, force: true }));
  }
  await attempt(() => rm(state.stagedMarketplace.staging, { force: true }));
  await attempt(() => rm(state.stagedMarketplace.transactionBackup, { force: true }));
  return errors;
}

function parseArgs(argv) {
  const parsed = { home: undefined, force: false, link: false, copy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--force") parsed.force = true;
    else if (token === "--link") parsed.link = true;
    else if (token === "--copy") parsed.copy = true;
    else if (token === "--home") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--home requires a path");
      parsed.home = isAbsolute(value) ? value : resolve(value);
      index += 1;
    } else if (token === "--help" || token === "-h") {
      process.stdout.write(
        "Usage: node scripts/install-local-plugin.mjs [--home PATH] [--link|--copy] [--force]\n" +
        "Default mode is a portable copy. Use --link only for local plugin development.\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${token}`);
  }
  if (parsed.link && parsed.copy) throw new Error("Choose either --link or --copy, not both.");
  return parsed;
}

function isExcluded(rel) {
  if (rel === "") return false;
  const normalized = rel.replaceAll("\\", "/");
  if (!isPublicPackagePathOrAncestor(normalized)) return true;
  return normalized.split("/").some((segment) =>
    segment === ".env" ||
    segment.startsWith(".env.") ||
    segment === ".npmrc" ||
    segment === ".netrc" ||
    /\.(pem|key|p12|pfx)$/iu.test(segment)
  );
}

async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(".", "-");
}

async function main(argv) {
  const args = parseArgs(argv);
  const result = await installLocalPlugin({ args });
  process.stdout.write(`Counterlane plugin source: ${result.pluginTarget}\n`);
  process.stdout.write(`Installation mode: ${args.link ? "development link" : "portable copy"}\n`);
  process.stdout.write(`Personal marketplace: ${result.marketplacePath}\n`);
  process.stdout.write(`Marketplace name: ${result.marketplace.name}\n\n`);
  process.stdout.write(`Activate or refresh it with:\n  codex plugin add counterlane@${result.marketplace.name}\n\n`);
  process.stdout.write("Start a new task. In ChatGPT Work/Desktop type @Counterlane; in Codex CLI/TUI type $counterlane.\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
