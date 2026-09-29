import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, it } from "node:test";

import { CLI_RESULT_SUBTYPE, CLUSTER_LOW, MODEL_HAIKU, OUTCOME, VERDICT } from "./parse.mjs";
import {
  evaluateCheck,
  formatDuration,
  formatUsd,
  normalize,
  promptFor,
  runClaude,
  runPool,
  totalCost,
  totalDuration,
  validateAndFinalize,
} from "./runner.mjs";

const CHECK = {
  slug: "demo-check",
  name: "Demo Check",
  description: "Flags demo violations",
  intelligence: CLUSTER_LOW,
  model: MODEL_HAIKU,
  cluster: CLUSTER_LOW,
  path: ".weave-checks/demo-check.md",
};

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
const SCHEMA_TEXT = '{"type":"object"}';

// Env vars the fake CLI below writes its observations into, so a test can
// assert on the argv, environment, and stdin the real CLI would have seen.
const ARGV_OUT = "WEAVE_CHECKS_TEST_ARGV_OUT";
const ENV_OUT = "WEAVE_CHECKS_TEST_ENV_OUT";
const STDIN_OUT = "WEAVE_CHECKS_TEST_STDIN_OUT";
const STREAM_PREFIX = "WEAVE_CHECKS_TEST_STREAM_PREFIX";
const COUNT_FILE = "WEAVE_CHECKS_TEST_COUNT_FILE";
const EXIT_CODE = "WEAVE_CHECKS_TEST_EXIT_CODE";

const originalPath = process.env.PATH;
const testEnvNames = [ARGV_OUT, ENV_OUT, STDIN_OUT, STREAM_PREFIX, COUNT_FILE, EXIT_CODE];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const name of testEnvNames) delete process.env[name];
});

// Builds a scratch workspace holding a fake `claude` on PATH. The shim records
// what it was invoked with and replays the stream-json lines the test queued
// for that call, which is the only way to assert the real argv and child
// environment without spending money on an actual agent call.
function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "weave-checks-runner-"));
  const bin = path.join(root, "bin");
  const tempDir = path.join(root, "temp");
  const repoDir = path.join(root, "repo");
  mkdirSync(bin);
  mkdirSync(tempDir);
  mkdirSync(path.join(repoDir, ".weave-checks"), { recursive: true });
  writeFileSync(path.join(repoDir, CHECK.path), "Flag any line that says one.\n");

  writeFileSync(
    path.join(bin, "claude"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > "$${ARGV_OUT}"`,
      `env > "$${ENV_OUT}"`,
      `cat > "$${STDIN_OUT}"`,
      // Replay the stream queued for this call number, falling back to the
      // first one so a test that only queues one stream can be called twice.
      `count=$(cat "$${COUNT_FILE}" 2>/dev/null || echo 0)`,
      "count=$((count + 1))",
      `printf '%s\\n' "$count" > "$${COUNT_FILE}"`,
      `stream="$${STREAM_PREFIX}.$count.jsonl"`,
      `[ -f "$stream" ] || stream="$${STREAM_PREFIX}.1.jsonl"`,
      'cat "$stream"',
      `exit "\${${EXIT_CODE}:-0}"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  process.env[ARGV_OUT] = path.join(root, "argv.txt");
  process.env[ENV_OUT] = path.join(root, "env.txt");
  process.env[STDIN_OUT] = path.join(root, "stdin.txt");
  process.env[STREAM_PREFIX] = path.join(root, "stream");
  process.env[COUNT_FILE] = path.join(root, "count.txt");

  return {
    root,
    repoDir,
    tempDir,
    // Queues one stream per invocation, in order.
    stream(...streams) {
      streams.forEach((lines, index) => {
        writeFileSync(`${process.env[STREAM_PREFIX]}.${index + 1}.jsonl`, `${lines.join("\n")}\n`);
      });
    },
    callCount() {
      return Number(readFileSync(process.env[COUNT_FILE], "utf8").trim());
    },
    argv() {
      return readFileSync(process.env[ARGV_OUT], "utf8").split("\n").slice(0, -1);
    },
    childEnv() {
      const entries = new Map();
      for (const line of readFileSync(process.env[ENV_OUT], "utf8").split("\n")) {
        const separator = line.indexOf("=");
        if (separator > 0) entries.set(line.slice(0, separator), line.slice(separator + 1));
      }
      return entries;
    },
    stdin() {
      return readFileSync(process.env[STDIN_OUT], "utf8");
    },
  };
}

function successEvents(structuredOutput) {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
    JSON.stringify({
      type: "result",
      subtype: CLI_RESULT_SUBTYPE.SUCCESS,
      is_error: false,
      session_id: "sess-1",
      structured_output: structuredOutput,
      num_turns: 4,
      duration_ms: 2500,
    }),
  ];
}

