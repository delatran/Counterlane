import { cwd as processCwd } from "node:process";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "./defaults.js";
import { deepMerge, validateConfig } from "./schema.js";
import type { CounterlaneConfig } from "./types.js";
import { pathExists, parseJsonc, readUtf8Bounded, writeJsonAtomic, writeJsonAtomicNew } from "../core/utils.js";
import { ConfigurationError } from "../core/errors.js";
import { isJsonObject, type JsonObject } from "../core/json.js";

export const DEFAULT_CONFIG_FILE = "counterlane.config.json";
const MAX_CONFIG_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CONFIG_DEPTH = 64;
const MAX_CONFIG_NODES = 100_000;

async function findConfigPath(startDirectory: string): Promise<string | null> {
  let directory = startDirectory;

  while (true) {
    const candidate = join(directory, DEFAULT_CONFIG_FILE);
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

export async function loadConfig(options: {
  cwd?: string;
  configPath?: string;
} = {}): Promise<{ config: CounterlaneConfig; configPath: string | null }> {
  const baseDirectory = resolve(options.cwd ?? processCwd());
  const requestedPath = options.configPath === undefined
    ? await findConfigPath(baseDirectory)
    : resolve(baseDirectory, options.configPath);
  let merged = structuredClone(DEFAULT_CONFIG) as unknown as JsonObject;
  let loadedPath: string | null = null;

  if (requestedPath !== null && await pathExists(requestedPath)) {
    const raw = parseJsonc(await readUtf8Bounded(requestedPath, MAX_CONFIG_FILE_BYTES, "Configuration file"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new ConfigurationError(`Configuration file ${requestedPath} must contain an object.`);
    }
    assertConfigComplexity(raw, requestedPath);
    const normalized = normalizeLegacyUtilityConfig(raw as JsonObject, requestedPath);
    merged = deepMerge(merged, normalized);
    loadedPath = requestedPath;
  } else if (options.configPath !== undefined) {
    throw new ConfigurationError(`Configuration file not found: ${requestedPath}`);
  }

  validateConfig(merged);
  return { config: merged, configPath: loadedPath };
}

function normalizeLegacyUtilityConfig(raw: JsonObject, path: string): JsonObject {
  const utility = raw["utility"];
  if (!isJsonObject(utility)) return raw;
  const legacy = utility["badEscapePenalty"];
  const current = utility["detectedVerificationFailurePenalty"];
  if (legacy === undefined) return raw;
  if (current !== undefined && current !== legacy) {
    throw new ConfigurationError(
      `Configuration file ${path} has contradictory utility.badEscapePenalty and utility.detectedVerificationFailurePenalty values.`,
    );
  }
  if (current === undefined) utility["detectedVerificationFailurePenalty"] = legacy;
  delete utility["badEscapePenalty"];
  return raw;
}

export async function writeDefaultConfig(path: string, overwrite = false): Promise<void> {
  const absolutePath = resolve(path);
  if (overwrite) {
    await writeJsonAtomic(absolutePath, DEFAULT_CONFIG as unknown as object);
    return;
  }
  try {
    await writeJsonAtomicNew(absolutePath, DEFAULT_CONFIG as unknown as object);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new ConfigurationError(`Refusing to overwrite existing configuration: ${absolutePath}`);
    }
    throw error;
  }
}

function assertConfigComplexity(value: object, path: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > MAX_CONFIG_NODES) {
      throw new ConfigurationError(`Configuration file ${path} exceeds the ${MAX_CONFIG_NODES}-node safety limit.`);
    }
    if (current.depth > MAX_CONFIG_DEPTH) {
      throw new ConfigurationError(`Configuration file ${path} exceeds the ${MAX_CONFIG_DEPTH}-level depth safety limit.`);
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 });
    } else if (typeof current.value === "object" && current.value !== null) {
      for (const entry of Object.values(current.value)) stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
}
