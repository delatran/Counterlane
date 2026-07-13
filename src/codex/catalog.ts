import { isJsonObject, type JsonObject } from "../core/json.js";
import type {
  ModelCatalog,
  ModelCatalogEntry,
  ModelFamily,
  ModelServiceTierOption,
  RateLimitBucket,
  RateLimitSnapshot,
} from "../core/types.js";
import type { CounterlaneConfig } from "../config/types.js";

export function parseModelCatalog(value: unknown): ModelCatalog {
  const object = isJsonObject(value) ? value : {};
  const data = Array.isArray(object["data"]) ? object["data"] : [];
  const models: ModelCatalogEntry[] = [];

  for (const entry of data) {
    if (!isJsonObject(entry)) {
      continue;
    }
    const id = stringField(entry, "id") ?? stringField(entry, "model");
    const model = stringField(entry, "model") ?? id;
    if (id === undefined || model === undefined) {
      continue;
    }
    const efforts = Array.isArray(entry["supportedReasoningEfforts"])
      ? entry["supportedReasoningEfforts"]
          .filter(isJsonObject)
          .flatMap((effort) => {
            const reasoningEffort = stringField(effort, "reasoningEffort");
            if (reasoningEffort === undefined) return [];
            const description = stringField(effort, "description");
            return [{
              reasoningEffort,
              ...(description === undefined ? {} : { description }),
            }];
          })
      : [];
    const defaultReasoningEffort = stringField(entry, "defaultReasoningEffort") ?? efforts[0]?.reasoningEffort;
    if (defaultReasoningEffort === undefined) continue;

    const modelDescription = stringField(entry, "description");
    models.push({
      id,
      model,
      displayName: stringField(entry, "displayName") ?? model,
      ...(modelDescription === undefined ? {} : { description: modelDescription }),
      hidden: entry["hidden"] === true,
      defaultReasoningEffort,
      supportedReasoningEfforts: efforts,
      serviceTiers: parseServiceTiers(entry),
      defaultServiceTier: nullableStringField(entry, "defaultServiceTier"),
      isDefault: entry["isDefault"] === true,
      ...(Array.isArray(entry["inputModalities"])
        ? { inputModalities: entry["inputModalities"].filter((item): item is string => typeof item === "string") }
        : {}),
      raw: entry,
    });
  }

  return { models, fetchedAt: new Date().toISOString() };
}

export function parseRateLimits(value: unknown, planType?: string | null): RateLimitSnapshot {
  const object = isJsonObject(value) ? value : {};
  const byIdObject = isJsonObject(object["rateLimitsByLimitId"]) ? object["rateLimitsByLimitId"] : {};
  const byId: Record<string, RateLimitBucket> = {};
  for (const [key, raw] of Object.entries(byIdObject)) {
    if (isJsonObject(raw)) {
      byId[key] = parseRateLimitBucket(raw, key);
    }
  }
  const primaryObject = isJsonObject(object["rateLimits"]) ? object["rateLimits"] : null;
  const primary = primaryObject === null ? null : parseRateLimitBucket(primaryObject, "codex");
  const effectivePlanType = planType ?? stringField(object, "planType") ??
    (primaryObject === null ? undefined : stringField(primaryObject, "planType"));
  return {
    primary,
    byId,
    ...(effectivePlanType === undefined ? {} : { planType: effectivePlanType }),
    fetchedAt: new Date().toISOString(),
    raw: object,
  };
}

export function modelFamily(model: ModelCatalogEntry, config: CounterlaneConfig): ModelFamily {
  const haystack = `${model.id} ${model.model} ${model.displayName}`.toLowerCase();
  for (const family of ["luna", "terra", "sol"] as const) {
    if (config.routing.familyMatchers[family].some((matcher) => matches(haystack, matcher))) {
      return family;
    }
  }
  return "unknown";
}

export function selectFamilyModel(
  catalog: ModelCatalog,
  family: Exclude<ModelFamily, "unknown">,
  config: CounterlaneConfig,
): ModelCatalogEntry | null {
  const candidates = catalog.models.filter((model) => !model.hidden && modelFamily(model, config) === family);
  return candidates.find((model) => model.isDefault) ?? candidates[0] ?? null;
}

export function supportedEfforts(model: ModelCatalogEntry): string[] {
  const efforts = model.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
  return efforts.length > 0 ? efforts : [model.defaultReasoningEffort];
}

/**
 * Standard is represented locally and maps to serviceTier=null. Every other
 * entry must be advertised by model/list unless the config explicitly opts in
 * to unadvertised tiers.
 */
export function supportedSpeedIds(model: ModelCatalogEntry): string[] {
  return ["standard", ...model.serviceTiers.map((tier) => tier.id).filter((id) => id !== "standard")];
}

