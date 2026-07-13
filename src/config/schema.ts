import { ConfigurationError } from "../core/errors.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../core/json.js";
import { MAX_TIMER_DELAY_MS } from "../core/utils.js";
import type { CounterlaneConfig, VerificationCommandConfig } from "./types.js";

export function validateConfig(value: unknown): asserts value is CounterlaneConfig {
  if (!isJsonObject(value)) {
    throw new ConfigurationError("Configuration must be a JSON object.");
  }
  expectNumber(value, "version", 1, 1);
  expectString(value, "dataDirectory");
  expectSafeRelativePath(value, "dataDirectory");

  const codex = expectObject(value, "codex");
  expectString(codex, "command", "codex");
  expectStringArray(codex, "args", false, "codex");
  expectTimeoutMs(codex, "startupTimeoutMs", "codex");
  expectTimeoutMs(codex, "requestTimeoutMs", "codex");
  expectTimeoutMs(codex, "turnTimeoutMs", "codex");
  expectTimeoutMs(codex, "shutdownTimeoutMs", "codex");
  expectBoolean(codex, "experimentalApi", "codex");
  expectEnum(codex, "approvalPolicy", ["never", "on-request", "untrusted"] as const, "codex");
  const sandbox = expectObject(codex, "sandbox", "codex");
  expectEnum(sandbox, "type", ["workspaceWrite", "readOnly"] as const, "codex.sandbox");
  expectBoolean(sandbox, "networkAccess", "codex.sandbox");
  expectObject(codex, "extraTurnParams", "codex");

  const routing = expectObject(value, "routing");
  expectEnum(routing, "profile", ["economy", "balanced", "quality"] as const, "routing");
  const staticRoute = expectObject(routing, "static", "routing");
  expectEnum(staticRoute, "family", ["luna", "terra", "sol"] as const, "routing.static");
  expectString(staticRoute, "effort", "routing.static");
  expectString(staticRoute, "speed", "routing.static");
  const matchers = expectObject(routing, "familyMatchers", "routing");
  expectStringArray(matchers, "luna", true, "routing.familyMatchers");
  expectStringArray(matchers, "terra", true, "routing.familyMatchers");
  expectStringArray(matchers, "sol", true, "routing.familyMatchers");
  expectStringArray(routing, "candidateEfforts", true, "routing");
  const prediction = expectObject(routing, "prediction", "routing");
  expectPositiveNumber(prediction, "baselineDurationMs", "routing.prediction");
  expectAtLeastOne(prediction, "p90Multiplier", "routing.prediction");
  expectNonNegativeInteger(prediction, "minimumCalibrationSamples", "routing.prediction");
  expectNonNegativeNumber(prediction, "shrinkageSamples", "routing.prediction");
  expectPositiveNumber(prediction, "fallbackCreditsPerCostWeight", "routing.prediction");
  const speed = expectObject(routing, "speed", "routing");
  expectBoolean(speed, "enabled", "routing.speed");
  expectStringArray(speed, "candidateTiers", true, "routing.speed");
  expectString(speed, "defaultTier", "routing.speed");
  expectBoolean(speed, "allowUnadvertisedTiers", "routing.speed");
  expectPercent(speed, "maxUsagePercentForPremium", "routing.speed");
  expectUnitNumber(speed, "minimumLatencySensitivityForPremium", "routing.speed");
  const speedProfiles = expectObject(speed, "profiles", "routing.speed");
  if (!Object.hasOwn(speedProfiles, "standard")) {
    fail("routing.speed.profiles.standard", "must be configured");
  }
  for (const [speedId, rawProfile] of Object.entries(speedProfiles)) {
    if (!isJsonObject(rawProfile)) {
      fail(`routing.speed.profiles.${speedId}`, "must be an object");
    }
    const profilePath = `routing.speed.profiles.${speedId}`;
    expectPositiveNumber(rawProfile, "costMultiplier", profilePath);
    expectPositiveNumber(rawProfile, "latencyMultiplier", profilePath);
    expectBoolean(rawProfile, "premium", profilePath);
    const rawOverrides = rawProfile["modelOverrides"];
    if (rawOverrides !== undefined) {
      if (!Array.isArray(rawOverrides)) {
        fail(`${profilePath}.modelOverrides`, "must be an array");
      }
      for (const [index, rawOverride] of rawOverrides.entries()) {
        const overridePath = `${profilePath}.modelOverrides[${index}]`;
        if (!isJsonObject(rawOverride)) {
          fail(overridePath, "must be an object");
        }
        expectString(rawOverride, "matcher", overridePath);
        const matcher = rawOverride["matcher"] as string;
        if (matcher.startsWith("re:")) {
          try {
            new RegExp(matcher.slice(3), "iu");
          } catch {
            fail(`${overridePath}.matcher`, "must contain a valid regular expression after re:");
          }
        }
        if (rawOverride["costMultiplier"] !== undefined) {
          expectPositiveNumber(rawOverride, "costMultiplier", overridePath);
        }
        if (rawOverride["latencyMultiplier"] !== undefined) {
          expectPositiveNumber(rawOverride, "latencyMultiplier", overridePath);
        }
        if (rawOverride["costMultiplier"] === undefined && rawOverride["latencyMultiplier"] === undefined) {
          fail(overridePath, "must override costMultiplier, latencyMultiplier, or both");
        }
      }
    }
  }
  const candidateTiers = speed["candidateTiers"] as string[];
  for (const tier of candidateTiers) {
    if (!Object.hasOwn(speedProfiles, tier)) {
      fail(`routing.speed.profiles.${tier}`, "must define every candidate speed tier");
    }
  }
  const defaultTier = speed["defaultTier"] as string;
  if (!candidateTiers.includes(defaultTier)) {
    fail("routing.speed.defaultTier", "must appear in routing.speed.candidateTiers");
  }
  const staticSpeed = staticRoute["speed"] as string;
  if (!candidateTiers.includes(staticSpeed)) {
    fail("routing.static.speed", "must appear in routing.speed.candidateTiers");
  }
  expectPercent(routing, "reservePercent", "routing");
  expectBoolean(routing, "enableMax", "routing");
  expectBoolean(routing, "enableUltra", "routing");
  expectPercent(routing, "maxUsagePercentForMax", "routing");
  expectPercent(routing, "maxUsagePercentForUltra", "routing");
  const minimumQuality = expectObject(routing, "minimumQuality", "routing");
  expectUnitNumber(minimumQuality, "normal", "routing.minimumQuality");
  expectUnitNumber(minimumQuality, "elevated", "routing.minimumQuality");
  expectUnitNumber(minimumQuality, "critical", "routing.minimumQuality");
  const costModel = expectObject(routing, "costModel", "routing");
  expectNonNegativeNumber(costModel, "inputCreditsPerMillionAtLuna", "routing.costModel");
  expectNonNegativeNumber(costModel, "cachedInputCreditsPerMillionAtLuna", "routing.costModel");
  expectNonNegativeNumber(costModel, "outputCreditsPerMillionAtLuna", "routing.costModel");
  const familyWeights = expectObject(costModel, "familyWeights", "routing.costModel");
  for (const key of ["luna", "terra", "sol", "unknown"] as const) {
    expectPositiveNumber(familyWeights, key, "routing.costModel.familyWeights");
  }
  const weights = expectObject(routing, "weights", "routing");
  for (const key of ["cost", "latency", "quota", "failure", "uncertainty", "switching"] as const) {
    expectNonNegativeNumber(weights, key, "routing.weights");
  }

  const meta = expectObject(value, "meta");
  expectBoolean(meta, "enabled", "meta");
  expectNonNegativeInteger(meta, "minimumExactSamples", "meta");
  expectNonNegativeInteger(meta, "minimumFallbackSamples", "meta");
  expectPositiveInteger(meta, "maximumTwinSamplesPerContext", "meta");
  expectPositiveNumber(meta, "confidenceZ", "meta");
  expectNonNegativeNumber(meta, "upliftMargin", "meta");
  expectPositiveNumber(meta, "priorStrength", "meta");
  expectPositiveNumber(meta, "priorStandardDeviation", "meta");
  expectNonNegativeInteger(meta, "expectedFutureSimilarTasks", "meta");
  expectNonNegativeNumber(meta, "informationValueScale", "meta");
  expectPositiveNumber(meta, "twinCostMultiplier", "meta");
  expectUnitNumber(meta, "maximumQuotaPressureForTwin", "meta");
  expectPercent(meta, "maximumUsedPercentForTwin", "meta");
  expectUnitNumber(meta, "minimumCriticalVerifierStrength", "meta");

  const twin = expectObject(value, "twin");
  expectEnum(twin, "execution", ["parallel", "sequential"] as const, "twin");
  expectEnum(twin, "preserveWorktrees", ["never", "on-failure", "always"] as const, "twin");
  expectTimeoutMs(twin, "maximumDurationMs", "twin");
  expectBoolean(twin, "applyWinnerByDefault", "twin");
  expectBoolean(twin, "requireOriginalStateUnchanged", "twin");
  expectNullableString(twin, "worktreeBaseDirectory", "twin");
  if (twin["worktreeBaseDirectory"] !== null) {
    expectSafeRelativePath(twin, "worktreeBaseDirectory", "twin");
  }
  expectStringArray(twin, "dependencyDirectories", false, "twin");
  const dependencyDirectories = twin["dependencyDirectories"] as string[];
  for (const [index, directory] of dependencyDirectories.entries()) {
    const normalized = directory.replaceAll("\\", "/");
    const absoluteLike = normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized);
    const segments = normalized.split("/");
    if (absoluteLike || normalized === "." || segments.some((segment) => segment === "..")) {
      fail(`twin.dependencyDirectories[${index}]`, "must stay within the repository and must not contain '..'");
    }
    const reservedPaths = [value["dataDirectory"] as string, twin["worktreeBaseDirectory"] as string | null]
      .filter((path): path is string => path !== null);
    if (reservedPaths.some((path) => relativePathsOverlap(directory, path))) {
      fail(`twin.dependencyDirectories[${index}]`, "must not overlap dataDirectory or worktreeBaseDirectory");
    }
    if (dependencyDirectories.slice(0, index).some((path) => relativePathsOverlap(directory, path))) {
      fail(`twin.dependencyDirectories[${index}]`, "must not overlap another dependency directory");
    }
  }
  expectPositiveInteger(twin, "maximumDependencyFiles", "twin");
  expectPositiveInteger(twin, "maximumDependencyBytes", "twin");

  const verification = expectObject(value, "verification");
  expectBoolean(verification, "autoDetect", "verification");
  const proofRouting = expectObject(verification, "routing", "verification");
  expectBoolean(proofRouting, "enabled", "verification.routing");
  expectEnumArray(proofRouting, "candidateTiers", ["basic", "standard", "strong", "adversarial"] as const, true, "verification.routing");
  expectEnum(proofRouting, "defaultTier", ["basic", "standard", "strong", "adversarial"] as const, "verification.routing");
  const proofCandidates = proofRouting["candidateTiers"] as string[];
  if (!proofCandidates.includes(proofRouting["defaultTier"] as string)) {
    fail("verification.routing.defaultTier", "must appear in verification.routing.candidateTiers");
  }
  const minimumByRisk = expectObject(proofRouting, "minimumTierByRisk", "verification.routing");
  for (const risk of ["normal", "elevated", "critical"] as const) {
    expectEnum(minimumByRisk, risk, ["basic", "standard", "strong", "adversarial"] as const, "verification.routing.minimumTierByRisk");
  }
  for (const field of ["costWeights", "detectionBoosts", "detectionFloors", "minimumIndependentChecks"] as const) {
    const table = expectObject(proofRouting, field, "verification.routing");
    for (const tier of ["basic", "standard", "strong", "adversarial"] as const) {
      if (field === "minimumIndependentChecks") expectNonNegativeInteger(table, tier, `verification.routing.${field}`);
      else if (field === "detectionBoosts" || field === "detectionFloors") {
        expectUnitNumber(table, tier, `verification.routing.${field}`);
      }
      else expectNonNegativeNumber(table, tier, `verification.routing.${field}`);
    }
  }
  expectBoolean(verification, "requireAtLeastOne", "verification");
  expectBoolean(verification, "failOnNoVerifier", "verification");
  expectTimeoutMs(verification, "defaultTimeoutMs", "verification");
  expectPositiveInteger(verification, "maximumOutputBytes", "verification");
  const commands = verification["commands"];
  if (!Array.isArray(commands)) {
    fail("verification.commands", "must be an array");
  }
  for (const [index, command] of commands.entries()) {
    validateVerificationCommand(command, `verification.commands[${index}]`);
  }

  const telemetry = expectObject(value, "telemetry");
  expectBoolean(telemetry, "enabled", "telemetry");
  expectBoolean(telemetry, "includePrompt", "telemetry");
  expectBoolean(telemetry, "allowHostLedgerLearning", "telemetry");
  expectString(telemetry, "file", "telemetry");
  expectSafeRelativePath(telemetry, "file", "telemetry");
  expectPositiveInteger(telemetry, "maximumReadEvents", "telemetry");
  expectPositiveInteger(telemetry, "maximumReadBytes", "telemetry");

  const utility = expectObject(value, "utility");
  for (const key of [
    "verifiedSuccessValue",
    "verificationScoreValue",
    "normalizedCreditPenalty",
    "latencyPenaltyPerMinute",
    "failedTurnPenalty",
    "badEscapePenalty",
    "practicalEquivalenceMargin",
  ] as const) {
    expectNonNegativeNumber(utility, key, "utility");
  }
}

