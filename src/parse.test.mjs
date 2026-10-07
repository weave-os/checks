import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESULT_SCHEMA,
  DEDUP_SCHEMA,
  GENERIC_POLICY,
  MODEL_FOR_INTELLIGENCE,
  MODEL_HAIKU,
  MODEL_OPUS,
  MODEL_SONNET,
  WEAVE_POLICY,
  policyFrom,
  RESOLUTION_SCHEMA,
  SUPPORTED_CLUSTERS,
  SUPPORTED_INTELLIGENCE,
  VERDICT,
  buildMatrix,
  checkSetDigest,
  everyCheckReviewed,
  formatReviewedMarker,
  formatReviewComment,
  interpretResult,
  INTERPRET_OUTCOME,
  ignorePathspecs,
  isCheckFile,
  parseIgnoreList,
  OUTCOME,
  NEUTRAL_CAUSE,
  parseAddedLines,
  parseCheckFile,
  parseStructuredOutput,
  validateResult,
} from "./parse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = path.join(__dirname, "fixtures", "checks");

const VALID = `---
name: Example Check
description: Does a thing
intelligence: low
---

Body text.
`;

function file(text, filePath = ".weave-checks/example.md") {
  return { path: filePath, text };
}

describe("parseCheckFile", () => {
  it("parses intelligence and derives the rolling model alias and Router cluster", () => {
    const check = parseCheckFile(VALID, ".weave-checks/example.md");
    assert.equal(check.slug, "example");
    assert.equal(check.name, "Example Check");
    assert.equal(check.description, "Does a thing");
    assert.equal(check.intelligence, "low");
    assert.equal(check.model, "haiku");
    assert.equal(check.cluster, "low");
    assert.equal(check.files, undefined);
    assert.equal(check.body.trim(), "Body text.");
  });

  it("retains a validated file glob in the check matrix", () => {
    const check = parseCheckFile(
      VALID.replace("intelligence: low", "intelligence: low\nfiles: frontend/**"),
      "checks/frontend.md",
    );
    assert.equal(check.files, "frontend/**");
    const [entry] = buildMatrix([
      file(
        VALID.replace("intelligence: low", "intelligence: low\nfiles: frontend/**"),
        "checks/frontend.md",
      ),
    ]);
    assert.equal(entry.files, "frontend/**");
  });

  it("allows glob syntax that resembles YAML structures in the files field", () => {
    assert.equal(
      parseCheckFile(
        VALID.replace("intelligence: low", "intelligence: low\nfiles: *.go"),
        "checks/x.md",
      ).files,
      "*.go",
    );
  });

  it("rejects quoted files globs instead of treating quotes as pattern characters", () => {
    for (const pattern of ['"frontend/**"', "'frontend/**'"]) {
      const text = VALID.replace("intelligence: low", `intelligence: low\nfiles: ${pattern}`);
      assert.throws(
        () => parseCheckFile(text, "checks/scoped.md"),
        /frontmatter values must be unquoted/,
      );
    }
  });

  it("rejects unsafe files globs", () => {
    for (const pattern of [
      "",
      "/frontend/**",
      "../**",
      "frontend\\\\**",
      "frontend/[x",
      "frontend/[]",
      "frontend/[z-a].js",
    ]) {
      const text = VALID.replace("intelligence: low", `intelligence: low\nfiles: ${pattern}`);
      assert.throws(() => parseCheckFile(text, "checks/scoped.md"), /invalid files glob/);
    }
  });

  it("maps each intelligence tier to a rolling model alias", () => {
    assert.deepEqual(MODEL_FOR_INTELLIGENCE, {
      low: "haiku",
      medium: "sonnet",
      high: "opus",
      maximum: "opus",
    });
    assert.equal(MODEL_HAIKU, "haiku");
    assert.equal(MODEL_SONNET, "sonnet");
    assert.equal(MODEL_OPUS, "opus");
  });

  it("rejects a file with no frontmatter", () => {
    assert.throws(
      () => parseCheckFile("Just a body.\n", ".weave-checks/x.md"),
      /missing frontmatter/,
    );
  });

  for (const key of ["name", "description", "intelligence"]) {
    it(`rejects frontmatter missing ${key}`, () => {
      const text = VALID.split("\n")
        .filter(line => !line.startsWith(`${key}:`))
        .join("\n");
      assert.throws(
        () => parseCheckFile(text, ".weave-checks/x.md"),
        new RegExp(`missing required key "${key}"`),
      );
    });
  }

  it("rejects unsupported intelligence values", () => {
    for (const intelligence of ["max", "fast", "Low", "haiku"]) {
      const text = VALID.replace("intelligence: low", `intelligence: ${intelligence}`);
      assert.throws(() => parseCheckFile(text, ".weave-checks/x.md"), /unsupported intelligence/);
    }
  });

  it("supports the cluster vocabulary as intelligence values", () => {
    assert.deepEqual([...SUPPORTED_INTELLIGENCE].sort(), ["high", "low", "maximum", "medium"]);
    assert.equal(SUPPORTED_INTELLIGENCE, SUPPORTED_CLUSTERS);
  });

  it("rejects legacy model and cluster frontmatter instead of silently ignoring it", () => {
    for (const legacy of ["model: claude-haiku-4-5", "cluster: low"]) {
      assert.throws(
        () =>
          parseCheckFile(
            VALID.replace("intelligence: low", `intelligence: low\n${legacy}`),
            "checks/x.md",
          ),
        /unknown frontmatter key/,
      );
    }
  });

  it("rejects an empty body", () => {
    const text = `---\nname: X\ndescription: Y\nintelligence: low\n---\n\n\n`;
    assert.throws(() => parseCheckFile(text, ".weave-checks/x.md"), /body is empty/);
  });

  it("rejects duplicate frontmatter keys", () => {
    const text = VALID.replace("description: Does a thing", "description: A\ndescription: B");
    assert.throws(() => parseCheckFile(text, ".weave-checks/x.md"), /duplicate frontmatter key/);
  });

  it("rejects unknown frontmatter keys", () => {
    const text = VALID.replace("intelligence: low", "intelligence: low\nowner: platform");
    assert.throws(
      () => parseCheckFile(text, ".weave-checks/x.md"),
      /unknown frontmatter key "owner"/,
    );
  });

  it("rejects YAML syntax the dependency-free frontmatter reader does not support", () => {
    for (const value of [
      '"Quoted Name"',
      "'Quoted Name'",
      "Name # inline comment",
      ">-",
      "[one, two]",
      "{key: value}",
    ]) {
      const text = VALID.replace("name: Example Check", `name: ${value}`);
      assert.throws(
        () => parseCheckFile(text, "checks/x.md"),
        /frontmatter values must be unquoted single-line scalars/,
        value,
      );
    }
  });

  it("includes the file path in errors", () => {
    assert.throws(
      () => parseCheckFile("nope", ".weave-checks/broken.md"),
      /\.weave-checks\/broken\.md/,
    );
  });
});

