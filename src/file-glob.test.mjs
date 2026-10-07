import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { filterDiffByGlob, matchesFileGlob, validateFileGlob } from "./file-glob.mjs";

const DIFF = `diff --git a/frontend/App.jsx b/frontend/App.jsx
index 1111111..2222222 100644
--- a/frontend/App.jsx
+++ b/frontend/App.jsx
@@ -1 +1 @@
-old
+new
diff --git a/backend/api.js b/backend/api.js
index 3333333..4444444 100644
--- a/backend/api.js
+++ b/backend/api.js
@@ -1 +1 @@
-old
+new
`;

describe("file globs", () => {
  it("matches segment wildcards and recursive paths", () => {
    assert.equal(matchesFileGlob("frontend/App.jsx", "frontend/**"), true);
    assert.equal(matchesFileGlob("frontend/nested/App.jsx", "frontend/**"), true);
    assert.equal(matchesFileGlob("backend/api.js", "frontend/**"), false);
    assert.equal(matchesFileGlob("frontend/App.jsx", "**/*.jsx"), true);
    assert.equal(matchesFileGlob("frontend/App.jsx", "frontend/*.jsx"), true);
    assert.equal(matchesFileGlob("frontend/nested/App.jsx", "frontend/*.jsx"), false);
    assert.equal(matchesFileGlob("frontend/App.jsx", "frontend/?.jsx"), false);
  });

  it("rejects empty, absolute, escaping, and backslash patterns", () => {
    for (const pattern of ["", "/frontend/**", "../**", "frontend\\**", "frontend/[x"]) {
      assert.throws(() => validateFileGlob(pattern), /files/);
    }
  });

  it("limits diff and stat to matches", () => {
    const scoped = filterDiffByGlob(DIFF, "frontend/**");
    assert.match(scoped.diff, /frontend\/App\.jsx/);
    assert.doesNotMatch(scoped.diff, /backend\/api\.js/);
    assert.match(scoped.stat, /frontend\/App\.jsx/);
    assert.doesNotMatch(scoped.stat, /backend\/api\.js/);
    assert.deepEqual(scoped.paths, ["frontend/App.jsx"]);
  });

  it("matches renamed and deleted paths", () => {
    const rename = `diff --git a/backend/old.ts b/frontend/new.ts\nsimilarity index 100%\nrename from backend/old.ts\nrename to frontend/new.ts\n`;
    assert.equal(filterDiffByGlob(rename, "frontend/**").diff, rename);
    assert.equal(filterDiffByGlob(rename, "backend/**").diff, rename);

    const sameDirectoryRename = `diff --git a/a/old.ts b/a/new.ts\nsimilarity index 100%\nrename from a/old.ts\nrename to a/new.ts\n`;
    assert.equal(filterDiffByGlob(sameDirectoryRename, "a/**").diff, sameDirectoryRename);
    assert.equal(filterDiffByGlob(sameDirectoryRename, "old/**").diff, "");

    const deletion = `diff --git a/frontend/gone.ts b/frontend/gone.ts\n--- a/frontend/gone.ts\n+++ /dev/null\n`;
    assert.equal(filterDiffByGlob(deletion, "frontend/**").diff, deletion);
  });

  it("does not treat diff-header-like hunk content as file metadata", () => {
    const diff = `diff --git a/backend/source.js b/backend/source.js\n--- a/backend/source.js\n+++ b/backend/source.js\n@@ -0,0 +1 @@\n+++ b/frontend/fake.js\n`;
    assert.equal(filterDiffByGlob(diff, "frontend/**").diff, "");
    assert.equal(filterDiffByGlob(diff, "backend/**").diff, diff);
  });

  it("handles binary diffs and filenames containing spaces", () => {
    const binary = `diff --git a/frontend/brand image.png b/frontend/brand image.png\nBinary files a/frontend/brand image.png and b/frontend/brand image.png differ\n`;
    assert.equal(filterDiffByGlob(binary, "frontend/**").diff, binary);

    const quoted = `diff --git "a/frontend/brand image.png" "b/frontend/brand image.png"\nBinary files a/frontend/brand image.png and b/frontend/brand image.png differ\n`;
    assert.equal(filterDiffByGlob(quoted, "frontend/**").diff, quoted);
  });
});
