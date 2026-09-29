// Content/provenance gate for the public check collections. The filenames,
// counts, strict policy, and blocked internal vocabulary are pinned so a later
// monorepo check cannot slip into the public package unnoticed.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { discoverChecks } from "./discover.mjs";
import { WEAVE_POLICY } from "./parse.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STARTER_DIR = path.join(ROOT, "starter-checks");
const LIBRARY_DIR = path.join(ROOT, "checks-library");
const STARTER_EXPECTED = [
  "boilerplate-explosion.md",
  "dead-code-paths.md",
  "defensive-programming.md",
  "documentation-signal.md",
  "extraction-cleanup.md",
  "intermediate-variable-cleanup.md",
  "naming-clarity.md",
  "no-tautological-tests.md",
  "over-abstraction.md",
  "redundant-type-annotations.md",
  "reinventing-the-wheel.md",
];
const LIBRARY_EXPECTED = [
  "README.md",
  "mobile-layout.md",
  "no-checked-in-specs.md",
  "user-prompt-privacy.md",
];

// These identifiers and paths refer to private Weave policy, internal
// architecture, incidents, or artifacts. The few generic terms also used
// elsewhere are intentionally matched with their identifying context.
const FORBIDDEN = [
  /workweave/i,
  /\.weave-checks\//,
  /\bml_dev\b/,
  /\btimeutils\b/,
  /\.agent-docs\b/,
  /backend\/internal\//,
  /frontend\/(?:components|lib)\//,
  /private-artifact/i,
  /offline.{0,30}check/i,
  /Weave monorepo/i,
  /run 320\d{7,}/i,
  /router-internal\//i,
  /customer incident/i,
];

describe("public check collections", () => {
  it("keeps the starter set separate from the situational library", () => {
    assert.deepEqual(readdirSync(STARTER_DIR).filter((name) => name.endsWith(".md")).sort(), STARTER_EXPECTED);
    assert.deepEqual(readdirSync(LIBRARY_DIR).filter((name) => name.endsWith(".md")).sort(), LIBRARY_EXPECTED);
    assert.equal(discoverChecks("starter-checks", { repoDir: ROOT, policy: WEAVE_POLICY }).length, 11);
    assert.equal(discoverChecks("checks-library", { repoDir: ROOT, policy: WEAVE_POLICY }).length, 3);
    assert.match(readFileSync(path.join(LIBRARY_DIR, "README.md"), "utf8"), /may make sense in certain circumstances/i);
  });

  it("maps all four intelligence tiers to rolling aliases and same-value Router clusters", () => {
    const expectedAlias = { low: "haiku", medium: "sonnet", high: "opus", maximum: "opus" };
    for (const dir of ["starter-checks", "checks-library"]) {
      const matrix = discoverChecks(dir, { repoDir: ROOT, policy: WEAVE_POLICY });
      for (const check of matrix) {
        assert.equal(check.model, expectedAlias[check.intelligence], `${check.path}: alias for ${check.intelligence}`);
        assert.equal(check.cluster, check.intelligence, `${check.path}: Router force-cluster`);
      }
    }
    assert.deepEqual(WEAVE_POLICY.allowedIntelligence, new Set(Object.keys(expectedAlias)));
  });

  it("contains no forbidden internal policy, paths, or incident context", () => {
    for (const [dir, names] of [[STARTER_DIR, STARTER_EXPECTED], [LIBRARY_DIR, LIBRARY_EXPECTED]]) {
      for (const name of names) {
        const text = readFileSync(path.join(dir, name), "utf8");
        for (const pattern of FORBIDDEN) {
          assert.doesNotMatch(text, pattern, `${name} contains ${pattern}`);
        }
      }
    }
  });

  it("does not publish a hidden ignore policy with the check criteria", () => {
    for (const dir of [STARTER_DIR, LIBRARY_DIR]) {
      assert.equal(readdirSync(dir).includes(".ignore"), false);
    }
  });
});
