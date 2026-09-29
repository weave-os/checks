// Cross-run memory for Weave Checks, built entirely from GitHub's own state --
// there is no database. Every comment a check posts carries an invisible
// marker; on the next run (a `synchronize` push, or a workflow re-run) we
// read that marker back via the GraphQL review-threads API to reconstruct
// "what has this check already said" without storing anything ourselves.
//
// Network calls (the GraphQL query itself, the resolve and minimize mutations,
// dismissing a review) live in worker.mjs. This module only shapes the query,
// parses the response, and makes the pure decisions: what to show the agent,
// which resolved-thread ids are real, and which reviews are now fully addressed.

import { LEGACY_MARKER_PREFIX } from "./branding.mjs";
import { REVIEW_STATE } from "./parse.mjs";

// Builds the marker helpers for one configured prefix.
//
// Writes only `<!-- <prefix>:<slug> -->`, but reads both the configured
// prefix and the legacy `weave-check` one, so comments posted before a
// consumer rebranded are still recognized as that check's history.
//
// The read regex is anchored to the END of the body (the last marker
// paragraph only): when a generated comment quotes another marker that was
// already committed to the PR -- e.g. the audit reply on a thread being
// resolved inlines the original flagged comment text verbatim -- a loose
// anywhere-in-body regex would match the embedded marker before reaching the
// marker append() itself appended, and threadsForCheck would then
// mis-classify the comment under the wrong check, dropping it from history.
// append() always writes the marker as the trailing paragraph, so requiring
// it at the end of a line is exactly that same invariant read back.
//
// Callers validate the prefix (branding.mjs) before it reaches this regex.
export function markerCodec(prefix = LEGACY_MARKER_PREFIX) {
  const prefixes = [...new Set([prefix, LEGACY_MARKER_PREFIX])];
  const trailing = new RegExp(`<!-- (?:${prefixes.join("|")}):([a-z0-9-]+) -->\\s*$`);
  const format = (slug) => `<!-- ${prefix}:${slug} -->`;
  return Object.freeze({
    format,
    // Appends the marker as its own trailing paragraph so it survives
    // GitHub's Markdown rendering as an invisible comment rather than
    // corrupting a ```suggestion block if placed inside one.
    append: (body, slug) => `${body}\n\n${format(slug)}`,
    strip: (body) => body.replace(trailing, "").trim(),
    extractSlug: (body) => trailing.exec(body)?.[1] ?? null,
  });
}

const DEFAULT_CODEC = markerCodec();

export const formatMarker = DEFAULT_CODEC.format;
export const appendMarker = DEFAULT_CODEC.append;
export const stripMarker = DEFAULT_CODEC.strip;
export const extractMarkerSlug = DEFAULT_CODEC.extractSlug;

