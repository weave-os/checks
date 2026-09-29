// Runs all Weave Checks from one GitHub Actions job.
//
// Check-run conclusions follow a strict PASS-or-neutral contract. A check
// run is `success` ONLY when the agent verdict is PASS; FAIL verdicts,
// operational misses (CLI crash, JSON parse failure, structured-output
// skipped), and every other non-PASS outcome publish as GitHub `neutral`.
// The reasoning: the underlying issues are surfaced as inline review
// comments already, so a red status row doesn't add new signal, it only paints the check red
// on the PR status row. Worse, there is no workflow event for "conversation
// resolved" to flip a check back to green when a human dismisses a
// finding, so a FAIL-on-findings check can stay red even after the
// underlying issue has been resolved by hand. Neutral is the correct
// conclusion in that case.
//
// The action creates one aggregate Check Run before starting this script.
// This worker creates the per-check runs, runs the agents in a bounded local
// pool, and updates the aggregate's short status table after every result.
// That provides live PR feedback without a GitHub Actions matrix repeating
// checkout, Node setup, CLI installation, or token minting.
//
// Cross-run memory: every comment a check posts is read back on the next run
// (a manual re-run or a plain `synchronize` push) via review-thread history
// (history.mjs) so the agent sees what it already flagged and never repeats a
// duplicate -- including a finding whose thread was resolved without the
// underlying code changing (e.g. a human clicked "Resolve conversation" to
// dismiss it): that resolution is final and the finding must never be
// re-raised. A separate resolution judge -- its own agent invocation, run
// concurrently with the check's own review -- independently decides whether
// each previously-OPEN thread still applies at the PR's current HEAD, so a
// fixed (or now-irrelevant) issue gets resolved even when the check's own run
// this time is neutral. Once every thread a review opened is resolved, that
// review is dismissed.
//
// Entry points: readWorkerConfig() turns the action's environment into a
// config object and runWorker() runs one pass. Both are exported so the
// whole coordinator can be driven against a fake GitHub and a fake agent in
// tests (worker.test.mjs); `node src/worker.mjs` wires them to process.env.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { brandingFromEnv, childCheckRunName } from "./branding.mjs";
import {
  DEDUP_CLUSTER,
  DEDUP_MODEL,
  DEDUP_SCHEMA,
  RESOLUTION_SCHEMA,
  RESULT_SCHEMA,
  RUN_MARKER,
  STATUS,
  OUTCOME,
  GITHUB_CONCLUSION,
  CHECK_RUN_STATUS,
  HTTP_METHOD,
  REVIEW_EVENT,
  everyCheckReviewed,
  formatReviewComment,
  formatReviewedMarker,
  parseAddedLines,
  publicOutcome,
} from "./parse.mjs";
import {
  extractThreadsPage,
  formatHistorySection,
  formatResolutionSection,
  isSettled,
  markerCodec,
  RESOLUTION_REPLY_PREFIX,
  REVIEW_THREADS_QUERY,
  reviewsToDismiss,
  reviewsToHide,
  threadsForCheck,
  validateResolutions,
} from "./history.mjs";
import { isRetryableGraphQLBody, requestWithRetry, truncateBody } from "./githubapi.mjs";
import { PROVIDER, createProvider, parseProviderEnv } from "./provider.mjs";
// The agent invocation, verdict pipeline, and cost/duration arithmetic are
// shared with the local runner (local.mjs, behind `weave-checks run`) so the
// two paths cannot drift. Everything GitHub -- check runs, review threads,
// the resolution and dedup judges -- stays in this file.
import {
  decodeAgentInvocation,
  evaluateCheck,
  formatDuration,
  formatUsd,
  invocationCost,
  invocationDuration,
  resultPath,
  runClaude,
  runPool,
  totalCost,
  totalDuration,
} from "./runner.mjs";
import { formatTranscriptSection } from "./streamsplit.mjs";

// The CI default provider. `inherit` is not offered here: the worker isolates
// every check from the runner's own Claude settings (`--setting-sources ""`),
// so there is nothing to inherit.
export const DEFAULT_CI_PROVIDER = PROVIDER.ANTHROPIC;

// Reads and validates one pass's configuration from the environment the
// action sets. Taking `env` as an argument (rather than reading process.env
// inline) is what makes the coordinator testable without spawning it.
export function readWorkerConfig(env) {
  const required = name => {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`Missing ${name}`);
    return value;
  };
  const providerName = env.WEAVE_CHECKS_PROVIDER || DEFAULT_CI_PROVIDER;
  if (providerName === PROVIDER.INHERIT) {
    throw new Error("provider inherit is local-only; use anthropic or weave-router in CI");
  }
  return {
    headSha: required("HEAD_SHA"),
    repoDir: required("REPO_DIR"),
    token: required("WEAVE_CHECKS_APP_TOKEN"),
    tempDir: required("WEAVE_CHECKS_TEMP_DIR"),
    prNumber: required("PR_NUMBER"),
    summaryPath: required("SUMMARY_PATH"),
    completePath: required("COMPLETE_PATH"),
    // Optional: where to write the machine-readable results the action turns
    // into its outputs (see writeResults below).
    resultsPath: env.RESULTS_PATH || null,
    // The action always creates the aggregate before this script starts, so
    // there is exactly one to update and no need to look one up.
    masterCheckRunId: required("MASTER_CHECK_RUN_ID"),
    repository: required("GITHUB_REPOSITORY"),
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    graphqlUrl:
      env.GITHUB_GRAPHQL_URL || `${env.GITHUB_API_URL || "https://api.github.com"}/graphql`,
    serverUrl: env.GITHUB_SERVER_URL || "https://github.com",
    runId: env.GITHUB_RUN_ID || "local",
    checks: JSON.parse(readFileSync(required("MATRIX_PATH"), "utf8")).check,
    // Two diffs, two audiences, and they must not be conflated.
    //
    // `diff` is the REVIEW scope: what this run is asking the checks to look
    // at. From the second run on a PR it is incremental (see prepare.mjs), so
    // lines an earlier run already reviewed are absent and cannot be flagged
    // twice.
    //
    // `fullDiff` is the PR scope: merge-base..HEAD, always, exactly GitHub's
    // own three-dot diff. Anything answering "is this still part of the PR?"
    // MUST read it. threadDiffEvidence() reports a file missing from the lines
    // it is given as "no longer part of the PR diff", which the resolution
    // judge treats as grounds to close the thread -- so feeding it the
    // incremental lines would close still-valid threads on every file the
    // latest push did not happen to touch.
    //
    // On the first run of a PR, and on every fallback, the two are identical.
    diff: readFileSync(required("DIFF_PATH"), "utf8"),
    stat: readFileSync(required("STAT_PATH"), "utf8"),
    fullDiff: readFileSync(required("FULL_DIFF_PATH"), "utf8"),
    fullStat: readFileSync(required("FULL_STAT_PATH"), "utf8"),
    // Optional: the schema is a constant of this package.
    schemaText:
      env.SCHEMA_PATH ? readFileSync(env.SCHEMA_PATH, "utf8") : JSON.stringify(RESULT_SCHEMA),
    concurrency: positiveInteger(env.WEAVE_CHECK_PARALLEL, 4),
    // Only the selected provider's credentials are read, so a consumer on
    // Anthropic never needs Weave secrets and a Router consumer missing one
    // fails here, before a single check run is created.
    provider: createProvider(providerName, {
      env,
      providerEnv: parseProviderEnv(env.WEAVE_CHECKS_PROVIDER_ENV),
    }),
    branding: brandingFromEnv(env),
    // Named in user-facing text ("excluded by .weave-checks/.ignore").
    checksDir: env.WEAVE_CHECKS_DIR || ".weave-checks",
  };
}

// GitHub validates output.summary as UTF-8 bytes (maxLength 65535 on POST
// and PATCH, confirmed in github/docs issue #35252). Setting a working
// ceiling slightly under the documented limit leaves headroom for the
// JSON envelope and any future tally-line additions without
// rounding-tripping the limit. The transcripts section is the only
// summary contributor that can be safely dropped on overflow -- the
// diagnostics artifact on disk holds the bytes it omits.
const MAX_CHECK_RUN_SUMMARY_BYTES = 60000;

