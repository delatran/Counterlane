import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sanitizeTerminalText } from "../../src/report/console.js";

void test("terminal output strips ANSI and flattens injected control rows", () => {
  const value = sanitizeTerminalText("model\u001b[2J\u001b[31mRED\u001b[0m\r\nforged\u0000\u0085row");
  assert.equal(value, "modelRED  forged  row");
  assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f]/u);
});
