import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Logger } from "../core/logger.js";
import { CodexProtocolError, errorMessage } from "../core/errors.js";
import { MAX_TIMER_DELAY_MS, withTimeout } from "../core/utils.js";
import { terminateProcessTree } from "../core/process.js";
import type { JsonObject } from "../core/json.js";

const MAXIMUM_INBOUND_FRAME_BYTES = 2 * 1024 * 1024;

export interface StdioTransportOptions {
  command: string;
  args: string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  logger: Logger;
}

export class StdioJsonRpcTransport extends EventEmitter {
  readonly #options: StdioTransportOptions;
  #process: ChildProcessWithoutNullStreams | null = null;
  #stdoutBuffer = Buffer.alloc(0);
  #closed = false;
  #starting: Promise<void> | null = null;

  public constructor(options: StdioTransportOptions) {
    super();
    assertTransportTimeout("startupTimeoutMs", options.startupTimeoutMs);
    assertTransportTimeout("shutdownTimeoutMs", options.shutdownTimeoutMs);
    this.#options = options;
    // EventEmitter treats an unhandled `error` event as an exception. Keep the
    // transport safe during the narrow gap between spawning the child and the
    // JSON-RPC client attaching its own listener.
    this.on("error", () => undefined);
  }

  public get pid(): number | undefined {
    return this.#process?.pid;
  }

  public async start(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw abortError(signal.reason);
    if (this.#process !== null && !this.#closed) return;
    if (this.#starting !== null) return this.#starting;
    if (this.#closed) throw new Error("Codex App Server transport cannot be restarted after it has closed.");

    const starting = this.#startOnce(signal);
    this.#starting = starting;
    try {
      await starting;
    } finally {
      this.#starting = null;
    }
  }

  async #startOnce(signal?: AbortSignal): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#options.command, this.#options.args, {
        cwd: this.#options.cwd,
        env: this.#options.environment ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      this.#closed = true;
      throw error;
    }
    this.#process = child;

    child.stdout.on("data", (chunk: Buffer) => this.#handleStdoutChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text.length > 0) {
        this.#options.logger.debug("Codex App Server stderr", { text });
        this.emit("stderr", text);
      }
    });
    child.once("exit", (code, signal) => {
      this.#closed = true;
      this.emit("exit", { code, signal });
    });
    child.on("error", (error) => this.emit("error", error));

    const startup = new Promise<void>((resolvePromise, reject) => {
      child.once("spawn", resolvePromise);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(new Error(`Codex App Server exited during startup (code=${String(code)}, signal=${String(signal)}).`));
      });
    });

    let onAbort: (() => void) | undefined;
    const aborted = signal === undefined
      ? new Promise<void>(() => undefined)
      : new Promise<void>((_resolvePromise, reject) => {
          onAbort = () => {
            terminateProcessTree(child, true);
            reject(abortError(signal.reason));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        });
    try {
      await withTimeout(Promise.race([startup, aborted]), this.#options.startupTimeoutMs, "Timed out starting Codex App Server.", () => {
        terminateProcessTree(child, true);
      });
      if (child.exitCode !== null || this.#closed || !child.stdin.writable) {
        throw new Error("Codex App Server became unavailable during startup.");
      }
    } catch (error) {
      this.#stdoutBuffer = Buffer.alloc(0);
      terminateProcessTree(child, true);
      await waitForExit(child, Math.min(this.#options.shutdownTimeoutMs, 2_000));
      this.#process = null;
      this.#closed = true;
      throw error;
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  public send(message: JsonObject): void {
    const child = this.#process;
    if (child === null || this.#closed || !child.stdin.writable) {
      throw new Error("Codex App Server transport is not writable.");
    }
    const serialized = `${JSON.stringify(message)}\n`;
    child.stdin.write(serialized, (error) => {
      if (error !== null && error !== undefined) this.emit("error", error);
    });
  }

  public async close(): Promise<void> {
    const child = this.#process;
    if (child === null) {
      this.#closed = true;
      return;
    }
    this.#closed = true;
    this.#stdoutBuffer = Buffer.alloc(0);
    child.stdin.end();

    if (child.exitCode === null) {
      terminateProcessTree(child, false);
      const exited = await waitForExit(child, this.#options.shutdownTimeoutMs);
      if (!exited && child.exitCode === null) {
        this.#options.logger.warn("Codex App Server required forced shutdown");
        terminateProcessTree(child, true);
        await waitForExit(child, Math.min(this.#options.shutdownTimeoutMs, 2_000));
      }
    }
    this.#process = null;
  }

  #handleLine(line: string): void {
    if (line.trim().length === 0) return;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        this.#options.logger.warn("Ignoring non-object App Server message", { line });
        return;
      }
      this.emit("message", value as JsonObject);
    } catch (error) {
      this.#options.logger.warn("Ignoring invalid JSON from App Server", {
        line,
        error: errorMessage(error),
      });
    }
  }

  #handleStdoutChunk(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (this.#stdoutBuffer.length + segment.length > MAXIMUM_INBOUND_FRAME_BYTES) {
        const error = new CodexProtocolError(`Codex App Server JSON-RPC frame exceeded ${MAXIMUM_INBOUND_FRAME_BYTES} bytes.`);
        this.#stdoutBuffer = Buffer.alloc(0);
        const child = this.#process;
        if (child !== null) terminateProcessTree(child, true);
        this.emit("error", error);
        return;
      }
      if (segment.length > 0) this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, segment]);
      if (newline !== -1) {
        let line = this.#stdoutBuffer.toString("utf8");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        this.#stdoutBuffer = Buffer.alloc(0);
        this.#handleLine(line);
        offset = newline + 1;
      } else {
        offset = chunk.length;
      }
    }
  }
}

function assertTransportTimeout(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new CodexProtocolError(
      `${name} must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}.`,
      undefined,
      { [name]: value },
    );
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolvePromise(value);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    timer.unref();
    child.once("exit", onExit);
  });
}

function abortError(reason: unknown): Error {
  const error = reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" && reason.length > 0 ? reason : "Transport startup aborted.");
  if (error.name === "Error") error.name = "AbortError";
  return error;
}
