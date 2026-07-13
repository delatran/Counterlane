import { appendFile, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CounterlaneConfig } from "../config/types.js";
import { SafetyError } from "../core/errors.js";
import type { JsonObject } from "../core/json.js";
import { canonicalizeContainedPath, ensureContainedDirectory, resolveContainedPath } from "../core/path-safety.js";
import type { TelemetryEvent } from "../core/types.js";
import { newId, sha256 } from "../core/utils.js";

export class TelemetryStore {
  readonly #enabled: boolean;
  readonly #repositoryRoot: string;
  readonly #dataDirectory: string;
  readonly #telemetryFile: string;
  readonly #path: string;
  readonly #trustedRoot: string;
  readonly #trustedPath: string;
  readonly #maximumReadEvents: number;
  readonly #maximumReadBytes: number;
  readonly #allowHostLedgerLearning: boolean;
  #writeChain: Promise<void> = Promise.resolve();

  public constructor(repositoryRoot: string, config: CounterlaneConfig) {
    this.#enabled = config.telemetry.enabled;
    this.#repositoryRoot = resolve(repositoryRoot);
    this.#dataDirectory = resolveContainedPath(this.#repositoryRoot, config.dataDirectory, {
      target: "Counterlane data directory",
      boundary: "repository",
    });
    this.#telemetryFile = config.telemetry.file;
    this.#path = resolveContainedPath(this.#dataDirectory, this.#telemetryFile, {
      target: "telemetry file",
      boundary: "configured data directory",
    });
    this.#trustedRoot = trustedTelemetryRoot();
    assertExternalTrustRoot(this.#repositoryRoot, this.#trustedRoot);
    const repositoryIdentity = process.platform === "win32" ? this.#repositoryRoot.toLowerCase() : this.#repositoryRoot;
    this.#trustedPath = resolveContainedPath(
      this.#trustedRoot,
      join("telemetry", `${sha256(repositoryIdentity)}.jsonl`),
      { target: "trusted telemetry ledger", boundary: "host-owned Counterlane trust directory" },
    );
    this.#maximumReadEvents = config.telemetry.maximumReadEvents;
    this.#maximumReadBytes = config.telemetry.maximumReadBytes;
    this.#allowHostLedgerLearning = config.telemetry.allowHostLedgerLearning;
  }

  public get path(): string {
    return this.#path;
  }

  public get trustedPath(): string {
    return this.#trustedPath;
  }

  public append(type: string, payload: JsonObject, experimentId?: string): Promise<void> {
    if (!this.#enabled) {
      return Promise.resolve();
    }
    const event: TelemetryEvent = {
      id: newId("evt"),
      type,
      timestamp: new Date().toISOString(),
      ...(experimentId === undefined ? {} : { experimentId }),
      payload,
    };
    // A transient write failure must be reported to its caller without
    // permanently poisoning the serialization chain for every later event.
    const previous = this.#writeChain.catch(() => undefined);
    const write = previous.then(async () => {
      const trustedPath = await this.#resolveTrustedPath(true);
      const serialized = `${JSON.stringify(event)}\n`;
      // The repository-local file is an audit mirror only. Routing and learning
      // read exclusively from the host-owned ledger so cloned source cannot
      // pre-seed fabricated successes or uplift observations.
      await appendFile(trustedPath, serialized, { encoding: "utf8", mode: 0o600 });
      const telemetryPath = await this.#resolveSafePath(true);
      await appendFile(telemetryPath, serialized, { encoding: "utf8", mode: 0o600 });
    });
    this.#writeChain = write.catch(() => undefined);
    return write;
  }

  public async readRecent(limit = 20): Promise<TelemetryEvent[]> {
    const boundedLimit = Math.min(this.#maximumReadEvents, Math.max(0, limit));
    if (boundedLimit === 0) return [];
    const events = await this.#readTail(boundedLimit);
    return events.slice(-boundedLimit);
  }

  /**
   * Returns a bounded tail of the append-only telemetry log. The method keeps
   * its historical name for API compatibility, but intentionally never loads
   * an unbounded production log into memory.
   */
  public async readAll(): Promise<TelemetryEvent[]> {
    return this.#readTail(this.#maximumReadEvents);
  }

  /**
   * Historical events are policy inputs only when the host explicitly opts in.
   * Repository code executes as the same OS user and can target the external
   * ledger, so host ownership alone is not an authentication boundary.
   */
  public async readLearningEvents(): Promise<TelemetryEvent[]> {
    if (!this.#allowHostLedgerLearning) return [];
    return this.#readTail(this.#maximumReadEvents);
  }

  async #readTail(maximumEvents: number): Promise<TelemetryEvent[]> {
    if (!this.#enabled) return [];
    // Ensure reads in this process observe every append that was already
    // requested, while still tolerating a torn final line from a prior crash.
    await this.#writeChain.catch(() => undefined);

    let handle;
    try {
      const telemetryPath = await this.#resolveTrustedPath(false);
      handle = await open(telemetryPath, "r");
      const stats = await handle.stat();
      const bytesToRead = Math.min(stats.size, this.#maximumReadBytes);
      if (bytesToRead === 0) return [];
      const start = stats.size - bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
      let text = buffer.subarray(0, bytesRead).toString("utf8");
      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        // The first fragment began before our bounded window. Discard it so a
        // partial JSON object can never be mistaken for a complete event.
        text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
      }
      const events: TelemetryEvent[] = [];
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const value = JSON.parse(line) as unknown;
          if (isTelemetryEvent(value)) events.push(value);
        } catch {
          // Preserve all valid events around a torn/corrupt line.
        }
      }
      return events.slice(-maximumEvents);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #resolveSafePath(createParent: boolean): Promise<string> {
    const dataDirectoryLabels = {
      target: "Counterlane data directory",
      boundary: "repository",
    } as const;
    const telemetryLabels = {
      target: "telemetry file",
      boundary: "configured data directory",
    } as const;
    const canonicalDataDirectory = createParent
      ? await ensureContainedDirectory(this.#repositoryRoot, this.#dataDirectory, dataDirectoryLabels)
      : await canonicalizeContainedPath(this.#repositoryRoot, this.#dataDirectory, dataDirectoryLabels);
    const candidatePath = resolveContainedPath(canonicalDataDirectory, this.#telemetryFile, telemetryLabels);
    if (createParent) {
      const canonicalParent = await ensureContainedDirectory(
        canonicalDataDirectory,
        dirname(candidatePath),
        { target: "telemetry file parent", boundary: "configured data directory" },
      );
      return canonicalizeContainedPath(
        canonicalDataDirectory,
        resolveContainedPath(canonicalParent, basename(candidatePath), telemetryLabels),
        telemetryLabels,
      );
    }
    return canonicalizeContainedPath(canonicalDataDirectory, candidatePath, telemetryLabels);
  }

  async #resolveTrustedPath(createParent: boolean): Promise<string> {
    if (createParent) {
      await mkdir(this.#trustedRoot, { recursive: true, mode: 0o700 });
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.#trustedRoot);
    } catch (error) {
      if (!createParent && isNotFound(error)) return this.#trustedPath;
      throw error;
    }
    assertExternalTrustRoot(this.#repositoryRoot, canonicalRoot);
    const candidatePath = resolveContainedPath(
      canonicalRoot,
      relative(this.#trustedRoot, this.#trustedPath),
      { target: "trusted telemetry ledger", boundary: "host-owned Counterlane trust directory" },
    );
    if (createParent) {
      await ensureContainedDirectory(
        canonicalRoot,
        dirname(candidatePath),
        { target: "trusted telemetry parent", boundary: "host-owned Counterlane trust directory" },
      );
    }
    return canonicalizeContainedPath(
      canonicalRoot,
      candidatePath,
      { target: "trusted telemetry ledger", boundary: "host-owned Counterlane trust directory" },
    );
  }
}

function trustedTelemetryRoot(): string {
  const configured = process.env["COUNTERLANE_TRUST_HOME"]?.trim();
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  const platformStateRoot = process.platform === "win32"
    ? process.env["LOCALAPPDATA"]
    : process.env["XDG_STATE_HOME"];
  if (platformStateRoot !== undefined && platformStateRoot.trim().length > 0) {
    return resolve(platformStateRoot, "Counterlane", "trust");
  }
  return resolve(homedir(), ".counterlane", "trust");
}

function assertExternalTrustRoot(repositoryRoot: string, trustRoot: string): void {
  const relativePath = relative(resolve(repositoryRoot), resolve(trustRoot));
  const outside = relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
  if (outside) return;
  throw new SafetyError("The trusted telemetry ledger must remain outside the repository.", {
    repositoryRoot,
    trustRoot,
  });
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event["id"] === "string" && event["id"].length > 0 &&
    typeof event["type"] === "string" && event["type"].length > 0 &&
    typeof event["timestamp"] === "string" && event["timestamp"].length > 0 &&
    (event["experimentId"] === undefined ||
      (typeof event["experimentId"] === "string" && event["experimentId"].length > 0)) &&
    typeof event["payload"] === "object" &&
    event["payload"] !== null &&
    !Array.isArray(event["payload"])
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
