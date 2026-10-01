---
name: pr-merge-ready
description: Addresses all review comments on a PR automatically. Escalates genuine human decisions. Use when asked to /pr-merge-ready, create and babysit a PR, batch-fix PR comments, or address review feedback quickly.
---

# PR Merge Ready (one pass, then validate once)

This is the PR merge-ready workflow. It follows the same merge-ready loop (threads resolved, reviewers done, CI green) with a **speed contract**:

1. **Triage every open thread before editing any file.**
2. **Apply every Fix in one pass** (group by file; one file is opened/edited once).
3. **Validate once**, after all edits, with the repository's required formatter and test suite — never after each comment.
4. **One commit, one push** per iteration. Extra pushes re-run CI and trigger bot reviewers.
5. **Comments first, CI second.** Never sit in a CI wait while unresolved actionable threads exist.

Do **not** auto-fix decisions that belong to a human. Product/architecture/scope/intent trade-offs are **Escalate** — pause, ask with options grounded in existing patterns, wait. Never guess.

## Absolute rule: never reply on PR threads

**Never post a reply or comment on any PR review thread** — no `addPullRequestReviewThreadReply`, no `gh pr comment`, no posted text of any kind. Where you would otherwise reply (declines, decided escalations), **resolve the thread silently** and **surface the rationale to the user in chat**. Resolving a thread is a status change, not a reply, and is allowed.

## Which reviewers auto-resolve their own threads

Not every reviewer needs a manual `resolveReviewThread` call. Some bots re-scan the pushed commit and close their own thread once the flagged issue is gone; calling `resolveReviewThread` on those threads yourself is redundant, and for `weave-checks[bot]` it is actively wrong — it marks a thread resolved against a code state the bot never re-verified.

| Reviewer                                                         | Auto-resolves?                              | Action                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cursor[bot]` (Cursor Bugbot)                                    | Yes, once it re-scans and the issue is gone | **Fix:** push the code change only — do not call `resolveReviewThread`. **Decline:** resolve manually (there's nothing new for the bot to re-scan). |
| `cubic-dev-ai[bot]` (Cubic)                                      | Yes, same as above                          | Same as Cursor Bugbot.                                                                                                                              |
| `weave-checks[bot]` (body carries `<!-- weave-check:<slug> -->`) | Yes, same as above                          | Same as Cursor Bugbot.                                                                                                                              |
| `greptile-apps[bot]`                                             | No                                          | Always resolve manually — Fix and Decline both.                                                                                                     |
| Human reviewers                                                  | No                                          | Always resolve manually — Fix and Decline both.                                                                                                     |
| Any other/unrecognized author                                    | Assume no                                   | Always resolve manually. Only skip the mutation for the three named auto-resolving bots above.                                                      |

Identify the author(s) from each `unresolved_comments` entry's `authors` field (or the `<!-- weave-check: -->` marker in `body`) during triage, and carry that classification into the resolve step.

**Reading a Weave Checks finding against its criteria.** The marker's `<slug>` identifies the rule file, typically `.weave-checks/<slug>.md` in a consuming repository or `starter-checks/<slug>.md` in this repository. Read that file, its scope, and any exclusions before deciding whether the finding applies.

**Collapsed threads and mixed authorship:** `pr-fix-plan` collapses same-location threads into one entry with a deduplicated `authors` list and a separately deduplicated `thread_ids` list — the two are **not positionally paired**. Apply the auto-resolving-bot exception only when **every** entry in `authors` is one of the three auto-resolving bots. If mixed, resolve **all** of that entry's `thread_ids` manually.

## Prerequisites

- GitHub CLI authenticated: `gh auth status`
- `jq` 1.6+ installed
- If working with stacked PRs, use the repository's stack-management workflow
- On the PR branch locally, or provide PR number
- Use the bundled analyzer at `./.agents/skills/pr-merge-ready/scripts/pr-fix-plan.sh` (also available through `./.claude/skills/pr-merge-ready/scripts/`); do not assume `pr-fix-plan.sh` is installed on `PATH`
- Run `npm run test` during Step 4; run `npm run format` before any commit or push

## Commit workflow

**NEVER `git add -A`.** Stage only files you changed.

1. Run `npm run format` before committing or pushing (Step 4 for review fixes)
2. `git add <specific files>`
3. `git commit -m "message"`
4. `git push` (or submit the stack through its usual workflow)

If the branch is out of date: `git push --force-with-lease` only after verifying you don't overwrite someone else's work. Never raw `git push --force`.

## High-level loop

```
0. Identify or create PR; align checkout with the PR's base repository and head SHA
0b. CHECKS PREFLIGHT: read the applicable `.weave-checks`/`starter-checks` criteria
1. Fetch fresh state
2. If DONE → exit
3. If actionable threads:
   a. TRIAGE ALL threads first (Fix / Decline / Skip / Escalate)
   b. Surface Escalates together in one batch of questions; wait if they block
   c. APPLY ALL Fixes in one pass (group by file)
   d. Resolve all Declines (and decided Escalates) silently
   e. Validate ONCE after all edits (Step 4)
   f. One commit + one push
   g. Go to step 1 — do NOT wait for CI yet