describe("parseCheckFile policies", () => {
  const WITHOUT_INTELLIGENCE = `---\nname: Bare\ndescription: No intelligence\n---\n\nBody.\n`;

  it("requires intelligence under both generic and Weave policies", () => {
    for (const policy of [WEAVE_POLICY, GENERIC_POLICY]) {
      assert.throws(
        () => parseCheckFile(WITHOUT_INTELLIGENCE, "checks/bare.md", policy),
        /missing required key "intelligence"/,
      );
    }
  });

  it("always serializes intelligence, its model alias, and its Router cluster in the matrix", () => {
    const [entry] = buildMatrix([file(VALID, "checks/bare.md")], GENERIC_POLICY);
    assert.deepEqual(
      { intelligence: entry.intelligence, model: entry.model, cluster: entry.cluster },
      { intelligence: "low", model: "haiku", cluster: "low" },
    );
  });

  it("allows callers to constrain intelligence values", () => {
    const policy = policyFrom({ allowedIntelligence: ["low", "medium"] });
    assert.equal(parseCheckFile(VALID, "checks/x.md", policy).model, "haiku");
    const high = VALID.replace("intelligence: low", "intelligence: high");
    assert.throws(
      () => parseCheckFile(high, "checks/x.md", policy),
      /unsupported intelligence "high"/,
    );
    assert.throws(
      () => policyFrom({ allowedIntelligence: ["fast"] }),
      /unsupported intelligence in allowlist/,
    );
  });

  it("accepts an empty allowlist as all four supported values", () => {
    assert.equal(policyFrom().allowedIntelligence, SUPPORTED_INTELLIGENCE);
    for (const intelligence of SUPPORTED_INTELLIGENCE) {
      const text = VALID.replace("intelligence: low", `intelligence: ${intelligence}`);
      assert.equal(parseCheckFile(text, "checks/x.md", GENERIC_POLICY).intelligence, intelligence);
    }
  });

  it("rejects a check file name outside the marker vocabulary", () => {
    for (const name of ["Bad_Name", "has space", "UPPER"]) {
      assert.throws(
        () => parseCheckFile(VALID, `checks/${name}.md`, GENERIC_POLICY),
        /must use only lowercase letters, digits, and hyphens/,
      );
    }
  });
});