function validateVerificationCommand(value: unknown, path: string): asserts value is VerificationCommandConfig {
  if (!isJsonObject(value)) {
    fail(path, "must be an object");
  }
  expectString(value, "name", path);
  expectStringArray(value, "command", true, path);
  expectBoolean(value, "required", path);
  if (value["timeoutMs"] !== undefined) {
    expectTimeoutMs(value, "timeoutMs", path);
  }
  if (value["minimumTier"] !== undefined) {
    expectEnum(value, "minimumTier", ["basic", "standard", "strong", "adversarial"] as const, path);
  }
  if (value["environment"] !== undefined) {
    const environment = expectObject(value, "environment", path);
    for (const [key, entry] of Object.entries(environment)) {
      if (typeof entry !== "string") {
        fail(`${path}.environment.${key}`, "must be a string");
      }
    }
  }
}

export function deepMerge(base: JsonObject, overlay: JsonObject): JsonObject {
  const result: JsonObject = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = Object.hasOwn(result, key) ? result[key] : undefined;
    const mergedValue = isJsonObject(baseValue) && isJsonObject(overlayValue)
      ? deepMerge(baseValue, overlayValue)
      : cloneJson(overlayValue);
    Object.defineProperty(result, key, {
      value: mergedValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(cloneJson);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]));
  }
  return value;
}