4. Else (zero actionable threads):
   a. Foreground CI-wait with cheap comment sentinel (Step 6)
   b. New comment → abort CI wait, go to Step 1
   c. CI all green + DONE → exit
```

### DONE conditions (ALL must hold against the LATEST head SHA)

Exit only when every condition is true on the same poll, _after CI has dispatched for the current head SHA_:

1. **No actionable review comments** — `unresolved_comments` is empty, or every remaining entry is Skip, `is_outdated: true`, or the issue no longer applies (`code_context`). For any thread in the skip ledger (an auto-resolving-bot thread left open under the exception): if the bot has closed it, count DONE; if the bounded fallback has **not** yet fired (≥2 pr-fix-plan polls AND ≥5 min), **do not count DONE and do not force-resolve** — wait for the bot. Only after that window, if the thread is still open, force-resolve, surface the deviation, then count DONE. Escalate threads awaiting a user decision **block DONE**.
2. **All required CI checks for the head SHA are present and concluded.**
3. **No CI pending/running** — `checks_summary.pending == 0` and `checks_fetch_failed` is absent. If `checks_fetch_failed: true`, CI is unknown — do not count as done.
4. **No `REVIEW_REQUESTED`** — `reviewRequests` is empty.
5. **No `CHANGES_REQUESTED`** — `reviewDecision` is not `CHANGES_REQUESTED`; each `latestReviews` state is `APPROVED`, `COMMENTED`, or `DISMISSED`.

## Execution

### Step 0: Identify or create the PR and align the local branch

Single-PR scoped. Use the user's PR number, else infer from the current branch. If the branch has
no PR yet, create one before fetching review state:

1. Ensure the intended changes are committed. Stage only the changed files; **never** use `git add -A`.
2. Push the branch, using `git push -u origin HEAD` when it has no upstream.
3. Open a ready-for-review PR with `gh pr create --base main` (do not pass `--draft` unless the user explicitly asks).
4. Capture the resulting PR number and continue with the same workflow below.

If there are no changes to publish and no PR exists, stop and ask the user what should be reviewed.

Resolve `OWNER/REPO` to the PR's **base repository** from the current repository context. The head owner/repository identify the fork containing the code; do not pass those values to the analyzer, which queries the PR in its base repository.

```bash
read -r OWNER REPO < <(gh repo view --json owner,name --jq '[.owner.login, .name] | @tsv')
gh pr view "${PR_NUMBER:-}" --repo "$OWNER/$REPO" \
  --json number,headRepositoryOwner,headRepository,headRefName,headRefOid \
  -q '{number: .number, head_owner: .headRepositoryOwner.login, head_repo: .headRepository.name, branch: .headRefName, sha: .headRefOid}'
