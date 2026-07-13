import { createReadStream } from "node:fs";
import { MAX_USER_PROMPT_BYTES } from "../runner/prompt.js";

export const MAX_PROMPT_BYTES = MAX_USER_PROMPT_BYTES;

export async function resolvePrompt(options: {
  prompt?: string;
  promptFile?: string;
  positionals?: string[];
}): Promise<string> {
  if (options.prompt !== undefined) {
    return requireNonEmpty(options.prompt);
  }
  if (options.promptFile !== undefined) {
    return requireNonEmpty(await readBoundedText(createReadStream(options.promptFile), "Prompt file"));
  }
  if ((options.positionals?.length ?? 0) > 0) {
    return requireNonEmpty(options.positionals?.join(" ") ?? "");
  }
  if (!process.stdin.isTTY) {
    return requireNonEmpty(await readBoundedText(process.stdin, "Prompt stdin"));
  }
  throw new Error("A prompt is required. Use --prompt, --prompt-file, positional text, or stdin.");
}

function requireNonEmpty(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Prompt must not be empty.");
  }
  const bytes = Buffer.byteLength(trimmed);
  if (bytes > MAX_PROMPT_BYTES) {
    throw new Error(`Prompt exceeds the ${MAX_PROMPT_BYTES}-byte safety limit.`);
  }
  return trimmed;
}

async function readBoundedText(source: AsyncIterable<unknown>, label: string): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_PROMPT_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_PROMPT_BYTES}-byte safety limit.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
