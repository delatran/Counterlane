export async function runBoundedBatch(items, worker, options = {}) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  if (typeof worker !== "function") throw new TypeError("worker must be a function");

  const snapshot = [...items];
  const results = [];
  for (let index = 0; index < snapshot.length; index += 1) {
    try {
      const value = await worker(snapshot[index], {
        index,
        attempt: 1,
        signal: options.signal,
      });
      results.push({ status: "fulfilled", value, attempts: 1 });
    } catch (error) {
      results.push({
        status: "rejected",
        reason: { name: error?.name ?? "Error", message: String(error?.message ?? error) },
        attempts: 1,
      });
    }
  }
  return results;
}