function expectObject(object: JsonObject, key: string, prefix = ""): JsonObject {
  const value = object[key];
  if (!isJsonObject(value)) {
    fail(joinPath(prefix, key), "must be an object");
  }
  return value;
}

function expectString(object: JsonObject, key: string, prefix = ""): void {
  if (typeof object[key] !== "string" || object[key] === "") {
    fail(joinPath(prefix, key), "must be a non-empty string");
  }
}

function expectSafeRelativePath(object: JsonObject, key: string, prefix = ""): void {
  const value = object[key];
  if (typeof value !== "string") {
    fail(joinPath(prefix, key), "must be a relative path");
  }
  const normalized = value.replaceAll("\\", "/");
  const absoluteLike = normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized);
  const segments = normalized.split("/");
  if (absoluteLike || normalized === "." || segments.some((segment) => segment === "..")) {
    fail(joinPath(prefix, key), "must stay within the repository and must not contain '..'");
  }
}

function expectNullableString(object: JsonObject, key: string, prefix = ""): void {
  const value = object[key];
  if (value !== null && (typeof value !== "string" || value === "")) {
    fail(joinPath(prefix, key), "must be null or a non-empty string");
  }
}

function relativePathsOverlap(left: string, right: string): boolean {
  const normalize = (path: string): string => path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`);
}

function expectBoolean(object: JsonObject, key: string, prefix = ""): void {
  if (typeof object[key] !== "boolean") {
    fail(joinPath(prefix, key), "must be a boolean");
  }
}

function expectPositiveNumber(object: JsonObject, key: string, prefix = ""): void {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(joinPath(prefix, key), "must be a positive number");
  }
}

function expectAtLeastOne(object: JsonObject, key: string, prefix = ""): void {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    fail(joinPath(prefix, key), "must be a finite number greater than or equal to 1");
  }
}

function expectPositiveInteger(object: JsonObject, key: string, prefix = ""): void {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(joinPath(prefix, key), "must be a positive integer");
  }
}

function expectTimeoutMs(object: JsonObject, key: string, prefix = ""): void {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TIMER_DELAY_MS) {
    fail(joinPath(prefix, key), `must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`);
  }
}

function expectNonNegativeInteger(object: JsonObject, key: string, prefix = ""): void {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(joinPath(prefix, key), "must be a non-negative integer");
  }
}

function expectNonNegativeNumber(object: JsonObject, key: string, prefix = ""): void {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(joinPath(prefix, key), "must be a non-negative number");
  }
}

function expectNumber(object: JsonObject, key: string, minimum: number, maximum: number, prefix = ""): void {
  const value = object[key];
  if (typeof value !== "number" || value < minimum || value > maximum) {
    fail(joinPath(prefix, key), `must be between ${minimum} and ${maximum}`);
  }
}

function expectUnitNumber(object: JsonObject, key: string, prefix = ""): void {
  expectNumber(object, key, 0, 1, prefix);
}

function expectPercent(object: JsonObject, key: string, prefix = ""): void {
  expectNumber(object, key, 0, 100, prefix);
}

function expectStringArray(
  object: JsonObject,
  key: string,
  nonEmpty = false,
  prefix = "",
): void {
  const value = object[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    fail(joinPath(prefix, key), "must be an array of non-empty strings");
  }
  if (nonEmpty && value.length === 0) {
    fail(joinPath(prefix, key), "must not be empty");
  }
}

function expectEnumArray<const T extends readonly string[]>(
  object: JsonObject,
  key: string,
  values: T,
  nonEmpty = false,
  prefix = "",
): void {
  const value = object[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !values.includes(entry))) {
    fail(joinPath(prefix, key), `must be an array containing only: ${values.join(", ")}`);
  }
  if (nonEmpty && value.length === 0) {
    fail(joinPath(prefix, key), "must not be empty");
  }
}

function expectEnum<const T extends readonly string[]>(
  object: JsonObject,
  key: string,
  values: T,
  prefix = "",
): void {
  const value = object[key];
  if (typeof value !== "string" || !values.includes(value)) {
    fail(joinPath(prefix, key), `must be one of: ${values.join(", ")}`);
  }
}

function joinPath(prefix: string, key: string): string {
  return prefix.length === 0 ? key : `${prefix}.${key}`;
}

function fail(path: string, message: string): never {
  throw new ConfigurationError(`Invalid configuration at ${path}: ${message}.`, { path, message });
}