// GraphQL query for every review thread on the PR, paginated. `comments(first: 1)`
// only needs the thread's opening comment: that's the one worker.mjs tags with
// the marker when it posts a suggestion, so it's the only comment that can
// carry one. `databaseId` on that comment is needed to post a REST reply
// before resolving (history has no GraphQL reply mutation). `isOutdated` is
// GitHub's own signal that the anchored code changed since the comment was
// posted -- free evidence for the resolution judge, no model call needed.
// `pullRequestReview` also carries `id` (the GraphQL global id, used as the
// subjectId for minimizeComment on the review summary) and `isMinimized`, so
// a review that was already minimized on a prior run isn't re-minimized.
// `latest` is the thread's newest comment, read to recognize a resolution
// reply this check already posted (see resolutionAlreadyPosted).
export const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 1) {
            totalCount
            nodes {
              databaseId
              body
              pullRequestReview { databaseId id state isMinimized }
            }
          }
          latest: comments(last: 1) {
            nodes { body }
          }
        }
      }
    }
  }
}`;

// Pulls the page of thread nodes and pagination cursor out of one GraphQL
// response. Kept separate from the paging loop (which lives in worker.mjs
// and needs `fetch`) so the shape of the response is unit-testable.
export function extractThreadsPage(data) {
  const connection = data?.repository?.pullRequest?.reviewThreads;
  if (connection === undefined || connection === null) {
    throw new Error("GraphQL response missing repository.pullRequest.reviewThreads");
  }
  const pageInfo = connection.pageInfo ?? { hasNextPage: false };
  // A malformed cursor state -- more pages promised with nothing to page by
  // -- must not be accepted silently: fetchAllReviewThreads's caller would
  // re-request the same `after` value forever. Fail loudly instead so this
  // pass is skipped and logged (worker.mjs's history fetch is best-effort),
  // rather than looping.
  if (pageInfo.hasNextPage === true && (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0)) {
    throw new Error("GraphQL response has hasNextPage=true but no endCursor");
  }
  return { nodes: connection.nodes ?? [], pageInfo };
}

// The audit reply the worker posts before resolving a thread opens with this.
export const RESOLUTION_REPLY_PREFIX = "**Resolved by ";

// True when the thread's newest reply is this check's own resolution reply:
// the resolution judge already decided the finding was fixed, but resolving
// the thread failed (GitHub gates resolveReviewThread behind Contents write).
// Counting it as settled stops every later push from re-judging it, posting
// another identical reply, and keeping the check flagged for a fixed issue.
function resolutionAlreadyPosted(node, slug, codec) {
  if ((node.comments?.totalCount ?? 0) < 2) return false;
  const body = node.latest?.nodes?.[0]?.body;
  return typeof body === "string" && body.startsWith(RESOLUTION_REPLY_PREFIX) && codec.extractSlug(body) === slug;
}

// Whether a thread no longer needs judging: resolved on GitHub, or judged
// fixed with the audit reply already posted. Only the GitHub state drives
// dismissing or hiding reviews; this drives "still open" and re-judging.
export function isSettled(thread) {
  return thread.isResolved || thread.resolutionReplied === true;
}

// Normalizes raw GraphQL thread nodes into the shape the rest of this module
// (and worker.mjs) works with, keeping only threads this check itself opened
// -- identified by the marker on the thread's first comment.
export function threadsForCheck(rawNodes, slug, codec = DEFAULT_CODEC) {
  const threads = [];
  for (const node of rawNodes) {
    const opener = node.comments?.nodes?.[0];
    if (opener === undefined) continue;
    if (codec.extractSlug(opener.body) !== slug) continue;
    const review = opener.pullRequestReview;
    const reviewId = review?.databaseId ?? null;
    if (reviewId === null) continue; // Not something we can dismiss later; ignore.
    threads.push({
      threadId: node.id,
      reviewId,
      reviewState: review?.state ?? null,
      // reviewGraphqlId is the subjectId for minimizeComment; absent on a
      // review we can't hide (e.g. very old review predating the field).
      reviewGraphqlId: review?.id ?? null,
      reviewIsMinimized: review?.isMinimized === true,
      isResolved: node.isResolved === true,
      resolutionReplied: resolutionAlreadyPosted(node, slug, codec),
      isOutdated: node.isOutdated === true,
      commentId: opener.databaseId ?? null,
      path: node.path,
      line: node.line ?? node.originalLine ?? null,
      comment: codec.strip(opener.body),
    });
  }
  return threads;
}

// The block shown to the main review agent (and to the duplicate judge) so it
// knows what this check has already told this PR and can avoid repeating it.
// Deliberately includes RESOLVED threads, not just open ones: once a thread is
// resolved -- whether by the resolution judge finding the code actually fixed,
// or by a human clicking "Resolve conversation" without changing anything --
// that is the last word on it. A human resolving a thread is a decision to
// ignore the suggestion, not a bug to route around, so the same finding must
// never come back as a "new" comment on a later run. (Deciding whether an
// *open* thread should now become resolved is a different question, answered
// by a separate judge -- see formatResolutionSection -- which is why that
// function still filters to open threads only.)
//
// Each RESOLVED comment is capped at MAX_HISTORY_COMMENT_LENGTH chars: a
// resolved thread only needs to carry enough identity for the main agent
// and the dedup judge to recognize a repeat, not its full original text
// (which can include a large ```suggestion block). Open threads, by
// contrast, are emitted verbatim -- the machine truncation happens after
// the JSON object has been read and would strip just as easily, but it
// would also strip the very detail the dedup judge needs to tell "this
// exact finding" from "a related but distinct one", so silent re-raises are
// far worse than a longer prompt for an open thread.
//
// Two caps independently bound the section size: the per-comment cap above
// caps each entry's contribution, but with many resolved threads even
// tightly-capped entries can still push the prompt past the model's
// context and turn the check neutral. MAX_HISTORY_THREADS bounds the
// number of entries themselves, with one definitive signal -- the most
// recently resolved thread -- preserved in full so the linear decay of
// signal-to-noise is explicit: older entries are less likely to fingerprint
// the diff being reviewed now anyway.
const MAX_HISTORY_COMMENT_LENGTH = 300;
const MAX_HISTORY_THREADS = 200;

