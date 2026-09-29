import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { git as realGit } from "./git.mjs";
import { formatReviewedMarker } from "./parse.mjs";
import { DIFF_BASE, fetchAuthEnv, preparePullRequest, verifyCheckout } from "./prepare.mjs";

const ROOTS = [];
after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function run(cwd, ...args) {
  return realGit(args, { cwd, env: GIT_ENV }).toString("utf8").trim();
}

// A repository standing in for GitHub ("origin") plus an empty clone that
// only has what prepare.mjs fetches -- the shape of the action's shallow
// checkout.
function repos() {
  const root = mkdtempSync(path.join(os.tmpdir(), "weave-checks-prepare-"));
  ROOTS.push(root);
  const origin = path.join(root, "origin");
  const work = path.join(root, "work");
  mkdirSync(origin);
  mkdirSync(work);
  run(origin, "init", "-q", "-b", "main");
  run(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  run(work, "init", "-q");
  run(work, "remote", "add", "origin", `file://${origin}`);
  const outDir = path.join(root, "out");
  mkdirSync(outDir);
  return {
    origin,
    work,
    outDir,
    commit(files, message = "change") {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(origin, name)), { recursive: true });
        writeFileSync(path.join(origin, name), text);
      }
      run(origin, "add", "-A");
      run(origin, "commit", "-q", "-m", message);
      return run(origin, "rev-parse", "HEAD");
    },
    checkout: ref => run(origin, "checkout", "-q", ref),
    branch: name => run(origin, "checkout", "-q", "-b", name),
    merge: ref => {
      run(origin, "merge", "-q", "--no-ff", "-m", "merge", ref);
      return run(origin, "rev-parse", "HEAD");
    },
    read: name => readFileSync(path.join(outDir, name), "utf8"),
  };
}

// Answers the three REST calls prepare.mjs makes from the origin repo's real
// history, so compare statuses and merge bases are what GitHub would say.
function fakeRest(space, { markers = {}, prCommits = null } = {}) {
  const calls = [];
  const isAncestor = (a, b) =>
    realGit(["merge-base", "--is-ancestor", a, b], { cwd: space.origin, allowFailure: true }) !==
    null;
  const rest = async (method, apiPath) => {
    calls.push(apiPath);
    let match = /^repos\/o\/r\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)\?per_page=1$/.exec(apiPath);
    if (match) {
      const [, a, b] = match;
      const status =
        a === b ? "identical"
        : isAncestor(a, b) ? "ahead"
        : isAncestor(b, a) ? "behind"
        : "diverged";
      return { status, merge_base_commit: { sha: run(space.origin, "merge-base", a, b) } };
    }
    match = /^repos\/o\/r\/pulls\/7\/commits\?per_page=100&page=(\d+)$/.exec(apiPath);
    if (match) {
      if (match[1] !== "1") return [];
      return (prCommits ?? []).map(sha => ({ sha }));
    }
    match =
      /^repos\/o\/r\/commits\/([0-9a-f]+)\/check-runs\?check_name=Weave%20Checks&filter=latest$/.exec(
        apiPath,
      );
    if (match) {
      const marker = markers[match[1]];
      return { check_runs: marker === undefined ? [] : [{ external_id: marker }] };
    }
    throw new Error(`unexpected call ${method} ${apiPath}`);
  };
  rest.calls = calls;
  return rest;
}

function prepare(space, rest, overrides = {}) {
  const logs = [];
  return preparePullRequest({
    rest,
    repoDir: space.work,
    outDir: space.outDir,
    repository: "o/r",
    prNumber: "7",
    aggregateName: "Weave Checks",
    sleep: async () => {},
    log: line => logs.push(line),
    ...overrides,
  }).then(result => ({ ...result, logs }));
}

const addedFiles = diff => [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1]);

