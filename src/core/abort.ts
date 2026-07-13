import { MAX_TIMER_DELAY_MS } from "./utils.js";

export interface LinkedAbortScope {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
}

export function throwIfAborted(signal: AbortSignal | undefined, fallbackMessage = "Operation cancelled."): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === "string" ? signal.reason : fallbackMessage);
  error.name = "AbortError";
  throw error;
}

/**
 * Creates a child AbortSignal that follows its parent and can optionally expire
 * after a hard wall-clock deadline. Disposing removes listeners and timers but
 * does not abort completed work.
 */
export function createLinkedAbortScope(options: {
  parent?: AbortSignal;
  timeoutMs?: number;
  timeoutMessage?: string;
} = {}): LinkedAbortScope {
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS
  )) {
    throw new Error(`timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}.`);
  }
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort(options.parent?.reason);
  if (options.parent?.aborted === true) {
    controller.abort(options.parent.reason);
  } else {
    options.parent?.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      const error = new Error(options.timeoutMessage ?? `Operation exceeded ${timeoutMs} ms.`);
      error.name = "TimeoutError";
      controller.abort(error);
    }, timeoutMs);
    timer.unref();
  }

  return {
    signal: controller.signal,
    abort(reason?: unknown): void {
      controller.abort(reason);
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      options.parent?.removeEventListener("abort", onParentAbort);
    },
  };
}
