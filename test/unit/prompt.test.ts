import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_PROMPT_BYTES, resolvePrompt } from "../../src/cli/prompt.js";
import { buildControlledPrompt } from "../../src/runner/prompt.js";
import { SingleRunner } from "../../src/runner/single.js";
import { TwinRunner } from "../../src/runner/twin.js";
import { MetaExecutionRunner } from "../../src/runner/meta.js";

void test("prompt inputs enforce the outbound resource bound", async () => {
  await assert.rejects(
    resolvePrompt({ prompt: "x".repeat(MAX_PROMPT_BYTES + 1) }),
    /Prompt exceeds the .*byte safety limit/u,
  );

  const directory = await mkdtemp(join(tmpdir(), "counterlane-prompt-bound-"));
  const promptFile = join(directory, "prompt.txt");
  try {
    await writeFile(promptFile, "x".repeat(MAX_PROMPT_BYTES + 1), "utf8");
    await assert.rejects(
      resolvePrompt({ promptFile }),
      /Prompt file exceeds the .*byte safety limit/u,
    );
    await writeFile(promptFile, "  bounded prompt  \n", "utf8");
    assert.equal(await resolvePrompt({ promptFile }), "bounded prompt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("direct runner prompts enforce the same non-empty and byte-bound contract", () => {
  assert.throws(() => buildControlledPrompt("  \n"), /Prompt must not be empty/u);
  assert.throws(
    () => buildControlledPrompt("x".repeat(MAX_PROMPT_BYTES + 1)),
    /Prompt exceeds the .*byte safety limit/u,
  );
  assert.match(buildControlledPrompt("  bounded  "), /<counterlane_task>\nbounded\n<\/counterlane_task>/u);
});

void test("public runners reject invalid prompts before touching repository or runtime dependencies", async () => {
  const inert = {
    repository: null as never,
    config: null as never,
    logger: null as never,
    telemetry: null as never,
  };
  await assert.rejects(
    new SingleRunner(inert).run({ prompt: "x".repeat(MAX_PROMPT_BYTES + 1), mode: "auto" }),
    /Prompt exceeds the .*byte safety limit/u,
  );
  await assert.rejects(new TwinRunner(inert).run({ prompt: " \n " }), /Prompt must not be empty/u);
  await assert.rejects(new MetaExecutionRunner(inert).run({ prompt: " \n " }), /Prompt must not be empty/u);
  await assert.rejects(new MetaExecutionRunner(inert).plan(" \n "), /Prompt must not be empty/u);
});