// The three transcript phases a check run can produce evidence for. Single
// source of truth for the transcriptSessions object keys and every
// recordAttempt() call site below -- a typo here would throw at runtime
// (`transcriptSessions["resolv"]` is undefined) instead of being caught
// statically.
const TRANSCRIPT_PHASE = { MAIN: "main", RESOLVE: "resolve", DEDUP: "dedup" };

// Runs one coordinator pass. `deps` exists for tests: `fetchFn`/`sleepFn`
// reach the GitHub transport, `evaluate` replaces the check's own review
// (runner.mjs's evaluateCheck), and `runAgent` replaces the judges' agent
// invocation (runner.mjs's runClaude).
//
// Resolves when the pass is over, whatever happened. A coordinator error is
// reported on the aggregate and by the returned `{ ok: false }`; the script
// entry point turns that into a non-zero exit.
export async function runWorker(config, deps = {}) {
  const {
    fetchFn = fetch,
    sleepFn = undefined,
    evaluate = evaluateCheck,
    runAgent = runClaude,
  } = deps;
  const {
    headSha: HEAD_SHA,
    repoDir: REPO_DIR,
    token: TOKEN,
    tempDir: TEMP_DIR,
    prNumber: PR_NUMBER,
    summaryPath: SUMMARY_PATH,
    completePath: COMPLETE_PATH,
    masterCheckRunId: MASTER_CHECK_RUN_ID,
    repository: REPOSITORY,
    checks: CHECKS,
    diff: DIFF,
    stat: STAT,
    fullDiff: FULL_DIFF,
    fullStat: FULL_STAT,
    schemaText: SCHEMA,
    concurrency: CONCURRENCY,
    provider: PROVIDER_IMPL,
    branding: BRANDING,
  } = config;
  const MARKERS = markerCodec(BRANDING.markerPrefix);
  const IGNORE_FILE = `${config.checksDir}/.ignore`;
  // Bounds the review agent's suggestions: it only saw DIFF, so it may only
  // comment on DIFF's lines.
  const ADDED_LINES = parseAddedLines(DIFF);
  // Evidence for the resolution judge. PR scope, never review scope.
  const FULL_ADDED_LINES = parseAddedLines(FULL_DIFF);

  mkdirSync(TEMP_DIR, { recursive: true });

  let states;

  // Per-check accumulation of cost-lookup failures (one entry per agent phase
  // that couldn't be priced), keyed by check slug. Surfaced on that check's
  // own run summary in completeCheckRun() -- a check whose review still
  // landed a real verdict shouldn't have a cost-lookup hiccup buried where
  // nobody sees it, since an unpriced check is the thing a spend-conscious
  // reader is most likely to go looking for.
  const COST_ERRORS = new Map();

  const transport = { fetchFn, ...(sleepFn === undefined ? {} : { sleepFn }) };

  // Every GitHub REST call in this file goes through here, so the retry policy
  // in githubapi.mjs applies uniformly -- a 503 on any single call is survivable
  // rather than terminal. See that module for why 5xx retries are safe even on
  // the non-idempotent POSTs below.
  async function github(method, apiPath, body) {
    const response = await requestWithRetry(
      `${config.apiUrl}/${apiPath}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { label: `${method} ${apiPath}`, ...transport },
    );
    if (!response.ok) {
      throw new Error(
        `${method} ${apiPath}: ${response.status} ${truncateBody(response.text)} (after ${response.attempts} attempt(s))`,
      );
    }
    if (response.text === "") return null;
    try {
      return JSON.parse(response.text);
    } catch (error) {
      // A 2xx whose body isn't JSON means GitHub served something other than the
      // API (an edge/proxy page). Say so, with the status and a bounded excerpt
      // -- a bare `SyntaxError: Unexpected token '<'` names neither the call nor
      // the reason.
      throw new Error(
        `${method} ${apiPath}: ${response.status} response was not valid JSON (${error.message}): ${truncateBody(response.text)}`,
      );
    }
  }

  // Thread history and resolution live only in GraphQL -- REST has no
  // review-thread-resolved field and no resolve mutation.
  //
  // GraphQL needs body-level retry classification on top of the shared status
  // classification: GitHub answers several of its own internal failures with
  // HTTP 200 and an `errors` payload, so a status-only rule would treat an
  // outage as a permanent answer (see isRetryableGraphQLBody).
  async function graphql(query, variables, label = "POST graphql") {
    const response = await requestWithRetry(
      config.graphqlUrl,
      {
        method: HTTP_METHOD.POST,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      },
      { label, shouldRetryResponse: isRetryableGraphQLBody, ...transport },
    );
    let json;
    try {
      json = JSON.parse(response.text);
    } catch (error) {
      throw new Error(
        `${label}: ${response.status} response was not valid JSON (${error.message}): ${truncateBody(response.text)}`,
      );
    }
    if (!response.ok || json.errors) {
      throw new Error(
        `${label}: ${response.status} ${truncateBody(JSON.stringify(json.errors ?? json))} (after ${response.attempts} attempt(s))`,
      );
    }
    return json.data;
  }

  async function fetchLivePRHeadSha() {
    const pr = await github(HTTP_METHOD.GET, `repos/${REPOSITORY}/pulls/${PR_NUMBER}`);
    return pr.head.sha;
  }

  // Guards the two GitHub-mutating actions in runCheck -- resolving/dismissing
  // threads and posting a review -- against a PR push landing mid-run. A single
  // check invocation can take minutes, so the one-time liveHeadSha check made
  // at startup (see the top-level try block) is not enough by itself: by the time a check
  // actually resolves a thread or posts a review, a newer push may have already
  // moved the PR's head. Re-checking immediately before each mutation means a
  // stale run never dismisses/resolves threads or posts a review for a PR state
  // that no longer exists.
  async function isStillLiveHead() {
    const liveHeadSha = await fetchLivePRHeadSha();
    return liveHeadSha === HEAD_SHA;
  }

  async function fetchAllReviewThreads() {
    const [owner, repo] = REPOSITORY.split("/");
    const nodes = [];
    let after = null;
    for (;;) {
      const data = await graphql(
        REVIEW_THREADS_QUERY,
        {
          owner,
          repo,
          number: Number(PR_NUMBER),
          after,
        },
        "POST graphql (reviewThreads)",
      );
      const page = extractThreadsPage(data);
      nodes.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    return nodes;
  }

  async function resolveThread(threadId) {
    await graphql(
      "mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }",
      { id: threadId },
      "POST graphql (resolveReviewThread)",
    );
  }

  // Requires the App to be allowed to dismiss reviews on this branch -- some
  // branch-protection configs restrict dismissal to admins/a named list. A
  // denial here is caught by the caller and surfaced as a history error rather
  // than failing the check.
  async function dismissReview(reviewId) {
    await github(
      HTTP_METHOD.PUT,
      `repos/${REPOSITORY}/pulls/${PR_NUMBER}/reviews/${reviewId}/dismissals`,
      {
        message: "All issues flagged in this review have been resolved.",
        event: REVIEW_EVENT.DISMISS,
      },
    );
  }

  // Minimizes the review SUMMARY (the comment GitHub renders at the top of the
  // thread list with the reasoning sentence `**<check-run name>**`).
  // PullRequestReview implements GitHub's Minimizable interface, so the review's
  // own GraphQL id is the subjectId -- no parallel IssueComment lookup needed.
  // `classifier: RESOLVED` matches the "3-dot -> Hide -> Resolved" UI: the
  // summary collapses to "Marked as resolved" exactly like a hidden thread.
  async function minimizeReview(reviewGraphqlId) {
    await graphql(
      "mutation($id: ID!, $c: ReportedContentClassifiers!) { minimizeComment(input: { subjectId: $id, classifier: $c }) { minimizedComment { isMinimized } } }",
      { id: reviewGraphqlId, c: "RESOLVED" },
      "POST graphql (minimizeComment)",
    );
  }

  // Builds the in-memory state table every other function reads/writes. Every
  // check starts queued; the pool below takes them in order.
  function buildStates() {
    return new Map(
      CHECKS.map(check => [
        check.slug,
        {
          check,
          status: STATUS.QUEUED,
          outcome: null,
          note: "Waiting for an agent slot.",
          checkRunId: null,
          cost: 0,
          durationMs: 0,
        },
      ]),
    );
  }

  function checkRunPath(id) {
    return `repos/${REPOSITORY}/check-runs/${id}`;
  }

  async function createCheckRun(check) {
    return github(HTTP_METHOD.POST, `repos/${REPOSITORY}/check-runs`, {
      name: childCheckRunName(BRANDING, check),
      head_sha: HEAD_SHA,
      external_id: `${config.runId}/${check.slug}`,
      status: CHECK_RUN_STATUS.IN_PROGRESS,
      details_url: `${config.serverUrl}/${REPOSITORY}/actions/runs/${config.runId}`,
      output: {
        title: `Running ${check.name}`,
        summary: check.description,
      },
    });
  }

  // Records a cost-lookup failure against the check it belongs to, so
  // completeCheckRun() can surface it on that check's own run summary. Passed to
  // every agent invocation below as runner.mjs's `onCostError` hook.
  function recordCostError({ slug, suffix, error }) {
    console.error(`[${slug}/${suffix}] cost unavailable: ${error}`);
    const errors = COST_ERRORS.get(slug) ?? [];
    errors.push(`${suffix}: ${error}`);
    COST_ERRORS.set(slug, errors);
  }

  // The environment contract every CI agent invocation shares: traffic goes
  // wherever the provider sends it, the runner's own Claude settings are
  // excluded (`--setting-sources ""`, so a stray settings file on the runner
  // can't change what a check sees), the provider's coordinator-only secrets
  // never reach the child, and cost-lookup failures accumulate per check. The
  // local runner can invert the settings isolation -- see local.mjs.
  function agentEnvironment() {
    return {
      repoDir: REPO_DIR,
      tempDir: TEMP_DIR,
      provider: PROVIDER_IMPL,
      settingSources: "",
      onCostError: recordCostError,
    };
  }

  function runCheckAgent(options) {
    return runAgent({ ...options, ...agentEnvironment() });
  }

  function resolutionPromptFor(check, openThreads) {
    const criteria = readFileSync(path.join(REPO_DIR, check.path), "utf8");
    return [
      `You are resolving previously-flagged findings for the ${BRANDING.productName} "${check.name}" on a pull request.`,
      "",
      "For each previously-flagged issue below, decide whether it STILL APPLIES at the PR's current HEAD.",
      "Read the current file at the flagged location if you need to. Read adjacent files only when needed.",
      "Do NOT modify files. You have read-only tools.",
      "",
      "Set `resolved` to true ONLY in these cases:",
      "- The flagged code has been changed and now satisfies the check criteria.",
      "- The flagged lines were deleted outright.",
      "- The file was removed from the PR entirely (the change was reverted).",
      "- The check criteria file changed in this PR such that this is no longer a violation.",
      "",
      "Set `resolved` to false in all other cases, including:",
      "- The code was moved but still violates the criteria.",
      "- The violation was only partially addressed.",
      "- You are uncertain whether the issue is fixed.",
      "",
      "You must provide a non-empty `evidence` string for every entry. When resolving,",
      "explain concretely what changed; when not resolving, explain why the issue still applies.",
      "The resolution will be audited, so a missing or vague evidence field is rejected.",
      "",
      "## Review criteria",
      "",
      criteria,
      "",
      "## Previously flagged issues, still open",
      "",
      // PR scope, not review scope: this judge decides whether a past finding
      // still applies to the PR as a whole, so it must see every file the PR
      // touches. Handing it the incremental diff would make each file the
      // latest push skipped look like it had left the PR.
      formatResolutionSection(openThreads, FULL_ADDED_LINES),
      "",
      "## Changed files",
      "",
      "```",
      FULL_STAT,
      "```",
      "",
      "## Diff",
      "",
      "```diff",
      FULL_DIFF,
      "```",
    ].join("\n");
  }

  function dedupPromptFor(check, checkThreads, accepted) {
    return [
      `You are deduplicating new review findings against already-flagged review threads for the ${BRANDING.productName} "${check.name}" on a pull request.`,
      "",
      "A new finding is a duplicate if it flags the same underlying issue as an existing comment, even if the",
      "wording, exact line, or file differs slightly (e.g. after a rebase shifted line numbers). This includes a",
      "comment marked (already resolved) -- a human dismissing a thread is a decision to drop that finding, not",
      "an invitation to re-raise it, so treat it as a duplicate too even though the underlying code is unchanged.",
      "Return the 0-based indices of new findings that duplicate an existing comment. Return an empty array if none do.",
      "",
      "## Existing comments",
      "",
      formatHistorySection(checkThreads),
      "",
      "## New findings",
      "",
      accepted.map((s, index) => `${index}. ${s.file}:${s.line} -- ${s.comment}`).join("\n"),
    ].join("\n");
  }

  // The check's own review. Everything it needs -- prompt construction, the
  // agent invocation, the structured-output retry, and diff validation -- lives
  // in runner.mjs and is shared verbatim with the local runner; this wrapper
  // only supplies the GitHub-side inputs (the rendered review-thread history)
  // and the CI environment contract.
  // Independent judgment of whether each previously-open thread still applies,
  // run as its own agent invocation on the check's own model -- deciding this
  // requires applying the check's own criteria to the code at HEAD, which is
  // exactly the check's own competence, not a narrow textual comparison like
  // judgeDuplicates. Runs concurrently with invokeClaude() in runCheck() so it
  // adds no wall-clock, and (unlike the main review) is applied regardless of
  // whether the check's own run this time comes back neutral.
  //
  // Fails CLOSED, the opposite of judgeDuplicates: any CLI, parsing, or
  // validation error resolves nothing. A missed resolution just leaves a stale
  // comment for a human to dismiss; a wrongly-resolved one silently buries a
  // real unfixed issue.
  //
  // `recordAttempt`, when provided, lets the caller attach this attempt's
  // session/transcript to the per-phase evidence block in the check-run
  // summary.
  async function judgeResolutions(check, openThreads, recordAttempt) {
    if (openThreads.length === 0) return { resolutions: [], error: null, cost: 0, duration: 0 };

    const invocation = await runCheckAgent({
      slug: check.slug,
      suffix: "resolve",
      model: check.model,
      cluster: check.cluster,
      schemaText: JSON.stringify(RESOLUTION_SCHEMA),
      promptText: resolutionPromptFor(check, openThreads),
    });
    recordAttempt?.("Resolution judge", invocation);
    const decoded = decodeAgentInvocation(invocation, {
      label: "Resolution judge",
    });
    if (!decoded.ok) {
      return {
        resolutions: [],
        error: decoded.error,
        cost: invocationCost(invocation),
        duration: invocationDuration(invocation),
      };
    }

    const resolutions = validateResolutions(decoded.resultObject.resolutions, openThreads);
    return {
      resolutions,
      raw: decoded.resultObject.resolutions ?? [],
      error: null,
      cost: invocationCost(invocation),
      duration: invocationDuration(invocation),
    };
  }

  // Cheap second pass: the check's own agent is told about open threads so it
  // mostly self-avoids repeats, but that's a prompt instruction, not a
  // guarantee. This is the enforced backstop, run only when there is something
  // to compare -- a fixed cheap model judging semantic (not just positional)
  // overlap against the existing open comments. Fails open (keeps every
  // finding) on any CLI or parsing error, since a missed duplicate just costs
  // one redundant comment while a false drop would silently swallow a real one.
  //
  // `recordAttempt`, when provided, lets the caller attach this attempt's
  // session/transcript to the per-phase evidence block in the check-run
  // summary.
  async function judgeDuplicates(check, checkThreads, accepted, recordAttempt) {
    if (accepted.length === 0 || checkThreads.length === 0)
      return { accepted, cost: 0, duration: 0 };

    const invocation = await runCheckAgent({
      slug: check.slug,
      suffix: "dedup",
      model: DEDUP_MODEL,
      cluster: DEDUP_CLUSTER,
      schemaText: JSON.stringify(DEDUP_SCHEMA),
      promptText: dedupPromptFor(check, checkThreads, accepted),
    });
    recordAttempt?.("Dedup judge", invocation);
    const decoded = decodeAgentInvocation(invocation, {
      label: "Duplicate judge",
    });
    if (!decoded.ok) {
      return {
        accepted,
        cost: invocationCost(invocation),
        duration: invocationDuration(invocation),
      };
    }

    const duplicateIndices = new Set(
      Array.isArray(decoded.resultObject.duplicate_indices) ?
        decoded.resultObject.duplicate_indices
      : [],
    );
    return {
      accepted: accepted.filter((_, index) => !duplicateIndices.has(index)),
      cost: invocationCost(invocation),
      duration: invocationDuration(invocation),
    };
  }

  // Runs an awaitable application-level mutation and records any failure under
  // `historyErrors` tagged with `errorLabel`. Returns true on success so the
  // caller can perform its own side effect (push to a tally, increment a
  // counter) only when the mutation actually took effect -- a failed mutation
  // silently skipping its tally update would let the dedup judge or summary
  // treat an unaddressed thread/review as resolved/minimized. Used by every
  // "best-effort" PR mutation in applyResolutions: post-reply, resolve thread,
  // dismiss review, minimize review.
  async function attemptHistory(operation, errorLabel, historyErrors) {
    try {
      await operation();
      return true;
    } catch (error) {
      historyErrors.push(`${errorLabel}: ${error.message ?? error}`);
      return false;
    }
  }

  // Applies the resolution judge's verdict: posts an audit reply on each thread
  // being resolved (so the resolution is explained and traceable, not a silent
  // disappearance), resolves it via GraphQL, and dismisses any review left with
  // nothing unresolved. Runs UNCONDITIONALLY in runCheck -- independent of the
  // check's own verdict this run -- so a fixed issue still gets resolved even
  // when the main review came back neutral. Best-effort: one resolve/dismiss
  // failure is recorded as a history error, not fatal to the check.
  async function applyResolutions(check, checkThreads, openThreads, judgment) {
    const historyErrors = [];
    const threadById = new Map(checkThreads.map(t => [t.threadId, t]));
    const openIds = new Set(openThreads.map(t => t.threadId));
    // GitHub may refuse resolveReviewThread even after this check posted its
    // audit reply. Re-attempt the mutation on every run, but never re-post the
    // same reply or ask the judge the same question again.
    const alreadyReplied = checkThreads
      .filter(thread => thread.resolutionReplied && !thread.isResolved)
      .map(thread => ({
        threadId: thread.threadId,
        evidence: "Previously judged resolved by this check.",
      }));
    const resolutions = [...judgment.resolutions, ...alreadyReplied];
    // Track only IDs whose resolveThread actually succeeded. reviewsToDismiss
    // and reviewsToHide honor this set, so a failed mutation keeps the parent
    // review visible. `resolvedOpenIds` counts only findings judged this run;
    // an already-replied thread is a retry, not a new still-open finding.
    const resolvedIds = [];
    const resolvedOpenIds = [];

    for (const { threadId, evidence } of resolutions) {
      // The caller already validated HEAD wasn't stale before applyResolutions
      // was entered, but the resolution judge above may have produced many
      // threads and each reply/resolve mutation is a live HTTP call -- a push
      // landing mid-loop would otherwise resolve/dismiss against a head that
      // no longer matches this check run. Aborting on any move keeps a stale
      // run from leaving marks on a newer PR's review threads. The small
      // added cost (`fetchLivePRHeadSha` makes one extra REST call per
      // resolution) only fires when the loop runs.
      if (await threadSafeStale()) break;
      const thread = threadById.get(threadId);
      // Comment-less threads can't receive an audit reply but still resolve.
      // A retry target already has its audit reply, so don't post a duplicate.
      // Best-effort: a reply failure is recorded but the resolve proceeds,
      // since an unexplained resolution is better than none.
      if (thread?.commentId != null && !thread.resolutionReplied) {
        await attemptHistory(
          () => postResolutionReply(check, thread, evidence),
          `reply ${thread.commentId}`,
          historyErrors,
        );
      }
      if (await threadSafeStale()) break;
      if (
        await attemptHistory(() => resolveThread(threadId), `resolve ${threadId}`, historyErrors)
      ) {
        resolvedIds.push(threadId);
        if (openIds.has(threadId)) resolvedOpenIds.push(threadId);
      }
    }

    const dismissIds = reviewsToDismiss(checkThreads, resolvedIds);
    // Successful dismissals only feed reviewsToHide below; failed/skipped
    // dismissals stay in `dismissIds` for history-error accounting but not
    // for hide targeting -- minimizing a summary whose state isn't actually
    // DISMISSED would leak that this run is about to do the dismiss.
    const dismissedThisRun = [];
    for (const reviewId of dismissIds) {
      if (await threadSafeStale()) break;
      if (
        await attemptHistory(
          () => dismissReview(reviewId),
          `dismiss review ${reviewId}`,
          historyErrors,
        )
      ) {
        dismissedThisRun.push(reviewId);
      }
    }

    // Hide review summaries that are fully resolved. reviewsToHide folds in two
    // independent qualifying paths (see its own doc comment): primarily, any
    // review with every one of this check's threads resolved -- regardless of
    // review state, so a COMMENTED review (what postReview() always creates,
    // and what dismissReview() can never touch) still gets hidden -- plus, as a
    // secondary path, reviews dismissed on THIS run (dismissedThisRun) or a
    // PRIOR run whose minimize step silently failed. Each minimize is
    // best-effort: a single failure must not block the rest, and for the
    // dismissed path a failure does not unsay the dismiss (the review state is
    // already DISMISSED on GitHub; only its visibility remains). resolvedIds is
    // passed through so a review whose last open thread was just resolved THIS
    // run (not yet reflected in checkThreads' start-of-run isResolved snapshot)
    // still qualifies via the primary path instead of waiting for a later run.
    const hideTargets = reviewsToHide(checkThreads, dismissedThisRun, resolvedIds);
    let hiddenCount = 0;
    for (const { reviewId, reviewGraphqlId } of hideTargets) {
      if (await threadSafeStale()) break;
      if (
        await attemptHistory(
          () => minimizeReview(reviewGraphqlId),
          `hide review ${reviewId}`,
          historyErrors,
        )
      ) {
        hiddenCount += 1;
      }
    }

    return {
      resolvedCount: resolvedIds.length,
      resolvedOpenCount: resolvedOpenIds.length,
      dismissedCount: dismissedThisRun.length,
      hiddenCount,
      historyErrors,
      resolutionError: judgment.error,
    };
  }

  // Wrap isStillLiveHead so the per-mutation loop in applyResolutions is
  // reversible at any point: a stale head returns true (meaning "stop the
  // loop") without throwing, because the caller still has to record the
  // outcome it produced up to that point. The throw in runCheck below
  // happens once, at the first mutation, to abandon the whole check on a
  // stale head -- this helper is for in-loop reuse where throwing would
  // skip the summary writing.
  async function threadSafeStale() {
    try {
      return !(await isStillLiveHead());
    } catch {
      // Treat a transient GitHub error as "still live" rather than aborting:
      // a flapping PR fetch mid-run is more likely than a real head move,
      // and the destructiveness of stopping on it (missed resolutions) is
      // higher than the destructiveness of continuing (one extra resolve
      // against a momentarily-stale head).
      return false;
    }
  }

  // Posts a reply on the opening comment of a thread about to be resolved,
  // carrying the judge's own evidence so the resolution is auditable rather
  // than a silent disappearance. GitHub collapses resolved threads, so without
  // this a reviewer has no way to see why something was marked done. The reply
  // carries the check marker only as a trailing tag -- threadsForCheck reads
  // the thread's FIRST comment, so a reply never registers as a new thread.
  // Best-effort: a failure is recorded by the caller and the resolve proceeds.
  async function postResolutionReply(check, thread, evidence) {
    await github(
      HTTP_METHOD.POST,
      `repos/${REPOSITORY}/pulls/${PR_NUMBER}/comments/${thread.commentId}/replies`,
      {
        body: MARKERS.append(
          `${RESOLUTION_REPLY_PREFIX}${childCheckRunName(BRANDING, check)}.**\n\n${evidence}`,
          check.slug,
        ),
      },
    );
  }

  // Runs the deduplication backstop and formats the survivors as postable review
  // comments tagged with this check's marker (so a future run can recognize
  // them). Only called when the check's own verdict is non-neutral, since a
  // neutral run has no new findings to dedup or post.
  //
  // `recordAttempt`, when provided, is forwarded to the dedup judge so the
  // invocation's transcript reaches the per-phase evidence block.
  async function applyFindings(check, checkThreads, result, recordAttempt) {
    const dedup = await judgeDuplicates(check, checkThreads, result.accepted ?? [], recordAttempt);
    const dedupDropped = (result.accepted?.length ?? 0) - dedup.accepted.length;
    const comments = dedup.accepted.map(suggestion => {
      const comment = formatReviewComment(suggestion);
      return { ...comment, body: MARKERS.append(comment.body, check.slug) };
    });

    return {
      ...result,
      // The surviving findings, unformatted, for a summary that lists them
      // itself when inline comments are off.
      findings: dedup.accepted,
      comments,
      dedupDropped,
      cost: totalCost([result.cost, dedup.cost]),
      duration: totalDuration([result.duration, dedup.duration]),
    };
  }

  async function postReview(check, result) {
    if (result.comments.length === 0) return;
    // GitHub rejects a review whose line comments omit `side` (and multi-line
    // comments omit `start_side`). All the comments here anchor to the PR's
    // HEAD (= the check's `commit_id` and RIGHT in line-colloquial terms), so
    // stamp both to RIGHT explicitly on every one -- including multi-line
    // suggestions whose start_line differs from line.
    const comments = result.comments.map(comment => ({
      ...comment,
      side: "RIGHT",
      ...(comment.start_line !== undefined ? { start_side: "RIGHT" } : {}),
    }));
    await github(HTTP_METHOD.POST, `repos/${REPOSITORY}/pulls/${PR_NUMBER}/reviews`, {
      commit_id: HEAD_SHA,
      // Use a COMMENT review so the check run's own conclusion, rather than
      // GitHub's separate review-approval gate, controls merge requirements.
      event: REVIEW_EVENT.COMMENT,
      body: `**${childCheckRunName(BRANDING, check)}**\n\n${result.reason}`,
      comments,
    });
  }

  async function completeCheckRun(state) {
    const { check, checkRunId, result } = state;
    const costErrors = COST_ERRORS.get(check.slug);
    // every non-PASS outcome -- FAIL verdict, operational error (CLI crash,
    // structured-output miss, dedup-eliminated finding, etc.) -- publishes as
    // neutral, never failure. See the top-of-file rationale: the underlying
    // issues are still surfaced as review comments and there is no workflow
    // event for "conversation resolved" to flip a red check green when a
    // human dismisses the finding, so red is the wrong signal here.
    const conclusion =
      result.outcome === OUTCOME.PASS ? GITHUB_CONCLUSION.SUCCESS : GITHUB_CONCLUSION.NEUTRAL;
    // Cost is the most-watched number on the status-checks list (people open it
    // from the PR header and the table is the first thing visible), so surface
    // it in the title seen next to the check name, not only in the body. The
    // full cost + duration line is repeated inside the summary so the check
    // detail page shows the same number without scrolling.
    const costLine = `Cost ${formatUsd(state.cost)} · ${formatDuration(state.durationMs)}`;
    // Build the summary as an ordered list of CHUNKS rather than lines: the
    // transcripts block is multi-line (one <details> per phase, with its own
    // paragraphs and fences inside), so any collapse-on-overflow logic that
    // filters at the LINE level would either split a code fence or drop a
    // partial phase. Leaving the chunk boundary coarse-grained means the
    // overflow path can drop the entire transcript block (or the entire
    // suggestion tally) without mangling braces and fences.
    // Only ever read when outcome !== NEUTRAL (see conditionalLines below), but
    // computed unconditionally -- a NEUTRAL result (CLI crash, 400 from the
    // router, structured-output miss) carries no
    // comments/proseFallbacks/rejected/dedupDropped
    // at all, so an eager read here throws before the gate below even applies,
    // masking the real error behind "Cannot read properties of undefined".
    const tallyLine =
      result.outcome === OUTCOME.NEUTRAL ?
        ""
      : `${result.comments.length} findings posted; ${result.proseFallbacks.length} converted to prose before duplicate filtering because an unsafe range or replacement was removed; ${result.rejected.length} dropped after anchor validation; ${result.dedupDropped} dropped as duplicates of already-flagged comments.`;
    const conditionalLines = [
      result.outcome === OUTCOME.NEUTRAL ? `Error: ${result.error}` : result.reason,
      result.outcome !== OUTCOME.NEUTRAL ? tallyLine : null,
      result.resolvedCount ?
        `Resolved ${result.resolvedCount} previously-flagged thread(s).`
      : null,
      result.stillOpenCount ?
        `${result.stillOpenCount} previously-flagged thread(s) still open.`
      : null,
      result.dismissedCount ? `Dismissed ${result.dismissedCount} fully-resolved review(s).` : null,
      result.hiddenCount ?
        `Hid ${result.hiddenCount} dismissed review summary(s) (resolved reason).`
      : null,
      result.resolutionError ? `Resolution judge error: ${result.resolutionError}` : null,
      result.historyErrors?.length ? `History errors: ${result.historyErrors.join("; ")}` : null,
      costErrors?.length ? `Cost lookup errors: ${costErrors.join("; ")}` : null,
    ].filter(line => line !== null);
    const transcripts = transcriptsSection(state);
    // Each chunk is the (now-filtered) plaintext header/separator plus the
    // optional transcripts section. Building them as separate blocks makes
    // the overflow handler below a trivial "drop chunk N" rather than a
    // multi-line string scan. The separators are real `""` chunks that join()
    // renders as a blank line -- filtering only `null` (not `""`) is what
    // makes that gap actually show up in the posted summary.
    const buildChunks = withTranscripts => {
      const transcriptChunk = withTranscripts ? transcripts : null;
      return [
        costLine,
        "",
        ...conditionalLines,
        // Only include the second gap when there's a collapsible below it --
        // no transcript chunk means no gap to open one, so nothing to show.
        transcriptChunk === null ? null : "",
        transcriptChunk,
      ].filter(chunk => chunk !== null);
    };
    // First attempt: include the transcripts section. If the joined summary
    // exceeds the documented 65535-byte limit, drop the transcripts chunk
    // first -- the diagnostic artifact on disk still has the full JSONL,
    // so dropping is recoverable, not lossy.
    let summary = buildChunks(true).join("\n");
    if (Buffer.byteLength(summary, "utf8") > MAX_CHECK_RUN_SUMMARY_BYTES) {
      summary = buildChunks(false).join("\n");
      // Belt-and-braces: if even the transcript-free summary exceeds the
      // cap (which the conditional lines are engineered to avoid), collapse
      // to cost + reason only. The PATCH must succeed; the cost line + reason
      // already encode the operationally relevant answer for a reader who
      // would otherwise have no summary at all.
      if (Buffer.byteLength(summary, "utf8") > MAX_CHECK_RUN_SUMMARY_BYTES) {
        summary = [
          costLine,
          "",
          result.outcome === OUTCOME.NEUTRAL ? `Error: ${result.error}` : result.reason,
        ].join("\n");
      }
    }

    const payload = {
      status: CHECK_RUN_STATUS.COMPLETED,
      conclusion,
      output: {
        // GitHub renders this title to the RIGHT of the check name on the PR's
        // status-checks list, so the check name itself is already in the
        // display -- prefixing it again ("Weave Check / X: pass") is redundant
        // and clutters the line. Outcome + cost is the only info that needs to
        // ride alongside the check name.
        title: `${result.outcome} · ${formatUsd(state.cost)}`,
        summary,
      },
    };

    await github(HTTP_METHOD.PATCH, checkRunPath(checkRunId), payload);
  }

  async function updateMaster(final = false) {
    const all = [...states.values()];
    const running = all.filter(state => state.status === STATUS.RUNNING).length;
    const queued = all.filter(state => state.status === STATUS.QUEUED).length;
    const pass = all.filter(state => state.outcome === OUTCOME.PASS).length;
    // "fail" here is just the internal OUTCOME.FAIL counter -- every external
    // check-run conclusion for those states is already neutral (see
    // completeCheckRun). The tally stays distinct in the table because the
    // top-line summary shows where findings landed; the *conclusion* on the
    // PR status row is neutral for ALL of them.
    const fail = all.filter(state => state.outcome === OUTCOME.FAIL).length;
    const neutral = all.filter(state => state.outcome === OUTCOME.NEUTRAL).length;
    const complete = all.filter(state => state.status === STATUS.COMPLETE);
    const totalCostUsd = totalCost(complete.map(state => state.cost));
    const totalDurationMs = totalDuration(complete.map(state => state.durationMs));
    const hasCompleteMetrics =
      complete.length > 0 &&
      complete.every(state => Number.isFinite(state.cost) && Number.isFinite(state.durationMs));

    const header =
      hasCompleteMetrics ?
        `**${BRANDING.aggregateName}** — ${pass} passed · ${fail} flagged · ${neutral} neutral · ${running} running · ${queued} queued — ${formatUsd(totalCostUsd)} total (${PROVIDER_IMPL.costLabel}), ${formatDuration(totalDurationMs)}`
      : `**${BRANDING.aggregateName}** — ${pass} passed · ${fail} flagged · ${neutral} neutral · ${running} running · ${queued} queued`;

    const summary = [
      header,
      "",
      "| Check | Status | Cost | Duration | Current detail |",
      "| --- | --- | --- | --- | --- |",
      ...all.map(state => {
        // An unpriced row has cost/durationMs set to null -- formatUsd/
        // formatDuration render those as "—" rather than a misleading
        // "$0.00"/"0s" for metrics that simply weren't recorded.
        const cost = state.status === STATUS.COMPLETE ? formatUsd(state.cost) : "—";
        const duration = state.status === STATUS.COMPLETE ? formatDuration(state.durationMs) : "—";
        return `| ${state.check.name} | ${statusLabel(state)} | ${cost} | ${duration} | ${markdownCell(state.note)} |`;
      }),
    ].join("\n");

    writeFileSync(SUMMARY_PATH, `${summary}\n`);

    // Title still distinguishes pass/fail/neutral in the running count -- it's
    // an internal tally for ops, not the GitHub conclusion. "fail" here means
    // "agent verdict was FAIL", which now publishes as `neutral` on the PR
    // status row but is still useful to enumerate when scanning the table.
    const payload = {
      output: {
        title:
          final ?
            hasCompleteMetrics ?
              `${BRANDING.aggregateName}: ${pass} pass · ${fail} flagged · ${neutral} neutral · ${formatUsd(totalCostUsd)}`
            : `${BRANDING.aggregateName}: ${pass} pass · ${fail} flagged · ${neutral} neutral`
          : hasCompleteMetrics ?
            `${BRANDING.aggregateName}: ${pass} pass · ${fail} flagged · ${neutral} neutral · ${running} running · ${formatUsd(totalCostUsd)}`
          : `${BRANDING.aggregateName}: ${running} running · ${queued} queued`,
        summary,
      },
    };
    if (final) {
      payload.status = CHECK_RUN_STATUS.COMPLETED;
      // A child FAIL verdict no longer paints the aggregate red either:
      // child-check findings are advisory and already surfaced on their own
      // check runs, and there is no "conversation resolved" event to flip a
      // red aggregate green. The aggregate goes `success` only when every
      // child PASSed; any non-PASS outcome (FAIL, operational error, the
      // child itself never ran because the coordinator crashed before
      // reaching it) collapses to neutral. A `failure` conclusion is only
      // reachable via a top-level coordinator error -- which still applies;
      // this branch is downstream of that and has already filtered it out.
      payload.conclusion =
        pass === all.length && all.length > 0 ?
          GITHUB_CONCLUSION.SUCCESS
        : GITHUB_CONCLUSION.NEUTRAL;
      // The next run reads this back to decide whether it may narrow its diff
      // to `HEAD_SHA..<new head>`. It is deliberately NOT the conclusion above:
      // that collapses a FAIL verdict and a crashed CLI into the same
      // `neutral`, and a fix iteration -- the case this whole feature exists
      // for -- normally has findings. everyCheckReviewed() asks the question
      // the conclusion cannot: did every check finish reading the diff?
      // Absent marker means "assume not", which costs a wider diff next run.
      if (everyCheckReviewed(all)) {
        payload.external_id = formatReviewedMarker(HEAD_SHA);
      }
    }
    await github(HTTP_METHOD.PATCH, checkRunPath(MASTER_CHECK_RUN_ID), payload);
  }

  // Serializes and coalesces the mid-run aggregate repaints, and never lets one
  // fail a check.
  //
  // Two problems it solves:
  //
  // 1. A repaint is cosmetic -- the table is rewritten on the next result and
  //    once more at the end of the run -- but it was awaited from outside
  //    runCheck's try block, so a single 503 on it unwound the worker pool and
  //    abandoned every remaining check. Swallowing the error (after
  //    githubapi.mjs has already retried it) is the correct blast radius: the
  //    run continues and the next repaint carries the missed state anyway.
  //
  // 2. With a 16-wide pool, every check start and every check result
  //    fires a PATCH against the SAME check run -- concurrent writes to one
  //    resource are exactly the shape GitHub answers with a
  //    secondary-rate-limit 403. At most one PATCH is in flight here, with at
  //    most one more queued behind it; a third caller collapses into that
  //    queued one, which reads whatever `states` holds when it actually runs
  //    and is therefore fresher than what the collapsed caller would have sent.
  //
  // The FINAL update deliberately does not go through here: it carries the
  // aggregate's conclusion, so it must be serial with respect to these repaints
  // (see the drain in the top-level block) and must be loud when it fails.
  let masterUpdateChain = Promise.resolve();
  let masterUpdateQueued = false;

  function updateMasterBestEffort() {
    if (masterUpdateQueued) return masterUpdateChain;
    masterUpdateQueued = true;
    masterUpdateChain = masterUpdateChain.then(async () => {
      // Cleared before the PATCH, not after: a caller arriving while this one is
      // in flight should be able to queue a trailing repaint carrying its state.
      masterUpdateQueued = false;
      try {
        await updateMaster();
      } catch (error) {
        console.error(
          `Weave Checks: aggregate status update failed, continuing: ${error.message ?? error}`,
        );
      }
    });
    return masterUpdateChain;
  }

  async function runCheck(state, rawThreadNodes) {
    const { check } = state;
    state.status = STATUS.RUNNING;
    state.note = `${check.description} Agent is reviewing changed lines.`;

    const checkThreads = threadsForCheck(rawThreadNodes, check.slug, MARKERS);
    const openThreads = checkThreads.filter(thread => !isSettled(thread));

    // Per-phase transcript evidence for the check-run summary's collapsible
    // section. Each entry is { phase, sessions:[{label,sessionId,text}] };
    // the summary builds one <details> per phase so a reviewer can drill into
    // the agent's reasoning without scrolling past the dedup tally above it.
    // Initialized per phase so calls can append without one phase's failure
    // (e.g. resolution judge skipping on zero open threads) hiding the others.
    const transcriptSessions = {
      [TRANSCRIPT_PHASE.MAIN]: [],
      [TRANSCRIPT_PHASE.RESOLVE]: [],
      [TRANSCRIPT_PHASE.DEDUP]: [],
    };
    const recordAttempt = (phase, label, invocation) => {
      transcriptSessions[phase].push({
        label,
        sessionId: invocation.sessionId,
        // The provider-reported cost is what the check-run summary carries
        // for this attempt; threading it (and how it was measured) onto each
        // session record lets the summary header show it next to the session
        // id, alongside the per-event projection it already shows.
        cost: invocation.cost,
        costLabel: invocation.costLabel,
        // `transcript` is the parsed array of raw JSONL lines; rejoined the
        // same way runClaude() (could have) so the on-disk bytes and the in-
        // summary bytes agree at the byte level minus trailing-newline noise.
        text: invocation.transcript.join("\n"),
      });
    };

    // Hoisted out of the try block so a throw partway through (e.g. a stale-head
    // abort, or a GitHub mutation failure) still lets the catch below report
    // whatever agent phases actually ran, instead of the neutral fallback
    // silently reporting zero cost/duration for spend that already happened.
    let initialResult = null;
    let judgment = null;
    let result = null;

    try {
      // Inside the try, not before it: creating the per-check run is a GitHub
      // write like any other, so a failure here has to neutral out this one
      // check rather than throw out of runPool and abandon every other check. The
      // completeCheckRun call below is skipped when it leaves checkRunId null.
      const run = await createCheckRun(check);
      state.checkRunId = run.id;
      await updateMasterBestEffort();

      // Independent of each other by design: the resolution judge answers "do
      // this check's past findings still apply", the main agent answers "does
      // this diff introduce a new violation". Running them concurrently costs
      // no extra wall-clock and means a resolution still lands even if the
      // main agent's run this time comes back neutral.
      [initialResult, judgment] = await Promise.all([
        evaluate({
          check,
          diff: DIFF,
          stat: STAT,
          addedLines: ADDED_LINES,
          schemaText: SCHEMA,
          historySection: formatHistorySection(checkThreads),
          productName: BRANDING.productName,
          onAttempt: (label, invocation) => recordAttempt(TRANSCRIPT_PHASE.MAIN, label, invocation),
          ...agentEnvironment(),
        }),
        judgeResolutions(check, openThreads, (label, invocation) =>
          recordAttempt(TRANSCRIPT_PHASE.RESOLVE, label, invocation),
        ),
      ]);

      // Both agent calls above can each take minutes -- re-check the live head
      // immediately before the first GitHub mutation (resolving/dismissing
      // threads) rather than trusting the one-time check the top-level try
      // block made before this check even started. See isStillLiveHead().
      if (!(await isStillLiveHead())) {
        throw new Error(
          `PR #${PR_NUMBER} head moved on from ${HEAD_SHA} during this check's run; aborting before mutating threads`,
        );
      }

      const resolutionOutcome = await applyResolutions(check, checkThreads, openThreads, judgment);

      result = initialResult;
      if (result.outcome !== OUTCOME.NEUTRAL) {
        result = await applyFindings(check, checkThreads, result, (label, invocation) =>
          recordAttempt(TRANSCRIPT_PHASE.DEDUP, label, invocation),
        );
        if (result.outcome === OUTCOME.FAIL && result.comments.length === 0) {
          // Every accepted suggestion turned out to duplicate an already-flagged
          // comment (open or dismissed) -- nothing new was posted, so the check
          // found no new violation. The still-open reconciliation below turns
          // this back to FAIL if any of those duplicates are still actionable;
          // otherwise a dismissed or resolved finding must not leave the check
          // in a flagged state with no comment a human can act on.
          result = {
            ...result,
            outcome: OUTCOME.PASS,
            reason: `No new violations in this diff: all ${result.dedupDropped} finding(s) were already flagged on this PR.`,
          };
        } else if (result.outcome === OUTCOME.FAIL && result.comments.length > 0) {
          // applyFindings() just made its own Claude call (the dedup judge), so
          // re-check the live head again rather than trusting the check made
          // before applyResolutions above.
          if (!(await isStillLiveHead())) {
            throw new Error(
              `PR #${PR_NUMBER} head moved on from ${HEAD_SHA} during this check's run; aborting before posting a review`,
            );
          }
          try {
            await postReview(check, result);
          } catch (error) {
            // Preserve the cost/duration already spent on the main review and
            // dedup judge above -- a failure to post shouldn't erase spend that
            // already happened.
            result = {
              outcome: OUTCOME.NEUTRAL,
              error: `Could not post review: ${error.message}`,
              cost: result.cost,
              duration: result.duration,
            };
          }
        }
      }
      result = {
        ...result,
        ...resolutionOutcome,
        stillOpenCount: openThreads.length - resolutionOutcome.resolvedOpenCount,
      };
      // A thread the resolution judge left open counts as a live issue even
      // when this run's own review passed or errored -- otherwise a check could
      // go green while its own unresolved comments still sit on the PR.
      // The reason is rewritten too: leaving a PASS reason on a flagged row
      // reads as a contradiction. An operational error (outcome "neutral")
      // stays neutral regardless -- an error is never a pass, and its own
      // error text is more useful than this one.
      if (result.outcome === OUTCOME.PASS && result.stillOpenCount > 0) {
        result.outcome = OUTCOME.FAIL;
        result.reason = `No new violations in this diff, but ${result.stillOpenCount} previously-flagged issue(s) from this check are still open on this PR.`;
      }

      writeFileSync(
        resultPath(TEMP_DIR, check.slug, "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      writeFileSync(
        resultPath(TEMP_DIR, check.slug, "resolutions.json"),
        `${JSON.stringify(judgment.raw ?? [], null, 2)}\n`,
      );
      state.result = result;
      state.outcome = result.outcome;
      state.status = STATUS.COMPLETE;
      state.cost = totalCost([result.cost, judgment.cost]);
      state.durationMs = totalDuration([result.duration, judgment.duration]);
      // Attach the per-phase transcript evidence so completeCheckRun can render
      // the collapsible reviewer's-transcript section below the existing
      // summary lines. Empty phases are intentional: a phase that didn't run
      // is omitted from the section by formatTranscriptSection's own filter.
      state.transcriptSessions = transcriptSessions;
      state.note = result.outcome === OUTCOME.NEUTRAL ? result.error : result.reason;
    } catch (error) {
      state.result = {
        outcome: OUTCOME.NEUTRAL,
        error: error.message ?? String(error),
      };
      state.outcome = OUTCOME.NEUTRAL;
      state.status = STATUS.COMPLETE;
      state.note = state.result.error;
      // The throw can land after the agent phases already ran (e.g. a
      // stale-head abort or a GitHub mutation failure) -- report whatever
      // spend actually happened instead of silently zeroing it out. `result`
      // (post-dedup, if applyFindings ran) supersedes `initialResult` when
      // present since dedup's cost/duration are already folded into it.
      state.cost = totalCost([(result ?? initialResult)?.cost, judgment?.cost]);
      state.durationMs = totalDuration([(result ?? initialResult)?.duration, judgment?.duration]);
      // Same reasoning as the cost/duration preservation above: whatever
      // phases ran before the throw already produced transcript evidence, and
      // a stale-head abort or mutation failure is exactly when a reader most
      // needs to see what the agent did. transcriptSessions is populated
      // in-place by recordAttempt() as each phase completes, so it already
      // reflects everything that ran regardless of where the throw landed.
      state.transcriptSessions = transcriptSessions;
    }

    if (state.checkRunId === null) {
      // createCheckRun never returned an id (it exhausted its retries), so
      // there is no per-check run to publish this outcome on -- the aggregate
      // table row is the only place a reader will see it. Say why, rather than
      // leaving a bare API error in a row whose check never appeared on the PR.
      state.note = `Could not create check run: ${state.note}`;
    } else {
      try {
        await completeCheckRun(state);
      } catch (error) {
        // Keep the master current even if an individual check-run update failed.
        state.outcome = OUTCOME.NEUTRAL;
        state.note = `Could not complete check run: ${error.message}`;
      }
    }
    await updateMasterBestEffort();
  }

  async function runQueuedChecks(rawThreadNodes) {
    const queued = [...states.values()].filter(state => state.status === STATUS.QUEUED);
    await runPool(queued, CONCURRENCY, async state => {
      try {
        await runCheck(state, rawThreadNodes);
      } catch (error) {
        // runCheck is written to absorb its own failures, so reaching here means
        // something outside its handlers threw (a bug in the summary builder, an
        // OOM, a malformed history item). Contain it to this one check: runPool
        // is a generic pool, so an exception escaping this callback rejects the
        // whole pool, abandons every still-queued check, and races the crash
        // path's aggregate PATCH against in-flight repaints -- the exact failure
        // mode the per-check catch exists to prevent.
        console.error(
          `Weave Checks: check "${state.check.slug}" threw outside its own handler: ${error.stack ?? error}`,
        );
        state.status = STATUS.COMPLETE;
        state.outcome = OUTCOME.NEUTRAL;
        state.note = `Coordinator error: ${error.message ?? error}`;
      }
    });
  }

  try {
    if (DIFF.trim() === "") {
      // Every path this PR touches is excluded by the checks directory's ignore
      // file (PR preparation applies it to `git diff` itself), so there is
      // nothing for any check to look at. Close the aggregate green and create
      // no per-check runs: queueing the full matrix here would pay for every
      // check to conclude, separately, that an empty diff contains no
      // violations.
      //
      // An incremental review base cannot reach this branch with threads left
      // to resolve: PR preparation widens the review scope back to the merge
      // base whenever it would otherwise hand us an empty diff over a
      // non-empty PR, precisely so skipping the checks never also skips the
      // resolution judge.
      //
      // The aggregate is the only run branch protection waits on, so publishing
      // it as `success` here is what unblocks the PR -- the per-check runs it
      // normally summarizes are never created in this path.
      console.log(
        `${BRANDING.aggregateName}: no changed paths outside ${IGNORE_FILE}; skipping every check`,
      );
      await github(HTTP_METHOD.PATCH, checkRunPath(MASTER_CHECK_RUN_ID), {
        status: CHECK_RUN_STATUS.COMPLETED,
        conclusion: GITHUB_CONCLUSION.SUCCESS,
        // Marked reviewed even though no check ran: nothing here was left
        // unread, because there was nothing to read. Withholding the marker
        // would let an ignored-paths-only push pin the review base until some
        // later run happened to re-establish it.
        external_id: formatReviewedMarker(HEAD_SHA),
        output: {
          title: `${BRANDING.aggregateName}: no reviewable changes`,
          summary:
            `Every path changed by this PR is excluded by \`${IGNORE_FILE}\`, ` +
            "so no check ran.",
        },
      });
      writeResults([]);
      writeFileSync(COMPLETE_PATH, `${RUN_MARKER.NO_REVIEWABLE_CHANGES}\n`);
      return { ok: true, marker: RUN_MARKER.NO_REVIEWABLE_CHANGES };
    }

    states = buildStates();
    await updateMasterBestEffort();

    // Best-effort: a history-fetch failure (rate limit, transient API error)
    // shouldn't block the run -- checks still run and post, just without
    // cross-run memory for this one pass.
    let rawThreadNodes = [];
    try {
      rawThreadNodes = await fetchAllReviewThreads();
    } catch (error) {
      console.error(
        `${BRANDING.aggregateName}: failed to fetch review thread history: ${error.stack ?? error}`,
      );
    }

    await runQueuedChecks(rawThreadNodes);
    await updateMaster(true);
    writeResults([...states.values()]);
    writeFileSync(COMPLETE_PATH, `${RUN_MARKER.COMPLETED}\n`);
    return { ok: true, marker: RUN_MARKER.COMPLETED, states: [...states.values()] };
  } catch (error) {
    console.error(`${BRANDING.aggregateName} worker fatal: ${error.stack ?? error}`);
    // A top-level coordinator error means the aggregate cannot represent the
    // child checks reliably. Even so, this also publishes as `neutral` in
    // step with the rest of the file -- a non-PASS outcome never goes red.
    // A child FAIL verdict can't paint the aggregate red, and a coordinator
    // crash shouldn't either: the workflow run's own failure badge and the
    // step summary already say something went wrong.
    let finalisedAggregate = false;
    try {
      await github(HTTP_METHOD.PATCH, checkRunPath(MASTER_CHECK_RUN_ID), {
        status: CHECK_RUN_STATUS.COMPLETED,
        conclusion: GITHUB_CONCLUSION.NEUTRAL,
        output: {
          title: `${BRANDING.aggregateName}: coordinator error`,
          summary: fallbackSummary(error),
        },
      });
      finalisedAggregate = true;
    } catch {}
    // Only mark the run as complete if our PATCH succeeded: the action's
    // always-on cleanup step (close-aggregate) treats this marker as "the
    // worker already closed the run, no-op". Writing it unconditionally would
    // leave the aggregate stuck `in_progress` if the PATCH above was itself
    // swallowed by a transient API error -- the cleanup PATCH would never get a
    // chance to retry. When the PATCH failed, leave the marker absent so the
    // cleanup step gives it one more try (with a generic "coordinator stopped"
    // summary; the specific String(error) is already in the job log).
    if (finalisedAggregate) {
      writeFileSync(COMPLETE_PATH, `${RUN_MARKER.CRASHED}\n`);
    }
    return { ok: false, error };
  }

  // Writes RESULTS_PATH: one entry per check plus totals, in the public
  // outcome vocabulary ("flagged", not "fail"). Written only for a pass that
  // finished; a crashed pass leaves no results rather than partial ones.
  function writeResults(finalStates) {
    if (config.resultsPath === null) return;
    const count = outcome => finalStates.filter(state => state.outcome === outcome).length;
    const results = {
      provider: PROVIDER_IMPL.id,
      costLabel: PROVIDER_IMPL.costLabel,
      headSha: HEAD_SHA,
      aggregateCheckRunId: MASTER_CHECK_RUN_ID,
      checks: finalStates.map(state => ({
        slug: state.check.slug,
        name: state.check.name,
        intelligence: state.check.intelligence,
        model: state.check.model,
        outcome: publicOutcome(state.outcome),
        checkRunId: state.checkRunId,
        cost: state.cost ?? null,
        durationMs: state.durationMs ?? null,
        detail: state.note ?? null,
      })),
      totals: {
        pass: count(OUTCOME.PASS),
        flagged: count(OUTCOME.FAIL),
        neutral: count(OUTCOME.NEUTRAL),
        cost: totalCost(finalStates.map(state => state.cost)),
        durationMs: totalDuration(finalStates.map(state => state.durationMs)),
      },
    };
    writeFileSync(config.resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  }

  // Summary for the top-level catch's closing PATCH. A coordinator error can
  // land AFTER every check already ran and published its own run -- the final
  // aggregate PATCH exhausting its retries is exactly that case -- and closing
  // the aggregate with nothing but a stack trace would throw away every real
  // verdicts a reader can still act on. updateMaster() writes SUMMARY_PATH
  // before it PATCHes, so the file holds the newest table even when the PATCH
  // that would have published it failed.
  function fallbackSummary(error) {
    const detail = String(error);
    // undefined only when the crash beat buildStates(), i.e. no check ever ran.
    if (states === undefined) return detail;
    let table;
    try {
      table = readFileSync(SUMMARY_PATH, "utf8");
    } catch {
      return detail;
    }
    const combined = `${detail}\n\n${table}`;
    return Buffer.byteLength(combined, "utf8") > MAX_CHECK_RUN_SUMMARY_BYTES ? detail : combined;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function statusLabel(state) {
  if (state.status === STATUS.QUEUED) return "queued";
  if (state.status === STATUS.RUNNING) return "running";
  // No "fail" label anymore -- a non-PASS outcome (FAIL verdict,
  // operational error) renders as neutral on the summary table too, so
  // the table agrees with the per-check run's conclusion.
  return state.outcome === OUTCOME.PASS ? "✓ pass" : "· neutral";
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .slice(0, 350);
}

// Joins every transcript phase into a single block of <details>...`</details>`
// elements, one per phase, ready to append to the summary. Returns null (so
// the upstream .filter() drops it) when no phase produced an attempt at all --
// a check whose run was operational-error-only should not surface an empty
// collapsible that confuses a reader looking for the verdict's reasoning.
function transcriptsSection(state) {
  const sessions = state.transcriptSessions;
  const blocks = [
    formatTranscriptSection("Reviewer", sessions.main),
    formatTranscriptSection("Resolution judge", sessions.resolve),
    formatTranscriptSection("Dedup judge", sessions.dedup),
  ].filter(block => block !== "");
  if (blocks.length === 0) return null;
  return blocks.join("\n\n");
}

async function main() {
  const outcome = await runWorker(readWorkerConfig(process.env));
  if (!outcome.ok) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    // readWorkerConfig() threw: nothing was touched on GitHub, so the action's
    // cleanup step is what closes the aggregate.
    console.error(`Weave Checks worker could not start: ${error.stack ?? error}`);
    process.exitCode = 1;
  }
}
