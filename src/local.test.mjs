import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  CLUSTER_LOW,
  CLUSTER_MEDIUM,
  MODEL_HAIKU,
  MODEL_SONNET,
  OUTCOME,
  RESULT_SCHEMA,
} from "./parse.mjs";
import { positiveInteger, readConfig, runChecks } from "./local.mjs";

const DIFF = [
  "diff --git a/app/main.go b/app/main.go",
  "--- a/app/main.go",
  "+++ b/app/main.go",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  "",
].join("\n");

const STAT = " app/main.go | 2 ++";

const CHECKS = [
  {
    slug: "first-check",
    name: "First Check",
    description: "Flags firsts",
    intelligence: CLUSTER_LOW,
    model: MODEL_HAIKU,
    cluster: CLUSTER_LOW,
    path: ".weave-checks/first-check.md",
  },
  {
    slug: "second-check",
    name: "Second Check",
    description: "Flags seconds",
    intelligence: CLUSTER_MEDIUM,
    model: MODEL_SONNET,
    cluster: CLUSTER_MEDIUM,
    path: ".weave-checks/second-check.md",
  },
];

// Every root fixture() hands out, so the single after() hook below can reclaim
// them. A per-test t.after() would need the test context threaded through all
// eleven call sites (several of which call fixture() inline inside an
// assertion), and these dirs are a few KB each -- one sweep at the end of the
// file is enough to stop them accumulating in os.tmpdir() across runs.
const FIXTURE_ROOTS = [];

after(() => {
  for (const root of FIXTURE_ROOTS) {
    rmSync(root, { recursive: true, force: true });
  }
  FIXTURE_ROOTS.length = 0;
});

// Writes the files the CLI wrapper prepares before invoking local.mjs, and
// returns the env it would pass.
function fixture(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "weave-checks-local-"));
  FIXTURE_ROOTS.push(root);
  const tempDir = path.join(root, "artifacts");
  mkdirSync(tempDir);
  const write = (name, contents) => {
    const target = path.join(root, name);
    writeFileSync(target, contents);
    return target;
  };
  return {
    root,
    tempDir,
    env: {
      REPO_DIR: root,
      TEMP_DIR: tempDir,
      OUTPUT_PATH: path.join(tempDir, "results.json"),
      MATRIX_PATH: write("matrix.json", JSON.stringify({ check: CHECKS })),
      DIFF_PATH: write("pr.diff", DIFF),
      STAT_PATH: write("pr.stat", STAT),
      SCHEMA_PATH: write("schema.json", '{"type":"object"}'),
      ...overrides,
    },
  };
}

describe("positiveInteger", () => {
  it("falls back for anything that is not a positive integer", () => {
    assert.equal(positiveInteger("8", 4), 8);
    assert.equal(positiveInteger(undefined, 4), 4);
    assert.equal(positiveInteger("0", 4), 4);
    assert.equal(positiveInteger("-2", 4), 4);
    assert.equal(positiveInteger("2.5", 4), 4);
    assert.equal(positiveInteger("many", 4), 4);
  });
});

