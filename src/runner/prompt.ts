export const MAX_USER_PROMPT_BYTES = 1024 * 1024;

export function normalizeUserPrompt(userPrompt: string): string {
  const prompt = userPrompt.trim();
  if (prompt.length === 0) throw new Error("Prompt must not be empty.");
  if (Buffer.byteLength(prompt) > MAX_USER_PROMPT_BYTES) {
    throw new Error(`Prompt exceeds the ${MAX_USER_PROMPT_BYTES}-byte safety limit.`);
  }
  return prompt;
}

export function buildControlledPrompt(userPrompt: string): string {
  const prompt = normalizeUserPrompt(userPrompt);
  return `<counterlane_task>\n${prompt}\n</counterlane_task>`;
}
