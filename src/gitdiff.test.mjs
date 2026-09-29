import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { git as realGit } from "./git.mjs";
import {
  DEFAULT_BASE,
  FALLBACK_BASE,
  repoRelativePathspec,
  resolveDiffBase,
  writeRangeDiff,
  writeWorkingTreeDiff,
} from "./gitdiff.mjs";

const ROOTS = [];
after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Checks",
  GIT_AUTHOR_EMAIL: "checks@example.com",
  GIT_COMMITTER_NAME: "Checks",
  GIT_COMMITTER_EMAIL: "checks@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "weave-checks-gitdiff-"));
  ROOTS.push(root);
  const dir = path.join(root, "repo");
  mkdirSync(dir);
  const git = (...args) => realGit(args, { cwd: dir, env: GIT_ENV }).toString("utf8");
  git("init", "-q", "-b", "main");
  const write = (name, text) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  };
  const commit = (message = "commit") => {
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  const out = path.join(root, "out");
  mkdirSync(out);
  return { root, dir, git, write, commit, out };
}

// Every scratch index this module creates lives under os.tmpdir() with this
// prefix; none may survive a call.
function scratchIndexes() {
  return readdirSync(os.tmpdir()).filter((name) => name.startsWith("weave-checks-index-"));
}

describe("writeWorkingTreeDiff", () => {
  it("includes staged, unstaged, and untracked changes without touching the real index", () => {
    const r = repo();
    r.write(".gitignore", "ignored/\n");
    r.write("ignored/tracked-unchanged.txt", "tracked and ignored\n");
    r.write("ignored/tracked-modified.txt", "base\n");
    r.write("tracked.txt", "base\n");
    r.git("add", ".");
    // Tracked files that also match an ignore rule: without read-tree HEAD
    // these would show up as deletions.
    r.git("add", "-f", "ignored/tracked-unchanged.txt", "ignored/tracked-modified.txt");
    const base = r.commit("base");

    r.write("staged.txt", "staged\n");
    r.git("add", "staged.txt");
    r.write("tracked.txt", "base\nunstaged\n");
    r.write("ignored/tracked-modified.txt", "base\nmodified despite ignore\n");
    r.write("untracked.txt", "untracked\n");
    r.write("ignored/junk.txt", "ignored\n");
    const indexBefore = readFileSync(path.join(r.dir, ".git", "index"));
    const scratchBefore = scratchIndexes();

    const { diff, stat } = writeWorkingTreeDiff({ repoDir: r.dir, base, outDir: r.out });

    for (const text of [diff, stat]) {
      assert.match(text, /staged\.txt/);
      assert.match(text, /tracked\.txt/);
      assert.match(text, /untracked\.txt/);
      assert.match(text, /ignored\/tracked-modified\.txt/);
      assert.doesNotMatch(text, /tracked-unchanged\.txt/);
      assert.doesNotMatch(text, /junk\.txt/);
    }
    assert.match(diff, /\+unstaged/);
    assert.doesNotMatch(diff, /^deleted file/m);
    // The real index is byte-identical and the user's staged state stands.
    assert.ok(readFileSync(path.join(r.dir, ".git", "index")).equals(indexBefore));
    assert.equal(r.git("status", "--short", "--", "staged.txt"), "A  staged.txt\n");
    assert.deepEqual(scratchIndexes(), scratchBefore);
  });

  it("removes the scratch index even when git fails", () => {
    const r = repo();
    r.write("a.txt", "a\n");
    r.git("add", ".");
    r.commit();
    const scratchBefore = scratchIndexes();

    assert.throws(() => writeWorkingTreeDiff({ repoDir: r.dir, base: "no-such-ref", outDir: r.out }), /git diff/);
    assert.deepEqual(scratchIndexes(), scratchBefore);
  });

  it("applies the ignore list to the diff, including already-committed paths", () => {
    const r = repo();
    r.write("app.go", "base\n");
    r.write("research/train.py", "old\n");
    r.git("add", ".");
    const base = r.commit("base");
    r.write("research/train.py", "old\ncommitted on the branch\n");
    r.git("add", ".");
    r.commit("branch");
    r.write("app.go", "base\nchanged\n");
    r.write("research/train.py", "old\ncommitted on the branch\nand uncommitted\n");

    const { diff, stat } = writeWorkingTreeDiff({
      repoDir: r.dir,
      base,
      outDir: r.out,
      ignorePathspecs: [":(exclude)research"],
    });

    assert.match(diff, /\+changed/);
    assert.doesNotMatch(diff, /research/);
    assert.doesNotMatch(stat, /research/);
  });

  it("excludes an in-repo artifacts directory and output file, credentials included", () => {
    const r = repo();
    r.write("tracked.txt", "base\n");
    r.git("add", ".");
    const base = r.commit();
    r.write("tracked.txt", "base\nchanged\n");
    r.write("review-out/matrix.json", '{"check":[]}\n');
    r.write("review-out/settings/settings-low.json", '{"env":{"ANTHROPIC_API_KEY":"sk-secret"}}\n');
    r.write("results.json", "{}\n");

    const { diff } = writeWorkingTreeDiff({
      repoDir: r.dir,
      base,
      outDir: r.out,
      excludePaths: [path.join(r.dir, "review-out"), path.join(r.dir, "results.json")],
    });

    assert.match(diff, /\+changed/);
    for (const leaked of ["review-out", "matrix.json", "settings-low.json", "sk-secret", "results.json"]) {
      assert.ok(!diff.includes(leaked), leaked);
    }
  });

  // git refuses an ignored path inside a pathspec, even under :(exclude).
  it("snapshots cleanly when the artifacts directory is gitignored", () => {
    const r = repo();
    r.write(".gitignore", ".weave-checks-local/\n");
    r.write("tracked.txt", "base\n");
    r.git("add", ".");
    const base = r.commit();
    r.write("tracked.txt", "base\nchanged\n");
    r.write(".weave-checks-local/settings/settings-low.json", '{"env":{"ANTHROPIC_API_KEY":"sk-secret"}}\n');

    const { diff } = writeWorkingTreeDiff({
      repoDir: r.dir,
      base,
      outDir: r.out,
      excludePaths: [path.join(r.dir, ".weave-checks-local")],
    });

    assert.match(diff, /\+changed/);
    assert.ok(!diff.includes("sk-secret"));
  });

  it("rejects the repository root as an excluded path", () => {
    const r = repo();
    r.write("tracked.txt", "base\n");
    r.git("add", ".");
    const base = r.commit();

    assert.throws(
      () => writeWorkingTreeDiff({ repoDir: r.dir, base, outDir: r.out, excludePaths: [r.dir] }),
      /cannot be the repository root/,
    );
  });

  it("writes git's bytes untrimmed", () => {
    const r = repo();
    r.write("a.txt", "a\n");
    r.git("add", ".");
    const base = r.commit();
    r.write("a.txt", "a\n  indented trailing  \n");

    writeWorkingTreeDiff({ repoDir: r.dir, base, outDir: r.out });

    const written = readFileSync(path.join(r.out, "pr.diff"), "utf8");
    assert.ok(written.endsWith("+  indented trailing  \n"));
    assert.ok(readFileSync(path.join(r.out, "pr.stat"), "utf8").startsWith(" a.txt | 1 +"));
  });

  it("handles paths with spaces and shell metacharacters as literal arguments", () => {
    const r = repo();
    r.write("a.txt", "a\n");
    r.git("add", ".");
    const base = r.commit();
    r.write("dir with space/$(touch pwned) ;.txt", "x\n");

    const { diff } = writeWorkingTreeDiff({ repoDir: r.dir, base, outDir: r.out });

    assert.match(diff, /\$\(touch pwned\) ;\.txt/);
    assert.equal(existsSync(path.join(r.dir, "pwned")), false);
  });
});