describe("readConfig", () => {
  it("reads the diff, stat, schema, and check matrix the CLI prepared", () => {
    const { env, tempDir } = fixture();

    const config = readConfig(env);

    assert.equal(config.tempDir, tempDir);
    assert.equal(config.diff, DIFF);
    assert.equal(config.stat, STAT);
    assert.equal(config.schemaText, '{"type":"object"}');
    assert.deepEqual(
      config.checks.map(check => check.slug),
      ["first-check", "second-check"],
    );
  });

  it("defaults the parallel bound and honours an explicit one", () => {
    assert.equal(readConfig(fixture().env).parallel, 4);
    assert.equal(readConfig(fixture({ PARALLEL: "12" }).env).parallel, 12);
    // A nonsense value must not become a zero-worker pool that silently runs
    // no checks at all.
    assert.equal(readConfig(fixture({ PARALLEL: "0" }).env).parallel, 4);
  });

  it("defaults to the inherit provider and needs no Weave key", () => {
    assert.equal(readConfig(fixture().env).provider.id, "inherit");
  });

  it("builds the anthropic provider with its env overlay and no Weave key", () => {
    const { provider } = readConfig(
      fixture({
        WEAVE_CHECKS_PROVIDER: "anthropic",
        WEAVE_CHECKS_PROVIDER_ENV: "ANTHROPIC_BASE_URL=https://gateway.example.com",
      }).env,
    );
    assert.equal(provider.id, "anthropic");
    assert.deepEqual(provider.envFor({}), { ANTHROPIC_BASE_URL: "https://gateway.example.com" });
  });

  it("requires only a Router key for weave-router", () => {
    assert.throws(
      () => readConfig(fixture({ WEAVE_CHECKS_PROVIDER: "weave-router" }).env),
      /requires WEAVE_ROUTER_KEY/,
    );
    const config = readConfig(
      fixture({ WEAVE_CHECKS_PROVIDER: "weave-router", WEAVE_ROUTER_KEY: "rk" }).env,
    );
    assert.equal(config.provider.id, "weave-router");
  });

  it("defaults the schema to the packaged result schema", () => {
    const { env } = fixture();
    delete env.SCHEMA_PATH;
    assert.equal(readConfig(env).schemaText, JSON.stringify(RESULT_SCHEMA));
  });

  it("fails loudly on a missing required path", () => {
    const { env } = fixture();
    for (const name of ["REPO_DIR", "TEMP_DIR", "OUTPUT_PATH", "DIFF_PATH"]) {
      const incomplete = { ...env, [name]: "" };
      assert.throws(() => readConfig(incomplete), new RegExp(`Missing ${name}`));
    }
  });
});