```

If the base repository cannot be resolved from the checkout, use the base repository explicitly; never substitute the fork's head repository.

For a mid-stack PR, use the repository's stack workflow to check out the PR head, then verify `git rev-parse HEAD` equals the PR's `headRefOid`. For a non-stack PR, use the PR number and base repository so GitHub CLI can select the correct fork ref; do not check out by branch name alone:

```bash
# Stop rather than switching away from uncommitted work.
test -z "$(git status --porcelain)" || { echo "Working tree is dirty" >&2; exit 1; }
gh pr checkout "$PR_NUMBER" --repo "$OWNER/$REPO" --branch "pr-${PR_NUMBER}-${HEAD_SHA:0:12}"
test "$(git rev-parse HEAD)" = "$HEAD_SHA" || { echo "PR head SHA mismatch" >&2; exit 1; }
```

If that unique local branch already exists at a different commit, choose another unused local name rather than resetting it. Before editing or pushing, verify the local branch tracks the PR head ref from `head_owner/head_repo`. If the checkout or upstream cannot be verified safely, stop and ask. Fixes always go on the PR's own head branch.

### Step 0b: Check-criteria preflight (once, before any triage or edit)

Read the applicable rules before triage: custom checks in the PR's `.weave-checks/` directory and, for this repository's default checks, relevant files in `starter-checks/`. Review each rule's scope and any exclusions to assess whether a finding is actionable.

### Step 1: Fetch fresh PR state (every iteration)

Re-fetch every iteration. Never reuse stale data. **Do not hand-roll GraphQL for review threads.**

```bash
./.agents/skills/pr-merge-ready/scripts/pr-fix-plan.sh "$PR_NUMBER" --owner "$OWNER" --repo "$REPO" --max-comments 0 --json
gh pr view "$PR_NUMBER" --json headRefOid,reviewDecision,reviewRequests,latestReviews
```

`--max-comments 0` = no display cap. pr-fix-plan paginates all review threads (fails loudly past 20 pages / 2,000 threads). GitHub orders threads oldest-first and resolved threads never leave the connection — a single-page `first:100` fetch goes permanently blind past 100 total threads.

`pr-fix-plan --json` returns:

- `head_branch`, `head_sha`, and `is_checked_out` — `is_checked_out` means the local `HEAD` SHA equals the PR head SHA; if false, use Step 0's safe checkout rather than checking out by branch name alone
- `changed_files` — do NOT re-derive via `git diff`
- `unresolved_comments` — unresolved, collapsed. Each has `file`, `line`, `start_line`, `authors`, `body`, `urls`, `thread_ids`, `is_outdated`, `collapsed_count`, `code_context`, `related_lines_in_pr`, `thread_comments`
- `top_level_comments` — omitted when empty
- `pattern_summary`
- `checks` / `checks_summary` — if `checks_fetch_failed: true`, the empty list is NOT trustworthy

Skip `is_outdated: true` entries when counting actionable work. Also skip any whose `code_context` shows the issue is already addressed.

`top_level_comments` are not line-anchored. Triage them the same Fix/Decline/Escalate/Skip way, but they have no `thread_ids` to GraphQL-resolve — Fix by editing, Decline/Skip by noting in chat only.

**Comment-first:** any non-Skip entry whose issue still applies → Steps 2–5 immediately. Do not wait for CI, even if checks are running or failed.

**CI-wait:** only when zero actionable comments → Step 6.

### Step 2: Triage ALL unresolved threads before touching code

Walk every actionable `unresolved_comments` entry **before any edit**. Produce a batch plan:

```
Fix     : [thread ids / files]
Decline : [thread ids + one-line rationale]
Escalate: [thread ids]
Skip    : [thread ids]
```

Announce this list to the user, then execute. Do not drip-triage (classify one, edit, classify next).

| Category | Type                                                                 | Action                                                   |
| -------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| Fix      | Bug, security, style, clear refactor, nit                            | Implement in the Step 3 pass                             |
| Decline  | False positive, already handled, would make code worse, out of scope | No code change; resolve silently; note rationale in chat |
| Escalate | Genuine human decision                                               | Do not change code. Ask (Step 3.5)                       |
| Skip     | Pure questions / discussion                                          | Leave unresolved                                         |

**Fix vs Escalate.** Fix = one objectively-correct resolution matching existing patterns. Escalate signals:

- Product / UX / behavior change
- Architectural trade-off with lasting consequences
- Scope expansion beyond the PR
- Ambiguous intent only the author knows
- Conflicting reviewers
- Risk / blast radius (security, data integrity, billing, migrations)

When in genuine doubt between Fix and Escalate, **Escalate**. (Low-stakes mechanical nits still default to Fix.)

### Step 3: Apply the whole Fix set in one pass

**Do not validate, commit, or push inside this step.**

1. Group Fix threads by file. Open each file once.
2. Use `code_context` and `related_lines_in_pr` instead of re-reading the diff / grepping. Open the file only for surrounding context.
3. Apply every requested change in that file, including every `related_lines_in_pr` site (fix the pattern once, everywhere it appears in the PR).
4. Move to the next file.
5. Independent files may be edited in parallel (multiple Edit/Write calls in one turn). Dependent edits (same file, or A must land before B compiles) stay serial.

Guidelines: only the changes requested; no unrelated refactors.

#### Decline

No code change, no PR reply. Resolve in Step 5. Collect one concise chat line each: what was asked, why you're declining (1–3 sentences, specific).

#### Skip

Leave alone.

#### Escalate → Step 3.5

Never change code or resolve on your own.

1. Investigate first (referenced file/line, surrounding code, how similar cases are handled).
2. Frame each thread: reviewer ask + link; why it needs a human; 2–4 options grounded in existing patterns with trade-offs; your recommendation.
3. Present **all** escalations together with `AskUserQuestion`.
4. If the user has not responded and the only remaining work is escalations, **stop the loop** — do not spin or sit in CI wait. Resume from Step 1 when they answer.
5. Once they choose, treat the chosen option as a Fix (fold into the current pass if you haven't validated yet; otherwise a new iteration). Resolve silently. If they defer, leave unresolved — the PR is blocked on it.

Do not auto-resolve an escalated thread. Do not let it slip through as a Fix because asking felt slower.

### Step 4: Validate ONCE after all fixes

Run this **after every Fix in this iteration is applied**, and **never per comment**. Skip the whole step if this iteration was all-Decline (no files changed).

Run the repository's formatter and tests once after the batch of fixes. Inspect the diff after formatting. Because `npm run format` may rewrite files repository-wide, restore unrelated formatting-only changes outside this iteration's fix set before staging; do not discard intended changes.

#### Format before validation

```bash
npm run format
```

#### Then run tests

- `npm run test`

#### Re-run fixed Weave Checks findings

When this iteration fixes one or more Weave Checks findings, run only those checks against the updated diff before committing or pushing. Use the check directory identified in Step 0b, the slug or comma-separated slugs from the findings' `<!-- weave-check:<slug> -->` markers, and the PR's base ref:

```bash
npx @weave-os/checks run --checks-dir .weave-checks --only <slug[,slug...]> --base origin/main
```

Replace `.weave-checks`, the slug placeholder, and `origin/main` with the applicable check directory, finding slug(s), and PR base ref (for example, use `starter-checks` for this repository's default checks). Do not push while the targeted check still reports the finding.

### Step 5: One commit, one push, then resolve

**Push before resolving human/Greptile Fix threads.** Resolving first and then failing the push leaves threads closed against code that never landed. Declines have no code change, so they can resolve immediately.

Resolve all Decline threads now. After a successful push, resolve Fix threads and decided Escalates — **except** the auto-resolving-bot exception below. Use each entry's `thread_ids` (collapsed comments may list more than one — resolve every id).

**Auto-resolving-bot exception (Fix only):** for a Fix whose `authors` are entirely `cursor[bot]`, `cubic-dev-ai[bot]`, or `weave-checks[bot]`, do **not** call `resolveReviewThread` — push and let the bot close it. Declines on those same threads still need a manual resolve. Greptile and humans always get a manual resolve.

**Bounded fallback:** carry a skip ledger `(thread_id, first_seen_unresolved_at)`. On every **full** pr-fix-plan poll inside Step 6 (~2 min cadence, not the cheap sentinel), if a skipped bot thread has been open across **≥2 full pr-fix-plan polls AND ≥5 min** since first seen, force-resolve it and tell the user the bot never closed it. Fire this from Step 6 too — Step 5 may never run again during a CI wait.

```bash
gh api graphql -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) { thread { isResolved } }
  }