// A clean session that never called the structured-output tool -- the one
// neutral cause evaluateCheck() is allowed to retry.
function proseOnlyEvents() {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "sess-a" }),
    JSON.stringify({
      type: "result",
      subtype: CLI_RESULT_SUBTYPE.SUCCESS,
      is_error: false,
      session_id: "sess-a",
      result: "prose only, no tool call",
      num_turns: 1,
      duration_ms: 100,
    }),
  ];
}

function fakeProvider(overrides = {}) {
  return {
    id: "fake",
    costLabel: "fake cost",
    dropEnv: [],
    envFor: () => ({}),
    resolveCost: () => ({ cost: null, error: null }),
    ...overrides,
  };
}

function invoke(space, overrides = {}) {
  return runClaude({
    slug: CHECK.slug,
    suffix: "claude",
    model: CHECK.model,
    schemaText: SCHEMA_TEXT,
    promptText: "review this",
    repoDir: space.repoDir,
    tempDir: space.tempDir,
    ...overrides,
  });
}

describe("runClaude", () => {
  it("invokes the CLI with the stream-json review argv", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));

    const invocation = await invoke(space);

    const argv = space.argv();
    assert.deepEqual(argv.slice(0, 9), [
      "-p",
      "--model",
      CHECK.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      SCHEMA_TEXT,
      "--permission-mode",
    ]);
    assert.ok(argv.includes("dontAsk"));
    assert.ok(argv.includes("--allowedTools"));
    assert.ok(argv.includes("Bash(git diff *)"));
    assert.ok(argv.includes("--no-session-persistence"));
    assert.ok(!argv.includes("--max-budget-usd"));
    assert.equal(invocation.code, 0);
    assert.equal(invocation.sessionId, "sess-1");
    assert.equal(space.childEnv().get("WEAVE_PROMPT_INITIATOR"), "automation");
    // The prompt is delivered on stdin, not as an argv positional -- a diff
    // routinely exceeds the platform's argv limit.
    assert.equal(space.stdin(), "review this");
  });

  it("omits --setting-sources when the caller passes null and forwards it otherwise", async () => {
    const local = workspace();
    local.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));
    await invoke(local, { settingSources: null });
    assert.ok(!local.argv().includes("--setting-sources"));

    // The CI shape, asserted in full: this is the argv the GitHub worker sends,
    // so a reordering or a dropped flag here changes what every check run sees.
    const ci = workspace();
    ci.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));
    await invoke(ci, { settingSources: "" });
    assert.deepEqual(ci.argv(), [
      "-p",
      "--model",
      CHECK.model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      SCHEMA_TEXT,
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      "Bash(git diff *)",
      "Bash(git show *)",
      "--setting-sources",
      "",
      "--no-session-persistence",
    ]);
  });

  it("passes a generated settings file after setting-sources", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));
    const settingsPath = path.join(space.root, "settings-low.json");
    writeFileSync(settingsPath, "{}");

    await invoke(space, { settingsPath, settingSources: "" });

    const argv = space.argv();
    const settingIndex = argv.indexOf("--settings");
    assert.notEqual(settingIndex, -1);
    assert.equal(argv[settingIndex - 1], "");
    assert.equal(argv[settingIndex + 1], settingsPath);
  });

  it("overlays the provider env on the child and strips its dropEnv", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));
    process.env.WEAVE_CHECKS_TEST_SECRET = "do-not-leak";
    const seen = [];

    try {
      await invoke(space, {
        cluster: CLUSTER_LOW,
        provider: fakeProvider({
          dropEnv: ["WEAVE_CHECKS_TEST_SECRET"],
          envFor: args => {
            seen.push(args);
            return { ANTHROPIC_BASE_URL: "https://gateway.example.com" };
          },
        }),
      });
    } finally {
      delete process.env.WEAVE_CHECKS_TEST_SECRET;
    }

    const childEnv = space.childEnv();
    assert.equal(childEnv.get("ANTHROPIC_BASE_URL"), "https://gateway.example.com");
    assert.equal(childEnv.has("WEAVE_CHECKS_TEST_SECRET"), false);
    assert.deepEqual(seen, [
      { model: CHECK.model, cluster: CLUSTER_LOW, slug: CHECK.slug, suffix: "claude" },
    ]);
  });

  it("drops an inherited value before overlaying the provider's own for the same name", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));
    process.env.WEAVE_CHECKS_TEST_COLLIDE = "inherited";
    process.env.WEAVE_CHECKS_TEST_CALLER_DROP = "inherited";

    try {
      await invoke(space, {
        provider: fakeProvider({
          dropEnv: ["WEAVE_CHECKS_TEST_COLLIDE"],
          envFor: () => ({
            WEAVE_CHECKS_TEST_COLLIDE: "from-provider",
            // A provider cannot override the automation initiator.
            WEAVE_PROMPT_INITIATOR: "human",
          }),
        }),
        dropEnv: ["WEAVE_CHECKS_TEST_CALLER_DROP"],
      });
    } finally {
      delete process.env.WEAVE_CHECKS_TEST_COLLIDE;
      delete process.env.WEAVE_CHECKS_TEST_CALLER_DROP;
    }

    const childEnv = space.childEnv();
    assert.equal(childEnv.get("WEAVE_CHECKS_TEST_COLLIDE"), "from-provider");
    assert.equal(childEnv.has("WEAVE_CHECKS_TEST_CALLER_DROP"), false);
    assert.equal(childEnv.get("WEAVE_PROMPT_INITIATOR"), "automation");
  });

  it("omits --model when the check declares none", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));

    await invoke(space, { model: null });

    assert.equal(space.argv().includes("--model"), false);
    assert.deepEqual(space.argv().slice(0, 3), ["-p", "--output-format", "stream-json"]);
  });

  it("prices the session through the provider with the terminal result event", async () => {
    const space = workspace();
    const events = successEvents({ verdict: VERDICT.PASS, reason: "fine" });
    const result = JSON.parse(events[1]);
    events[1] = JSON.stringify({ ...result, total_cost_usd: 0.31, modelUsage: { m: {} } });
    space.stream(events);
    const calls = [];

    const invocation = await invoke(space, {
      cluster: CLUSTER_LOW,
      provider: fakeProvider({
        costLabel: "test cost",
        resolveCost: async args => {
          calls.push(args);
          return { cost: args.resultEvent.total_cost_usd, error: null };
        },
      }),
    });

    assert.equal(invocation.cost, 0.31);
    assert.equal(invocation.costLabel, "test cost");
    assert.equal(calls[0].sessionId, "sess-1");
    assert.equal(calls[0].model, CHECK.model);
    assert.equal(calls[0].cluster, CLUSTER_LOW);
    assert.equal(invocation.cli.total_cost_usd, 0.31);
    assert.deepEqual(invocation.cli.modelUsage, { m: {} });
  });

  it("reports a provider's cost error through onCostError", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));
    const errors = [];

    const invocation = await invoke(space, {
      provider: fakeProvider({ resolveCost: () => ({ cost: null, error: "no cost" }) }),
      onCostError: entry => errors.push(entry),
    });

    assert.equal(invocation.cost, null);
    assert.deepEqual(errors, [{ slug: CHECK.slug, suffix: "claude", error: "no cost" }]);
  });

  it("writes the prompt, transcript, session, and stderr artifacts", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));

    await invoke(space);

    const artifact = suffix =>
      readFileSync(path.join(space.tempDir, `${CHECK.slug}.claude.${suffix}`), "utf8");
    assert.equal(artifact("prompt.txt"), "review this");
    assert.match(artifact("transcript.jsonl"), /"type":"result"/);
    assert.equal(artifact("session.txt"), "sess-1\n");
    assert.equal(artifact("stderr"), "");
  });

  it("reports an unknown cost with no error when no provider is supplied", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));

    const invocation = await invoke(space, { provider: null });

    // Null (unknown), never 0: a skipped lookup must not present a billed run
    // as verified-free. And a skipped lookup is not a failure to report.
    assert.equal(invocation.cost, null);
    assert.equal(invocation.costError, null);
  });

  it("surfaces a non-zero CLI exit as a neutral outcome", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "fine" }));
    process.env[EXIT_CODE] = "3";

    const invocation = await invoke(space);
    const result = normalize(invocation, new Map());

    assert.equal(invocation.code, 3);
    assert.equal(result.outcome, OUTCOME.NEUTRAL);
    assert.equal(result.error, "Claude CLI exited 3");
  });

  it("includes the terminal result when a non-zero exit explains its failure", async () => {
    const space = workspace();
    space.stream([
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
      JSON.stringify({
        type: "result",
        subtype: CLI_RESULT_SUBTYPE.SUCCESS,
        is_error: true,
        session_id: "sess-1",
        result: "Prompt is too long",
        duration_ms: 2500,
      }),
    ]);
    process.env[EXIT_CODE] = "1";

    const invocation = await invoke(space);
    const result = normalize(invocation, new Map());

    assert.equal(result.outcome, OUTCOME.NEUTRAL);
    assert.equal(result.error, "Claude CLI exited 1: Prompt is too long");
  });
});