describe("parseIgnoreList", () => {
  it("skips comments, blanks, and trailing slashes", () => {
    assert.deepEqual(parseIgnoreList("# research\n\nresearch/\n  vendor  \n"), [
      "research",
      "vendor",
    ]);
  });

  it("treats an empty file as no exclusions", () => {
    assert.deepEqual(parseIgnoreList(""), []);
    assert.deepEqual(parseIgnoreList("# only a comment\n"), []);
  });

  it("accepts wildcards below a literal directory prefix", () => {
    assert.deepEqual(parseIgnoreList("server/internal/db/*.sql.go\nvendor/?/generated[0-9].go\n"), [
      "server/internal/db/*.sql.go",
      "vendor/?/generated[0-9].go",
    ]);
  });

  it("rejects unanchored wildcard patterns", () => {
    for (const pattern of ["*", "**", "?*", "[a-z]*", "*.go", "a*", "./*", "./**", "./?.go"]) {
      assert.throws(
        () => parseIgnoreList(`${pattern}\n`),
        /wildcards require a literal directory prefix/,
        pattern,
      );
    }
  });

  it("rejects backslashes", () => {
    assert.throws(
      () => parseIgnoreList("server\\generated\\*.go\n"),
      /must use forward slashes without escapes/,
    );
  });

  it("rejects a pattern that would empty the whole tree", () => {
    assert.throws(() => parseIgnoreList(".\n"), /entire repository/);
    // A lone slash trims to empty, which is the same "exclude everything"
    // case as `.` -- not the absolute-path case (`/foo` still is).
    assert.throws(() => parseIgnoreList("/\n"), /entire repository/);
    assert.throws(() => parseIgnoreList("/foo\n"), /relative to the repository root/);
    assert.throws(() => parseIgnoreList("foo/../bar\n"), /escapes the repository root/);
  });
});

describe("ignorePathspecs", () => {
  it("prefixes each pattern as a git exclude", () => {
    assert.deepEqual(ignorePathspecs(["research", "vendor"]), [
      ":(exclude)research",
      ":(exclude)vendor",
    ]);
  });
});

describe("isCheckFile", () => {
  it("excludes README.md", () => {
    assert.equal(isCheckFile(".weave-checks/README.md"), false);
  });

  it("includes check markdown", () => {
    assert.equal(isCheckFile(".weave-checks/accessibility.md"), true);
  });

  it("excludes non-markdown", () => {
    assert.equal(isCheckFile(".weave-checks/notes.txt"), false);
  });
});

describe("buildMatrix", () => {
  it("rejects duplicate display names", () => {
    const a = file(VALID, ".weave-checks/a.md");
    const b = file(VALID, ".weave-checks/b.md");
    assert.throws(() => buildMatrix([a, b]), /duplicate check name "Example Check"/);
  });

  it("omits the body from matrix entries", () => {
    const [entry] = buildMatrix([file(VALID)]);
    assert.equal(entry.body, undefined);
    assert.deepEqual(Object.keys(entry).sort(), [
      "cluster",
      "description",
      "intelligence",
      "model",
      "name",
      "path",
      "slug",
    ]);
  });

  it("skips README.md without failing", () => {
    const readme = file("# Docs\n", ".weave-checks/README.md");
    const matrix = buildMatrix([file(VALID), readme]);
    assert.equal(matrix.length, 1);
  });

  it("is ordered by slug", () => {
    const b = file(VALID.replace("Example Check", "B"), ".weave-checks/b.md");
    const a = file(VALID.replace("Example Check", "A"), ".weave-checks/a.md");
    assert.deepEqual(
      buildMatrix([b, a]).map(entry => entry.slug),
      ["a", "b"],
    );
  });
});