' -f threadId='{THREAD_ID}'
```

Then **one** commit and **one** push (skip if no files changed):

```bash
git add path/to/fixed1.go path/to/fixed2.tsx
git commit -m "fix: address PR review feedback (iteration N)

Fixed:
- [summary of fix 1]
- [summary of fix 2]

Declined (with explanation):
- [summary of declined 1]"
git push   # or submit with the repository's stack workflow
PUSHED_HEAD_SHA=$(git rev-parse HEAD)
# now resolve human/Greptile Fix thread_ids (Declines already resolved above)
```

If push is rejected as out of date, fetch and rebase onto the current base branch or sync the stack using its usual workflow, then push with `--force-with-lease`. Never raw `--force`. Do not resolve Fix threads until the push succeeds.

**After push:** enter the Step 6 watcher. Do not run an in-band `pr-fix-plan`. Auto-reviewers file new threads on the new commit asynchronously — "zero threads right before push" is meaningless for the new SHA.

Skipped bot Fix threads may still show `isResolved: false` until the bot re-scans. If `code_context` shows the issue is gone, treat as non-actionable — but not merge-ready until the bot closes it or the bounded fallback fires.

### Step 6: Foreground CI wait with comment sentinel

**Enter only when Step 1 found zero actionable threads.** The instant the sentinel detects a new unresolved thread, abort and return to Step 1.

A naive `gh pr checks` right after push reports `pending=0` because GitHub has not dispatched yet. Anchor on the head SHA; validate dispatch before treating CI as done.

#### Cheap sentinel + full fetch-on-fire

Do not run `pr-fix-plan` on every 15s sentinel tick. Poll the cheap GraphQL sentinel, and run the full fetch only when something changes or periodically for CI status.

- **Sentinel** every 15–30s: unresolved count + `updatedAt` of the most recent review. Tune toward 15s in the first 2 min after push (bots are most active); 30s later.
- **Full fetch** when the sentinel fires, or every ~2 min for CI status.

Keep the watcher in the foreground so new review activity is noticed promptly.

#### Sentinel query

`CAPTURED_UNRESOLVED_COUNT` / `CAPTURED_THREAD_TOTAL` are taken from **one sentinel read at CI-wait entry**. Baseline and every poll must count the same population — every non-outdated unresolved thread, including Skip and pending auto-resolving-bot threads. Do **not** derive the baseline from pr-fix-plan's actionable count (that excludes those, so every poll looks like "new thread").

The sentinel MUST read the **newest** page (`last:100`, never `first:100`). GitHub orders oldest-first and resolved threads stay forever, so `first:100` reports `unresolved=0` on busy PRs while new comments sit at the tail.

```bash
gh api graphql -f query='
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        headRefOid
        reviewThreads(last: 100) {
          totalCount
          edges {
            node {
              isOutdated
              isResolved
              comments(last: 1) { edges { node { updatedAt } } }
            }
          }
        }
        reviews(last: 10, states: [COMMENTED, APPROVED, CHANGES_REQUESTED]) {
          edges { node { updatedAt } }
        }
      }
    }
  }
