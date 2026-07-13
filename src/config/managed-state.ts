import type { CounterlaneConfig } from "./types.js";

/** Repository-relative paths owned by Counterlane rather than task source. */
export function managedStatePrefixes(config: CounterlaneConfig): string[] {
  const values = [config.dataDirectory, config.twin.worktreeBaseDirectory]
    .filter((value): value is string => value !== null)
    .map((value) => value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, ""))
    .filter((value) => value.length > 0);
  return [...new Set(values)];
}