describe("parseAddedLines", () => {
  it("collects added line numbers per file", () => {
    const diff = [
      "diff --git a/foo.go b/foo.go",
      "--- a/foo.go",
      "+++ b/foo.go",
      "@@ -10,0 +11,2 @@",
      "+added one",
      "+added two",
      "@@ -30,1 +33,1 @@",
      "-old",
      "+new",
    ].join("\n");

    const lines = parseAddedLines(diff);
    assert.deepEqual(
      [...lines.get("foo.go")].sort((a, b) => a - b),
      [11, 12, 33],
    );
  });

  it("handles a single-line hunk with no count", () => {
    const diff = ["+++ b/a.ts", "@@ -1 +5 @@", "+x"].join("\n");
    assert.deepEqual([...parseAddedLines(diff).get("a.ts")], [5]);
  });

  it("tracks multiple files independently", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -0,0 +1,1 @@",
      "+a",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -0,0 +7,1 @@",
      "+b",
    ].join("\n");
    const lines = parseAddedLines(diff);
    assert.deepEqual([...lines.get("a.ts")], [1]);
    assert.deepEqual([...lines.get("b.ts")], [7]);
  });

  it("keeps added source lines beginning with plus signs in the current file", () => {
    const diff = [
      "diff --git a/plus.go b/plus.go",
      "--- a/plus.go",
      "+++ b/plus.go",
      "@@ -0,0 +1,2 @@",
      "+++ source line",
      "+another line",
    ].join("\n");

    const lines = parseAddedLines(diff);
    assert.deepEqual([...lines.keys()], ["plus.go"]);
    assert.deepEqual([...lines.get("plus.go")], [1, 2]);
  });

  it("ignores deleted files", () => {
    const diff = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-x"].join("\n");
    assert.equal(parseAddedLines(diff).size, 0);
  });

  it("decodes quoted Git paths and clears the prior file on an unknown header", () => {
    const diff = [
      "diff --git a/first.go b/first.go",
      "--- a/first.go",
      "+++ b/first.go",
      "@@ -0,0 +1 @@",
      "+first",
      "diff --git a/tab\tname.go b/tab\tname.go",
      "--- a/tab\tname.go",
      String.raw`+++ "b/tab\tname.go"`,
      "@@ -0,0 +2 @@",
      "+tab",
      "diff --git a/café.md b/café.md",
      "--- a/café.md",
      String.raw`+++ "b/caf\303\251.md"`,
      "@@ -0,0 +3 @@",
      "+utf8",
      String.raw`diff --git a/quote\"slash\\file.go b/quote\"slash\\file.go`,
      String.raw`--- a/quote\"slash\\file.go`,
      String.raw`+++ "b/quote\"slash\\file.go"`,
      "@@ -0,0 +4 @@",
      "+escaped",
      'diff --git "a/space name.go" "b/space name.go"',
      '--- "a/space name.go"',
      '+++ "b/space name.go"\t2026-01-01',
      "@@ -0,0 +5 @@",
      "+space",
      "diff --git a/broken.go b/broken.go",
      "--- a/broken.go",
      String.raw`+++ "b/broken\q.go"`,
      "@@ -0,0 +6 @@",
      "+must not attach to previous file",
    ].join("\n");

    const lines = parseAddedLines(diff);
    assert.deepEqual(
      [...lines.keys()],
      ["first.go", "tab\tname.go", "café.md", 'quote"slash\\file.go', "space name.go"],
    );
    assert.deepEqual([...lines.get("first.go")], [1]);
    assert.deepEqual([...lines.get("tab\tname.go")], [2]);
    assert.deepEqual([...lines.get("café.md")], [3]);
    assert.deepEqual([...lines.get('quote"slash\\file.go')], [4]);
    assert.deepEqual([...lines.get("space name.go")], [5]);
  });
});

