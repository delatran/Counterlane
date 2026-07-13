import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { CommandResult } from "./types.js";
import { MAX_TIMER_DELAY_MS, truncate } from "./utils.js";

export interface RunCommandOptions {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maximumOutputBytes?: number;
  input?: string;
  signal?: AbortSignal;
}

export async function runCommand(command: readonly string[], options: RunCommandOptions): Promise<CommandResult> {
  if (command.length === 0) {
    throw new Error("Cannot run an empty command.");
  }

  const executable = command[0];
  if (executable === undefined || executable.length === 0) {
    throw new Error("Command executable must be non-empty.");
  }
  if (options.signal?.aborted === true) {
    throw abortError(options.signal.reason);
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`Command timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}.`);
  }

  const resolved = resolveCommandForPlatform(command, {
    platform: process.platform,
    environment: options.environment ?? process.env,
    execPath: process.execPath,
    exists: existsSync,
  });
  const args = resolved.args;
  const startedAt = Date.now();
  const maximumOutputBytes = options.maximumOutputBytes ?? 1_000_000;
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 0) {
    throw new Error("Command maximumOutputBytes must be a non-negative safe integer.");
  }
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    env: resolved.environment ?? options.environment ?? process.env,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    // A dedicated process group lets cancellation terminate descendants such
    // as test runners, compilers, and package-manager subprocesses on POSIX.
    detached: process.platform !== "win32",
  };

  return new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(resolved.executable, args, spawnOptions);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let terminationRequested = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (target === "stdout") {
        if (stdoutBytes < maximumOutputBytes) {
          const remaining = maximumOutputBytes - stdoutBytes;
          const accepted = chunk.subarray(0, remaining);
          if (accepted.length > 0) stdoutChunks.push(accepted);
          stdoutBytes += accepted.length;
          stdoutTruncated ||= chunk.length > remaining;
        } else if (chunk.length > 0) {
          stdoutTruncated = true;
        }
      } else if (stderrBytes < maximumOutputBytes) {
        const remaining = maximumOutputBytes - stderrBytes;
        const accepted = chunk.subarray(0, remaining);
        if (accepted.length > 0) stderrChunks.push(accepted);
        stderrBytes += accepted.length;
        stderrTruncated ||= chunk.length > remaining;
      } else if (chunk.length > 0) {
        stderrTruncated = true;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

    if (options.input !== undefined) {
      // A child may exit before consuming all input. Without an error listener,
      // Node emits EPIPE/EOF on the stdin socket as an uncaught exception and
      // can terminate the whole Counterlane process instead of returning the
      // child's actual exit result.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }

    const terminate = (): void => {
      if (child.exitCode !== null || child.killed) return;
      terminationRequested = true;
      terminateProcessTree(child, false);
      forceTimer ??= setTimeout(() => {
        terminateProcessTree(child, true);
      }, 2_000);
      forceTimer.unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Close the race between the pre-spawn check and listener registration.
    if (options.signal?.aborted === true) onAbort();

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (terminationRequested) terminateProcessTree(child, true);
      cleanup();
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
      const outputSuffix = stdoutTruncated ? "\n… <stdout truncated>" : "";
      const errorSuffix = stderrTruncated ? "\n… <stderr truncated>" : "";
      resolvePromise({
        command: [...command],
        cwd: options.cwd,
        exitCode,
        signal,
        stdout: truncate(stdout + outputSuffix, maximumOutputBytes + 256),
        stderr: truncate(stderr + errorSuffix, maximumOutputBytes + 256),
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
      });
    });
  });
}

export interface CommandResolutionOptions {
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  execPath: string;
  exists: (path: string) => boolean;
}

/**
 * Node cannot execute Windows `.cmd` shims with `shell: false`. Resolve npm to
 * its adjacent JavaScript entry point so verifier arguments remain structured
 * and never pass through a command shell.
 */
export function resolveCommandForPlatform(
  command: readonly string[],
  options: CommandResolutionOptions,
): { executable: string; args: string[]; environment?: NodeJS.ProcessEnv } {
  const executable = command[0];
  if (executable === undefined || executable.length === 0) {
    throw new Error("Command executable must be non-empty.");
  }
  const args = command.slice(1);
  if (options.platform !== "win32") return { executable, args };

  const pathApi = win32;
  const executableName = pathApi.basename(executable).toLowerCase();
  if (executableName !== "npm" && executableName !== "npm.cmd" && executableName !== "npm.ps1") {
    return { executable, args };
  }

  const pathKey = Object.keys(options.environment).find((key) => key.toLowerCase() === "path") ?? "Path";
  const pathValue = options.environment[pathKey] ?? "";
  const pathEntries = pathValue.split(";")
    .map((entry) => entry.trim().replace(/^"|"$/gu, ""))
    .filter((entry) => entry.length > 0);
  const directories = new Set<string>();
  if (pathApi.isAbsolute(executable)) directories.add(pathApi.dirname(executable));
  directories.add(pathApi.dirname(options.execPath));
  for (const entry of pathEntries) directories.add(entry);

  for (const directory of directories) {
    const npmCli = pathApi.join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    const nodeExecutable = pathApi.join(directory, "node.exe");
    const hasShim = options.exists(pathApi.join(directory, "npm.cmd")) ||
      options.exists(pathApi.join(directory, "npm.ps1"));
    if (hasShim && options.exists(npmCli) && options.exists(nodeExecutable)) {
      const selectedDirectory = pathApi.resolve(directory).toLowerCase();
      const remainingPath = pathEntries.filter(
        (entry) => pathApi.resolve(entry).toLowerCase() !== selectedDirectory,
      );
      return {
        executable: nodeExecutable,
        args: [npmCli, ...args],
        environment: {
          ...options.environment,
          [pathKey]: [directory, ...remainingPath].join(";"),
        },
      };
    }
  }

  return { executable, args };
}

export function terminateProcessTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const killer = spawn("taskkill", args, {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
      detached: false,
    });
    const fallback = (): void => {
      if (child.exitCode === null) child.kill(force ? "SIGKILL" : "SIGTERM");
    };
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code !== 0) fallback();
    });
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

function abortError(reason: unknown): Error {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason.length > 0
      ? reason
      : "Operation aborted.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function quoteCommand(command: readonly string[]): string {
  return command.map((part) => (/\s|["']/u.test(part) ? JSON.stringify(part) : part)).join(" ");
}
