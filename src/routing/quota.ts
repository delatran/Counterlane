import type { QuotaState, RateLimitBucket, RateLimitSnapshot, RateLimitWindow } from "../core/types.js";
import { clamp } from "../core/utils.js";

export function deriveQuotaState(snapshot: RateLimitSnapshot, reservePercent: number, now = Date.now()): QuotaState {
  const candidates: Array<{ id: string; window: RateLimitWindow; rateLimitReachedType: string | null }> = [];
  if (snapshot.primary?.primary !== undefined && snapshot.primary.primary !== null) {
    candidates.push({
      id: snapshot.primary.limitId,
      window: snapshot.primary.primary,
      rateLimitReachedType: snapshot.primary.rateLimitReachedType ?? null,
    });
  }
  if (snapshot.primary?.secondary !== undefined && snapshot.primary.secondary !== null) {
    candidates.push({
      id: `${snapshot.primary.limitId}:secondary`,
      window: snapshot.primary.secondary,
      rateLimitReachedType: snapshot.primary.rateLimitReachedType ?? null,
    });
  }
  for (const bucket of Object.values(snapshot.byId)) {
    appendBucket(candidates, bucket);
  }

  if (candidates.length === 0) {
    return {
      known: false,
      exhausted: false,
      rateLimitReachedType: null,
      usedPercent: null,
      remainingPercent: null,
      resetAt: null,
      minutesUntilReset: null,
      pressure: 1,
      healthy: false,
      sourceLimitId: null,
    };
  }

  const scored = candidates.map((candidate) => {
    const minutesUntilReset = Math.max(0, candidate.window.resetsAt * 1000 - now) / 60_000;
    const elapsedFraction = clamp(
      1 - minutesUntilReset / Math.max(1, candidate.window.windowDurationMins),
      0.05,
      1,
    );
    const burnRatio = candidate.window.usedPercent / 100 / elapsedFraction;
    const reservePressure = clamp((candidate.window.usedPercent - (100 - reservePercent)) / Math.max(1, reservePercent));
    const pressure = clamp(0.55 * (candidate.window.usedPercent / 100) + 0.3 * clamp(burnRatio / 2) + 0.15 * reservePressure);
    const exhausted = candidate.window.usedPercent >= 100 || candidate.rateLimitReachedType === "rate_limit_reached";
    return { ...candidate, exhausted, minutesUntilReset, pressure };
  });
  scored.sort((left, right) => Number(right.exhausted) - Number(left.exhausted) || right.pressure - left.pressure);
  const selected = scored[0];
  if (selected === undefined) {
    throw new Error("Quota candidate selection failed unexpectedly.");
  }

  return {
    known: true,
    exhausted: selected.exhausted,
    rateLimitReachedType: selected.rateLimitReachedType,
    usedPercent: selected.window.usedPercent,
    remainingPercent: Math.max(0, 100 - selected.window.usedPercent),
    resetAt: new Date(selected.window.resetsAt * 1000).toISOString(),
    minutesUntilReset: selected.minutesUntilReset,
    pressure: selected.pressure,
    healthy: !selected.exhausted && selected.window.usedPercent < Math.max(50, 100 - reservePercent),
    sourceLimitId: selected.id,
  };
}

function appendBucket(
  target: Array<{ id: string; window: RateLimitWindow; rateLimitReachedType: string | null }>,
  bucket: RateLimitBucket,
): void {
  if (bucket.primary !== undefined && bucket.primary !== null) {
    target.push({
      id: bucket.limitId,
      window: bucket.primary,
      rateLimitReachedType: bucket.rateLimitReachedType ?? null,
    });
  }
  if (bucket.secondary !== undefined && bucket.secondary !== null) {
    target.push({
      id: `${bucket.limitId}:secondary`,
      window: bucket.secondary,
      rateLimitReachedType: bucket.rateLimitReachedType ?? null,
    });
  }
}