describe("validateResult", () => {
  const addedLines = new Map([["foo.go", new Set([10, 11, 12])]]);

  it("accepts a PASS with no suggestions", () => {
    const out = validateResult({ verdict: "PASS", reason: "clean" }, addedLines);
    assert.equal(out.verdict, "PASS");
    assert.deepEqual(out.accepted, []);
    assert.deepEqual(out.proseFallbacks, []);
    assert.deepEqual(out.rejected, []);
  });

  it("accepts a suggestion inside the diff", () => {
    const out = validateResult(
      {
        verdict: VERDICT.FAIL,
        reason: "missing log context",
        suggestions: [{ file: "foo.go", line: 11, comment: "add err", replacement: "x" }],
      },
      addedLines,
    );
    assert.equal(out.accepted.length, 1);
    assert.equal(out.accepted[0].start_line, 11);
  });

  it("rejects a suggestion for a file not in the diff", () => {
    const out = validateResult(
      {
        verdict: "FAIL",
        reason: "r",
        suggestions: [{ file: "other.go", line: 1, comment: "c" }],
      },
      addedLines,
    );
    assert.deepEqual(out.accepted, []);
    assert.match(out.rejected[0].why, /file not in diff/);
  });

  it("rejects a suggestion on an unchanged line", () => {
    const out = validateResult(
      {
        verdict: "FAIL",
        reason: "r",
        suggestions: [{ file: "foo.go", line: 99, comment: "c" }],
      },
      addedLines,
    );
    assert.deepEqual(out.accepted, []);
    assert.match(out.rejected[0].why, /not in the diff/);
  });

  it("keeps a finding as anchored prose when its range is partly outside the diff", () => {
    const out = validateResult(
      {
        verdict: "FAIL",
        reason: "r",
        suggestions: [
          {
            file: "foo.go",
            start_line: 9,
            line: 11,
            comment: "remove this dead binding",
            replacement: "",
          },
        ],
      },
      addedLines,
    );
    assert.deepEqual(out.accepted, [
      {
        file: "foo.go",
        start_line: 11,
        line: 11,
        comment: "remove this dead binding",
      },
    ]);
    assert.equal(out.rejected.length, 0);
    assert.match(out.proseFallbacks[0].why, /posted prose at line 11/);
  });

  it("keeps a finding as anchored prose when its start line is inverted", () => {
    const out = validateResult(
      {
        verdict: VERDICT.FAIL,
        reason: "r",
        suggestions: [{ file: "foo.go", start_line: 12, line: 10, comment: "c" }],
      },
      addedLines,
    );
    assert.equal(out.accepted[0].line, 10);
    assert.equal(out.accepted[0].start_line, 10);
    assert.equal(out.accepted[0].replacement, undefined);
    assert.match(out.proseFallbacks[0].why, /range 12-10/);
  });

  it("rejects a finding whose anchor line is outside the diff", () => {
    const out = validateResult(
      {
        verdict: VERDICT.FAIL,
        reason: "r",
        suggestions: [{ file: "foo.go", start_line: 10, line: 99, comment: "c" }],
      },
      addedLines,
    );
    assert.deepEqual(out.accepted, []);
    assert.deepEqual(out.proseFallbacks, []);
    assert.match(out.rejected[0].why, /anchor line 99/);
  });

  it("rejects an empty comment", () => {
    const out = validateResult(
      {
        verdict: "FAIL",
        reason: "r",
        suggestions: [{ file: "foo.go", line: 10, comment: "  " }],
      },
      addedLines,
    );
    assert.match(out.rejected[0].why, /empty comment/);
  });

  it("throws on a malformed verdict so the job can go neutral", () => {
    assert.throws(
      () => validateResult({ verdict: "MAYBE", reason: "r" }, addedLines),
      /invalid verdict/,
    );
  });

  it("throws on a missing reason", () => {
    assert.throws(() => validateResult({ verdict: "FAIL" }, addedLines), /missing a reason/);
  });

  it("throws on a non-object result", () => {
    assert.throws(() => validateResult(null, addedLines), /not an object/);
  });

  // Resolution moved to its own judge agent (history.validateResolutions), so
  // the main review schema no longer carries it -- a stale field from an old
  // prompt must not be silently honored.
  it("ignores a stray resolved_thread_ids field", () => {
    const out = validateResult(
      { verdict: "PASS", reason: "clean", resolved_thread_ids: ["T1"] },
      addedLines,
    );
    assert.equal(out.resolvedThreadIds, undefined);
    assert.deepEqual(Object.keys(out).sort(), [
      "accepted",
      "proseFallbacks",
      "reason",
      "rejected",
      "verdict",
    ]);
  });
});