function truncateForHistory(comment) {
  if (comment.length <= MAX_HISTORY_COMMENT_LENGTH) return comment;
  return `${comment.slice(0, MAX_HISTORY_COMMENT_LENGTH)}... [truncated]`;
}

export function formatHistorySection(threads) {
  if (threads.length === 0) {
    return "None -- this is the first time this check has run on this PR.";
  }
  // Sort by the thread id, which is a stable, time-correlated ordering -- node
  // ids monotonically grow as GitHub creates more threads, so the tail is the
  // newest history and the head is the oldest.
  const ordered = [...threads].sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
  // Either keep every thread or, if it would overshoot
  // MAX_HISTORY_THREADS, prefer open threads (any duplicate signal against an
  // unresolved finding matters more than one against a long-resolved one) and
  // fill the rest of the budget with the most recent resolved threads.
  let visible;
  let droppedResolvedCount = 0;
  let droppedOpenCount = 0;
  if (ordered.length <= MAX_HISTORY_THREADS) {
    visible = ordered;
  } else {
    const openThreads = ordered.filter((t) => !isSettled(t));
    const resolvedThreads = ordered.filter((t) => isSettled(t));
    const openCount = openThreads.length;
    if (openCount >= MAX_HISTORY_THREADS) {
      // Both branches of the cap can drop RESOLVED threads too: when open
      // threads already saturate the budget they consume every slot, so any
      // resolved thread must be sliced off -- a silent drop here would let
      // the dedup judge treat an omitted resolved finding as new.
      visible = openThreads.slice(openCount - MAX_HISTORY_THREADS);
      droppedResolvedCount = resolvedThreads.length;
      droppedOpenCount = openCount - visible.length;
    } else {
      const resolvedBudget = MAX_HISTORY_THREADS - openCount;
      // `resolved` is already oldest-first by sort; take its tail (newest).
      const recentResolved = resolvedThreads.slice(-resolvedBudget);
      visible = recentResolved.concat(openThreads);
      droppedResolvedCount = resolvedThreads.length - recentResolved.length;
    }
  }
  const droppedCount = droppedResolvedCount + droppedOpenCount;
  const header = droppedCount > 0
    ? droppedOpenCount > 0
      // Open threads were trimmed -- flag it plainly rather than implying
      // completeness, since the dedup judge and main agent can otherwise
      // treat an excluded open finding as already covered. Also surface
      // resolved-thread omissions when both kinds were dropped, since the
      // resolved-only header would otherwise be silently misleading. Note
      // that "older" only describes the OPEN drop -- resolved threads are
      // dropped wholesale in this branch (the budget is fully consumed by
      // open threads), so the newest resolved findings can be among those
      // omitted and must not be characterized as "older".
      ? `(Showing only the most recent ${visible.length} of ${ordered.length} previously-flagged threads -- ${droppedOpenCount} older OPEN thread(s) and ${droppedResolvedCount} other resolved thread(s) are also omitted; the shown set may not be a complete duplicate-detection history.)\n`
      : `(Showing the most recent ${visible.filter((t) => isSettled(t)).length} resolved and all ${visible.filter((t) => !isSettled(t)).length} open previously-flagged threads; the older ${droppedResolvedCount} resolved ones are omitted.)\n`
    : "";
  return header + visible
    .map((t) => {
      const resolvedNote = isSettled(t) ? " (already resolved -- do not repeat this finding)" : "";
      // Omit the truncation for OPEN threads -- the dedup judge depends on the
      // exact body to tell a new finding from an existing one. RESOLVED threads
      // are still capped at MAX_HISTORY_COMMENT_LENGTH so a single thread with
      // a giant ```suggestion block can't dominate the section.
      const text = isSettled(t) ? truncateForHistory(t.comment) : t.comment;
      return `- [id=${t.threadId}] ${t.path}:${t.line} -- ${text}${resolvedNote}`;
    })
    .join("\n");
}

