// End-to-end tests of bin/cli.mjs, spawned as a real process against a
// scratch repository and a fake `claude` on PATH.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { git as realGit } from "./git.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.mjs");
const FIXTURE_CHECKS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "checks",
);

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

// A fake Claude CLI: flags "Alpha Check" on line 1 of app.js and passes
// everything else. It records its environment and prompt for assertions.
const FAKE_CLAUDE = `#!/bin/sh
# The CLI probes \`claude --version\` before any agent runs; only agent
# invocations (\`-p\`) are recorded.
[ "$1" = "-p" ] || { echo "fake 0.0.0"; exit 0; }
prompt=$(cat)
printf '%s' "$prompt" > "$FAKE_OUT/prompt-$$.txt"
env > "$FAKE_OUT/env-$$.txt"
echo '{"type":"system","subtype":"init","session_id":"s-'$$'"}'
case "$prompt" in
  *'"Alpha Check"'*)
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s","num_turns":1,"duration_ms":100,"total_cost_usd":0.25,"structured_output":{"verdict":"FAIL","reason":"alpha problem","suggestions":[{"file":"app.js","line":1,"comment":"Avoid alpha."}]}}'
    ;;
  *)
    echo '{"type":"result","subtype":"success","is_error":false,"session_id":"s","num_turns":1,"duration_ms":100,"total_cost_usd":0.1,"structured_output":{"verdict":"PASS","reason":"fine"}}'
    ;;
esac
`;

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "weave-checks-cli-"));
  ROOTS.push(root);
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const fakeOut = path.join(root, "fake");
  for (const dir of [repo, bin, fakeOut, path.join(repo, ".weave-checks")])
    mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(path.join(bin, "claude"), 0o755);
  for (const name of ["alpha-check.md", "beta-check.md", "README.md"]) {
    writeFileSync(
      path.join(repo, ".weave-checks", name),
      readFileSync(path.join(FIXTURE_CHECKS, name)),
    );
  }
  const git = (...args) => realGit(args, { cwd: repo, env: GIT_ENV });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(path.join(repo, "app.js"), "alpha()\n");

  const cli = (args, env = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        ...GIT_ENV,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        FAKE_OUT: fakeOut,
        NO_COLOR: "1",
        ...env,
      },
    });
  const envs = () =>
    spawnSync("sh", ["-c", `cat "${fakeOut}"/env-*.txt`], { encoding: "utf8" }).stdout;
  return { root, repo, cli, envs };
}

describe("weave-checks run", () => {
  it("reviews the working tree and exits 1 when a check flags findings", () => {
    const space = workspace();

    const result = space.cli(["run", "--base", "main", "--format", "json"]);

    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.provider, "inherit");
    assert.equal(summary.costLabel, "client-reported cost");
    assert.deepEqual(
      summary.checks.map(c => [c.slug, c.outcome]),
      [
        ["alpha-check", "flagged"],
        ["beta-check", "pass"],
      ],
    );
    assert.deepEqual(
      summary.checks[0].suggestions.map(s => `${s.file}:${s.line}`),
      ["app.js:1"],
    );
    assert.deepEqual(summary.totals, {
      pass: 1,
      flagged: 1,
      neutral: 0,
      cost: 0.35,
      durationMs: 200,
    });
  });

  it("exits 0 with --no-fail and renders a text table", () => {
    const space = workspace();

    const result = space.cli(["run", "--base", "main", "--no-fail"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Weave Checks — 1 passed · 1 flagged · 0 neutral — \$0\.35 total \(client-reported cost\)/,
    );
    assert.match(result.stdout, /app\.js:1 Avoid alpha\./);
  });

  it("runs only the selected checks and rejects unknown ones", () => {
    const space = workspace();
    const only = space.cli(["run", "--base", "main", "--only", "beta-check", "--format", "json"]);
    assert.equal(only.status, 0, only.stderr);
    assert.deepEqual(
      JSON.parse(only.stdout).checks.map(c => c.slug),
      ["beta-check"],
    );

    const unknown = space.cli(["run", "--base", "main", "--only", "gamma"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown check\(s\): gamma/);
  });

  it("refuses an empty diff", () => {
    const space = workspace();
    rmSync(path.join(space.repo, "app.js"));

    const result = space.cli(["run", "--base", "main"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /nothing to check/);
  });

  it("rejects the removed max-budget option", () => {
    const space = workspace();
    const result = space.cli(["run", "--max-budget", "1"]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /max-budget/);
  });

  it("needs no Weave secret for anthropic and never hands one to the agent", () => {
    const space = workspace();

    const result = space.cli(
      ["run", "--base", "main", "--provider", "anthropic", "--format", "json"],
      {
        WEAVE_API_KEY: "wk-should-not-leak",
        GITHUB_TOKEN: "ghs-should-not-leak",
        WEAVE_CHECKS_PROVIDER_ENV: "ANTHROPIC_BASE_URL=https://gateway.example.com",
      },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).provider, "anthropic");
    const envs = space.envs();
    // Plain boolean asserts: a failing match would print the whole recorded
    // environment into the test log.
    assert.ok(
      /^ANTHROPIC_BASE_URL=https:\/\/gateway\.example\.com$/m.test(envs),
      "gateway overlay applied",
    );
    assert.ok(/^WEAVE_PROMPT_INITIATOR=automation$/m.test(envs), "initiator pinned");
    assert.ok(!envs.includes("should-not-leak"), "a coordinator-only secret reached the agent");
  });

  it("fails fast when weave-router is missing a key", () => {
    const space = workspace();
    const result = space.cli(["run", "--base", "main", "--provider", "weave-router"], {
      WEAVE_ROUTER_KEY: "",
      WEAVE_API_KEY: "",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires WEAVE_ROUTER_KEY/);
  });

  it("keeps an in-repo artifacts directory out of the reviewed diff", () => {
    const space = workspace();

    const result = space.cli([
      "run",
      "--base",
      "main",
      "--artifacts-dir",
      "review-out",
      "--format",
      "json",
    ]);

    assert.equal(result.status, 1, result.stderr);
    const diff = readFileSync(path.join(space.repo, "review-out", "pr.diff"), "utf8");
    assert.match(diff, /\+alpha\(\)/);
    assert.doesNotMatch(diff, /review-out|matrix\.json/);
  });
});

describe("weave-checks list", () => {
  it("lists discovered checks and fails loudly on a bad one", () => {
    const space = workspace();
    const ok = space.cli(["list"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(
      ok.stdout,
      'alpha-check: "Alpha Check" (intelligence low)\nbeta-check: "Beta Check" (intelligence medium)\n',
    );

    const anthropic = space.cli(["list", "--provider", "anthropic"]);
    assert.equal(anthropic.status, 0, anthropic.stderr);
    assert.match(anthropic.stdout, /intelligence low → haiku/);

    const router = space.cli(["list", "--provider", "weave-router"]);
    assert.equal(router.status, 0, router.stderr);
    assert.doesNotMatch(router.stdout, /→ haiku/);

    writeFileSync(path.join(space.repo, ".weave-checks", "broken.md"), "no frontmatter\n");
    const bad = space.cli(["list"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /broken\.md: missing frontmatter/);
  });

  it("filters the intelligence allowlist and rejects an excluded tier", () => {
    const space = workspace();
    const ok = space.cli(["list", "--allowed-intelligence", "low,medium"]);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = space.cli(["list", "--allowed-intelligence", "low"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unsupported intelligence "medium"/);
  });

  it("rejects a checks directory outside the repository", () => {
    const space = workspace();
    const result = space.cli(["list", "--checks-dir", "../elsewhere"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /escapes the repository root/);
  });
});