describe("formatReviewComment", () => {
  it("emits a committable suggestion block when a replacement is given", () => {
    const comment = formatReviewComment({
      file: "foo.go",
      start_line: 10,
      line: 10,
      comment: "add context",
      replacement: 'log.Error("x", "err", err)',
    });
    assert.equal(comment.path, "foo.go");
    assert.equal(comment.line, 10);
    assert.equal(comment.start_line, undefined);
    assert.match(comment.body, /```suggestion\nlog\.Error/);
  });

  it("emits advisory prose with no replacement", () => {
    const comment = formatReviewComment({
      file: "foo.go",
      start_line: 10,
      line: 10,
      comment: "consider a table test",
    });
    assert.equal(comment.body, "consider a table test");
    assert.doesNotMatch(comment.body, /```suggestion/);
  });

  it("sets start_line only for a true multi-line range", () => {
    const comment = formatReviewComment({
      file: "foo.go",
      start_line: 8,
      line: 10,
      comment: "c",
    });
    assert.equal(comment.start_line, 8);
  });
});

describe("parseStructuredOutput", () => {
  it("returns an already-parsed object as-is", () => {
    const cli = { structured_output: { verdict: "PASS", reason: "clean" } };
    assert.deepEqual(parseStructuredOutput(cli), { verdict: "PASS", reason: "clean" });
  });

  it("JSON-parses a string structured_output", () => {
    const cli = { structured_output: '{"verdict":"FAIL","reason":"r"}' };
    assert.deepEqual(parseStructuredOutput(cli), { verdict: "FAIL", reason: "r" });
  });

  it("throws on a malformed string", () => {
    const cli = { structured_output: "{not json" };
    assert.throws(() => parseStructuredOutput(cli));
  });
});

describe("interpretResult", () => {
  it("returns ok with the structured_output object when present", () => {
    const cli = { subtype: "success", structured_output: { verdict: "PASS", reason: "clean" } };
    assert.deepEqual(interpretResult(cli), {
      outcome: INTERPRET_OUTCOME.OK,
      value: { verdict: "PASS", reason: "clean" },
    });
  });

  it("parses a stringified structured_output into ok", () => {
    const cli = { subtype: "success", structured_output: '{"verdict":"FAIL","reason":"r"}' };
    assert.deepEqual(interpretResult(cli), {
      outcome: INTERPRET_OUTCOME.OK,
      value: { verdict: "FAIL", reason: "r" },
    });
  });

  // Authored synthetic fixture for the CLI-success/no-structured-output case.
  it("is retryable when the CLI succeeded but the model skipped the tool call", () => {
    const cli = {
      subtype: "success",
      result: "The response omitted structured output.",
    };
    const interpreted = interpretResult(cli);
    assert.equal(interpreted.outcome, "retryable");
    assert.equal(interpreted.cause, NEUTRAL_CAUSE.INVALID_OUTPUT);
    assert.match(interpreted.value.error, /structured_output was missing/);
    assert.equal(interpreted.value.rawResult, cli.result);
  });

  it("is definite when structured_output is a string but not valid JSON", () => {
    // Distinct from the retryable "missing structured_output" case: here the
    // CLI did try to hand back structured output, it was just malformed --
    // a schema/serialization bug, not a skipped tool call, so a retry isn't
    // expected to help.
    const cli = { subtype: "success", structured_output: "{not json" };
    const interpreted = interpretResult(cli);
    assert.equal(interpreted.outcome, "definite");
    assert.equal(interpreted.cause, NEUTRAL_CAUSE.INVALID_OUTPUT);
  });

  it("recovers a verdict JSON literal embedded in prose as ok", () => {
    const cli = {
      subtype: "success",
      result: 'Verdict: {"verdict":"FAIL","reason":"bad enum usage"}',
    };
    assert.deepEqual(interpretResult(cli), {
      outcome: INTERPRET_OUTCOME.OK,
      value: { verdict: "FAIL", reason: "bad enum usage" },
    });
  });

  // The regex fallback used to stop at the first `}`, which truncates a
  // pretty-printed object -- the object's own closing brace is many lines
  // later, not right after "verdict".
  it("recovers a pretty-printed verdict JSON literal embedded in prose", () => {
    const cli = {
      subtype: "success",
      result: [
        "Here is my verdict:",
        "{",
        '  "verdict": "FAIL",',
        '  "reason": "bad enum usage"',
        "}",
      ].join("\n"),
    };
    assert.deepEqual(interpretResult(cli), {
      outcome: INTERPRET_OUTCOME.OK,
      value: { verdict: "FAIL", reason: "bad enum usage" },
    });
  });

  // Same failure mode: a `reason` string that itself contains a `}` used to
  // truncate the match before the real closing brace.
  it("recovers a verdict JSON literal whose reason string contains a closing brace", () => {
    const cli = {
      subtype: "success",
      result: 'Verdict: {"verdict":"FAIL","reason":"uses obj[key] instead of obj[key] }"}',
    };
    assert.deepEqual(interpretResult(cli), {
      outcome: INTERPRET_OUTCOME.OK,
      value: { verdict: "FAIL", reason: "uses obj[key] instead of obj[key] }" },
    });
  });

  it("is definite (not retryable) when the CLI itself errored", () => {
    const cli = { subtype: "error_max_turns" };
    const interpreted = interpretResult(cli);
    assert.equal(interpreted.outcome, "definite");
    assert.equal(interpreted.cause, NEUTRAL_CAUSE.INFRASTRUCTURE);
    assert.match(interpreted.value.error, /error_max_turns/);
  });

  it("is definite when is_error is true even with subtype success", () => {
    const cli = { subtype: "success", is_error: true };
    assert.equal(interpretResult(cli).outcome, "definite");
    assert.equal(interpretResult(cli).cause, NEUTRAL_CAUSE.INFRASTRUCTURE);
  });

  it("is definite for a null or non-object cli and marks it as infrastructure", () => {
    assert.equal(interpretResult(null).outcome, "definite");
    assert.equal(interpretResult(null).cause, NEUTRAL_CAUSE.INFRASTRUCTURE);
    assert.equal(interpretResult(undefined).outcome, "definite");
    assert.equal(interpretResult(undefined).cause, NEUTRAL_CAUSE.INFRASTRUCTURE);
  });

  it("is retryable when structured_output is an array, not an object", () => {
    const cli = { subtype: "success", structured_output: [1, 2, 3], result: "no verdict here" };
    assert.equal(interpretResult(cli).outcome, "retryable");
  });
});