export function serviceTierForSpeed(speedId: string): string | null {
  return speedId === "standard" ? null : speedId;
}

export function speedDisplayName(model: ModelCatalogEntry, speedId: string): string {
  if (speedId === "standard") {
    return "Standard";
  }
  return model.serviceTiers.find((tier) => tier.id === speedId)?.name ?? speedId;
}

export function closestSupportedEffort(model: ModelCatalogEntry, requested: string, order: readonly string[]): string {
  const supported = new Set(supportedEfforts(model));
  if (supported.has(requested)) {
    return requested;
  }
  const requestedIndex = order.indexOf(requested);
  if (requestedIndex < 0) {
    return model.defaultReasoningEffort;
  }
  const ranked = order
    .map((effort, index) => ({ effort, distance: Math.abs(index - requestedIndex), index }))
    .filter((entry) => supported.has(entry.effort))
    .sort((left, right) => left.distance - right.distance || left.index - right.index);
  return ranked[0]?.effort ?? model.defaultReasoningEffort;
}

export function closestSupportedSpeed(
  model: ModelCatalogEntry,
  requested: string,
  config: CounterlaneConfig,
): string {
  if (requested === "standard") {
    return "standard";
  }
  const advertised = new Set(model.serviceTiers.map((tier) => tier.id));
  if (advertised.has(requested) || config.routing.speed.allowUnadvertisedTiers) {
    return requested;
  }
  const configuredDefault = config.routing.speed.defaultTier;
  if (
    configuredDefault !== "standard" &&
    (advertised.has(configuredDefault) || config.routing.speed.allowUnadvertisedTiers)
  ) {
    return configuredDefault;
  }
  return "standard";
}

function parseServiceTiers(entry: JsonObject): ModelServiceTierOption[] {
  const byId = new Map<string, ModelServiceTierOption>();
  const serviceTiers = Array.isArray(entry["serviceTiers"]) ? entry["serviceTiers"] : [];
  for (const rawTier of serviceTiers) {
    if (!isJsonObject(rawTier)) {
      continue;
    }
    const id = stringField(rawTier, "id");
    if (id === undefined || id === "standard") {
      continue;
    }
    byId.set(id, {
      id,
      name: stringField(rawTier, "name") ?? id,
      description: stringField(rawTier, "description") ?? "",
    });
  }

  // Older catalogs exposed only string ids through additionalSpeedTiers.
  const legacyTiers = Array.isArray(entry["additionalSpeedTiers"]) ? entry["additionalSpeedTiers"] : [];
  for (const rawTier of legacyTiers) {
    if (typeof rawTier !== "string" || rawTier.length === 0 || rawTier === "standard" || byId.has(rawTier)) {
      continue;
    }
    byId.set(rawTier, { id: rawTier, name: rawTier, description: "Legacy catalog speed tier" });
  }
  return [...byId.values()];
}

function matches(haystack: string, matcher: string): boolean {
  if (matcher.startsWith("re:")) {
    try {
      return new RegExp(matcher.slice(3), "iu").test(haystack);
    } catch {
      return false;
    }
  }
  return haystack.includes(matcher.toLowerCase());
}

function parseRateLimitBucket(value: JsonObject, fallbackId: string): RateLimitBucket {
  return {
    limitId: stringField(value, "limitId") ?? fallbackId,
    ...(value["limitName"] === null || typeof value["limitName"] === "string" ? { limitName: value["limitName"] } : {}),
    ...(isJsonObject(value["primary"]) && parseWindow(value["primary"]) !== null
      ? { primary: parseWindow(value["primary"]) }
      : {}),
    ...(isJsonObject(value["secondary"]) && parseWindow(value["secondary"]) !== null
      ? { secondary: parseWindow(value["secondary"]) }
      : {}),
    ...(value["rateLimitReachedType"] === null || typeof value["rateLimitReachedType"] === "string"
      ? { rateLimitReachedType: value["rateLimitReachedType"] }
      : {}),
  };
}

function parseWindow(value: JsonObject): { usedPercent: number; windowDurationMins: number; resetsAt: number } | null {
  const usedPercent = numberField(value, "usedPercent");
  const windowDurationMins = numberField(value, "windowDurationMins");
  const resetsAt = numberField(value, "resetsAt");
  if (
    usedPercent === undefined || usedPercent < 0 || usedPercent > 100 ||
    windowDurationMins === undefined || windowDurationMins <= 0 ||
    resetsAt === undefined || resetsAt <= 0
  ) {
    return null;
  }
  return { usedPercent, windowDurationMins, resetsAt };
}

function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableStringField(object: JsonObject, key: string): string | null {
  const value = object[key];
  return typeof value === "string" ? value : null;
}

function numberField(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