describe("preparePullRequest", () => {
  it("reviews the full merge-base diff on a PR's first run", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const head = space.commit({ "app.js": "one\n" });

    const result = await prepare(space, fakeRest(space, { prCommits: [head] }), {
      baseSha: base,
      headSha: head,
    });

    assert.equal(result.mergeBaseSha, base);
    assert.equal(result.reviewBaseSha, base);
    assert.match(result.note, /full PR diff/);
    assert.equal(space.read("pr.diff"), space.read("pr.full.diff"));
    assert.deepEqual(addedFiles(space.read("pr.diff")), ["app.js"]);
  });

  it("writes git's bytes untrimmed, final newline included", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const head = space.commit({ "app.js": "trailing   \n" });

    await prepare(space, fakeRest(space, { prCommits: [head] }), { baseSha: base, headSha: head });

    const expected = realGit(["diff", "-U0", base, head, "--", "."], { cwd: space.origin });
    assert.ok(readFileSync(path.join(space.outDir, "pr.full.diff")).equals(expected));
    assert.ok(space.read("pr.full.diff").endsWith("+trailing   \n"));
  });

  it("narrows to the last fully reviewed commit, keeping the full scope for resolution", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const reviewed = space.commit({ "old.js": "reviewed\n" });
    const head = space.commit({ "new.js": "fresh\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [reviewed, head],
        markers: { [reviewed]: formatReviewedMarker(reviewed) },
      }),
      { baseSha: base, headSha: head },
    );

    assert.equal(result.reviewBaseSha, reviewed);
    assert.match(result.note, /incremental; lines reviewed on an earlier run are excluded/);
    assert.deepEqual(addedFiles(space.read("pr.diff")), ["new.js"]);
    assert.deepEqual(addedFiles(space.read("pr.full.diff")), ["new.js", "old.js"]);
  });

  it("walks past a commit whose run did not finish every check", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const reviewed = space.commit({ "a.js": "a\n" });
    const partial = space.commit({ "b.js": "b\n" });
    const head = space.commit({ "c.js": "c\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [reviewed, partial, head],
        // The newer run had an operational miss: no marker, or someone else's.
        markers: { [partial]: "", [reviewed]: formatReviewedMarker(reviewed) },
      }),
      { baseSha: base, headSha: head },
    );

    assert.equal(result.reviewBaseSha, reviewed);
    assert.deepEqual(addedFiles(space.read("pr.diff")), ["b.js", "c.js"]);
  });

  it("rejects a marker naming a different sha", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const reviewed = space.commit({ "a.js": "a\n" });
    const head = space.commit({ "b.js": "b\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [reviewed, head],
        markers: { [reviewed]: formatReviewedMarker(head) },
      }),
      { baseSha: base, headSha: head },
    );

    assert.equal(result.reviewBaseSha, base);
  });

  it("falls back to the merge base when the reviewed commit is no longer an ancestor", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const orphaned = space.commit({ "a.js": "before force-push\n" });
    space.checkout(base);
    space.branch("rewritten");
    const head = space.commit({ "a.js": "after force-push\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [orphaned, head],
        markers: { [orphaned]: formatReviewedMarker(orphaned) },
      }),
      { baseSha: base, headSha: head },
    );

    assert.equal(result.reviewBaseSha, base);
    assert.equal(space.read("pr.diff"), space.read("pr.full.diff"));
  });

  it("re-diffs files a base-branch merge touched from the current merge base", async () => {
    const space = repos();
    const oldBase = space.commit({ "shared.js": "v1\n", "main-only.js": "v1\n" });
    space.branch("feature");
    const reviewed = space.commit({ "feature.js": "first\n" });
    space.checkout("main");
    const newBase = space.commit({
      "main-only.js": "v2 from main\n",
      "shared.js": "v2 from main\n",
    });
    space.checkout("feature");
    space.merge("main");
    const head = space.commit({
      "feature.js": "first\nsecond\n",
      "shared.js": "v2 from main\nbranch edit\n",
    });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [reviewed, head],
        markers: { [reviewed]: formatReviewedMarker(reviewed) },
      }),
      { baseSha: newBase, headSha: head },
    );

    assert.equal(result.mergeBaseSha, newBase);
    assert.equal(result.reviewBaseSha, reviewed);
    assert.match(result.note, /2 file\(s\) touched by a base-branch merge re-diffed/);
    const review = space.read("pr.diff");
    // main-only.js changed only on main: from the current merge base it has
    // no diff at all, so the merged-in commit is never reviewed.
    assert.deepEqual(addedFiles(review).sort(), ["feature.js", "shared.js"]);
    assert.doesNotMatch(review, /\+v2 from main/);
    assert.match(review, /\+branch edit/);
    // feature.js stays incremental: only the new line.
    assert.match(review, /\+second/);
    assert.doesNotMatch(review, /\+first/);
    assert.equal(space.read("main-touched.txt"), "main-only.js\nshared.js\n");
    assert.ok(oldBase);
  });

  it("applies ignore pathspecs to both scopes", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const head = space.commit({ "app.js": "x\n", "vendor/lib.js": "y\n" });

    await prepare(space, fakeRest(space, { prCommits: [head] }), {
      baseSha: base,
      headSha: head,
      ignorePathspecs: [":(exclude)vendor"],
    });

    assert.deepEqual(addedFiles(space.read("pr.diff")), ["app.js"]);
    assert.deepEqual(addedFiles(space.read("pr.full.diff")), ["app.js"]);
  });

  it("widens back to the merge base when an incremental push changed only ignored paths", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const reviewed = space.commit({ "app.js": "x\n" });
    const head = space.commit({ "vendor/lib.js": "y\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [reviewed, head],
        markers: { [reviewed]: formatReviewedMarker(reviewed) },
      }),
      { baseSha: base, headSha: head, ignorePathspecs: [":(exclude)vendor"] },
    );

    assert.equal(result.reviewBaseSha, base);
    assert.ok(result.logs.some(line => /widening to the merge base/.test(line)));
    assert.deepEqual(addedFiles(space.read("pr.diff")), ["app.js"]);
  });

  it("never looks for a prior review in merge-base mode", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const reviewed = space.commit({ "a.js": "a\n" });
    const head = space.commit({ "b.js": "b\n" });
    const rest = fakeRest(space, {
      prCommits: [reviewed, head],
      markers: { [reviewed]: formatReviewedMarker(reviewed) },
    });

    const result = await prepare(space, rest, {
      baseSha: base,
      headSha: head,
      diffBase: DIFF_BASE.MERGE_BASE,
    });

    assert.equal(result.reviewBaseSha, base);
    assert.equal(rest.calls.length, 1);
  });

  it("degrades to the merge base when prior-run lookups fail", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const head = space.commit({ "b.js": "b\n" });
    const inner = fakeRest(space, { prCommits: [head] });
    const rest = async (method, apiPath) => {
      if (apiPath.includes("/pulls/")) throw new Error("HTTP 502");
      return inner(method, apiPath);
    };

    const result = await prepare(space, rest, { baseSha: base, headSha: head });

    assert.equal(result.reviewBaseSha, base);
    assert.ok(result.logs.some(line => /Could not list PR commits/.test(line)));
  });

  it("fails when the mandatory merge-base/head fetch never succeeds", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const head = space.commit({ "b.js": "b\n" });
    let fetches = 0;
    const git = (args, options) => {
      if (args[0] === "fetch") {
        fetches += 1;
        return null;
      }
      return realGit(args, options);
    };

    await assert.rejects(
      prepare(space, fakeRest(space, { prCommits: [head] }), { baseSha: base, headSha: head, git }),
      /Could not fetch merge base .* after 4 attempts/,
    );
    assert.equal(fetches, 4);
  });

  it("authenticates every fetch through the environment, never argv", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const head = space.commit({ "b.js": "b\n" });
    const seen = [];
    const git = (args, options) => {
      if (args[0] === "fetch") seen.push({ args, env: options.env });
      return realGit(args, options);
    };
    const fetchEnv = fetchAuthEnv("https://github.com", "ghs_secret");

    await prepare(space, fakeRest(space, { prCommits: [head] }), {
      baseSha: base,
      headSha: head,
      git,
      fetchEnv,
    });

    assert.ok(seen.length > 0);
    for (const call of seen) {
      assert.equal(call.env, fetchEnv);
      assert.ok(!call.args.join(" ").includes("ghs_secret"));
    }
  });

  it("rejects an unknown diff-base mode", async () => {
    const space = repos();
    await assert.rejects(
      prepare(space, fakeRest(space), { baseSha: "a", headSha: "b", diffBase: "two-dot" }),
      /diff-base must be one of/,
    );
  });
});