' -f owner="$OWNER" -f repo="$REPO" -F pr="$PR_NUMBER" --jq '
  .data.repository.pullRequest | {
    sha: .headRefOid,
    thread_total: .reviewThreads.totalCount,
    unresolved: [.reviewThreads.edges[].node | select(.isResolved == false and .isOutdated == false)] | length,
    latest_thread_timestamp: ([.reviewThreads.edges[].node.comments.edges[].node.updatedAt] | sort | last),
    latest_review_timestamp: ([.reviews.edges[].node.updatedAt] | sort | last)
  }
'
```

`thread_total` is the arrival detector (monotonic — resolved threads never leave). `unresolved` is the state detector. Compare **both** to the entry baseline. `unresolved` alone misses a swap (new thread filed in the same interval an old one closed). A **reply on an existing unresolved thread** changes neither count — detect it via `latest_thread_timestamp` (the query uses `comments(last: 1)` so that is the newest comment, not the first).

#### Watcher loop

```
captured_unresolved_count, captured_thread_total = one sentinel read at entry
last_seen_sha = HEAD_SHA
last_seen_thread_timestamp, last_seen_review_timestamp = that same read

loop:
  sleep 15–30s
  run sentinel

  if sentinel.sha != last_seen_sha:
    # Someone else pushed. Watcher is stale.
    break → Step 1

  if sentinel.thread_total > captured_thread_total:
    break → Step 1   # new thread (catches the swap case)

  if sentinel.unresolved > captured_unresolved_count:
    break → Step 1

  if sentinel.latest_thread_timestamp > last_seen_thread_timestamp:
    break → Step 1   # reply on an existing unresolved thread

  if (sentinel.latest_review_timestamp > last_seen_review_timestamp) and sentinel.unresolved > 0:
    break → Step 1   # activity on a previously-Skip thread, or overdue re-triage

  # Dispatch check ONCE after the first sentinel cycle, not every tick
  if not yet validated dispatch:
    check_run_count = gh api "repos/$OWNER/$REPO/commits/$HEAD_SHA/check-runs" --jq '.total_count'
    if check_run_count == 0: continue  # no runs dispatched yet; don't false-DONE

  # Full CI check every ~5 sentinel cycles (~2 min), not every tick
  if cycles_since_last_ci_check >= 5:
    ./.agents/skills/pr-merge-ready/scripts/pr-fix-plan.sh "$PR_NUMBER" --owner "$OWNER" --repo "$REPO" --max-comments 0 --json
    also run the bounded bot-thread fallback against the skip ledger (force-resolve if ≥2 polls AND ≥5 min)
    if checks_summary.failed > 0:
      # Do not wait for remaining checks. Pull logs, fix, push.
      break → Step 1 with failing checks as extra Fix items
    if checks all concluded and pending == 0:
      fetch reviewer state; if DONE (skip-ledger threads only after bot close or post-window force-resolve) → Step 7
    if actionable comments → Step 1

  if elapsed_watch_minutes > 45: surface to user, stop