describe("normalize", () => {
  const addedLines = new Map([["app/main.go", new Set([1, 2])]]);

  function invocation(resultEvent, overrides = {}) {
    return { code: 0, cli: resultEvent, cost: 0.5, transcript: [], ...overrides };
  }

  function cli(structuredOutput) {
    return {
      is_error: false,
      subtype: CLI_RESULT_SUBTYPE.SUCCESS,
      result: "",
      structured_output: structuredOutput,
      permission_denials: [],
      num_turns: 2,
      duration_ms: 1500,
    };
  }

  it("accepts a PASS verdict", () => {
    const result = normalize(
      invocation(cli({ verdict: VERDICT.PASS, reason: "no violations" })),
      addedLines,
    );
    assert.equal(result.outcome, OUTCOME.PASS);
    assert.equal(result.reason, "no violations");
    assert.equal(result.cost, 0.5);
    assert.equal(result.duration, 1500);
  });

  it("accepts a FAIL verdict whose suggestion lands on a changed line", () => {
    const result = normalize(
      invocation(
        cli({
          verdict: VERDICT.FAIL,
          reason: "line one is bad",
          suggestions: [
            { file: "app/main.go", line: 1, comment: "rename this", replacement: "uno" },
          ],
        }),
      ),
      addedLines,
    );
    assert.equal(result.outcome, OUTCOME.FAIL);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.proseFallbacks.length, 0);
    assert.equal(result.rejected.length, 0);
  });

  it("keeps a FAIL when an unsafe replacement range has a valid anchor", () => {
    const result = normalize(
      invocation(
        cli({
          verdict: VERDICT.FAIL,
          reason: "the binding is unused",
          suggestions: [
            {
              file: "app/main.go",
              start_line: 0,
              line: 1,
              comment: "remove this dead binding",
              replacement: "",
            },
          ],
        }),
      ),
      addedLines,
    );
    assert.equal(result.outcome, OUTCOME.FAIL);
    assert.deepEqual(result.accepted, [
      {
        file: "app/main.go",
        start_line: 1,
        line: 1,
        comment: "remove this dead binding",
      },
    ]);
    assert.equal(result.proseFallbacks.length, 1);
    assert.equal(result.rejected.length, 0);
  });

  it("neutralizes a FAIL whose only suggestion is outside the diff", () => {
    const result = normalize(
      invocation(
        cli({
          verdict: VERDICT.FAIL,
          reason: "something elsewhere",
          suggestions: [{ file: "other/file.go", line: 9, comment: "nope" }],
        }),
      ),
      addedLines,
    );
    assert.equal(result.outcome, OUTCOME.NEUTRAL);
    assert.match(result.error, /no valid anchored findings/);
    assert.equal(result.proseFallbacks.length, 0);
    assert.equal(result.rejected.length, 1);
    // Spend already happened; a diff-validation miss must not report as free.
    assert.equal(result.cost, 0.5);
  });

  it("treats a missing terminal result event as neutral with an unknown duration", () => {
    const result = normalize(invocation(null), addedLines);
    assert.equal(result.outcome, OUTCOME.NEUTRAL);
    assert.match(result.error, /no terminal result event/);
    assert.equal(result.duration, null);
  });

  it("flags a skipped structured-output call as retryable", () => {
    const result = normalize(
      invocation({
        is_error: false,
        subtype: CLI_RESULT_SUBTYPE.SUCCESS,
        result: "I decided not to call the tool.",
        structured_output: undefined,
        permission_denials: [],
        num_turns: 1,
        duration_ms: 900,
      }),
      addedLines,
    );
    assert.equal(result.outcome, OUTCOME.NEUTRAL);
    assert.equal(result.retryable, true);
  });
});