describe("writeRangeDiff", () => {
  it("diffs committed history only", () => {
    const r = repo();
    r.write("a.txt", "a\n");
    r.git("add", ".");
    const base = r.commit();
    r.write("a.txt", "a\ncommitted\n");
    r.git("add", ".");
    const head = r.commit();
    r.write("a.txt", "a\ncommitted\nuncommitted\n");

    const { diff } = writeRangeDiff({ repoDir: r.dir, base, head, outDir: r.out });

    assert.match(diff, /\+committed/);
    assert.doesNotMatch(diff, /uncommitted/);
  });
});

describe("resolveDiffBase", () => {
  function branched() {
    const r = repo();
    r.write("a.txt", "a\n");
    r.git("add", ".");
    const forkPoint = r.commit();
    r.git("checkout", "-q", "-b", "feature");
    r.write("b.txt", "b\n");
    r.git("add", ".");
    r.commit();
    r.git("checkout", "-q", "main");
    r.write("c.txt", "c\n");
    r.git("add", ".");
    const mainTip = r.commit();
    r.git("checkout", "-q", "feature");
    return { r, forkPoint, mainTip };
  }

  it("uses the merge base by default, falling back to main without origin/main", () => {
    const { r, forkPoint } = branched();
    assert.equal(DEFAULT_BASE, "origin/main");
    assert.equal(FALLBACK_BASE, "main");
    assert.equal(resolveDiffBase({ repoDir: r.dir }), forkPoint);
  });

  it("takes a two-dot base when asked", () => {
    const { r, mainTip } = branched();
    assert.equal(resolveDiffBase({ repoDir: r.dir, base: "main", useMergeBase: false }), mainTip);
  });

  it("never rewrites an explicit base", () => {
    const { r } = branched();
    assert.throws(() => resolveDiffBase({ repoDir: r.dir, base: "origin/develop" }), /git merge-base origin\/develop HEAD/);
  });
});

describe("repoRelativePathspec", () => {
  it("returns POSIX paths inside the repo and null outside", () => {
    assert.equal(repoRelativePathspec("/r", "/r/a/b"), "a/b");
    assert.equal(repoRelativePathspec("/r", "/elsewhere/x"), null);
    assert.equal(repoRelativePathspec("/r", "/r/../r2"), null);
    assert.throws(() => repoRelativePathspec("/r", "/r/"), /repository root/);
  });
});
