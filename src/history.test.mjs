import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REVIEW_STATE } from "./parse.mjs";

// Mirror history.mjs's cap so the overflow-by-one test can size its fixtures
// exactly. If history.mjs bumps this, the overflow test will start passing
// trivially; bumping both keeps the boundary check meaningful.
const MAX_HISTORY_THREADS_FOR_TEST = 200;

import {
  appendMarker,
  extractMarkerSlug,
  extractThreadsPage,
  formatHistorySection,
  formatMarker,
  formatResolutionSection,
  markerCodec,
  reviewsToDismiss,
  reviewsToHide,
  stripMarker,
  threadDiffEvidence,
  threadsForCheck,
  validateResolutions,
} from "./history.mjs";

describe("marker round-trip", () => {
  it("appends and extracts a marker", () => {
    const body = appendMarker("Consider adding a nil check here.", "anti-slop");
    assert.equal(extractMarkerSlug(body), "anti-slop");
    assert.equal(stripMarker(body), "Consider adding a nil check here.");
  });

  it("returns null for a comment with no marker", () => {
    assert.equal(extractMarkerSlug("Just a human comment."), null);
  });

  it("survives a trailing suggestion block", () => {
    const body = appendMarker("Fix this.\n\n```suggestion\nfixed()\n```", "anti-slop");
    assert.equal(extractMarkerSlug(body), "anti-slop");
    assert.match(stripMarker(body), /```suggestion/);
  });

  // A generated comment (e.g. an audit reply) can quote another marker
  // earlier in its own body -- only the trailing marker appendMarker itself
  // wrote is authoritative.
  it("matches the trailing marker, not one quoted earlier in the body", () => {
    const quoted = appendMarker("Original finding.", "mobile-layout");
    const reply = appendMarker(`**Resolved.** Was flagged as:\n\n> ${quoted}`, "anti-slop");
    assert.equal(extractMarkerSlug(reply), "anti-slop");
  });

  it("formats the exact marker string", () => {
    assert.equal(formatMarker("mobile-layout"), "<!-- weave-check:mobile-layout -->");
  });
});

describe("markerCodec", () => {
  const acme = markerCodec("acme-review");

  it("writes only the configured prefix", () => {
    assert.equal(acme.format("naming"), "<!-- acme-review:naming -->");
    assert.equal(acme.append("Rename this.", "naming"), "Rename this.\n\n<!-- acme-review:naming -->");
  });

  it("reads its own markers", () => {
    const body = acme.append("Rename this.", "naming");
    assert.equal(acme.extractSlug(body), "naming");
    assert.equal(acme.strip(body), "Rename this.");
  });

  // Comments already on a PR from before the rebrand carry the legacy marker;
  // dropping them would make every old finding look new to the dedup judge.
  it("still reads legacy weave-check markers", () => {
    const legacy = appendMarker("Old finding.", "naming");
    assert.equal(acme.extractSlug(legacy), "naming");
    assert.equal(acme.strip(legacy), "Old finding.");
  });

  it("ignores another tool's marker", () => {
    assert.equal(acme.extractSlug("Hi.\n\n<!-- other-tool:naming -->"), null);
  });

  it("is the legacy codec by default", () => {
    assert.equal(markerCodec().format("x"), formatMarker("x"));
  });

  it("classifies threads by either marker", () => {
    const node = (id, body) => ({
      id,
      isResolved: false,
      isOutdated: false,
      path: "a.go",
      line: 1,
      comments: { nodes: [{ databaseId: 1, body, pullRequestReview: { databaseId: 9, id: "R", state: "COMMENTED" } }] },
    });
    const threads = threadsForCheck(
      [node("T1", appendMarker("legacy", "naming")), node("T2", acme.append("new", "naming")), node("T3", acme.append("other", "dead-code"))],
      "naming",
      acme,
    );
    assert.deepEqual(threads.map((t) => [t.threadId, t.comment]), [["T1", "legacy"], ["T2", "new"]]);
  });
});

describe("extractThreadsPage", () => {
  it("extracts nodes and pageInfo", () => {
    const data = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "abc" },
            nodes: [{ id: "T1" }],
          },
        },
      },
    };
    const page = extractThreadsPage(data);
    assert.deepEqual(page.nodes, [{ id: "T1" }]);
    assert.equal(page.pageInfo.hasNextPage, true);
  });

  it("throws when the response shape is missing reviewThreads", () => {
    assert.throws(() => extractThreadsPage({ repository: { pullRequest: {} } }), /reviewThreads/);
  });

  it("defaults to an empty page when nodes/pageInfo are absent", () => {
    const page = extractThreadsPage({ repository: { pullRequest: { reviewThreads: {} } } });
    assert.deepEqual(page.nodes, []);
    assert.equal(page.pageInfo.hasNextPage, false);
  });

  // A malformed cursor (more pages promised, nothing to page by) must fail
  // loudly rather than let the paging loop re-request the same page forever.
  it("throws when hasNextPage is true but endCursor is missing", () => {
    const data = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true },
            nodes: [],
          },
        },
      },
    };
    assert.throws(() => extractThreadsPage(data), /hasNextPage=true but no endCursor/);
  });

  // An empty-string cursor is just as unusable as a missing one -- re-sending
  // it as `after` would repeat the same page forever.
  it("throws when endCursor is an empty string", () => {
    const data = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "" },
            nodes: [],
          },
        },
      },
    };
    assert.throws(() => extractThreadsPage(data), /hasNextPage=true but no endCursor/);
  });

  // A non-string cursor (e.g. a stray number) is equally unusable.
  it("throws when endCursor is not a string", () => {
    const data = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: 123 },
            nodes: [],
          },
        },
      },
    };
    assert.throws(() => extractThreadsPage(data), /hasNextPage=true but no endCursor/);
  });
});

function threadNode({
  id,
  isResolved,
  path,
  line,
  slug,
  reviewId,
  reviewState = "CHANGES_REQUESTED",
  reviewGraphqlId = reviewId === null ? null : `PRR_${reviewId}`,
  reviewIsMinimized = false,
  isOutdated = false,
  commentId = 5000,
}) {
  const pullRequestReview = reviewId === null ? null : { databaseId: reviewId, id: reviewGraphqlId, state: reviewState, isMinimized: reviewIsMinimized };
  return {
    id,
    isResolved,
    isOutdated,
    path,
    line,
    comments: {
      nodes: [{
        databaseId: commentId,
        body: slug === null ? "A human comment with no marker." : appendMarker("Flagged text.", slug),
        pullRequestReview,
      }],
    },
  };
}

describe("threadsForCheck", () => {
  it("keeps only threads marked for this check", () => {
    const nodes = [
      threadNode({ id: "T1", isResolved: false, path: "a.go", line: 10, slug: "anti-slop", reviewId: 1 }),
      threadNode({ id: "T2", isResolved: false, path: "b.go", line: 20, slug: "mobile-layout", reviewId: 2 }),
      threadNode({ id: "T3", isResolved: false, path: "c.go", line: 30, slug: null, reviewId: 3 }),
    ];
    const threads = threadsForCheck(nodes, "anti-slop");
    assert.deepEqual(threads.map((t) => t.threadId), ["T1"]);
  });

  it("strips the marker from the surfaced comment text", () => {
    const nodes = [threadNode({ id: "T1", isResolved: false, path: "a.go", line: 10, slug: "anti-slop", reviewId: 1 })];
    const [thread] = threadsForCheck(nodes, "anti-slop");
    assert.equal(thread.comment, "Flagged text.");
  });

  it("ignores a marked thread with no attached review", () => {
    const nodes = [threadNode({ id: "T1", isResolved: false, path: "a.go", line: 10, slug: "anti-slop", reviewId: null })];
    assert.deepEqual(threadsForCheck(nodes, "anti-slop"), []);
  });

  it("skips a thread with no opening comment", () => {
    const nodes = [{ id: "T1", isResolved: false, path: "a.go", line: 10, comments: { nodes: [] } }];
    assert.deepEqual(threadsForCheck(nodes, "anti-slop"), []);
  });

  it("falls back to originalLine when line is null", () => {
    const node = threadNode({ id: "T1", isResolved: false, path: "a.go", line: null, slug: "anti-slop", reviewId: 1 });
    node.originalLine = 42;
    const [thread] = threadsForCheck([node], "anti-slop");
    assert.equal(thread.line, 42);
  });

  // commentId is what the audit reply is posted against before resolving;
  // isOutdated is free evidence handed to the resolution judge.
  it("carries the opening comment's databaseId and the outdated flag", () => {
    const node = threadNode({
      id: "T1",
      isResolved: false,
      path: "a.go",
      line: 10,
      slug: "anti-slop",
      reviewId: 1,
      isOutdated: true,
      commentId: 9876,
    });
    const [thread] = threadsForCheck([node], "anti-slop");
    assert.equal(thread.commentId, 9876);
    assert.equal(thread.isOutdated, true);
  });

  it("defaults commentId to null and isOutdated to false when absent", () => {
    const node = threadNode({ id: "T1", isResolved: false, path: "a.go", line: 10, slug: "anti-slop", reviewId: 1 });
    delete node.comments.nodes[0].databaseId;
    delete node.isOutdated;
    const [thread] = threadsForCheck([node], "anti-slop");
    assert.equal(thread.commentId, null);
    assert.equal(thread.isOutdated, false);
  });

  // reviewGraphqlId is the subjectId for minimizeComment; reviewIsMinimized
  // keeps a previously-hidden review from being re-minimized every run.
  it("carries the review's GraphQL id and isMinimized flag", () => {
    const node = threadNode({
      id: "T1",
      isResolved: true,
      path: "a.go",
      line: 10,
      slug: "anti-slop",
      reviewId: 1,
      reviewGraphqlId: "PRR_abc",
      reviewIsMinimized: true,
    });
    const [thread] = threadsForCheck([node], "anti-slop");
    assert.equal(thread.reviewGraphqlId, "PRR_abc");
    assert.equal(thread.reviewIsMinimized, true);
  });

  // A very old review predating the GraphQL id field would arrive with id
  // null; that review can still be dismissed (REST path matches on databaseId)
  // but its summary cannot be hidden. The default must surface that miss so
  // hide logic can skip it cleanly.
  it("defaults reviewGraphqlId and reviewIsMinimized to false-like values when absent", () => {
    const node = threadNode({ id: "T1", isResolved: false, path: "a.go", line: 10, slug: "anti-slop", reviewId: 1 });
    delete node.comments.nodes[0].pullRequestReview.id;
    delete node.comments.nodes[0].pullRequestReview.isMinimized;
    const [thread] = threadsForCheck([node], "anti-slop");
    assert.equal(thread.reviewGraphqlId, null);
    assert.equal(thread.reviewIsMinimized, false);
  });
});

describe("formatHistorySection", () => {
  it("reports no history for an empty list", () => {
    assert.match(formatHistorySection([]), /first time/);
  });

  it("lists each open thread with its id, location, and comment", () => {
    const threads = [{ threadId: "T1", path: "a.go", line: 10, comment: "Missing error log.", isResolved: false }];
    const section = formatHistorySection(threads);
    assert.match(section, /\[id=T1\] a\.go:10 -- Missing error log\./);
    assert.doesNotMatch(section, /already resolved/);
  });

  // A resolved thread must still be surfaced -- and flagged as resolved -- so
  // the agent (and the duplicate judge) never treat a dismissed finding as new.
  it("includes a resolved thread with a note not to repeat it", () => {
    const threads = [{ threadId: "T1", path: "a.go", line: 10, comment: "Missing error log.", isResolved: true }];
    const section = formatHistorySection(threads);
    assert.match(section, /\[id=T1\] a\.go:10 -- Missing error log\. \(already resolved -- do not repeat this finding\)/);
  });

  // Bounds each comment's contribution to the prompt: without a cap, a PR
  // with many resolved findings could eventually push the history section
  // past the model's context and force the check to neutral.
  it("truncates a resolved comment longer than the cap", () => {
    const longComment = "x".repeat(500);
    const threads = [{ threadId: "T1", path: "a.go", line: 10, comment: longComment, isResolved: true }];
    const section = formatHistorySection(threads);
    assert.ok(section.length < longComment.length);
    assert.match(section, /\[truncated\]/);
  });

  // Open threads are passed through verbatim: the dedup judge depends on the
  // exact body to tell a new finding from an existing one, and a silent
  // re-raise of a previously-reported issue is far worse than a longer prompt.
  it("does not truncate an open thread's body", () => {
    const longComment = "x".repeat(500);
    const threads = [{ threadId: "T1", path: "a.go", line: 10, comment: longComment, isResolved: false }];
    const section = formatHistorySection(threads);
    assert.doesNotMatch(section, /\[truncated\]/);
    assert.match(section, /x{300}/);
  });

  it("does not truncate a comment at or under the cap", () => {
    const comment = "y".repeat(300);
    const threads = [{ threadId: "T1", path: "a.go", line: 10, comment, isResolved: false }];
    const section = formatHistorySection(threads);
    assert.doesNotMatch(section, /\[truncated\]/);
    assert.match(section, new RegExp(comment));
  });

  // MAX_HISTORY_THREADS = 200. Below the cap, every thread (open + resolved)
  // is shown and no header is added.
  function manyThreads(count, { resolved }) {
    return Array.from({ length: count }, (_, i) => ({
      threadId: `T${String(i).padStart(4, "0")}`,
      path: "a.go",
      line: 10,
      comment: `finding ${i}`,
      isResolved: resolved,
    }));
  }

  it("adds no header and keeps every thread when under the cap", () => {
    const threads = [...manyThreads(50, { resolved: true }), ...manyThreads(50, { resolved: false })];
    const section = formatHistorySection(threads);
    assert.doesNotMatch(section, /Showing/);
    assert.equal(section.split("\n").length, 100);
  });

  // Over the cap with few open threads: only the oldest RESOLVED threads are
  // trimmed, every open thread survives, and the header says so plainly.
  it("trims only resolved threads when open threads fit the budget", () => {
    const threads = [...manyThreads(250, { resolved: true }), ...manyThreads(10, { resolved: false })];
    const section = formatHistorySection(threads);
    assert.match(section, /Showing the most recent 190 resolved and all 10 open previously-flagged threads; the older 60 resolved ones are omitted\./);
    // Every open thread (unresolved) must appear -- none dropped.
    const openThreads = threads.filter((t) => !t.isResolved);
    for (const t of openThreads) {
      assert.ok(section.includes(`[id=${t.threadId}]`), `missing open thread ${t.threadId}`);
    }
  });

  // Over the cap with MORE open threads than the budget itself: open threads
  // are now also dropped (oldest first), and the header must say so instead
  // of implying only resolved history was cut -- the bug cubic's review
  // caught, where the header lied about completeness.
  it("warns when even open threads must be trimmed", () => {
    const threads = manyThreads(250, { resolved: false });
    const section = formatHistorySection(threads);
    assert.match(section, /50 older OPEN thread\(s\)/);
    assert.doesNotMatch(section, /all \d+ open previously-flagged threads/);
    // The newest 200 (highest-numbered ids) must survive; the oldest 50 must not.
    assert.ok(section.includes("[id=T0249]"));
    assert.ok(!section.includes("[id=T0000]"));
  });

  // The boundary case cursor caught: open threads saturate the budget
  // exactly -- every resolved thread must also be sliced off AND counted,
  // or the dedup judge can re-report a long-resolved finding.
  it("counts resolved threads as dropped when open threads saturate the budget", () => {
    const open = manyThreads(MAX_HISTORY_THREADS_FOR_TEST, { resolved: false });
    const resolved = manyThreads(50, { resolved: true });
    const section = formatHistorySection([...open, ...resolved]);
    // The resolved-only header fires (droppedOpenCount == 0) and must report
    // the 50 dropped resolved threads so the dedup judge does not silently
    // treat any of them as new.
    assert.match(section, /the older 50 resolved ones are omitted\./);
    assert.doesNotMatch(section, /Older OPEN/);
    assert.equal(section.split("\n").length - 1, MAX_HISTORY_THREADS_FOR_TEST);
  });

  // Both open AND resolved threads overflow the budget together
  // (droppedOpenCount > 0 && droppedResolvedCount > 0) -- the one combined
  // path none of the other cases exercise. Resolved threads are dropped
  // wholesale here (including the newest), so the header must call them
  // "other", never "older" -- pins the wording cubic's review flagged as
  // otherwise untested.
  it("says 'other' (not 'older') resolved when open threads also overflow", () => {
    const open = manyThreads(250, { resolved: false });
    const resolved = manyThreads(50, { resolved: true });
    const section = formatHistorySection([...open, ...resolved]);
    assert.match(section, /50 older OPEN thread\(s\) and 50 other resolved thread\(s\)/);
    assert.doesNotMatch(section, /older resolved/);
  });
});

describe("threadDiffEvidence", () => {
  const addedLines = new Map([["a.go", new Set([10, 11])]]);

  it("reports a file that dropped out of the diff entirely", () => {
    const evidence = threadDiffEvidence({ path: "gone.go", line: 10 }, addedLines);
    assert.match(evidence, /no longer part of the PR diff/);
  });

  it("reports a flagged line that is no longer a changed line", () => {
    const evidence = threadDiffEvidence({ path: "a.go", line: 99 }, addedLines);
    assert.match(evidence, /no longer among this PR's changed lines/);
  });

  it("reports a flagged line that is still changed", () => {
    const evidence = threadDiffEvidence({ path: "a.go", line: 10 }, addedLines);
    assert.match(evidence, /still a changed line/);
  });

  it("treats a null line as no longer changed", () => {
    const evidence = threadDiffEvidence({ path: "a.go", line: null }, addedLines);
    assert.match(evidence, /no longer among this PR's changed lines/);
  });
});

describe("formatResolutionSection", () => {
  const addedLines = new Map([["a.go", new Set([10])]]);

  it("reports no open threads for an empty list", () => {
    assert.match(formatResolutionSection([], addedLines), /no previously-flagged issues open/);
  });

  it("includes the id, location, comment, and diff evidence", () => {
    const threads = [{ threadId: "T1", path: "a.go", line: 10, comment: "Missing error log.", isOutdated: false }];
    const section = formatResolutionSection(threads, addedLines);
    assert.match(section, /\[id=T1\] a\.go:10 -- Missing error log\./);
    assert.match(section, /Evidence: The flagged line is still a changed line/);
  });

  it("notes GitHub's own outdated signal when set", () => {
    const threads = [{ threadId: "T1", path: "a.go", line: 10, comment: "c", isOutdated: true }];
    assert.match(formatResolutionSection(threads, addedLines), /anchored code has changed/);
  });

  it("omits the outdated note when not set", () => {
    const threads = [{ threadId: "T1", path: "a.go", line: 10, comment: "c", isOutdated: false }];
    assert.doesNotMatch(formatResolutionSection(threads, addedLines), /anchored code has changed/);
  });
});

describe("validateResolutions", () => {
  const open = [{ threadId: "T1" }, { threadId: "T2" }];
  const row = (overrides) => ({ thread_id: "T1", resolved: true, evidence: "fixed in the diff", ...overrides });

  it("returns the id and evidence of rows resolved with evidence", () => {
    assert.deepEqual(validateResolutions([row({})], open), [
      { threadId: "T1", evidence: "fixed in the diff" },
    ]);
  });

  it("trims surrounding whitespace from the evidence", () => {
    const [resolved] = validateResolutions([row({ evidence: "  fixed  " })], open);
    assert.equal(resolved.evidence, "fixed");
  });

  it("omits a row that was judged not resolved", () => {
    assert.deepEqual(validateResolutions([row({ resolved: false })], open), []);
  });

  it("drops a thread_id that was never shown as open", () => {
    assert.deepEqual(validateResolutions([row({ thread_id: "T9" })], open), []);
  });

  // Evidence is the audit trail the resolution reply is built from; without
  // it there is nothing to justify burying the comment.
  it("drops a resolution with empty or missing evidence", () => {
    assert.deepEqual(validateResolutions([row({ evidence: "   " })], open), []);
    assert.deepEqual(validateResolutions([row({ evidence: undefined })], open), []);
  });

  // A truthy-but-not-true value must not resolve: the schema says boolean,
  // and anything else means the judge did not answer the question asked.
  it("drops a non-boolean resolved value", () => {
    assert.deepEqual(validateResolutions([row({ resolved: "true" })], open), []);
    assert.deepEqual(validateResolutions([row({ resolved: 1 })], open), []);
  });

  it("de-duplicates repeated thread ids", () => {
    assert.deepEqual(validateResolutions([row({}), row({})], open).map((r) => r.threadId), ["T1"]);
  });

  it("keeps valid rows alongside a malformed one", () => {
    const rows = [null, row({}), row({ thread_id: "T2", evidence: "lines deleted" })];
    assert.deepEqual(validateResolutions(rows, open).map((r) => r.threadId), ["T1", "T2"]);
  });

  it("returns nothing for a non-array judgment", () => {
    assert.deepEqual(validateResolutions(undefined, open), []);
    assert.deepEqual(validateResolutions("T1", open), []);
  });
});

describe("reviewsToDismiss", () => {
  it("dismisses a review whose only thread was already resolved", () => {
    const threads = [{ threadId: "T1", reviewId: 1, isResolved: true, reviewState: "CHANGES_REQUESTED" }];
    assert.deepEqual(reviewsToDismiss(threads, []), [1]);
  });

  it("dismisses a review whose last open thread was just resolved this run", () => {
    const threads = [
      { threadId: "T1", reviewId: 1, isResolved: true, reviewState: "CHANGES_REQUESTED" },
      { threadId: "T2", reviewId: 1, isResolved: false, reviewState: "CHANGES_REQUESTED" },
    ];
    assert.deepEqual(reviewsToDismiss(threads, ["T2"]), [1]);
  });

  it("does not dismiss a review with any thread still open", () => {
    const threads = [
      { threadId: "T1", reviewId: 1, isResolved: true, reviewState: "CHANGES_REQUESTED" },
      { threadId: "T2", reviewId: 1, isResolved: false, reviewState: "CHANGES_REQUESTED" },
    ];
    assert.deepEqual(reviewsToDismiss(threads, []), []);
  });

  it("skips a review that is already dismissed", () => {
    const threads = [{ threadId: "T1", reviewId: 1, isResolved: true, reviewState: "DISMISSED" }];
    assert.deepEqual(reviewsToDismiss(threads, []), []);
  });

  it("handles multiple independent reviews", () => {
    const threads = [
      { threadId: "T1", reviewId: 1, isResolved: true, reviewState: "CHANGES_REQUESTED" },
      { threadId: "T2", reviewId: 2, isResolved: false, reviewState: "CHANGES_REQUESTED" },
    ];
    assert.deepEqual(reviewsToDismiss(threads, []), [1]);
  });
});

describe("reviewsToHide", () => {
  function thread({
    threadId,
    reviewId,
    reviewGraphqlId = `PRR_${reviewId}`,
    reviewIsMinimized = false,
    reviewState = "DISMISSED",
    isResolved,
  }) {
    return { threadId, reviewId, reviewGraphqlId, reviewIsMinimized, reviewState, isResolved };
  }

  it("hides a freshly dismissed review's summary", () => {
    const threads = [thread({ threadId: "T1", reviewId: 1, reviewState: "CHANGES_REQUESTED" })];
    assert.deepEqual(reviewsToHide(threads, [1]), [
      { reviewId: 1, reviewGraphqlId: "PRR_1" },
    ]);
  });

  // A review dismissed on a previous run whose minimize step failed must
  // still be re-hidden on this run so the dismissal/hide pair eventually
  // converges -- the candidate pool isn't bounded to the current run only.
  it("hides a review already DISMISSED on a prior run", () => {
    const threads = [thread({ threadId: "T1", reviewId: 1 })];
    assert.deepEqual(reviewsToHide(threads, []), [
      { reviewId: 1, reviewGraphqlId: "PRR_1" },
    ]);
  });

  it("does not hide a review whose state is not DISMISSED and was not dismissed this run", () => {
    const threads = [thread({ threadId: "T1", reviewId: 1, reviewState: "CHANGES_REQUESTED" })];
    assert.deepEqual(reviewsToHide(threads, []), []);
  });

  // The bug this section guards against: a Weave Checks review is always
  // posted with event: COMMENT (see postReview), so its state is always
  // COMMENTED and dismissReview() 422s on it forever -- it can never reach
  // REVIEW_STATE.DISMISSED. Hiding must not be gated on dismissal succeeding;
  // "every thread this check opened is resolved" is its own, independent
  // qualifying path, regardless of review state or who/what resolved them
  // (this check's own resolution judge, a different check's rerun, or a
  // human clicking "Resolve conversation").
  it("hides a COMMENTED review once every thread it opened is resolved", () => {
    const threads = [
      thread({ threadId: "T1", reviewId: 1, reviewState: REVIEW_STATE.COMMENTED, isResolved: true }),
      thread({ threadId: "T2", reviewId: 1, reviewState: REVIEW_STATE.COMMENTED, isResolved: true }),
    ];
    assert.deepEqual(reviewsToHide(threads, []), [
      { reviewId: 1, reviewGraphqlId: "PRR_1" },
    ]);
  });

  it("does not hide a COMMENTED review with any thread still open", () => {
    const threads = [
      thread({ threadId: "T1", reviewId: 1, reviewState: REVIEW_STATE.COMMENTED, isResolved: true }),
      thread({ threadId: "T2", reviewId: 1, reviewState: REVIEW_STATE.COMMENTED, isResolved: false }),
    ];
    assert.deepEqual(reviewsToHide(threads, []), []);
  });

  // The bug this guards against: checkThreads is a start-of-run snapshot, so
  // a thread resolved by THIS run's resolution judge still reads isResolved:
  // false from it. Without folding in resolvedThisRun, a COMMENTED review
  // whose last open thread was just resolved would never qualify via the
  // primary path and would stay visible until a later run refreshed state.
  it("hides a COMMENTED review whose last open thread was resolved this run", () => {
    const threads = [
      thread({ threadId: "T1", reviewId: 1, reviewState: REVIEW_STATE.COMMENTED, isResolved: true }),
      thread({ threadId: "T2", reviewId: 1, reviewState: REVIEW_STATE.COMMENTED, isResolved: false }),
    ];
    assert.deepEqual(reviewsToHide(threads, [], ["T2"]), [
      { reviewId: 1, reviewGraphqlId: "PRR_1" },
    ]);
  });

  // Same fold-in, but the review still has another thread that stayed open
  // this run -- it must not qualify just because one thread resolved.
  it("does not hide a COMMENTED review when another thread stayed unresolved this run", () => {
    const threads = [
      thread({ threadId: "T1", reviewId: 1, reviewState: REVIEW_STATE.COMMENTED, isResolved: true }),
      thread({ threadId: "T2", reviewId: 1, reviewState: REVIEW_STATE.COMMENTED, isResolved: false }),
      thread({ threadId: "T3", reviewId: 1, reviewState: REVIEW_STATE.COMMENTED, isResolved: false }),
    ];
    assert.deepEqual(reviewsToHide(threads, [], ["T2"]), []);
  });

  // GitHub 422s a repeat minimizeComment with the same classifier; without
  // this skip we would re-send the mutation on every run and surface the
  // rejection as a perpetual historyError.
  it("does not hide a review that is already minimized", () => {
    const threads = [thread({ threadId: "T1", reviewId: 1, reviewIsMinimized: true })];
    assert.deepEqual(reviewsToHide(threads, []), []);
  });

  // Predating the GraphQL `id` field on the review surface arrives with id
  // null; REST dismiss still works on the databaseId, but minimizeComment
  // has no subjectId, so the hide step must skip — not crash. The review
  // summary stays visible forever, which is the pre-feature behavior.
  it("does not hide a review with no GraphQL id available", () => {
    const threads = [thread({ threadId: "T1", reviewId: 1, reviewGraphqlId: null })];
    assert.deepEqual(reviewsToHide(threads, []), []);
  });

  it("deduplicates threads that share a single review", () => {
    const threads = [
      thread({ threadId: "T1", reviewId: 1 }),
      thread({ threadId: "T2", reviewId: 1 }),
    ];
    assert.deepEqual(reviewsToHide(threads, []), [
      { reviewId: 1, reviewGraphqlId: "PRR_1" },
    ]);
  });

  it("treats a discarded id set as no-op", () => {
    const threads = [thread({ threadId: "T1", reviewId: 1 })];
    assert.deepEqual(reviewsToHide(threads, null), [
      { reviewId: 1, reviewGraphqlId: "PRR_1" },
    ]);
    assert.deepEqual(reviewsToHide(threads, undefined), [
      { reviewId: 1, reviewGraphqlId: "PRR_1" },
    ]);
  });

  // Two distinct REST ids under the same GraphQL id would mean a corrupt
  // API response; treat as data integrity fail rather than silently picking
  // one -- a mistake here hides the wrong review.
  it("throws when threads of one graph id disagree on the REST id", () => {
    const threads = [
      { ...thread({ threadId: "T1", reviewId: 1 }), reviewGraphqlId: "PRR_x" },
      { ...thread({ threadId: "T2", reviewId: 2 }), reviewGraphqlId: "PRR_x" },
    ];
    assert.throws(() => reviewsToHide(threads, []), /conflicting REST ids/);
  });
});
