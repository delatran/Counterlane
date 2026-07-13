import { runCommand } from "../core/process.js";
import type { CounterlaneConfig } from "../config/types.js";
import type { Logger } from "../core/logger.js";
import { CodexAppServer } from "../codex/app-server.js";
import { GitRepository } from "../git/repository.js";
import { resolveVerificationCommands } from "../verification/detect.js";
import { printDoctorCheck } from "../report/console.js";
import { errorMessage } from "../core/errors.js";
import { throwIfAborted } from "../core/abort.js";
import type { RateLimitBucket, RateLimitSnapshot } from "../core/types.js";
import { deriveQuotaState } from "../routing/quota.js";

export async function runDoctor(options: {
  cwd: string;
  config: CounterlaneConfig;
  logger: Logger;
  json: boolean;
  signal?: AbortSignal;
}): Promise<boolean> {
  throwIfAborted(options.signal);
  const checks: Array<{ label: string; ok: boolean; detail: string }> = [];
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push({ label: "Node.js", ok: major >= 22, detail: process.version });

  let repository: GitRepository | null = null;
  try {
    repository = await GitRepository.discover(options.cwd);
    checks.push({ label: "Git repository", ok: true, detail: repository.root });
  } catch (error) {
    throwIfAborted(options.signal);
    checks.push({ label: "Git repository", ok: false, detail: errorMessage(error) });
  }

  const codexVersion = await runCommand([options.config.codex.command, "--version"], {
    cwd: options.cwd,
    timeoutMs: 10_000,
    maximumOutputBytes: 32_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).catch(() => {
    throwIfAborted(options.signal);
    return null;
  });
  checks.push({
    label: "Codex executable",
    ok: codexVersion?.exitCode === 0,
    detail: codexVersion === null ? "not executable" : (codexVersion.stdout || codexVersion.stderr).trim(),
  });

  if (repository !== null && codexVersion?.exitCode === 0) {
    let server: CodexAppServer | null = null;
    try {
      server = await CodexAppServer.connect({
        config: options.config,
        cwd: repository.root,
        logger: options.logger,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const [catalog, limits] = await Promise.all([
        server.listModels(options.signal),
        server.readRateLimits(options.signal),
      ]);
      checks.push({ label: "App Server handshake", ok: true, detail: `pid=${server.pid ?? "unknown"}` });
      checks.push({ label: "Model catalog", ok: catalog.models.length > 0, detail: `${catalog.models.length} model(s)` });
      const primaryLimit = limits.primary ?? null;
      const readiness = summarizeRateLimitReadiness(limits, options.config.routing.reservePercent);
      checks.push({
        label: "Rate-limit API",
        ok: readiness.apiAvailable,
        detail: primaryLimit === null && Object.keys(limits.byId).length === 0
          ? "unavailable or API-key auth"
          : readiness.detail,
      });
      checks.push({
        label: "Delegated execution quota",
        ok: readiness.executionReady,
        detail: readiness.detail,
      });
    } catch (error) {
      throwIfAborted(options.signal);
      checks.push({ label: "App Server handshake", ok: false, detail: errorMessage(error) });
    } finally {
      await server?.close();
    }
  }

  if (repository !== null) {
    throwIfAborted(options.signal);
    const verifiers = await resolveVerificationCommands(repository.root, options.config);
    throwIfAborted(options.signal);
    checks.push({
      label: "Verifier discovery",
      ok: verifiers.length > 0 || !options.config.verification.failOnNoVerifier,
      detail: verifiers.length === 0 ? "no verifier commands detected" : verifiers.map((item) => item.name).join(", "),
    });
  }

  throwIfAborted(options.signal);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ checks, ok: checks.every((check) => check.ok) }, null, 2)}\n`);
  } else {
    for (const check of checks) {
      printDoctorCheck(check.label, check.ok, check.detail);
    }
  }
  return checks.every((check) => check.ok);
}

export function summarizeRateLimitReadiness(
  limits: RateLimitSnapshot,
  reservePercent: number,
  now = Date.now(),
): { apiAvailable: boolean; executionReady: boolean; detail: string } {
  const buckets = deduplicateRateLimitBuckets([
    ...(limits.primary === null || limits.primary === undefined ? [] : [limits.primary]),
    ...Object.values(limits.byId),
  ]);
  const apiAvailable = buckets.length > 0;
  const quota = deriveQuotaState(limits, reservePercent, now);
  const selectedBucket = selectedRateLimitBucket(buckets, quota.sourceLimitId);
  const reachedType = selectedBucket?.rateLimitReachedType ?? null;
  const exhausted = quota.known && (quota.exhausted ||
    quota.remainingPercent !== null && quota.remainingPercent <= 0 ||
    reachedType === "rate_limit_reached"
  );
  const selected = quota.known
    ? `selected=${quota.sourceLimitId ?? "unknown"} used=${quota.usedPercent ?? "unknown"}% ` +
      `remaining=${quota.remainingPercent ?? "unknown"}% reset=${quota.resetAt ?? "unknown"} ` +
      `reached=${reachedType ?? "none"}`
    : "selected=unknown; quota telemetry unavailable; Counterlane is limited to fail-closed/degraded routing";
  const inventory = buckets.length === 0
    ? "no buckets"
    : buckets.map(formatRateLimitBucket).join(", ");
  return {
    apiAvailable,
    executionReady: apiAvailable && !exhausted,
    detail: `${selected}; buckets=[${inventory}]`,
  };
}

function deduplicateRateLimitBuckets(buckets: readonly RateLimitBucket[]): RateLimitBucket[] {
  const output: RateLimitBucket[] = [];
  for (const bucket of buckets) {
    if (!output.some((candidate) => rateLimitBucketsEqual(candidate, bucket))) output.push(bucket);
  }
  return output;
}

function rateLimitBucketsEqual(left: RateLimitBucket, right: RateLimitBucket): boolean {
  return left.limitId === right.limitId &&
    (left.limitName ?? null) === (right.limitName ?? null) &&
    (left.rateLimitReachedType ?? null) === (right.rateLimitReachedType ?? null) &&
    rateLimitWindowsEqual(left.primary, right.primary) &&
    rateLimitWindowsEqual(left.secondary, right.secondary);
}

function rateLimitWindowsEqual(
  left: RateLimitBucket["primary"],
  right: RateLimitBucket["primary"],
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  return left.usedPercent === right.usedPercent &&
    left.windowDurationMins === right.windowDurationMins &&
    left.resetsAt === right.resetsAt;
}

function selectedRateLimitBucket(
  buckets: readonly RateLimitBucket[],
  sourceLimitId: string | null,
): RateLimitBucket | undefined {
  if (sourceLimitId === null) return undefined;
  const id = sourceLimitId.endsWith(":secondary") ? sourceLimitId.slice(0, -":secondary".length) : sourceLimitId;
  return buckets.find((bucket) => bucket.limitId === id);
}

function formatRateLimitBucket(bucket: RateLimitBucket): string {
  const windows = [
    ...(bucket.primary === null || bucket.primary === undefined ? [] : [`primary:${bucket.primary.usedPercent}%`]),
    ...(bucket.secondary === null || bucket.secondary === undefined ? [] : [`secondary:${bucket.secondary.usedPercent}%`]),
  ];
  return `${bucket.limitId}{${windows.join("/") || "no-valid-window"};reached=${bucket.rateLimitReachedType ?? "none"}}`;
}
