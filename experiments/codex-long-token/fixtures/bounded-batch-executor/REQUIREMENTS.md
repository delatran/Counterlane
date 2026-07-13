# Bounded batch executor contract

Implement `runBoundedBatch(items, worker, options)` in `src/bounded-batch.mjs`. Do not modify any other task file.

## Inputs

- `items` must be an array. Snapshot it before starting work.
- `worker` must be a function called as `worker(item, context)`.
- `options.concurrency` defaults to `4` and must be an integer from `1` through `64`.
- `options.retries` defaults to `0` and must be a non-negative integer.
- `options.timeoutMs` defaults to `null`; when supplied it must be a positive integer and applies independently to every attempt.
- `options.signal` may be omitted or must be an `AbortSignal`-compatible object with `aborted`, `addEventListener`, and `removeEventListener`.
- Reject invalid inputs with `TypeError` or `RangeError` before calling the worker.

## Execution

- Never have more than `concurrency` worker calls logically active at once.
- Call the worker with `{ index, attempt, signal }`, where `attempt` starts at `1` and `signal` is specific to that attempt.
- Preserve input order in the returned results even when work completes out of order.
- Retry ordinary throws, rejected promises, and timeouts until `retries + 1` attempts have been used.
- A timeout aborts the attempt signal and records a `TimeoutError`. Late worker settlement must not create an unhandled rejection.
- An outer abort immediately prevents new items and retries from starting, aborts every active attempt signal, and settles every unfinished item as `AbortError`. Abort failures are never retried.
- Resolve an empty input immediately without calling the worker.

## Results

The function always resolves after valid input; individual worker failures are data:

```text
{ status: "fulfilled", value, attempts }
{ status: "rejected", reason: { name, message }, attempts }
```

- `attempts` is the number of worker calls actually started for that item. Items prevented from starting by an outer abort use `0`.
- Normalize non-`Error` rejection values to `{ name: "Error", message: String(value) }`.
- Do not expose mutable internal state or reject the whole batch because one item failed.
