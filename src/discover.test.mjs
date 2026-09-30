import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { discoverChecksWithDefaults } from "./discover.mjs";
import { WEAVE_POLICY } from "./parse.mjs";

const ROOTS = [];
after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), "weave-checks-discover-"));
  ROOTS.push(root);
  return root;
}

function check(name, intelligence = "low") {
  return `---\nname: ${name}\ndescription: ${name} description\nintelligence: ${intelligence}\n---\n\nReview ${name}.\n`;
}

describe("discoverChecksWithDefaults", () => {
  it("combines repository checks with bundled starter checks", () => {
    const root = scratch();
    const customDir = path.join(root, ".weave-checks");
    const starterDir = path.join(root, "package", "starter-checks");
    mkdirSync(customDir, { recursive: true });
    mkdirSync(starterDir, { recursive: true });
    writeFileSync(path.join(customDir, "custom-check.md"), check("Custom Check"));
    writeFileSync(path.join(starterDir, "starter-check.md"), check("Starter Check", "medium"));

    const matrix = discoverChecksWithDefaults(".weave-checks", {
      repoDir: root,
      policy: WEAVE_POLICY,
      useDefaultChecks: true,
      starterChecksDir: starterDir,
    });

    assert.deepEqual(
      matrix.map(({ slug, path: checkPath }) => [slug, checkPath]),
      [
        ["custom-check", ".weave-checks/custom-check.md"],
        ["starter-check", "starter-checks/starter-check.md"],
      ],
    );
    assert.equal(matrix[1].criteriaPath, path.join(starterDir, "starter-check.md"));
  });

  it("allows a missing repository checks directory when defaults are enabled", () => {
    const root = scratch();
    const starterDir = path.join(root, "starter-checks");
    mkdirSync(starterDir);
    writeFileSync(path.join(starterDir, "starter-check.md"), check("Starter Check"));

    const matrix = discoverChecksWithDefaults(".weave-checks", {
      repoDir: root,
      policy: WEAVE_POLICY,
      useDefaultChecks: true,
      starterChecksDir: starterDir,
    });

    assert.deepEqual(
      matrix.map(({ slug }) => slug),
      ["starter-check"],
    );
    assert.throws(
      () => discoverChecksWithDefaults(".weave-checks", { repoDir: root, policy: WEAVE_POLICY }),
      /failed to read \.weave-checks/,
    );
  });

  it("rejects duplicate slugs across the two check collections", () => {
    const root = scratch();
    const customDir = path.join(root, ".weave-checks");
    const starterDir = path.join(root, "starter-checks");
    mkdirSync(customDir);
    mkdirSync(starterDir);
    writeFileSync(path.join(customDir, "shared.md"), check("Custom Shared Check"));
    writeFileSync(path.join(starterDir, "shared.md"), check("Default Shared Check"));

    assert.throws(
      () =>
        discoverChecksWithDefaults(".weave-checks", {
          repoDir: root,
          policy: WEAVE_POLICY,
          useDefaultChecks: true,
          starterChecksDir: starterDir,
        }),
      /duplicate check slug "shared"/,
    );
  });
});