describe("RESULT_SCHEMA", () => {
  it("requires verdict and reason and forbids extra keys", () => {
    assert.deepEqual(RESULT_SCHEMA.required, ["verdict", "reason"]);
    assert.equal(RESULT_SCHEMA.additionalProperties, false);
    assert.deepEqual(RESULT_SCHEMA.properties.verdict.enum, ["PASS", "FAIL"]);
  });

  // Resolution is the separate judge's job now; leaving the field here would
  // invite the review agent to resolve threads as a side effect of reviewing.
  it("no longer declares resolved_thread_ids", () => {
    assert.equal(RESULT_SCHEMA.properties.resolved_thread_ids, undefined);
  });
});

describe("RESOLUTION_SCHEMA", () => {
  it("requires resolutions and forbids extra keys", () => {
    assert.deepEqual(RESOLUTION_SCHEMA.required, ["resolutions"]);
    assert.equal(RESOLUTION_SCHEMA.additionalProperties, false);
  });

  // Evidence is required on every row, not just resolved ones: the audit
  // reply posted before resolving depends on the judge having justified it.
  it("requires thread_id, resolved, and evidence on every row", () => {
    const item = RESOLUTION_SCHEMA.properties.resolutions.items;
    assert.deepEqual(item.required, ["thread_id", "resolved", "evidence"]);
    assert.equal(item.additionalProperties, false);
    assert.equal(item.properties.thread_id.type, "string");
    assert.equal(item.properties.resolved.type, "boolean");
    assert.equal(item.properties.evidence.type, "string");
  });
});

describe("DEDUP_SCHEMA", () => {
  it("requires duplicate_indices and forbids extra keys", () => {
    assert.deepEqual(DEDUP_SCHEMA.required, ["duplicate_indices"]);
    assert.equal(DEDUP_SCHEMA.additionalProperties, false);
    assert.equal(DEDUP_SCHEMA.properties.duplicate_indices.items.type, "integer");
  });
});

