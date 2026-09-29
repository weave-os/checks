// Prepares one pull request for review: resolves GitHub's merge base, picks
// the review base (incremental where it is provably safe), and writes the
// review-scope and PR-scope diffs the worker reads.
//
// Ported from the shell step that used to do this inline, so each guard is a
// unit-testable function (prepare.test.mjs runs them against real git repos)
// rather than one opaque bash blob.
//
// Two scopes, always both written:
//
//   pr.diff / pr.stat           -- REVIEW scope: what the checks look at.
//   pr.full.diff / pr.stat.full -- PR scope: merge-base..HEAD, exactly
//                                  GitHub's own three-dot diff. The resolution
//                                  judge needs it even when review is
//                                  incremental (see worker.mjs).
//
// Every fallback in here lands on the merge base, the widest correct diff. A
// miss costs a re-review; it can never open a gap.

import { writeFileSync } from "node:fs";
import path from "node:path";

import { git as defaultGit } from "./git.mjs";
import { formatReviewedMarker } from "./parse.mjs";

// How far back through the PR's commits to look for the last fully reviewed
// one. Each candidate is one check-runs lookup; a push that was cancelled or
// never ran simply has no aggregate and costs one call.
const MAX_REVIEWED_CANDIDATES = 10;

// The mandatory merge-base/head fetch retries on this ladder (seconds).
const FETCH_RETRY_DELAYS_S = [0, 2, 4, 8];

// GitHub's PR commits endpoint pages at 100 and stops at 250 commits.
const PR_COMMITS_PAGE_SIZE = 100;
const PR_COMMITS_MAX_PAGES = 3;

export const DIFF_BASE = Object.freeze({
  INCREMENTAL: "incremental",
  MERGE_BASE: "merge-base",
});

export const PREPARED_FILES = Object.freeze({
  DIFF: "pr.diff",
  STAT: "pr.stat",
  FULL_DIFF: "pr.full.diff",
  FULL_STAT: "pr.stat.full",
  MAIN_TOUCHED: "main-touched.txt",
});

const compareUrl = (repository, from, to) =>
  // per_page=1 keeps GitHub from paging a long commit list into a response we
  // only read three fields from.
  `repos/${repository}/compare/${from}...${to}?per_page=1`;

// GitHub's own merge base for the PR. A plain `git diff BASE HEAD` would
// include commits that landed on the base branch since the branch point and
// have the agents review lines GitHub doesn't consider part of the PR; the
// compare API answers without a deep local clone. Failure here is fatal:
// there is no correct diff without it.
export async function resolveMergeBase({ rest, repository, baseSha, headSha }) {
  const compare = await rest("GET", compareUrl(repository, baseSha, headSha));
  const sha = compare?.merge_base_commit?.sha;
  if (typeof sha !== "string" || sha === "") {
    throw new Error(`compare ${baseSha}...${headSha} returned no merge_base_commit`);
  }
  return sha;
}