describe("runChecks", () => {
  function passResult(reason) {
    return {
      outcome: OUTCOME.PASS,
      reason,
      accepted: [],
      rejected: [],
      cost: 0.02,
      duration: 1200,
    };
  }

  it("runs every check and shapes the summary the CLI renders", async () => {
    const { env, tempDir } = fixture();
    const config = readConfig(env);
    const seen = [];

    const summary = await runChecks(config, {
      evaluate: async ({
        check,
        diff,
        stat,
        addedLines,
        settingSources,
        settingsPath,
        provider,
      }) => {
        seen.push({ slug: check.slug, settingSources, settingsPath, provider });
        assert.equal(diff, DIFF);
        assert.equal(stat, STAT);
        // The diff is parsed once and shared, so a suggestion's line can be
        // validated against exactly the lines this diff added.
        assert.deepEqual([...addedLines.get("app/main.go")], [1, 2]);
        return check.slug === "first-check" ?
            {
              outcome: OUTCOME.FAIL,
              reason: "line one is bad",
              accepted: [
                {
                  file: "app/main.go",
                  line: 1,
                  start_line: 1,
                  comment: "rename this",
                  replacement: "uno",
                },
              ],
              rejected: [
                { suggestion: { file: "other.go", line: 9 }, why: "file not in diff: other.go" },
              ],
              cost: 0.05,
              duration: 3000,
            }
          : passResult("nothing to flag");
      },
    });

    assert.deepEqual(
      seen.map(entry => entry.slug),
      ["first-check", "second-check"],
    );
    // Under the default inherit provider, local runs must load the engineer's
    // own Claude settings and inject no env of their own.
    assert.deepEqual(seen[0].settingSources, null);
    assert.equal(seen[0].settingsPath, null);
    assert.equal(seen[0].provider.id, "inherit");
    assert.deepEqual(seen[0].provider.envFor({}), {});
    assert.equal(summary.provider, "inherit");
    assert.equal(summary.costLabel, "client-reported cost");

    const [first, second] = summary.checks;
    assert.equal(first.slug, "first-check");
    assert.equal(first.name, "First Check");
    assert.equal(first.outcome, "flagged");
    assert.deepEqual(first.suggestions, [
      {
        file: "app/main.go",
        line: 1,
        start_line: 1,
        comment: "rename this",
        replacement: "uno",
      },
    ]);
    assert.deepEqual(first.proseFallbacks, []);
    assert.deepEqual(first.rejected, [
      { file: "other.go", line: 9, why: "file not in diff: other.go" },
    ]);
    assert.equal(second.outcome, OUTCOME.PASS);
    assert.equal(second.error, null);

    assert.deepEqual(summary.totals, {
      pass: 1,
      flagged: 1,
      neutral: 0,
      cost: 0.07,
      durationMs: 4200,
    });

    // Per-check artifacts land under the same <slug>.<suffix> naming CI uses.
    const artifact = JSON.parse(
      readFileSync(path.join(tempDir, "first-check.result.json"), "utf8"),
    );
    assert.equal(artifact.reason, "line one is bad");
  });

  it("skips checks without matching changed files and scopes matching diff and stat", async () => {
    const { env, tempDir } = fixture();
    const config = readConfig(env);
    const backendDiff = [
      DIFF.trimEnd(),
      "diff --git a/backend/api.go b/backend/api.go",
      "--- a/backend/api.go",
      "+++ b/backend/api.go",
      "@@ -0,0 +1 @@",
      "+backend change",
      "",
    ].join("\n");
    config.diff = backendDiff;
    config.stat = "app/main.go | 2 ++\nbackend/api.go | 1 +";
    config.checks = [
      { ...CHECKS[0], files: "app/**" },
      { ...CHECKS[1], files: "db/**" },
    ];
    const seen = [];

    const summary = await runChecks(config, {
      evaluate: async ({ check, diff, stat }) => {
        seen.push(check.slug);
        assert.match(diff, /app\/main\.go/);
        assert.doesNotMatch(diff, /backend\/api\.go|backend change/);
        assert.match(stat, /app\/main\.go/);
        assert.doesNotMatch(stat, /backend\/api\.go/);
        return passResult("scoped");
      },
    });

    assert.deepEqual(seen, ["first-check"]);
    assert.equal(summary.checks[1].outcome, "pass");
    assert.match(summary.checks[1].reason, /No changed files match db\/\*\*/);
    assert.equal(
      JSON.parse(readFileSync(path.join(tempDir, "second-check.result.json"), "utf8")).cost,
      0,
    );
  });

  it("uses each check's intelligence as the generated settings filename", async () => {
    const { env, tempDir } = fixture();
    env.SETTINGS_DIR = path.join(tempDir, "settings");
    const config = readConfig(env);
    const seen = [];

    await runChecks(config, {
      evaluate: async ({ check, settingsPath, dropEnv }) => {
        seen.push({ intelligence: check.intelligence, settingsPath, dropEnv });
        return passResult("fine");
      },
    });

    assert.deepEqual(
      seen.map(({ intelligence, settingsPath }) => [intelligence, settingsPath]),
      [
        ["low", path.join(config.settingsDir, "settings-low.json")],
        ["medium", path.join(config.settingsDir, "settings-medium.json")],
      ],
    );
    assert.deepEqual(seen[0].dropEnv, [
      "WEAVE_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_CUSTOM_HEADERS",
    ]);
  });

  it("isolates an explicit provider from the engineer's settings", async () => {
    const config = readConfig(fixture({ WEAVE_CHECKS_PROVIDER: "anthropic" }).env);
    const seen = [];

    await runChecks(config, {
      evaluate: async ({ settingSources }) => {
        seen.push(settingSources);
        return passResult("fine");
      },
    });

    assert.deepEqual(seen, ["", ""]);
  });

  it("reports a thrown check as its own neutral outcome without abandoning the rest", async () => {
    const config = readConfig(fixture().env);

    const summary = await runChecks(config, {
      evaluate: async ({ check }) => {
        if (check.slug === "first-check") throw new Error("check file unreadable");
        return passResult("fine");
      },
    });

    const [first, second] = summary.checks;
    assert.equal(first.outcome, OUTCOME.NEUTRAL);
    assert.equal(first.error, "check file unreadable");
    assert.equal(first.cost, null);
    assert.equal(second.outcome, OUTCOME.PASS);
    assert.equal(summary.totals.neutral, 1);
    // One unpriced check makes the whole total unknown rather than reporting a
    // partial sum as if it were complete.
    assert.equal(summary.totals.cost, null);
  });

  it("never exceeds the configured parallel bound", async () => {
    const config = { ...readConfig(fixture({ PARALLEL: "1" }).env) };
    let inFlight = 0;
    let peak = 0;

    await runChecks(config, {
      evaluate: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight -= 1;
        return passResult("fine");
      },
    });

    assert.equal(peak, 1);
  });
});