// Exercises discovery end to end over an on-disk checks directory: a check
// with bad frontmatter, a duplicate display name, or unsupported intelligence
// would otherwise only fail once the workflow ran on a PR.
describe("fixture checks directory", () => {
  const files = fs
    .readdirSync(CHECKS_DIR)
    .filter(name => isCheckFile(name))
    .map(name => ({
      path: `.weave-checks/${name}`,
      text: fs.readFileSync(path.join(CHECKS_DIR, name), "utf8"),
    }));

  it("all parse and build a matrix", () => {
    const matrix = buildMatrix(files);
    assert.ok(matrix.length > 0, "expected at least one check");
    for (const entry of matrix) {
      assert.ok(
        SUPPORTED_INTELLIGENCE.has(entry.intelligence),
        `${entry.path}: ${entry.intelligence}`,
      );
      assert.ok(["haiku", "sonnet", "opus"].includes(entry.model), `${entry.path}: ${entry.model}`);
      assert.equal(entry.cluster, entry.intelligence);
    }
  });

  it("declares no version-pinned model or separate cluster field", () => {
    for (const { path: filePath, text } of files) {
      assert.doesNotMatch(text, /^model:/m, filePath);
      assert.doesNotMatch(text, /^cluster:/m, filePath);
      assert.match(text, /^intelligence: (low|medium|high|maximum)$/m, filePath);
    }
  });

  it("parses .ignore when present", () => {
    const ignorePath = path.join(CHECKS_DIR, ".ignore");
    if (!fs.existsSync(ignorePath)) return;
    const patterns = parseIgnoreList(fs.readFileSync(ignorePath, "utf8"));
    assert.deepEqual(patterns, ["vendor", "generated/api/*.pb.go"]);
  });
});

const SHA = "7d723791c13464f0e66dc2dafe107aef40a22c06";
const CHECK_DIGEST = "b".repeat(64);

describe("checkSetDigest", () => {
  it("is order-independent and changes with criteria or model selection", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weave-check-set-"));
    try {
      fs.writeFileSync(path.join(dir, "a.md"), "criteria a\n");
      fs.writeFileSync(path.join(dir, "b.md"), "criteria b\n");
      const checks = [
        { slug: "a", intelligence: "low", model: "haiku", path: "a.md" },
        { slug: "b", intelligence: "medium", model: "sonnet", path: "b.md" },
      ];
      const digest = checkSetDigest(checks, dir);
      assert.equal(checkSetDigest([...checks].reverse(), dir), digest);

      fs.writeFileSync(path.join(dir, "a.md"), "updated criteria a\n");
      assert.notEqual(checkSetDigest(checks, dir), digest);
      assert.notEqual(
        checkSetDigest(
          checks.map(check => ({ ...check, model: "opus" })),
          dir,
        ),
        digest,
      );
      assert.notEqual(
        checkSetDigest(
          checks.map((check, index) => (index === 0 ? { ...check, files: "src/**" } : check)),
          dir,
        ),
        digest,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatReviewedMarker", () => {
  it("embeds the sha and check-set digest behind a stable prefix", () => {
    assert.equal(formatReviewedMarker(SHA, CHECK_DIGEST), `reviewed:${SHA}:${CHECK_DIGEST}`);
  });
});

describe("everyCheckReviewed", () => {
  const states = (...outcomes) => outcomes.map(outcome => ({ outcome }));

  it("is true when every check passed", () => {
    assert.ok(everyCheckReviewed(states(OUTCOME.PASS, OUTCOME.PASS)));
  });

  // The case the conclusion cannot express: a FAIL verdict publishes as
  // `neutral` like a crash does, but it IS a completed review, and it is the
  // ordinary state of a fix iteration. Treating it as unreviewed would keep
  // the base pinned on exactly the PRs this feature exists for.
  it("is true when checks passed and flagged", () => {
    assert.ok(everyCheckReviewed(states(OUTCOME.PASS, OUTCOME.FAIL)));
  });

  it("is false when any check was neutral", () => {
    assert.equal(everyCheckReviewed(states(OUTCOME.PASS, OUTCOME.NEUTRAL)), false);
  });

  // The coordinator-crashed case: no check run was ever created, so nothing
  // read the diff. This is the load-bearing guard -- everything else here is
  // a state the caller (updateMaster, over [...states.values()]) guarantees.
  it("is false for no checks at all", () => {
    assert.equal(everyCheckReviewed([]), false);
  });

  it("is false for a state carrying no outcome", () => {
    assert.equal(everyCheckReviewed([{ outcome: OUTCOME.PASS }, {}]), false);
  });
});
