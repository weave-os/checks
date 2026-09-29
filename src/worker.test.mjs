import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { OUTCOME, RESULT_SCHEMA } from "./parse.mjs";
import { appendMarker } from "./history.mjs";
import { readWorkerConfig, runWorker } from "./worker.mjs";

const HEAD_SHA = "a".repeat(40);
const REPO = "acme/widgets";

const DIFF = [
  "diff --git a/app/main.go b/app/main.go",
  "--- a/app/main.go",
  "+++ b/app/main.go",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  "",
].join("\n");

const CHECKS = [
  { slug: "first-check", name: "First Check", description: "Flags firsts", intelligence: "low", model: "haiku", cluster: "low", path: "checks/first-check.md" },
  { slug: "second-check", name: "Second Check", description: "Flags seconds", intelligence: "medium", model: "sonnet", cluster: "medium", path: "checks/second-check.md" },
];

const ROOTS = [];
after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

function workerEnv(overrides = {}, { diff = DIFF } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "weave-checks-worker-"));
  ROOTS.push(root);
  const repoDir = path.join(root, "repo");
  mkdirSync(path.join(repoDir, "checks"), { recursive: true });
  for (const check of CHECKS) {
    writeFileSync(path.join(repoDir, check.path), `Criteria for ${check.name}.\n`);
  }
  const write = (name, text) => {
    const target = path.join(root, name);
    writeFileSync(target, text);
    return target;
  };
  return {
    root,
    env: {
      HEAD_SHA,
      REPO_DIR: repoDir,
      WEAVE_CHECKS_APP_TOKEN: "ghs_test",
      WEAVE_CHECKS_TEMP_DIR: path.join(root, "temp"),
      PR_NUMBER: "7",
      SUMMARY_PATH: path.join(root, "summary.md"),
      COMPLETE_PATH: path.join(root, "complete"),
      MASTER_CHECK_RUN_ID: "1000",
      GITHUB_REPOSITORY: REPO,
      GITHUB_API_URL: "https://api.test",
      GITHUB_RUN_ID: "42",
      MATRIX_PATH: write("matrix.json", JSON.stringify({ check: CHECKS })),
      DIFF_PATH: write("pr.diff", diff),
      STAT_PATH: write("pr.stat", " app/main.go | 2 ++"),
      FULL_DIFF_PATH: write("pr.full.diff", diff),
      FULL_STAT_PATH: write("pr.stat.full", " app/main.go | 2 ++"),
      WEAVE_CHECKS_DIR: "checks",
      RESULTS_PATH: path.join(root, "results.json"),
      ...overrides,
    },
  };
}

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

// A GitHub stand-in that records every call and answers the handful of
// endpoints the worker uses. `threads` are the raw review-thread nodes the
// GraphQL history query returns; `failMaster` makes every aggregate PATCH 500.
function fakeGitHub({ threads = [], failMaster = false, failResolve = false, liveHead = HEAD_SHA } = {}) {
  const calls = [];
  let nextId = 2000;
  const fetchFn = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    const route = url.replace("https://api.test/", "");
    calls.push({ method, route, body });
    if (route === "graphql") {
      if (body.query.includes("reviewThreads")) {
        return reply(200, {
          data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads } } } },
        });
      }
      if (body.query.includes("resolveReviewThread") && failResolve) {
        return reply(200, { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
      }
      return reply(200, { data: {} });
    }
    if (method === "POST" && route === `repos/${REPO}/check-runs`) {
      nextId += 1;
      return reply(201, { id: nextId });
    }
    if (method === "PATCH" && route === `repos/${REPO}/check-runs/1000` && failMaster) {
      return reply(500, { message: "down" });
    }
    if (method === "GET" && route === `repos/${REPO}/pulls/7`) {
      return reply(200, { head: { sha: liveHead } });
    }
    return reply(200, {});
  };
  const find = (predicate) => calls.filter(predicate);
  return {
    fetchFn,
    calls,
    childRuns: () => find((c) => c.method === "POST" && c.route === `repos/${REPO}/check-runs`),
    masterPatches: () => find((c) => c.method === "PATCH" && c.route === `repos/${REPO}/check-runs/1000`),
    childPatches: () => find((c) => c.method === "PATCH" && /check-runs\/2\d{3}$/.test(c.route)),
    reviews: () => find((c) => c.method === "POST" && c.route === `repos/${REPO}/pulls/7/reviews`),
  };
}