```

Use a foreground `while`/`sleep` loop. If you genuinely must pause or yield, provide a concise state-carrying resume prompt rather than restarting the workflow from scratch.

#### If you must yield: state-carrying resume prompt (never `/pr-merge-ready`)

If a fresh agent/session resumes the work, provide the current loop state and next action instead of restarting PR discovery.

```
Resume the pr-merge-ready loop from this state; do not restart PR setup unless the state is unavailable.
PR #<num> <owner>/<repo>, branch <headRefName>, head SHA <sha>
Phase: <ci-wait | fixing threads | blocked-on-escalation> · Iteration <n>/5
Sentinel baseline (captured unresolved / captured total): <n> / <m>
Pending escalations: <one line each, or "none">
Declines to surface at exit: <count>
Last CI state: <pass/fail/pending counts, or "not yet dispatched for this SHA">
On wake: run the Step 1 fetch (`./.agents/skills/pr-merge-ready/scripts/pr-fix-plan.sh <num> --owner <owner> --repo <repo> --max-comments 0 --json`; `gh pr view <num> --json headRefOid,reviewDecision,reviewRequests,latestReviews`), re-evaluate DONE, then comments-first.
If the skill body is no longer in context (compacted away), Read .agents/skills/pr-merge-ready/SKILL.md once before acting.
```

#### When CI wait completes (no new threads)

1. Read failing check logs for any `bucket: fail` rows and feed them into the next iteration as issues to fix:

   ```bash
   gh run view <run-id> --log-failed 2>&1 | grep -E 'error|Error|##\[error\]|FAIL' | head -40
   ```

2. Re-run `pr-fix-plan` once more (auto-reviewers may have posted at the end of CI).
3. Go back to Step 1.

### Step 7: Stop

When Step 1's DONE check passes against the latest head SHA:

```
PR #<num> ready to merge:
  - Resolved threads this run: <count>
  - Declined threads this run: <count>
  - Escalated → user-decided this run: <count>
  - CI checks: all green (<count> checks)
  - Reviewers: <list>
