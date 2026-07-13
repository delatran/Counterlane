import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { JsonValue } from "./json.js";

const atomicWriteTails = new Map<string, Promise<void>>();
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_STABLE_JSON_DEPTH = 128;
const MAX_STABLE_JSON_NODES = 500_000;

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function sleep(milliseconds: number): Promise<void> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIMER_DELAY_MS) {
    throw new Error(`Sleep duration must be a non-negative safe integer no greater than ${MAX_TIMER_DELAY_MS} ms.`);
  }
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  onTimeout?: () => Promise<void> | void,
): Promise<T> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds > MAX_TIMER_DELAY_MS) {
    throw new Error(`Timeout must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS} ms.`);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        const cleanup = onTimeout?.();
        void Promise.resolve(cleanup).catch(() => undefined);
      } catch {
        // Cleanup is best effort. A synchronous cleanup failure must not replace
        // or delay the caller-visible timeout.
      }
      reject(new Error(message));
    }, milliseconds);
    timer.unref();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value, 0, { nodes: 0, ancestors: new WeakSet<object>() }));
}

function sortForStableJson(
  value: unknown,
  depth: number,
  state: { nodes: number; ancestors: WeakSet<object> },
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_STABLE_JSON_NODES) {
    throw new Error(`Stable JSON exceeds the ${MAX_STABLE_JSON_NODES}-node safety limit.`);
  }
  if (depth > MAX_STABLE_JSON_DEPTH) {
    throw new Error(`Stable JSON exceeds the ${MAX_STABLE_JSON_DEPTH}-level depth safety limit.`);
  }
  if (Array.isArray(value)) {
    if (state.ancestors.has(value)) throw new Error("Stable JSON cannot encode a circular value.");
    state.ancestors.add(value);
    try {
      return value.map((entry) => sortForStableJson(entry, depth + 1, state));
    } finally {
      state.ancestors.delete(value);
    }
  }
  if (typeof value === "object" && value !== null) {
    if (state.ancestors.has(value)) throw new Error("Stable JSON cannot encode a circular value.");
    state.ancestors.add(value);
    const input = value as Record<string, unknown>;
    try {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sortForStableJson(input[key], depth + 1, state)]),
      );
    } finally {
      state.ancestors.delete(value);
    }
  }
  return value;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function readUtf8(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function readUtf8Bounded(path: string, maximumBytes: number, label = "File"): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes >= Number.MAX_SAFE_INTEGER) {
    throw new Error("maximumBytes must be a positive safe integer below Number.MAX_SAFE_INTEGER.");
  }
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
    while (totalBytes <= maximumBytes) {
      const bytesToRead = Math.min(buffer.length, maximumBytes + 1 - totalBytes);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, null);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (totalBytes > maximumBytes) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte safety limit: ${path}`);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

export async function writeUtf8Atomic(path: string, contents: string): Promise<void> {
  await writeAtomic(path, contents, "utf8");
}

export async function writeBufferAtomic(path: string, contents: Uint8Array): Promise<void> {
  await writeAtomic(path, contents);
}

async function writeAtomic(path: string, contents: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
  await withAtomicWriteLock(path, async () => {
    await ensureDirectory(dirname(path));
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { ...(encoding === undefined ? {} : { encoding }), flag: "wx" });
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function writeJsonAtomic(path: string, value: JsonValue | object): Promise<void> {
  await writeUtf8Atomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeJsonAtomicNew(path: string, value: JsonValue | object): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  await withAtomicWriteLock(path, async () => {
    await ensureDirectory(dirname(path));
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
      await link(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
}

async function withAtomicWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const resolvedPath = resolve(path);
  const key = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  const previous = atomicWriteTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  atomicWriteTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (atomicWriteTails.get(key) === tail) atomicWriteTails.delete(key);
  }
}

export function resolveFrom(baseDirectory: string, path: string): string {
  return resolve(baseDirectory, path);
}

export function truncate(text: string, maximumLength: number): string {
  if (text.length <= maximumLength) {
    return text;
  }
  const omitted = text.length - maximumLength;
  return `${text.slice(0, maximumLength)}\n… <${omitted} characters omitted>`;
}

export function sanitizeFileSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 80) : "item";
}

export function parseJsonc(text: string): unknown {
  const withoutComments = stripJsonComments(text);
  const withoutTrailingCommas = stripTrailingCommas(withoutComments);
  return JSON.parse(withoutTrailingCommas) as unknown;
}

function stripTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index] ?? "";
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(text[lookahead] ?? "")) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    output += current;
  }
  return output;
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let index = 0;

  while (index < text.length) {
    const current = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (current === '"') {
      inString = true;
      output += current;
      index += 1;
      continue;
    }

    if (current === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      index += 1;
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      let closed = false;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        output += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < text.length) closed = true;
      if (!closed) throw new SyntaxError("Unterminated JSONC block comment.");
      index += 2;
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}