const pass = (reason = "clean") => ({ outcome: OUTCOME.PASS, reason, accepted: [], proseFallbacks: [], rejected: [], cost: 0.01, duration: 100 });
const fail = () => ({
  outcome: OUTCOME.FAIL,
  reason: "line one is bad",
  accepted: [{ file: "app/main.go", start_line: 1, line: 1, comment: "Rename `one`." }],
  proseFallbacks: [],
  rejected: [],
  cost: 0.02,
  duration: 200,
});

async function run(env, github, evaluate, extraDeps = {}) {
  const config = readWorkerConfig(env);
  return runWorker(config, {
    fetchFn: github.fetchFn,
    sleepFn: async () => {},
    evaluate,
    // No judge should need a real agent in these tests; fail loudly if one runs.
    runAgent: async () => {
      throw new Error("unexpected judge invocation");
    },
    ...extraDeps,
  });
}

describe("readWorkerConfig", () => {
  it("defaults to the anthropic provider and needs no Weave secret", () => {
    const config = readWorkerConfig(workerEnv().env);
    assert.equal(config.provider.id, "anthropic");
    assert.equal(config.reviewEvent, "COMMENT");
    assert.equal(config.inlineComments, true);
    assert.equal(config.schemaText, JSON.stringify(RESULT_SCHEMA));
    assert.deepEqual(config.budgets, { review: "2", resolution: "1", dedup: "0.5" });
  });

  it("fails at startup when weave-router is missing a key", () => {
    const { env } = workerEnv({ WEAVE_CHECKS_PROVIDER: "weave-router", WEAVE_ROUTER_KEY: "rk" });
    assert.throws(() => readWorkerConfig(env), /requires WEAVE_API_KEY/);
    const { env: noRouter } = workerEnv({ WEAVE_CHECKS_PROVIDER: "weave-router", WEAVE_API_KEY: "wk" });
    assert.throws(() => readWorkerConfig(noRouter), /requires WEAVE_ROUTER_KEY/);
  });

  it("refuses the local-only inherit provider", () => {
    assert.throws(() => readWorkerConfig(workerEnv({ WEAVE_CHECKS_PROVIDER: "inherit" }).env), /local-only/);
  });

  it("validates the review event, toggles, and budgets", () => {
    assert.throws(() => readWorkerConfig(workerEnv({ WEAVE_CHECKS_REVIEW_EVENT: "APPROVE" }).env), /REVIEW_EVENT/);
    assert.throws(() => readWorkerConfig(workerEnv({ WEAVE_CHECKS_INLINE_COMMENTS: "yes" }).env), /"true" or "false"/);
    assert.throws(() => readWorkerConfig(workerEnv({ WEAVE_CHECKS_REVIEW_BUDGET: "-1" }).env), /positive USD/);
    assert.equal(readWorkerConfig(workerEnv({ WEAVE_CHECKS_REVIEW_EVENT: "REQUEST_CHANGES" }).env).reviewEvent, "REQUEST_CHANGES");
  });

  it("requires the aggregate check run id", () => {
    assert.throws(() => readWorkerConfig(workerEnv({ MASTER_CHECK_RUN_ID: "" }).env), /Missing MASTER_CHECK_RUN_ID/);
  });
});

