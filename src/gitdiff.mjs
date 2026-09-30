// Builds the diff a local run reviews, from a developer's working tree.
//
// Reviews the filesystem state, not just what's committed: an engineer
// running this before committing has exactly the changes they want reviewed
// sitting staged, unstaged, or untracked, and a plain `git diff <base> HEAD`
// would silently review only what was already committed. So the whole
// working tree is snapshotted into a throwaway index and THAT is diffed
// against the base -- never touching the user's real index or staged state.
//
// Invariants (gitdiff.test.mjs pins each one):
//
//   1. The scratch GIT_INDEX_FILE lives outside the repository and is removed
//      in `finally`; the real index is never written.
//   2. The scratch index is seeded with `git read-tree HEAD` before
//      `git add -A`. Otherwise a file both tracked and matched by .gitignore
//      is absent from the index -- `add -A` won't add ignored paths -- and
//      the diff reports it as a wholesale deletion.
//   3. Generated output, artifacts, and settings overlays are excluded from
//      the snapshot with `:(exclude)`, so a run never reviews its own files
//      (a settings overlay can carry routing credentials). The repository
//      root is rejected as such a path: excluding "." drops the whole tree.
//   4. The checks directory's ignore list is applied to the diff commands,
//      not just the snapshot: an ignored path already committed on the
//      branch is in HEAD, and so in the scratch index, regardless.
//   5. Git output is written untrimmed; whitespace and the final newline are
//      part of the diff and the stat.
//   6. Git runs from argument arrays (git.mjs), never a shell string.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { git as defaultGit, gitLine } from "./git.mjs";

// GitHub diffs a PR against the remote's base branch; a local `main` goes
// stale. The fallback is for a clone with no `origin/main` at all.
export const DEFAULT_BASE = "origin/main";
export const FALLBACK_BASE = "main";

export function repoRoot(cwd) {
  const root = gitLine(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (root === null) throw new Error(`${path.resolve(cwd)} is not inside a git repository`);
  return root;
}

export function refExists(repoDir, ref, { git = defaultGit } = {}) {
  return (
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoDir,
      allowFailure: true,
    }) !== null
  );
}

// The commit the diff is taken from. Defaults to the merge base, because that
// is what GitHub's PR diff is: a three-dot comparison. A two-dot diff against
// a base that has moved ahead would show lines from commits that landed on
// the base since the branch point -- lines the PR does not contain.
//
// Only the default base falls back: an explicit base is taken at face value,
// so a typo surfaces as a git error rather than a silent diff against
// something else.
export function resolveDiffBase({
  repoDir,
  base = DEFAULT_BASE,
  useMergeBase = true,
  head = "HEAD",
  git = defaultGit,
}) {
  const ref =
    base === DEFAULT_BASE && !refExists(repoDir, DEFAULT_BASE, { git }) ? FALLBACK_BASE : base;
  const args =
    useMergeBase ? ["merge-base", ref, head] : ["rev-parse", "--verify", `${ref}^{commit}`];
  return git(args, { cwd: repoDir }).toString("utf8").trim();
}

// Repo-relative POSIX path for `target`, or null when it sits outside the
// repository. Throws for the repository root itself (invariant 3).
export function repoRelativePathspec(repoDir, target) {
  const relative = path.relative(path.resolve(repoDir), path.resolve(target));
  if (relative === "") {
    throw new Error(
      `${target} cannot be the repository root: generated files would enter the review diff. ` +
        "Pick a subdirectory or a path outside the repository.",
    );
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  return relative.split(path.sep).join("/");
}

function isGitIgnored(git, repoDir, pathspec, env) {
  // check-ignore answers with its exit code (0 ignored, 1 not). It consults
  // the index as well, so a force-tracked path inside an ignored directory
  // reads as not ignored.
  return (
    git(["check-ignore", "-q", "--", pathspec], { cwd: repoDir, env, allowFailure: true }) !== null
  );
}

// Writes `pr.diff` and `pr.stat` for base..working-tree into `outDir`.
// `excludePaths` are filesystem paths (artifacts, output files) to keep out of
// the snapshot; `ignorePathspecs` are the checks directory's `:(exclude)`
// pathspecs (ignore.mjs).
export function writeWorkingTreeDiff({
  repoDir,
  base,
  outDir,
  excludePaths = [],
  ignorePathspecs = [],
  git = defaultGit,
}) {
  // Resolve exclusions first, so a bad path fails before any git state exists.
  const excluded = excludePaths
    .map(target => repoRelativePathspec(repoDir, target))
    .filter(pathspec => pathspec !== null);

  // Outside the repository, so no snapshot can ever sweep it up (invariant 1).
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), "weave-checks-index-"));
  const env = { GIT_INDEX_FILE: path.join(scratchDir, "index") };
  try {
    git(["read-tree", "HEAD"], { cwd: repoDir, env });
    // Naming a gitignored path is fatal even under :(exclude) -- git rejects
    // it ("The following paths are ignored by one of your .gitignore
    // files") -- and .gitignore already keeps it out, so only unignored
    // exclusions are passed.
    const snapshotExcludes = excluded
      .filter(pathspec => !isGitIgnored(git, repoDir, pathspec, env))
      .map(pathspec => `:(exclude)${pathspec}`);
    git(["add", "-A", "--", ".", ...snapshotExcludes], { cwd: repoDir, env });
    // -U0 matches CI: the agent reviews changed lines only, so context lines
    // would just invite comments that diff validation then drops.
    const diff = git(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-U0",
        "--cached",
        base,
        "--",
        ".",
        ...ignorePathspecs,
      ],
      { cwd: repoDir, env },
    );
    const stat = git(
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--cached",
        "--stat",
        base,
        "--",
        ".",
        ...ignorePathspecs,
      ],
      { cwd: repoDir, env },
    );
    return writeDiffFiles(outDir, diff, stat);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

// Writes `pr.diff` and `pr.stat` for a committed range, e.g. to review a
// branch that is already pushed without its working-tree noise.
export function writeRangeDiff({
  repoDir,
  base,
  head,
  outDir,
  ignorePathspecs = [],
  git = defaultGit,
}) {
  const diff = git(
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "-U0",
      base,
      head,
      "--",
      ".",
      ...ignorePathspecs,
    ],
    { cwd: repoDir },
  );
  const stat = git(
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--stat",
      base,
      head,
      "--",
      ".",
      ...ignorePathspecs,
    ],
    { cwd: repoDir },
  );
  return writeDiffFiles(outDir, diff, stat);
}

function writeDiffFiles(outDir, diff, stat) {
  const diffPath = path.join(outDir, "pr.diff");
  const statPath = path.join(outDir, "pr.stat");
  writeFileSync(diffPath, diff);
  writeFileSync(statPath, stat);
  return { diffPath, statPath, diff: diff.toString("utf8"), stat: stat.toString("utf8") };
}
