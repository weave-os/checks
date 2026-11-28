import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { discoverChecks } from "./discover.mjs";
import { git as realGit } from "./git.mjs";
import { readIgnorePathspecs } from "./ignore.mjs";
import { checkSetDigest, formatReviewedMarker, parseAddedLines } from "./parse.mjs";
import { DIFF_BASE, fetchAuthEnv, preparePullRequest, verifyCheckout } from "./prepare.mjs";

const ROOTS = [];
after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

const CHECK_DIGEST = "a".repeat(64);

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
function fakeRest(
  space,
  { markers = {}, prCommits = null, forcePushes = [], graphqlError = null } = {},
) {
  const calls = [];
  const isAncestor = (a, b) =>
    realGit(["merge-base", "--is-ancestor", a, b], { cwd: space.origin, allowFailure: true }) !==
    null;
  const rest = async (method, apiPath, body) => {
    calls.push(apiPath);
    if (method === "POST" && apiPath === "graphql") {
      if (graphqlError !== null) throw graphqlError;
      assert.deepEqual(body.variables, { owner: "o", name: "r", number: 7, limit: 10 });
      return {
        data: {
          repository: {
            pullRequest: {
              timelineItems: { nodes: forcePushes.map(oid => ({ beforeCommit: { oid } })) },
            },
          },
        },
      };
    }
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
    checkDigest: CHECK_DIGEST,
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

  it("parses paths Git quotes in the prepared diff", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const fileNames = ["café.md", "tab\tname.md", "line\nbreak.md", 'quote"slash\\file.md'];
    const head = space.commit(Object.fromEntries(fileNames.map(name => [name, `${name}\n`])));

    await prepare(space, fakeRest(space, { prCommits: [head] }), { baseSha: base, headSha: head });

    const addedLines = parseAddedLines(space.read("pr.diff"));
    assert.deepEqual([...addedLines.keys()].sort(), fileNames.sort());
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
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
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
        markers: { [partial]: "", [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
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
        markers: { [reviewed]: formatReviewedMarker(head, CHECK_DIGEST) },
      }),
      { baseSha: base, headSha: head },
    );

    assert.equal(result.reviewBaseSha, base);
  });

  it("rejects a marker from a different check set", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const reviewed = space.commit({ "a.js": "a\n" });
    const head = space.commit({ "b.js": "b\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [reviewed, head],
        markers: { [reviewed]: formatReviewedMarker(reviewed, "b".repeat(64)) },
      }),
      { baseSha: base, headSha: head },
    );

    assert.equal(result.reviewBaseSha, base);
    assert.equal(space.read("pr.diff"), space.read("pr.full.diff"));
  });

  it("re-reviews previously ignored code when the CLI removes an exclusion", async t => {
    const space = repos();
    const checksDir = ".weave-checks";
    const base = space.commit({
      [`${checksDir}/policy.md`]:
        "---\nname: Policy\ndescription: Reject forbidden calls\nintelligence: low\n---\nReject forbidden().\n",
      [`${checksDir}/.ignore`]: "generated\nvendor\n",
    });
    space.branch("feature");
    const reviewed = space.commit({ "generated/app.js": "forbidden();\n" });
    const checks = discoverChecks(checksDir, { repoDir: space.origin });
    const previousPathspecs = readIgnorePathspecs(path.join(space.origin, checksDir)).pathspecs;
    const previousDigest = checkSetDigest(checks, space.origin, previousPathspecs);

    const head = space.commit({
      [`${checksDir}/.ignore`]: "vendor\n",
      "vendor/lib.js": "still excluded\n",
    });
    const rest = fakeRest(space, {
      prCommits: [reviewed, head],
      markers: { [reviewed]: formatReviewedMarker(reviewed, previousDigest) },
    });
    const server = createServer(async (request, response) => {
      try {
        const result = await rest(request.method, request.url.slice(1));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(500);
        response.end(JSON.stringify({ message: error.message }));
      }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
    run(space.origin, "remote", "add", "origin", `file://${space.origin}`);
    await promisify(execFile)(process.execPath, [cli, "prepare"], {
      env: {
        ...process.env,
        ...GIT_ENV,
        REPO_DIR: space.origin,
        WEAVE_CHECKS_TEMP_DIR: space.outDir,
        WEAVE_CHECKS_DIR: checksDir,
        HEAD_SHA: head,
        BASE_SHA: base,
        GITHUB_REPOSITORY: "o/r",
        PR_NUMBER: "7",
        WEAVE_CHECKS_APP_TOKEN: "test-app-token",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_OUTPUT: path.join(space.outDir, "github-output"),
        GITHUB_STEP_SUMMARY: "",
      },
    });

    const full = parseAddedLines(space.read("pr.full.diff"));
    assert.ok(full.get("generated/app.js")?.has(1));
    assert.equal(full.has("vendor/lib.js"), false);
    const review = parseAddedLines(space.read("pr.diff"));
    assert.ok(review.get("generated/app.js")?.has(1), "newly included code must reach review");
    assert.equal(review.has("vendor/lib.js"), false);
    assert.equal(space.read("pr.diff"), space.read("pr.full.diff"));
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
        markers: { [orphaned]: formatReviewedMarker(orphaned, CHECK_DIGEST) },
      }),
      { baseSha: base, headSha: head },
    );

    assert.equal(result.reviewBaseSha, base);
    assert.equal(space.read("pr.diff"), space.read("pr.full.diff"));
  });

  it("skips every file after a rebase that changed nothing", async () => {
    const space = repos();
    space.commit({ "README.md": "hello\n", "app.js": "base\n" });
    space.branch("old-feature");
    const reviewed = space.commit({ "app.js": "base\nfeature\n", "lib.js": "lib\n" });
    space.checkout("main");
    const newBase = space.commit({ "README.md": "hello\nmain\n", "app.js": "header\nbase\n" });
    space.branch("rebased");
    const head = space.commit({ "app.js": "header\nbase\nfeature\n", "lib.js": "lib\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [head],
        forcePushes: [reviewed],
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
      }),
      { baseSha: newBase, headSha: head },
    );

    assert.equal(result.reviewBaseSha, reviewed);
    assert.match(result.note, /rebased from reviewed .*; 2 of 2 files unchanged/);
    assert.equal(space.read("pr.diff"), "");
    assert.equal(space.read("pr.stat"), "");
    assert.deepEqual(addedFiles(space.read("pr.full.diff")), ["app.js", "lib.js"]);
  });

  it("reviews the whole diff of each file a rebase changed", async () => {
    const space = repos();
    space.commit({ "a.js": "one\ntwo\nthree\nfour\nfive\n", "b.js": "base\n" });
    space.branch("old-feature");
    const reviewed = space.commit({
      "a.js": "one\nold edit\nthree\nfour\nfive\nreviewed\n",
      "b.js": "base\nreviewed\n",
    });
    space.checkout("main");
    const newBase = space.commit({ "a.js": "one\nmain edit\nthree\nfour\nfive\n" });
    space.branch("rebased");
    const head = space.commit({
      "a.js": "one\nconflict fix\nthree\nfour\nfive\nreviewed\n",
      "b.js": "base\nreviewed\n",
    });

    const result = await prepare(
      space,
      fakeRest(space, {
        forcePushes: [reviewed],
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
      }),
      { baseSha: newBase, headSha: head },
    );

    const review = space.read("pr.diff");
    assert.equal(result.reviewBaseSha, reviewed);
    assert.match(result.note, /1 of 2 files unchanged/);
    assert.deepEqual(addedFiles(review), ["a.js"]);
    assert.match(review, /^\+conflict fix$/m);
    assert.match(review, /^\+reviewed$/m);
    assert.match(space.read("pr.stat"), /^a\.js \| 3 \+\+-$/m);
  });

  it("reviews a file whose change only lost a line in the rebase", async () => {
    const space = repos();
    space.commit({ "app.js": "guard\nwork\n" });
    space.branch("old-feature");
    const reviewed = space.commit({ "app.js": "guard\nwork\nfeature\n" });
    space.checkout("main");
    const newBase = space.commit({ "README.md": "main\n" });
    space.branch("rebased");
    const head = space.commit({ "app.js": "work\nfeature\n" });

    await prepare(
      space,
      fakeRest(space, {
        forcePushes: [reviewed],
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
      }),
      { baseSha: newBase, headSha: head },
    );

    const review = space.read("pr.diff");
    assert.match(review, /^-guard$/m);
    assert.match(review, /^\+feature$/m);
  });

  it("reviews a binary file whose contents changed in the rebase", async () => {
    const space = repos();
    space.commit({ "image.bin": "\0old", "same.bin": "\0old" });
    space.branch("old-feature");
    const reviewed = space.commit({ "image.bin": "\0reviewed", "same.bin": "\0reviewed" });
    space.checkout("main");
    const newBase = space.commit({ "README.md": "main\n" });
    space.branch("rebased");
    const head = space.commit({ "image.bin": "\0changed", "same.bin": "\0reviewed" });

    await prepare(
      space,
      fakeRest(space, {
        forcePushes: [reviewed],
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
      }),
      { baseSha: newBase, headSha: head },
    );

    const review = space.read("pr.diff");
    assert.match(review, /Binary files a\/image\.bin and b\/image\.bin differ/);
    assert.doesNotMatch(review, /same\.bin/);
  });

  it("reviews a file the rebase renamed", async () => {
    const space = repos();
    space.commit({ "old.js": "alpha\nbeta\ngamma\ndelta\n" });
    space.branch("old-feature");
    const reviewed = space.commit({ "old.js": "alpha\nbeta\ngamma\ndelta\nfeature\n" });
    space.checkout("main");
    run(space.origin, "mv", "old.js", "new.js");
    run(space.origin, "commit", "-q", "-m", "rename");
    const newBase = run(space.origin, "rev-parse", "HEAD");
    space.branch("rebased");
    const head = space.commit({ "new.js": "alpha\nbeta\ngamma\ndelta\nfeature\n" });

    await prepare(
      space,
      fakeRest(space, {
        forcePushes: [reviewed],
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
      }),
      { baseSha: newBase, headSha: head },
    );

    assert.deepEqual(addedFiles(space.read("pr.diff")), ["new.js"]);
    assert.match(space.read("pr.diff"), /^\+feature$/m);
  });

  it("reviews only the conflicted file after the lower PR of a stack is squash-merged", async () => {
    const space = repos();
    space.commit({ "shared.js": "one\ntwo\n", "upper.js": "base\n", "README.md": "readme\n" });
    space.branch("lower");
    const lower = space.commit({ "shared.js": "one\nlower\ntwo\n" });
    space.branch("upper");
    const reviewed = space.commit({
      "shared.js": "one\nlower\ntwo\nupper\n",
      "upper.js": "base\nupper\n",
    });
    space.checkout("main");
    space.commit({ "README.md": "readme\nunrelated\n" });
    const newBase = space.commit({ "shared.js": "one\nlower squashed\ntwo\n" }, "squash lower");
    space.branch("upper-rebased");
    const head = space.commit({
      "shared.js": "one\nlower squashed\ntwo\nupper\n",
      "upper.js": "base\nupper\n",
    });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [head],
        forcePushes: [reviewed],
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST, lower) },
      }),
      { baseSha: newBase, headSha: head },
    );

    assert.equal(result.reviewBaseSha, reviewed);
    assert.equal(space.read("pr.diff"), "");
    assert.deepEqual(addedFiles(space.read("pr.full.diff")), ["shared.js", "upper.js"]);
  });

  it("reviews a file whose change differs after a stack rebase", async () => {
    const space = repos();
    space.commit({ "shared.js": "one\ntwo\n", "upper.js": "base\n" });
    space.branch("lower");
    const lower = space.commit({ "shared.js": "one\nlower\ntwo\n" });
    space.branch("upper");
    const reviewed = space.commit({
      "shared.js": "one\nlower\ntwo\nupper\n",
      "upper.js": "base\nupper\n",
    });
    space.checkout("main");
    const newBase = space.commit({ "shared.js": "one\nlower squashed\ntwo\n" });
    space.branch("upper-rebased");
    const head = space.commit({
      "shared.js": "one\nlower squashed\ntwo\nupper fixed\n",
      "upper.js": "base\nupper\n",
    });

    await prepare(
      space,
      fakeRest(space, {
        forcePushes: [reviewed],
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST, lower) },
      }),
      { baseSha: newBase, headSha: head },
    );

    assert.deepEqual(addedFiles(space.read("pr.diff")), ["shared.js"]);
    assert.match(space.read("pr.diff"), /^\+upper fixed$/m);
  });

  it("resolves the merge base of a reviewed head whose marker predates recording it", async () => {
    const space = repos();
    space.commit({ "app.js": "base\n", "lib.js": "lib\n" });
    space.branch("old-feature");
    const reviewed = space.commit({ "app.js": "base\nfeature\n", "lib.js": "lib\nfeature\n" });
    space.checkout("main");
    const newBase = space.commit({ "README.md": "main\n" });
    space.branch("rebased");
    const head = space.commit({ "app.js": "base\nfeature\n", "lib.js": "lib\nchanged\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        forcePushes: [reviewed],
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
      }),
      { baseSha: newBase, headSha: head },
    );

    assert.equal(result.reviewBaseSha, reviewed);
    assert.deepEqual(addedFiles(space.read("pr.diff")), ["lib.js"]);
  });

  it("uses the newest reviewed head among several force pushes", async () => {
    const space = repos();
    space.commit({ "app.js": "base\n", "lib.js": "lib\n" });
    space.branch("first");
    const older = space.commit({ "app.js": "base\nolder\n", "lib.js": "lib\nolder\n" });
    space.checkout("main");
    space.branch("second");
    const unreviewed = space.commit({ "app.js": "base\nnewer\n", "lib.js": "lib\nnewer\n" });
    space.checkout("main");
    space.branch("third");
    const newer = space.commit({ "app.js": "base\nnewer\n", "lib.js": "lib\nolder\n" });
    space.checkout("main");
    const newBase = space.commit({ "README.md": "main\n" });
    space.branch("rebased");
    const head = space.commit({ "app.js": "base\nnewer\n", "lib.js": "lib\nolder\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        forcePushes: [older, unreviewed, newer],
        markers: {
          [older]: formatReviewedMarker(older, CHECK_DIGEST),
          [newer]: formatReviewedMarker(newer, CHECK_DIGEST),
        },
      }),
      { baseSha: newBase, headSha: head },
    );

    assert.equal(result.reviewBaseSha, newer);
    assert.equal(space.read("pr.diff"), "");
  });

  for (const [name, options] of [
    ["the check set changed", { marker: "b".repeat(64) }],
    ["force-push lookup fails", { graphqlError: new Error("unavailable") }],
  ]) {
    it(`reviews a rebase from the merge base when ${name}`, async () => {
      const space = repos();
      const oldBase = space.commit({ "app.js": "base\n" });
      space.branch("old-feature");
      const reviewed = space.commit({ "app.js": "base\nreviewed\n" });
      space.checkout("main");
      const newBase = space.commit({ "README.md": "main\n" });
      space.branch("rebased");
      const head = space.commit({ "app.js": "base\nreviewed\n" });

      const result = await prepare(
        space,
        fakeRest(space, {
          forcePushes: [reviewed],
          graphqlError: options.graphqlError ?? null,
          markers: {
            [reviewed]: formatReviewedMarker(reviewed, options.marker ?? CHECK_DIGEST),
          },
        }),
        { baseSha: newBase, headSha: head },
      );

      assert.equal(result.reviewBaseSha, newBase);
      assert.equal(space.read("pr.diff"), space.read("pr.full.diff"));
      assert.ok(oldBase);
    });
  }

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
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
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

  it("leaves the review scope empty when an incremental push changed only ignored paths", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const reviewed = space.commit({ "app.js": "x\n" });
    const head = space.commit({ "vendor/lib.js": "y\n" });

    const result = await prepare(
      space,
      fakeRest(space, {
        prCommits: [reviewed, head],
        markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
      }),
      { baseSha: base, headSha: head, ignorePathspecs: [":(exclude)vendor"] },
    );

    assert.equal(result.reviewBaseSha, reviewed);
    assert.equal(space.read("pr.diff"), "");
    assert.deepEqual(addedFiles(space.read("pr.full.diff")), ["app.js"]);
  });

  it("never looks for a prior review in merge-base mode", async () => {
    const space = repos();
    const base = space.commit({ "README.md": "hello\n" });
    space.branch("feature");
    const reviewed = space.commit({ "a.js": "a\n" });
    const head = space.commit({ "b.js": "b\n" });
    const rest = fakeRest(space, {
      prCommits: [reviewed, head],
      markers: { [reviewed]: formatReviewedMarker(reviewed, CHECK_DIGEST) },
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