describe("verifyCheckout", () => {
  it("accepts a merge commit whose second parent is the PR head, or the head itself", () => {
    const space = repos();
    space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const head = space.commit({ "a.js": "a\n" });
    space.checkout("main");
    space.commit({ "b.js": "b\n" });
    space.merge("feature");

    assert.match(verifyCheckout({ repoDir: space.origin, headSha: head }), /contains PR head/);
    space.checkout(head);
    assert.match(verifyCheckout({ repoDir: space.origin, headSha: head }), /is the PR head/);
  });

  it("rejects a checkout that does not contain the PR head", () => {
    const space = repos();
    space.commit({ "README.md": "hello\n" });
    assert.throws(
      () => verifyCheckout({ repoDir: space.origin, headSha: "f".repeat(40) }),
      /neither the PR head nor a merge of it/,
    );
  });
});

describe("fetchAuthEnv", () => {
  it("builds an extraheader for the server from the token", () => {
    const env = fetchAuthEnv("https://github.example.com/", "tok");
    assert.equal(env.GIT_CONFIG_COUNT, "1");
    assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.example.com/.extraheader");
    assert.equal(
      env.GIT_CONFIG_VALUE_0,
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:tok").toString("base64")}`,
    );
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  });

  it("adds nothing without a token", () => {
    assert.equal(fetchAuthEnv("https://github.com", ""), undefined);
  });
});
