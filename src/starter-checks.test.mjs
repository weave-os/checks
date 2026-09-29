// Content/provenance gate for the public starter set. The filenames, count,
// strict policy, and blocked internal vocabulary are pinned so a later
// monorepo check cannot slip into the public package unnoticed.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { discoverChecks } from "./discover.mjs";
import { WEAVE_POLICY } from "./parse.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "starter-checks");
const EXPECTED = [
  "boilerplate-explosion.md",
  "dead-code-paths.md",
  "defensive-programming.md",
  "documentation-signal.md",
  "extraction-cleanup.md",
  "intermediate-variable-cleanup.md",
  "mobile-layout.md",
  "naming-clarity.md",
  "no-checked-in-specs.md",
  "no-tautological-tests.md",
  "over-abstraction.md",
  "redundant-type-annotations.md",
  "reinventing-the-wheel.md",
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

describe("starter checks", () => {
  it("contains exactly the 14 generic checks", () => {
    assert.deepEqual(readdirSync(DIR).filter((name) => name.endsWith(".md")).sort(), EXPECTED);
    const matrix = discoverChecks("starter-checks", { repoDir: ROOT, policy: WEAVE_POLICY });
    assert.equal(matrix.length, 14);
  });

  it("maps all four intelligence tiers to rolling aliases and same-value Router clusters", () => {
    const matrix = discoverChecks("starter-checks", { repoDir: ROOT, policy: WEAVE_POLICY });
    const expectedAlias = { low: "haiku", medium: "sonnet", high: "opus", maximum: "opus" };
    for (const check of matrix) {
      assert.equal(check.model, expectedAlias[check.intelligence], `${check.path}: alias for ${check.intelligence}`);
      assert.equal(check.cluster, check.intelligence, `${check.path}: Router force-cluster`);
    }
    assert.deepEqual(WEAVE_POLICY.allowedIntelligence, new Set(Object.keys(expectedAlias)));
  });

  it("contains no forbidden internal policy, paths, or incident context", () => {
    for (const name of EXPECTED) {
      const text = readFileSync(path.join(DIR, name), "utf8");
      for (const pattern of FORBIDDEN) {
        assert.doesNotMatch(text, pattern, `${name} contains ${pattern}`);
      }
    }
  });

  it("does not publish a hidden ignore policy with the starter criteria", () => {
    assert.equal(readdirSync(DIR).includes(".ignore"), false);
  });
});
