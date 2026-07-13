import { strict as assert } from "node:assert";
import { test } from "node:test";
import { summarizeUnifiedDiff } from "../../src/git/worktree.js";

void test("unified diff summary counts files and lines", () => {
  const summary = summarizeUnifiedDiff(`diff --git a/a.txt b/a.txt
index 123..456 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1,2 @@
-old
+new
+extra
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
`);
  assert.deepEqual(summary, {
    filesChanged: 2,
    insertions: 3,
    deletions: 1,
    newFiles: 1,
    deletedFiles: 0,
    binaryFiles: 0,
  });
});