// The PR's commits, newest first, excluding the head itself.
async function priorPRCommits({ rest, repository, prNumber, headSha }) {
  const shas = [];
  for (let page = 1; page <= PR_COMMITS_MAX_PAGES; page += 1) {
    const commits = await rest(
      "GET",
      `repos/${repository}/pulls/${prNumber}/commits?per_page=${PR_COMMITS_PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(commits)) break;
    shas.push(...commits.map(commit => commit.sha));
    if (commits.length < PR_COMMITS_PAGE_SIZE) break;
  }
  return shas.reverse().filter(sha => sha !== headSha);
}

// Guard 1: the newest PR commit whose aggregate check run carries the
// worker's `reviewed:<sha>` external_id -- i.e. every check finished reading
// its diff. A green run does NOT mean this: an operational miss publishes as
// `neutral` and the job still exits 0, so its range would be skipped forever
// if a conclusion were trusted. The marker embeds the sha, so a match also
// proves the lookup landed on the right commit.
//
// Walking older commits past an unmarked one is safe: a fully reviewed
// ancestor is a valid base for everything after it, just a wider one.
// Returns null on any lookup failure.
export async function findLastReviewedSha({
  rest,
  repository,
  prNumber,
  headSha,
  aggregateName,
  maxCandidates = MAX_REVIEWED_CANDIDATES,
  log = () => {},
}) {
  let candidates;
  try {
    candidates = await priorPRCommits({ rest, repository, prNumber, headSha });
  } catch (error) {
    log(`Could not list PR commits (${error.message}); reviewing from the merge base.`);
    return null;
  }
  for (const sha of candidates.slice(0, maxCandidates)) {
    let runs;
    try {
      runs = await rest(
        "GET",
        `repos/${repository}/commits/${sha}/check-runs?check_name=${encodeURIComponent(aggregateName)}&filter=latest`,
      );
    } catch (error) {
      log(
        `Could not read check runs for ${sha} (${error.message}); reviewing from the merge base.`,
      );
      return null;
    }
    if (runs?.check_runs?.[0]?.external_id === formatReviewedMarker(sha)) return sha;
  }
  return null;
}

// Guards 2 and 3, given a fully reviewed candidate. Returns
// `{ reviewBaseSha, oldMergeBaseSha }` where `oldMergeBaseSha` is non-null
// exactly when the base branch was merged in since the candidate was
// reviewed (the split case), or null to review from the merge base.
export async function checkIncrementalBase({
  rest,
  repository,
  mergeBaseSha,
  lastReviewedSha,
  headSha,
  log = () => {},
}) {
  if (lastReviewedSha === null || lastReviewedSha === mergeBaseSha) return null;

  // Guard 2: is the current merge base already contained in the candidate?
  // One call answers it twice over: `status` says whether the merge base
  // has moved, and `merge_base_commit.sha` is the base-branch commit the
  // branch contained at last-review time -- the OLD merge base, which is
  // what makes the split possible.
  let baseStatus = null;
  let oldMergeBaseSha = null;
  try {
    const compare = await rest("GET", compareUrl(repository, mergeBaseSha, lastReviewedSha));
    baseStatus = compare?.status ?? null;
    oldMergeBaseSha = compare?.merge_base_commit?.sha ?? null;
  } catch (error) {
    log(`Could not compare ${mergeBaseSha}...${lastReviewedSha} (${error.message}).`);
  }
  const baseMoved = baseStatus !== "ahead" && baseStatus !== "identical";
  if (baseMoved && (oldMergeBaseSha === null || oldMergeBaseSha === "")) {
    log("Could not resolve the pre-merge base; reviewing from the merge base.");
    return null;
  }

  // Guard 3: the candidate is an ancestor of HEAD. `ahead` is GitHub's
  // phrasing for that; `diverged` (force-push, rebase) and `behind` (the
  // reviewed commits were reverted away) both mean the range no longer
  // describes this head.
  let headStatus = null;
  try {
    const compare = await rest("GET", compareUrl(repository, lastReviewedSha, headSha));
    headStatus = compare?.status ?? null;
  } catch (error) {
    log(
      `Could not compare ${lastReviewedSha}...${headSha} (${error.message}); reviewing from the merge base.`,
    );
    return null;
  }
  if (headStatus !== "ahead") return null;

  return { reviewBaseSha: lastReviewedSha, oldMergeBaseSha: baseMoved ? oldMergeBaseSha : null };
}

function fetchShallow(git, repoDir, shas, env) {
  return (
    git(["fetch", "--no-tags", "--depth=1", "origin", ...shas], {
      cwd: repoDir,
      env,
      allowFailure: true,
    }) !== null
  );
}

// Git config that authenticates fetches from `serverUrl` with `token`,
// carried in the environment (GIT_CONFIG_*, git >= 2.31) rather than argv or
// .git/config: the action checks out without persisting credentials, so no
// file an agent can read ever holds the token.
export function fetchAuthEnv(serverUrl, token) {
  if (!token) return undefined;
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${serverUrl.replace(/\/+$/, "")}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

// Writes both scopes. Returns the review base that actually won and a note
// saying which, for the log and the step summary.
export async function preparePullRequest({
  rest,
  git = defaultGit,
  repoDir,
  outDir,
  repository,
  prNumber,
  baseSha,
  headSha,
  aggregateName,
  ignorePathspecs = [],
  diffBase = DIFF_BASE.INCREMENTAL,
  fetchEnv = undefined,
  sleep = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)),
  log = message => console.error(message),
}) {
  if (!Object.values(DIFF_BASE).includes(diffBase)) {
    throw new Error(
      `diff-base must be one of ${Object.values(DIFF_BASE).join(", ")}, got ${JSON.stringify(diffBase)}`,
    );
  }
  const out = name => path.join(outDir, name);
  const mergeBaseSha = await resolveMergeBase({ rest, repository, baseSha, headSha });

  let reviewBaseSha = mergeBaseSha;
  let mainTouched = null;
  if (diffBase === DIFF_BASE.INCREMENTAL) {
    const lastReviewedSha = await findLastReviewedSha({
      rest,
      repository,
      prNumber,
      headSha,
      aggregateName,
      log,
    });
    const incremental = await checkIncrementalBase({
      rest,
      repository,
      mergeBaseSha,
      lastReviewedSha,
      headSha,
      log,
    });
    if (incremental !== null) {
      if (incremental.oldMergeBaseSha !== null) {
        // The base branch was merged in (GitHub's "Update branch"), so the
        // merge base advanced past commits the candidate never had. Those
        // are someone else's work and must not be reviewed here -- GitHub's
        // three-dot PR diff excludes them, and only the incremental range,
        // being two-dot, can leak them back in. Split by path instead of
        // giving up: files the base branch touched are diffed from the
        // CURRENT merge base, everything else stays incremental.
        if (fetchShallow(git, repoDir, [incremental.oldMergeBaseSha, mergeBaseSha], fetchEnv)) {
          const names = git(
            [
              "-c",
              "core.quotePath=false",
              "diff",
              "--name-only",
              "-z",
              incremental.oldMergeBaseSha,
              mergeBaseSha,
            ],
            { cwd: repoDir },
          );
          mainTouched = names
            .toString("utf8")
            .split("\0")
            .filter(name => name !== "");
          writeFileSync(
            out(PREPARED_FILES.MAIN_TOUCHED),
            mainTouched.map(name => `${name}\n`).join(""),
          );
          reviewBaseSha = incremental.reviewBaseSha;
        } else {
          log("Could not fetch the pre-merge base; reviewing from the merge base.");
        }
      } else {
        reviewBaseSha = incremental.reviewBaseSha;
      }
    }
    // Best-effort, deliberately separate from the mandatory fetch below.
    if (reviewBaseSha !== mergeBaseSha && !fetchShallow(git, repoDir, [reviewBaseSha], fetchEnv)) {
      log(`Could not fetch last-reviewed ${reviewBaseSha}; reviewing from the merge base.`);
      reviewBaseSha = mergeBaseSha;
      mainTouched = null;
    }
  }

  // Fetch the two trees the PR-scope diff names. The checkout is shallow and
  // the merge base is not guaranteed to be present as an object.
  let fetched = false;
  for (const delay of FETCH_RETRY_DELAYS_S) {
    if (delay > 0) {
      log(`Retrying merge-base/head fetch in ${delay}s...`);
      await sleep(delay);
    }
    if (fetchShallow(git, repoDir, [mergeBaseSha, headSha], fetchEnv)) {
      fetched = true;
      break;
    }
  }
  if (!fetched) {
    throw new Error(
      `Could not fetch merge base ${mergeBaseSha} and head ${headSha} after ${FETCH_RETRY_DELAYS_S.length} attempts.`,
    );
  }

  const diff = (from, pathspecs) =>
    git(["diff", "-U0", from, headSha, "--", ...pathspecs], { cwd: repoDir });
  const stat = (from, pathspecs) =>
    git(["diff", "--stat", from, headSha, "--", ...pathspecs], { cwd: repoDir });
  const fullTreePathspecs = [".", ...ignorePathspecs];

  const fullDiff = diff(mergeBaseSha, fullTreePathspecs);
  const fullStat = stat(mergeBaseSha, fullTreePathspecs);
  writeFileSync(out(PREPARED_FILES.FULL_DIFF), fullDiff);
  writeFileSync(out(PREPARED_FILES.FULL_STAT), fullStat);

  let reviewDiff;
  let reviewStat;
  if (reviewBaseSha === mergeBaseSha) {
    reviewDiff = fullDiff;
    reviewStat = fullStat;
  } else if (mainTouched !== null) {
    // Concatenating two unified diffs is fine: a diff is a sequence of
    // per-file hunks, and the two path sets are disjoint by construction.
    const include = mainTouched.map(name => `:(literal)${name}`);
    const exclude = mainTouched.map(name => `:(exclude,literal)${name}`);
    const parts =
      include.length === 0 ?
        { diff: [], stat: [] }
      : {
          diff: [diff(mergeBaseSha, [...include, ...ignorePathspecs])],
          stat: [stat(mergeBaseSha, [...include, ...ignorePathspecs])],
        };
    reviewDiff = Buffer.concat([
      ...parts.diff,
      diff(reviewBaseSha, [...fullTreePathspecs, ...exclude]),
    ]);
    reviewStat = Buffer.concat([
      ...parts.stat,
      stat(reviewBaseSha, [...fullTreePathspecs, ...exclude]),
    ]);
  } else {
    reviewDiff = diff(reviewBaseSha, fullTreePathspecs);
    reviewStat = stat(reviewBaseSha, fullTreePathspecs);
  }

  // An empty review scope over a non-empty PR means this push changed
  // nothing reviewable. The worker reads an empty diff as "skip every
  // check", which would take the resolution judge down with them: threads
  // whose file has since left the PR would never be closed. Widen back to the
  // merge base so the judge still runs.
  if (reviewDiff.length === 0 && fullDiff.length > 0 && reviewBaseSha !== mergeBaseSha) {
    log(
      `Nothing reviewable changed since ${reviewBaseSha}; widening to the merge base so thread resolution still runs.`,
    );
    reviewBaseSha = mergeBaseSha;
    mainTouched = null;
    reviewDiff = fullDiff;
    reviewStat = fullStat;
  }
  writeFileSync(out(PREPARED_FILES.DIFF), reviewDiff);
  writeFileSync(out(PREPARED_FILES.STAT), reviewStat);

  // A check going green on code it flagged last run is expected under an
  // incremental base, and unexplainable without this note.
  let note;
  if (reviewBaseSha === mergeBaseSha) {
    note = `merge base ${mergeBaseSha} (full PR diff)`;
  } else if (mainTouched !== null) {
    note = `last reviewed ${reviewBaseSha} (incremental), with ${mainTouched.length} file(s) touched by a base-branch merge re-diffed from ${mergeBaseSha} so the merged-in commits are not reviewed`;
  } else {
    note = `last reviewed ${reviewBaseSha} (incremental; lines reviewed on an earlier run are excluded)`;
  }
  log(`Reviewing ${note}...${headSha}`);

  return {
    mergeBaseSha,
    reviewBaseSha,
    note,
    paths: {
      diff: out(PREPARED_FILES.DIFF),
      stat: out(PREPARED_FILES.STAT),
      fullDiff: out(PREPARED_FILES.FULL_DIFF),
      fullStat: out(PREPARED_FILES.FULL_STAT),
    },
  };
}

// The action checks out the PR's merge commit (github.sha) at depth 2 so the
// agents read a tree with the base branch's latest helpers. Before any agent
// reads it, prove the checkout actually contains the PR head: the payload's
// merge commit can lag a push. A consumer that checks out the head itself is
// accepted too; either way the diffs above name explicit SHAs.
export function verifyCheckout({ git = defaultGit, repoDir, headSha }) {
  const head = git(["rev-parse", "HEAD"], { cwd: repoDir }).toString("utf8").trim();
  if (head === headSha) return `Checkout is the PR head ${headSha}.`;
  const secondParent =
    git(["rev-parse", "--verify", "--quiet", "HEAD^2"], { cwd: repoDir, allowFailure: true })
      ?.toString("utf8")
      .trim() ?? "";
  if (secondParent !== headSha) {
    throw new Error(
      `Checked-out commit ${head} is neither the PR head nor a merge of it ` +
        `(expected second parent ${headSha}, observed ${secondParent || "<unavailable>"}).`,
    );
  }
  return `Merge commit ${head} contains PR head ${headSha}.`;
}
