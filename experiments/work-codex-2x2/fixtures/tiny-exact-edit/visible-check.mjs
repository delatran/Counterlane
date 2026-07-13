import { readFile } from "node:fs/promises";

const value = await readFile(new URL("./answer.txt", import.meta.url), "utf8");
if (value.length === 0 || !value.endsWith("\n")) {
  console.error("answer.txt must be non-empty and end with one newline");
  process.exitCode = 1;
}