// Free, deterministic evidence for the resolution judge, computed from the
// diff with no model call. This is the strongest signal for the "no longer
// applicable" cases -- a file dropped from the PR, or a flagged line that's
// no longer part of the changed-lines set -- so the judge doesn't have to
// infer them from the diff text.
export function threadDiffEvidence(thread, addedLines) {
  const lines = addedLines.get(thread.path);
  if (lines === undefined) {
    return "This file is no longer part of the PR diff.";
  }
  if (thread.line === null || !lines.has(thread.line)) {
    return "The flagged line is no longer among this PR's changed lines.";
  }
  return "The flagged line is still a changed line in this PR.";
}

// The block shown to the resolution judge: each open thread plus the free
// diff evidence and GitHub's own isOutdated signal, so the judge starts from
// concrete facts rather than having to re-derive them from the diff text.
export function formatResolutionSection(openThreads, addedLines) {
  if (openThreads.length === 0) {
    return "None -- this check has no previously-flagged issues open on this PR.";
  }
  return openThreads
    .map((t) => {
      const outdated = t.isOutdated ? " The anchored code has changed since this was posted." : "";
      return `- [id=${t.threadId}] ${t.path}:${t.line} -- ${t.comment}\n  Evidence: ${threadDiffEvidence(t, addedLines)}${outdated}`;
    })
    .join("\n");
}

// Validates the resolution judge's structured output against the actual open
// set, returning `{ threadId, evidence }` for each thread safe to resolve.
// A row is only honored when its thread_id was really shown as open, resolved
// is exactly true (not just truthy -- a stray string or number is rejected),
// and evidence is a non-empty string, matching the judge's own contract that
// every resolution must be justified. The evidence rides along because it is
// posted as an audit reply before the thread is resolved. An unjustified,
// hallucinated, or duplicate row is dropped rather than resolved -- one bad
// row does not disqualify the rest of an otherwise-valid judgment.
export function validateResolutions(resolutions, openThreads) {
  if (!Array.isArray(resolutions)) return [];

  const openIds = new Set(openThreads.map((t) => t.threadId));
  const seen = new Set();
  const resolved = [];
  for (const row of resolutions) {
    if (row === null || typeof row !== "object") continue;
    if (typeof row.thread_id !== "string" || !openIds.has(row.thread_id)) continue;
    if (row.resolved !== true) continue;
    if (typeof row.evidence !== "string" || row.evidence.trim() === "") continue;
    if (seen.has(row.thread_id)) continue;
    seen.add(row.thread_id);
    resolved.push({ threadId: row.thread_id, evidence: row.evidence.trim() });
  }
  return resolved;
}

// A review is only worth dismissing once every thread it opened is resolved.
// `resolvedThisRun` folds in this run's just-resolved ids so a review that
// becomes fully resolved in the same run it started in still gets dismissed,
// without needing a second GraphQL round-trip to re-read `isResolved`.
//
// Two states are skipped up front so dismissReview() never asks GitHub for
// something it will reject:
//
//   * REVIEW_STATE.DISMISSED -- GitHub 422s a repeat dismissal, and there is
//     nothing left to hide.
//   * REVIEW_STATE.COMMENTED -- the dismiss-review API only accepts reviews
//     awaiting a decision (APPROVED or CHANGES_REQUESTED); a COMMENTED review
//     is not waiting for a sign-off to withdraw -- it was just commentary --
//     so a dismissal attempt would 422, the failure would land in
//     `historyErrors`, and every subsequent run would retry the same 422
//     forever.
export function reviewsToDismiss(checkThreads, resolvedThisRun) {
  const resolvedSet = new Set(resolvedThisRun);
  const byReview = new Map();
  const stateByReview = new Map();
  for (const thread of checkThreads) {
    const resolved = thread.isResolved || resolvedSet.has(thread.threadId);
    byReview.set(thread.reviewId, [...(byReview.get(thread.reviewId) ?? []), resolved]);
    stateByReview.set(thread.reviewId, thread.reviewState);
  }

  const reviewIds = [];
  for (const [reviewId, resolvedFlags] of byReview) {
    const state = stateByReview.get(reviewId);
    if (state === REVIEW_STATE.DISMISSED) continue;
    if (state === REVIEW_STATE.COMMENTED) continue;
    if (resolvedFlags.every(Boolean)) {
      reviewIds.push(reviewId);
    }
  }
  return reviewIds;
}