describe("validateAndFinalize", () => {
  it("reports an undiffable structured result as neutral, preserving spend", () => {
    const result = validateAndFinalize(
      { verdict: "MAYBE", reason: "unsure" },
      { cost: 0.25 },
      { duration_ms: 400 },
      new Map(),
    );
    assert.equal(result.outcome, OUTCOME.NEUTRAL);
    assert.match(result.error, /Invalid structured result/);
    assert.equal(result.cost, 0.25);
    assert.equal(result.duration, 400);
  });
});

describe("promptFor", () => {
  it("includes the diff, the stat, and the check's criteria", () => {
    const space = workspace();
    const prompt = promptFor(CHECK, {
      repoDir: space.repoDir,
      diff: DIFF,
      stat: STAT,
    });
    assert.match(prompt, /advisory Weave Check "Demo Check"/);
    assert.match(prompt, /Flag any line that says one\./);
    assert.ok(prompt.includes(DIFF));
    assert.ok(prompt.includes(STAT));
    // No GitHub history locally: neither the section nor the instruction that
    // only makes sense alongside it should appear.
    assert.ok(!prompt.includes("Previously flagged issues"));
    assert.ok(!prompt.includes("Do NOT repeat a finding"));
  });

  it("reads criteria from a bundled source path when provided", () => {
    const space = workspace();
    const criteriaPath = path.join(space.root, "starter-check.md");
    writeFileSync(criteriaPath, "Bundled starter criteria.\n");

    const prompt = promptFor(
      { ...CHECK, criteriaPath },
      {
        repoDir: space.repoDir,
        diff: DIFF,
        stat: STAT,
      },
    );

    assert.match(prompt, /Bundled starter criteria/);
  });

  it("names the check with the configured product name", () => {
    const space = workspace();
    const prompt = promptFor(CHECK, {
      repoDir: space.repoDir,
      diff: DIFF,
      stat: STAT,
      productName: "Acme Review",
    });
    assert.match(
      prompt,
      /^You are running the advisory Acme Review "Demo Check" on a pull request\./,
    );
  });

  it("includes the history section and the don't-repeat rule when given one", () => {
    const space = workspace();
    const prompt = promptFor(CHECK, {
      repoDir: space.repoDir,
      diff: DIFF,
      stat: STAT,
      historySection: "1. app/main.go:1 -- already said this",
    });
    assert.match(prompt, /## Previously flagged issues by this check on this PR/);
    assert.match(prompt, /already said this/);
    assert.match(prompt, /Do NOT repeat a finding/);
  });

  // These two rules govern how the diff is swept and how a criteria match is
  // scored, so they are NOT part of the history block -- extracting promptFor
  // out of worker.mjs once dropped them, which let a check report only the
  // first matching line and downgrade a genuine match to a "noted" pass. Both
  // callers (CI, with history; local, without) must carry them.
  for (const [label, historySection] of [
    ["local (no history)", null],
    ["CI (with history)", "1. app/main.go:1 -- already said this"],
  ]) {
    it(`always requires the full-diff sweep and Flag-means-FAIL for ${label}`, () => {
      const space = workspace();
      const prompt = promptFor(CHECK, {
        repoDir: space.repoDir,
        diff: DIFF,
        stat: STAT,
        historySection,
      });
      assert.match(prompt, /sweep the entire diff/);
      assert.match(prompt, /every other occurrence before finalizing your verdict/);
      assert.match(prompt, /"Flag" conditions IS a violation — set FAIL/);
    });
  }
});

describe("evaluateCheck", () => {
  function evaluate(space, overrides = {}) {
    return evaluateCheck({
      check: CHECK,
      repoDir: space.repoDir,
      tempDir: space.tempDir,
      diff: DIFF,
      stat: STAT,
      addedLines: new Map([["app/main.go", new Set([1, 2])]]),
      schemaText: SCHEMA_TEXT,
      settingSources: null,
      provider: null,
      ...overrides,
    });
  }

  it("returns the verdict from a single successful invocation", async () => {
    const space = workspace();
    space.stream(successEvents({ verdict: VERDICT.PASS, reason: "nothing to flag" }));

    const result = await evaluate(space);

    assert.equal(result.outcome, OUTCOME.PASS);
    assert.equal(result.reason, "nothing to flag");
    assert.equal(space.callCount(), 1);
    // The prompt actually sent must be the one promptFor built, diff included.
    assert.ok(space.stdin().includes(DIFF));
  });

  it("retries once when the model skipped the structured-output call", async () => {
    const space = workspace();
    space.stream(
      proseOnlyEvents(),
      successEvents({ verdict: VERDICT.PASS, reason: "second time lucky" }),
    );
    const attempts = [];

    const result = await evaluate(space, {
      onAttempt: label => attempts.push(label),
    });

    assert.deepEqual(attempts, ["Main review", "Main review (retry)"]);
    assert.equal(space.callCount(), 2);
    assert.equal(result.outcome, OUTCOME.PASS);
    assert.equal(result.reason, "second time lucky");
    // Neither invocation was priced (no Weave API key), so the summed cost
    // stays unknown rather than collapsing to 0.
    assert.equal(result.cost, null);
    // Both attempts' durations are accounted for, not just the retry's.
    assert.equal(result.duration, 2600);
  });

  it("does not retry a verdict that came back cleanly", async () => {
    const space = workspace();
    space.stream(
      successEvents({
        verdict: VERDICT.FAIL,
        reason: "line one is bad",
        suggestions: [{ file: "app/main.go", line: 1, comment: "rename this" }],
      }),
    );

    const result = await evaluate(space);

    assert.equal(result.outcome, OUTCOME.FAIL);
    assert.equal(space.callCount(), 1);
  });
});

describe("cost and duration arithmetic", () => {
  it("propagates an unknown component through a sum", () => {
    assert.equal(totalCost([0.1, 0.2]), 0.3);
    assert.equal(totalCost([0.1, null]), null);
    assert.equal(totalDuration([100, 250]), 350);
    assert.equal(totalDuration([null, 250]), null);
  });

  it("renders unknown metrics as an em dash", () => {
    assert.equal(formatUsd(null), "—");
    assert.equal(formatUsd(1.235), "$1.24");
    assert.equal(formatDuration(null), "—");
    assert.equal(formatDuration(0), "—");
    assert.equal(formatDuration(450), "450ms");
    assert.equal(formatDuration(59995), "1m0s");
    assert.equal(formatDuration(90000), "1m30s");
  });
});

describe("runPool", () => {
  it("preserves input order and never exceeds the concurrency bound", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async item => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 2;
    });
    assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
    assert.equal(peak <= 3, true, `peak concurrency was ${peak}`);
  });

  it("runs nothing for an empty item list", async () => {
    assert.deepEqual(await runPool([], 4, async () => "never"), []);
  });
});
