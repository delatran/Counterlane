import { rm } from "node:fs/promises";

await Promise.all([
  removeGeneratedDirectory("../dist"),
  removeGeneratedDirectory("../dist-test"),
  removeGeneratedDirectory("../coverage"),
]);

function removeGeneratedDirectory(path) {
  return rm(new URL(path, import.meta.url), {
    recursive: true,
    force: true,
    // Windows, antivirus, and sync clients may briefly retain a just-closed
    // compiler/test handle. Node retries only when these options are explicit.
    maxRetries: 10,
    retryDelay: 100,
  });
}