```

If after **5 full iterations** (5 push cycles) the loop hasn't terminated, stop and surface the blocker. Don't loop forever.

## Anti-patterns

| Anti-pattern                                                                  | Why it bit us                                                                                     | Instead                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Running validation after each individual fix                                  | Repeats formatter/test work for a batch of review fixes                                           | Apply all fixes, then validate once in Step 4                          |
| Fix comment 1 → validate → commit → fix comment 2 → validate…                 | Repeats formatting, tests, CI, and bot review for each comment instead of handling the batch once | Triage all → edit all → validate once → one push                       |
| Resolving Fix threads, then a push that fails                                 | Threads closed against code that never landed                                                     | Push first, resolve human/Greptile Fixes after                         |
| Waiting for all checks after the first red result                             | Delays action while unrelated checks continue                                                     | Investigate the failing check, fix it, and push a new iteration        |
| Falling through to another PR review workflow                                 | This skill is the full workflow and validates once per batch                                      | This file is the full workflow                                         |
| Waiting for CI before fixing review comments                                  | Reviewers blocked while the agent watches checks                                                  | Comments first                                                         |
| Sitting in CI wait without polling for new threads                            | Auto-reviewers post during CI                                                                     | Sentinel every 15–30s                                                  |
| Polling CI immediately after push                                             | `pending=0` before dispatch → false DONE                                                          | Anchor on `commits/$HEAD_SHA/check-runs` count                         |
| Treating "0 threads at push time" as forever                                  | Bots post minutes later                                                                           | Sentinel + re-fetch after CI                                           |
| Conflating PRs in a stack                                                     | Comments on PR #2 fixed on PR #1's branch                                                         | Verify base repo, head repo, and checked-out head SHA each iteration   |
| Auto-fixing a product/architecture/scope decision                             | Shipped an opinionated change the author didn't want                                              | Escalate                                                               |
| Asking with no research or options                                            | Forces the human to do the legwork                                                                | Investigate, then 2–4 grounded options + recommendation                |
| Running `pr-fix-plan` on every sentinel tick                                  | Repeats full PR fetches unnecessarily                                                             | Cheap GraphQL sentinel; full fetch on fire or periodically             |
| Passing `/pr-merge-ready` as the scheduled resume prompt                      | Repeats PR setup on every wake-up                                                                 | Resume with a concise state-carrying prompt                            |
| Manually resolving an auto-resolving bot Fix right after push                 | The bot may not have re-scanned the pushed change yet                                             | Skip resolve; let the bot re-scan                                      |
| Skipping resolve on a Decline just because the bot auto-resolves Fixes        | Nothing new to re-scan → thread sits open                                                         | Always resolve Declines yourself                                       |
| Applying the bot exception to a collapsed entry that mixes a bot with a human | `authors` and `thread_ids` aren't paired — you'd strand the human thread                          | Only skip when `authors` is entirely auto-resolving bots               |
| Declaring merge-ready while a skipped bot thread is still open                | Bot never re-scanned                                                                              | Wait the 2-poll / 5 min window; only then force-resolve and count DONE |
| Sentinel `comments(first: 1)`                                                 | Replies on an open thread never bump counts; oldest timestamp stays put                           | `comments(last: 1)` + compare `latest_thread_timestamp`                |

## Error handling

| Issue                                       | Solution                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Comment references deleted line             | Check git history, apply to current location                                               |
| File was renamed                            | Find new path, apply there                                                                 |
| Conflicting comments                        | Address most recent; note the conflict in chat                                             |
| Fix breaks tests                            | Revert or correct the fix, then rerun `npm run test`                                       |
| CI check stuck `IN_PROGRESS` >30min         | Surface to user, stop the watcher                                                          |
| Reviewer keeps re-requesting the same point | After 2 declines on the same thread, surface to user                                       |
| Push rejected (rebase / merged dependency)  | Rebase onto the current base branch or sync the stack, then push with `--force-with-lease` |

## Notes

- Always re-run `pr-fix-plan` (+ `gh pr view` for reviewer state) at the **start** of every iteration.
- A Skip thread does not block DONE — it stays unresolved on purpose.
- Prefer minimal fixes.
- When declining, resolve silently and surface the rationale in chat.
- Cap iterations at **5** push cycles.
- Output discipline: announce the unresolved-thread batch plan before editing. If the sentinel interrupts a CI wait, say so ("sentinel detected new review thread — fixing before CI finishes").