describe("runWorker", () => {
  it("creates one child run per check under the shared name helper and closes the aggregate reviewed", async () => {
    const { env } = workerEnv();
    const github = fakeGitHub();

    const outcome = await run(env, github, async () => pass());

    assert.equal(outcome.ok, true);
    assert.deepEqual(
      github.childRuns().map((c) => c.body.name),
      ["Weave Check / First Check", "Weave Check / Second Check"],
    );
    assert.deepEqual(github.childPatches().map((c) => c.body.conclusion), ["success", "success"]);
    const final = github.masterPatches().at(-1).body;
    assert.equal(final.status, "completed");
    assert.equal(final.conclusion, "success");
    assert.equal(final.external_id, `reviewed:${HEAD_SHA}`);
    assert.match(final.output.title, /^Weave Checks: 2 pass · 0 flagged · 0 neutral/);
    assert.match(final.output.summary, /client-reported cost/);
    assert.equal(readFileSync(env.COMPLETE_PATH, "utf8"), "completed\n");
  });

  it("posts findings as a COMMENT review under the configured marker and names, concluding neutral", async () => {
    const { env } = workerEnv({
      WEAVE_CHECKS_CHECK_RUN_PREFIX: "Acme Review",
      WEAVE_CHECKS_AGGREGATE_NAME: "Acme Reviews",
      WEAVE_CHECKS_MARKER_PREFIX: "acme-review",
    });
    const github = fakeGitHub();

    await run(env, github, async ({ check }) => (check.slug === "first-check" ? fail() : pass()));

    assert.deepEqual(github.childRuns().map((c) => c.body.name), ["Acme Review / First Check", "Acme Review / Second Check"]);
    const [review] = github.reviews();
    assert.equal(review.body.event, "COMMENT");
    assert.equal(review.body.commit_id, HEAD_SHA);
    assert.match(review.body.body, /^\*\*Acme Review \/ First Check\*\*/);
    assert.match(review.body.comments[0].body, /<!-- acme-review:first-check -->$/);
    assert.equal(review.body.comments[0].side, "RIGHT");
    // A FAIL verdict is a completed review, so the base still advances, but
    // never paints anything red.
    const conclusions = github.childPatches().map((c) => c.body.conclusion).sort();
    assert.deepEqual(conclusions, ["neutral", "success"]);
    const final = github.masterPatches().at(-1).body;
    assert.equal(final.conclusion, "neutral");
    assert.equal(final.external_id, `reviewed:${HEAD_SHA}`);
    assert.match(final.output.title, /^Acme Reviews: 1 pass · 1 flagged/);
    const results = JSON.parse(readFileSync(env.RESULTS_PATH, "utf8"));
    assert.deepEqual(results.totals, { pass: 1, flagged: 1, neutral: 0, cost: 0.03, durationMs: 300 });
    assert.deepEqual(results.checks.map((c) => c.outcome), ["flagged", "pass"]);
    assert.deepEqual(
      results.checks.map((c) => [c.intelligence, c.model]),
      [["low", "haiku"], ["medium", "sonnet"]],
    );
    assert.equal(results.aggregateCheckRunId, "1000");
  });

  it("does not mark the head reviewed when a check was an operational miss", async () => {
    const { env } = workerEnv();
    const github = fakeGitHub();

    await run(env, github, async ({ check }) =>
      check.slug === "first-check" ? { outcome: OUTCOME.NEUTRAL, error: "Claude CLI exited 1", cost: null, duration: null } : pass(),
    );

    const final = github.masterPatches().at(-1).body;
    assert.equal(final.conclusion, "neutral");
    assert.equal(final.external_id, undefined);
  });

  it("lists findings on the check run instead of posting a review when inline comments are off", async () => {
    const { env } = workerEnv({ WEAVE_CHECKS_INLINE_COMMENTS: "false" });
    const github = fakeGitHub();

    await run(env, github, async ({ check }) => (check.slug === "first-check" ? fail() : pass()));

    assert.equal(github.reviews().length, 0);
    const summaries = github.childPatches().map((c) => c.body.output.summary).join("\n");
    assert.match(summaries, /1 findings listed below/);
    assert.match(summaries, /- `app\/main\.go:1` — Rename `one`\./);
  });

  it("feeds legacy-marker history to the review under a rebranded marker", async () => {
    const { env } = workerEnv({ WEAVE_CHECKS_MARKER_PREFIX: "acme-review" });
    const github = fakeGitHub({
      threads: [
        {
          id: "T1",
          isResolved: true,
          isOutdated: false,
          path: "app/main.go",
          line: 1,
          comments: {
            nodes: [{ databaseId: 5, body: appendMarker("Old legacy finding.", "first-check"), pullRequestReview: { databaseId: 9, id: "R9", state: "COMMENTED", isMinimized: true } }],
          },
        },
      ],
    });
    const histories = new Map();

    await run(env, github, async ({ check, historySection }) => {
      histories.set(check.slug, historySection);
      return pass();
    });

    assert.match(histories.get("first-check"), /Old legacy finding\./);
    assert.doesNotMatch(histories.get("second-check"), /Old legacy finding/);
  });

  const openThread = (slug) => ({
    id: "T-open",
    isResolved: false,
    isOutdated: true,
    path: "app/main.go",
    line: 1,
    comments: {
      nodes: [{ databaseId: 55, body: appendMarker("Rename `one`.", slug), pullRequestReview: { databaseId: 77, id: "R77", state: "COMMENTED", isMinimized: false } }],
    },
  });
  const judgeInvocation = (structuredOutput) => ({
    code: 0,
    sessionId: "judge-session",
    cost: 0.01,
    costLabel: "client-reported cost",
    transcript: [],
    cli: { subtype: "success", is_error: false, structured_output: structuredOutput, duration_ms: 10 },
  });

  it("resolves a fixed thread with an audit reply under the configured marker", async () => {
    const { env } = workerEnv({ WEAVE_CHECKS_MARKER_PREFIX: "acme-review" });
    const github = fakeGitHub({ threads: [openThread("first-check")] });
    const judged = [];

    await run(env, github, async () => pass(), {
      runAgent: async (options) => {
        judged.push(options.suffix);
        return judgeInvocation({ resolutions: [{ thread_id: "T-open", resolved: true, evidence: "Renamed to uno." }] });
      },
    });

    assert.deepEqual(judged, ["resolve"]);
    const replyCall = github.calls.find((c) => c.route === `repos/${REPO}/pulls/7/comments/55/replies`);
    assert.match(replyCall.body.body, /^\*\*Resolved by Weave Check \/ First Check\.\*\*\n\nRenamed to uno\./);
    assert.match(replyCall.body.body, /<!-- acme-review:first-check -->$/);
    assert.ok(github.calls.some((c) => c.route === "graphql" && c.body.query.includes("resolveReviewThread")));
  });

  // Found live on this repo's own PR: GitHub refused resolveReviewThread, so
  // every later push re-judged the same fixed finding and posted another reply.
  // Retry the GitHub mutation, but don't repeat the judge or the reply.
  it("retries resolving an already-replied thread and hides the parent after success", async () => {
    const { env } = workerEnv();
    const replied = openThread("first-check");
    replied.comments.totalCount = 2;
    replied.latest = { nodes: [{ body: appendMarker("**Resolved by Weave Check / First Check.**\n\nFixed.", "first-check") }] };
    const github = fakeGitHub({ threads: [replied] });

    await run(env, github, async () => pass(), {
      runAgent: async () => {
        throw new Error("the resolution judge must not run for a thread with its audit reply");
      },
    });

    assert.equal(github.calls.some((c) => c.route.endsWith("/replies")), false);
    assert.equal(github.calls.filter((c) => c.route === "graphql" && c.body.query.includes("resolveReviewThread")).length, 1);
    assert.equal(github.calls.filter((c) => c.route === "graphql" && c.body.query.includes("minimizeComment")).length, 1);
    assert.ok(
      github.childPatches().some((c) => c.body.output.summary.includes("Resolved 1 previously-flagged thread")),
      "expected the retried thread to resolve",
    );
    assert.equal(github.childPatches().every((c) => !/still open/.test(c.body.output.summary)), true);
    assert.equal(github.childPatches().every((c) => c.body.conclusion === "success"), true);
  });

  it("keeps retrying an already-replied thread after GitHub refuses resolution", async () => {
    const { env } = workerEnv();
    const replied = openThread("first-check");
    replied.comments.totalCount = 2;
    replied.latest = { nodes: [{ body: appendMarker("**Resolved by Weave Check / First Check.**\n\nFixed.", "first-check") }] };
    const github = fakeGitHub({ threads: [replied], failResolve: true });

    await run(env, github, async () => pass(), {
      runAgent: async () => {
        throw new Error("the resolution judge must not run again");
      },
    });

    assert.equal(github.calls.some((c) => c.route.endsWith("/replies")), false);
    assert.equal(github.calls.filter((c) => c.route === "graphql" && c.body.query.includes("resolveReviewThread")).length, 1);
    assert.equal(github.calls.some((c) => c.body?.query?.includes("minimizeComment")), false);
    const first = github.childPatches().find((c) => c.body.output.summary.includes("Resource not accessible by integration"));
    assert.ok(first);
    assert.doesNotMatch(first.body.output.summary, /still open/);
  });

  it("skips the resolution judge when it is turned off, leaving the thread open", async () => {
    const { env } = workerEnv({ WEAVE_CHECKS_RESOLUTION_JUDGE: "false" });
    const github = fakeGitHub({ threads: [openThread("first-check")] });

    await run(env, github, async () => pass());

    // Still-open history keeps the check flagged rather than green.
    const first = github.childPatches().find((c) => /still open/.test(c.body.output.summary));
    assert.ok(first, "expected the first check to report its still-open thread");
    assert.equal(github.calls.some((c) => c.route === "graphql" && c.body.query.includes("resolveReviewThread")), false);
  });

  it("closes the aggregate green without creating child runs when nothing is reviewable", async () => {
    const { env } = workerEnv({}, { diff: "" });
    const github = fakeGitHub();

    const outcome = await run(env, github, async () => {
      throw new Error("no check should run");
    });

    assert.equal(outcome.ok, true);
    assert.equal(github.childRuns().length, 0);
    const [final] = github.masterPatches();
    assert.equal(final.body.conclusion, "success");
    assert.equal(final.body.external_id, `reviewed:${HEAD_SHA}`);
    assert.match(final.body.output.summary, /excluded by `checks\/\.ignore`/);
    assert.equal(readFileSync(env.COMPLETE_PATH, "utf8"), "no-reviewable-changes\n");
  });

  it("neutralizes a check whose head moved before it could post", async () => {
    const { env } = workerEnv();
    const github = fakeGitHub({ liveHead: "b".repeat(40) });

    await run(env, github, async () => fail());

    assert.equal(github.reviews().length, 0);
    assert.deepEqual(github.childPatches().map((c) => c.body.conclusion), ["neutral", "neutral"]);
    assert.match(github.childPatches()[0].body.output.summary, /head moved on/);
  });

  // The always() cleanup step keys off COMPLETE_PATH: it must stay absent
  // when the worker could not close the aggregate itself, so cleanup retries.
  it("leaves the complete marker absent when it cannot close the aggregate", async () => {
    const { env } = workerEnv();
    const github = fakeGitHub({ failMaster: true });

    const outcome = await run(env, github, async () => pass());

    assert.equal(outcome.ok, false);
    assert.equal(existsSync(env.COMPLETE_PATH), false);
    assert.equal(existsSync(env.RESULTS_PATH), false);
  });
});