// Decides which review SUMMARIES are worth minimizing. A review qualifies
// when EITHER of two independent conditions holds:
//
//   * Every thread this check opened on it is resolved -- reading each
//     thread's start-of-run `isResolved` snapshot OR'd with `resolvedThisRun`
//     (threads this same `applyResolutions` call just resolved). Without
//     that fold-in, a review whose last open thread the resolution judge
//     resolves THIS run would still read as unresolved from the stale
//     snapshot and never get hidden until some later run refreshes thread
//     state. This is the primary path and does NOT require the review to be
//     dismissed first: hiding and dismissing are separate GitHub mutations
//     (minimizeComment vs the review dismissals endpoint), and a COMMENTED
//     review -- what every Weave Checks review is, since postReview()
//     deliberately uses event: COMMENT -- can never reach
//     REVIEW_STATE.DISMISSED (dismissReview 422s on it; see
//     reviewsToDismiss). Gating hiding on dismissal would mean a fully
//     resolved COMMENTED review -- whether resolved by this check's own
//     resolution judge, by a different check's rerun, or by a human clicking
//     "Resolve conversation" -- could never be hidden, on any run, forever.
//   * It has already reached REVIEW_STATE.DISMISSED (or was dismissed this
//     run, via `dismissedIds`) -- the APPROVED/CHANGES_REQUESTED path, kept
//     so a dismissal from a previous run whose minimize step silently failed
//     still gets retried here.
//
// Two guards drop candidates that would either no-op or error:
//
//   * No reviewGraphqlId -- the GraphQL `id` field did not exist on very old
//     reviews predating the field's introduction, so minimizeComment has no
//     subjectId to address. Skipping is harmless: the summary just stays
//     visible -- exactly the pre-this-feature behavior, so nothing regresses.
//   * Already minimized -- GitHub 422s a repeat minimizeComment, so re-sending
//     the same mutation every run would land in historyErrors forever.
//     Skipping matches real state.
export function reviewsToHide(checkThreads, dismissedIds, resolvedThisRun) {
  const dismissedSet = new Set(dismissedIds ?? []);
  const resolvedThisRunSet = new Set(resolvedThisRun ?? []);
  const resolvedFlagsByReview = new Map();
  const threadByReview = new Map();

  for (const thread of checkThreads) {
    if (thread.reviewGraphqlId === null) continue;
    if (thread.reviewIsMinimized) continue;

    const resolved = thread.isResolved || resolvedThisRunSet.has(thread.threadId);
    resolvedFlagsByReview.set(thread.reviewId, [
      ...(resolvedFlagsByReview.get(thread.reviewId) ?? []),
      resolved,
    ]);

    // One representative thread per review is enough to read its (review-
    // level, not thread-level) reviewState/reviewGraphqlId back out below.
    if (!threadByReview.has(thread.reviewId)) {
      threadByReview.set(thread.reviewId, thread);
    }
  }

  const hidden = new Map();
  for (const [reviewId, thread] of threadByReview) {
    const allThreadsResolved = resolvedFlagsByReview.get(reviewId).every(Boolean);
    const alreadyDismissed = thread.reviewState === REVIEW_STATE.DISMISSED || dismissedSet.has(reviewId);
    if (!allThreadsResolved && !alreadyDismissed) continue;

    const existingReviewId = hidden.get(thread.reviewGraphqlId);
    // Dedup reviews that share the same GraphQL id (very common: every thread
    // of one review points at the same id). Last-write-wins is safe because
    // we only ever read two booleans off the thread record.
    if (existingReviewId === undefined) {
      hidden.set(thread.reviewGraphqlId, reviewId);
      continue;
    }
    if (existingReviewId !== reviewId) {
      // Two distinct REST ids under the same GraphQL id would mean a corrupt
      // API response; treat as data integrity fail rather than silently
      // picking one -- a mistake here hides the wrong review.
      throw new Error(`review ${thread.reviewGraphqlId} reported with conflicting REST ids (${existingReviewId} vs ${reviewId})`);
    }
  }
  return [...hidden.entries()].map(([graphqlId, reviewId]) => ({ reviewId, reviewGraphqlId: graphqlId }));
}
