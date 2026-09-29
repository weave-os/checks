import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESULT_SCHEMA,
  DEDUP_SCHEMA,
  GENERIC_POLICY,
  MODEL_HAIKU_45,
  MODEL_OPUS_4_8,
  MODEL_OPUS_5,
  MODEL_SONNET_4_6,
  MODEL_SONNET_5,
  WEAVE_POLICY,
  policyFrom,
  RESOLUTION_SCHEMA,
  SUPPORTED_CLUSTERS,
  SUPPORTED_MODELS,
  VERDICT,
  buildMatrix,
  everyCheckReviewed,
  formatReviewedMarker,
  formatReviewComment,
  interpretResult,
  INTERPRET_OUTCOME,
  ignorePathspecs,
  isCheckFile,
  parseIgnoreList,
  OUTCOME,
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
model: claude-haiku-4-5
cluster: low
---

Body text.
`;

function file(text, filePath = ".weave-checks/example.md") {
  return { path: filePath, text };
}

describe("parseCheckFile", () => {
  it("parses a valid check", () => {
    const check = parseCheckFile(VALID, ".weave-checks/example.md");
    assert.equal(check.slug, "example");
    assert.equal(check.name, "Example Check");
    assert.equal(check.description, "Does a thing");
    assert.equal(check.model, "claude-haiku-4-5");
    assert.equal(check.cluster, "low");
    assert.equal(check.body.trim(), "Body text.");
  });

  it("rejects a file with no frontmatter", () => {
    assert.throws(
      () => parseCheckFile("Just a body.\n", ".weave-checks/x.md"),
      /missing frontmatter/,
    );
  });

  for (const key of ["name", "description", "model", "cluster"]) {
    it(`rejects frontmatter missing ${key}`, () => {
      const text = VALID.split("\n")
        .filter((line) => !line.startsWith(`${key}:`))
        .join("\n");
      assert.throws(
        () => parseCheckFile(text, ".weave-checks/x.md"),
        new RegExp(`missing required key "${key}"`),
      );
    });
  }

  it("rejects an unsupported model", () => {
    const text = VALID.replace("claude-haiku-4-5", "gpt-4o");
    assert.throws(() => parseCheckFile(text, ".weave-checks/x.md"), /unsupported model/);
  });

  it("rejects an unsupported cluster", () => {
    const text = VALID.replace("cluster: low", "cluster: explore");
    assert.throws(() => parseCheckFile(text, ".weave-checks/x.md"), /unsupported cluster/);
  });

  it("supports only the live production routing clusters", () => {
    assert.deepEqual([...SUPPORTED_CLUSTERS].sort(), ["high", "low", "maximum", "medium"]);
  });

  it("rejects an empty body", () => {
    const text = `---\nname: X\ndescription: Y\nmodel: claude-haiku-4-5\ncluster: low\n---\n\n\n`;
    assert.throws(() => parseCheckFile(text, ".weave-checks/x.md"), /body is empty/);
  });

  it("rejects duplicate frontmatter keys", () => {
    const text = VALID.replace("description: Does a thing", "description: A\ndescription: B");
    assert.throws(() => parseCheckFile(text, ".weave-checks/x.md"), /duplicate frontmatter key/);
  });

  it("rejects unknown frontmatter keys", () => {
    const text = VALID.replace("model: claude-haiku-4-5", "model: claude-haiku-4-5\nowner: platform");
    assert.throws(() => parseCheckFile(text, ".weave-checks/x.md"), /unknown frontmatter key "owner"/);
  });

  it("includes the file path in errors", () => {
    assert.throws(() => parseCheckFile("nope", ".weave-checks/broken.md"), /\.weave-checks\/broken\.md/);
  });
});

describe("parseCheckFile policies", () => {
  const WITHOUT_ROUTING = `---\nname: Bare\ndescription: No routing keys\n---\n\nBody.\n`;

  it("keeps the Weave Router model list pinned", () => {
    // The self-check workflow and any Weave adopter depend on this exact set;
    // widening it is a deliberate change, not a side effect of a refactor.
    assert.deepEqual(
      [...SUPPORTED_MODELS].sort(),
      [MODEL_HAIKU_45, MODEL_OPUS_4_8, MODEL_OPUS_5, MODEL_SONNET_4_6, MODEL_SONNET_5].sort(),
    );
    assert.equal(WEAVE_POLICY.allowedModels, SUPPORTED_MODELS);
    assert.equal(WEAVE_POLICY.requireCluster, true);
  });

  it("defaults to the Weave policy", () => {
    assert.throws(() => parseCheckFile(WITHOUT_ROUTING, "checks/bare.md"), /missing required key "model"/);
  });

  it("serializes absent model and cluster as null under the generic policy", () => {
    const check = parseCheckFile(WITHOUT_ROUTING, "checks/bare.md", GENERIC_POLICY);
    assert.equal(check.model, null);
    assert.equal(check.cluster, null);
    const [entry] = buildMatrix([file(WITHOUT_ROUTING, "checks/bare.md")], GENERIC_POLICY);
    assert.ok(Object.hasOwn(entry, "cluster"));
    assert.equal(entry.cluster, null);
  });

  it("applies the policy's default model to a check that declares none", () => {
    const policy = policyFrom({ defaultModel: "claude-sonnet-4-5" });
    assert.equal(parseCheckFile(WITHOUT_ROUTING, "checks/bare.md", policy).model, "claude-sonnet-4-5");
  });

  it("accepts any well-formed model without an allowlist", () => {
    for (const model of ["claude-sonnet-4-5", "us.anthropic.claude-opus-4-1-v1:0", "sonnet"]) {
      const text = VALID.replace("claude-haiku-4-5", model);
      assert.equal(parseCheckFile(text, "checks/x.md", GENERIC_POLICY).model, model);
    }
  });

  it("rejects a malformed model without an allowlist", () => {
    for (const model of ["-flag", "two words", "bad\u0000byte"]) {
      const text = VALID.replace("claude-haiku-4-5", model);
      assert.throws(() => parseCheckFile(text, "checks/x.md", GENERIC_POLICY), /malformed model name/);
    }
  });

  it("names the fix for a Continue-style provider-prefixed model", () => {
    const text = VALID.replace("claude-haiku-4-5", "anthropic/claude-haiku-4-5");
    for (const policy of [WEAVE_POLICY, GENERIC_POLICY]) {
      assert.throws(
        () => parseCheckFile(text, "checks/x.md", policy),
        /uses a provider prefix; write the bare Claude model name \(e\.g\. "claude-haiku-4-5"\)/,
      );
    }
  });

  it("enforces caller-supplied allowlists", () => {
    const policy = policyFrom({ allowedModels: ["claude-sonnet-4-5"], allowedClusters: ["fast"] });
    assert.throws(() => parseCheckFile(VALID, "checks/x.md", policy), /unsupported model "claude-haiku-4-5" \(allowed: claude-sonnet-4-5\)/);
    const ok = VALID.replace("claude-haiku-4-5", "claude-sonnet-4-5").replace("cluster: low", "cluster: fast");
    assert.equal(parseCheckFile(ok, "checks/x.md", policy).cluster, "fast");
  });

  it("requires a cluster when the policy says so", () => {
    const text = VALID.split("\n").filter((line) => !line.startsWith("cluster:")).join("\n");
    assert.throws(() => parseCheckFile(text, "checks/x.md", policyFrom({ requireCluster: true })), /missing required key "cluster"/);
  });

  it("rejects a malformed cluster without an allowlist", () => {
    const text = VALID.replace("cluster: low", "cluster: Low Tier");
    assert.throws(() => parseCheckFile(text, "checks/x.md", GENERIC_POLICY), /malformed cluster name/);
  });

  it("rejects a default model outside the allowlist", () => {
    assert.throws(
      () => policyFrom({ allowedModels: ["claude-sonnet-4-5"], defaultModel: "claude-haiku-4-5" }),
      /unsupported model/,
    );
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

describe("buildMatrix provider validation", () => {
  it("fails discovery with the provider's error and the offending path", () => {
    const noCluster = VALID.split("\n").filter((line) => !line.startsWith("cluster:")).join("\n");
    const validateCheck = (check) => (check.cluster === null ? "requires a cluster" : null);
    assert.throws(
      () => buildMatrix([file(noCluster, "checks/a.md")], GENERIC_POLICY, validateCheck),
      /checks\/a\.md: requires a cluster/,
    );
    assert.equal(buildMatrix([file(VALID, "checks/a.md")], GENERIC_POLICY, validateCheck).length, 1);
  });
});

describe("parseIgnoreList", () => {
  it("skips comments, blanks, and trailing slashes", () => {
    assert.deepEqual(
      parseIgnoreList("# research\n\nresearch/\n  vendor  \n"),
      ["research", "vendor"],
    );
  });

  it("treats an empty file as no exclusions", () => {
    assert.deepEqual(parseIgnoreList(""), []);
    assert.deepEqual(parseIgnoreList("# only a comment\n"), []);
  });

  it("accepts wildcards below a literal directory prefix", () => {
    assert.deepEqual(
      parseIgnoreList("server/internal/db/*.sql.go\nvendor/?/generated[0-9].go\n"),
      ["server/internal/db/*.sql.go", "vendor/?/generated[0-9].go"],
    );
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
      buildMatrix([b, a]).map((entry) => entry.slug),
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
    assert.deepEqual([...lines.get("foo.go")].sort((a, b) => a - b), [11, 12, 33]);
  });

  it("handles a single-line hunk with no count", () => {
    const diff = ["+++ b/a.ts", "@@ -1 +5 @@", "+x"].join("\n");
    assert.deepEqual([...parseAddedLines(diff).get("a.ts")], [5]);
  });

  it("tracks multiple files independently", () => {
    const diff = [
      "+++ b/a.ts",
      "@@ -0,0 +1,1 @@",
      "+a",
      "+++ b/b.ts",
      "@@ -0,0 +7,1 @@",
      "+b",
    ].join("\n");
    const lines = parseAddedLines(diff);
    assert.deepEqual([...lines.get("a.ts")], [1]);
    assert.deepEqual([...lines.get("b.ts")], [7]);
  });

  it("ignores deleted files", () => {
    const diff = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-x"].join("\n");
    assert.equal(parseAddedLines(diff).size, 0);
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
        suggestions: [
          { file: "foo.go", start_line: 10, line: 99, comment: "c" },
        ],
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
    assert.throws(() => validateResult({ verdict: "MAYBE", reason: "r" }, addedLines), /invalid verdict/);
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
    const out = validateResult({ verdict: "PASS", reason: "clean", resolved_thread_ids: ["T1"] }, addedLines);
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
    assert.deepEqual(interpretResult(cli), { outcome: INTERPRET_OUTCOME.OK, value: { verdict: "PASS", reason: "clean" } });
  });

  it("parses a stringified structured_output into ok", () => {
    const cli = { subtype: "success", structured_output: '{"verdict":"FAIL","reason":"r"}' };
    assert.deepEqual(interpretResult(cli), { outcome: INTERPRET_OUTCOME.OK, value: { verdict: "FAIL", reason: "r" } });
  });

  // This is the exact shape from the neutral run on PR #11658
  // (.weave-checks/enum-type-safety.md): subtype=success, no structured_output,
  // the model narrated the tool call in prose instead of making it.
  it("is retryable when the CLI succeeded but the model skipped the tool call", () => {
    const cli = {
      subtype: "success",
      result: "I have already called the **StructuredOutput** tool in my response above.",
    };
    const interpreted = interpretResult(cli);
    assert.equal(interpreted.outcome, "retryable");
    assert.match(interpreted.value.error, /structured_output was missing/);
    assert.equal(interpreted.value.rawResult, cli.result);
  });

  it("is definite when structured_output is a string but not valid JSON", () => {
    // Distinct from the retryable "missing structured_output" case: here the
    // CLI did try to hand back structured output, it was just malformed --
    // a schema/serialization bug, not a skipped tool call, so a retry isn't
    // expected to help.
    const cli = { subtype: "success", structured_output: "{not json" };
    assert.equal(interpretResult(cli).outcome, "definite");
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
    assert.match(interpreted.value.error, /error_max_turns/);
  });

  it("is definite when is_error is true even with subtype success", () => {
    const cli = { subtype: "success", is_error: true };
    assert.equal(interpretResult(cli).outcome, "definite");
  });

  it("is definite for a null or non-object cli", () => {
    assert.equal(interpretResult(null).outcome, "definite");
    assert.equal(interpretResult(undefined).outcome, "definite");
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
// with bad frontmatter, a duplicate display name, or an unsupported model
// would otherwise only fail once the workflow ran on a PR.
describe("fixture checks directory", () => {
  const files = fs
    .readdirSync(CHECKS_DIR)
    .filter((name) => isCheckFile(name))
    .map((name) => ({
      path: `.weave-checks/${name}`,
      text: fs.readFileSync(path.join(CHECKS_DIR, name), "utf8"),
    }));

  it("all parse and build a matrix", () => {
    const matrix = buildMatrix(files);
    assert.ok(matrix.length > 0, "expected at least one check");
    for (const entry of matrix) {
      assert.ok(SUPPORTED_MODELS.has(entry.model), `${entry.path}: ${entry.model}`);
      assert.ok(SUPPORTED_CLUSTERS.has(entry.cluster), `${entry.path}: ${entry.cluster}`);
    }
  });

  it("declares no Continue-style model names", () => {
    for (const { path: filePath, text } of files) {
      assert.doesNotMatch(text, /^model:\s*anthropic\//m, filePath);
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

describe("formatReviewedMarker", () => {
  // Both sides of the marker contract read this function: the worker writes
  // its result to the aggregate's external_id, and the workflow formats the
  // expected value from it via `node -e` rather than hardcoding the prefix in
  // bash. A silent change here stops the review base narrowing, so pin it.
  it("embeds the sha behind a stable prefix", () => {
    assert.equal(formatReviewedMarker(SHA), `reviewed:${SHA}`);
  });
});

describe("everyCheckReviewed", () => {
  const states = (...outcomes) => outcomes.map((outcome) => ({ outcome }));

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
