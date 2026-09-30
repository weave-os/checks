#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { exchangeForAppToken, requestOidcToken, revokeAppToken } from "../src/apptoken.mjs";
import { brandingFromEnv } from "../src/branding.mjs";
import {
  closeAggregate,
  createAggregate,
  report,
  writeOutputs,
  writeStepSummary,
} from "../src/ci.mjs";
import {
  DEFAULT_CHECKS_DIR,
  describeEntry,
  discoverChecks,
  discoverChecksWithDefaults,
} from "../src/discover.mjs";
import { createGitHubClient, permissionHint } from "../src/github.mjs";
import { gitLine } from "../src/git.mjs";
import {
  DEFAULT_BASE,
  repoRoot,
  resolveDiffBase,
  writeRangeDiff,
  writeWorkingTreeDiff,
} from "../src/gitdiff.mjs";
import { readIgnorePathspecs } from "../src/ignore.mjs";
import { DEFAULT_LOCAL_PROVIDER, positiveInteger, runChecks } from "../src/local.mjs";
import { parseBoolean, policyForRun, validateChecksDir } from "../src/options.mjs";
import { DEDUP_SCHEMA, RESOLUTION_SCHEMA, RESULT_SCHEMA, checkSetDigest } from "../src/parse.mjs";
import {
  fetchAuthEnv,
  preparePullRequest,
  resolveMergeBase,
  verifyCheckout,
} from "../src/prepare.mjs";
import { PROVIDER, createProvider, parseProviderEnv } from "../src/provider.mjs";
import { renderMarkdown, renderText } from "../src/render.mjs";

const USAGE = `Usage: weave-checks <command> [options]

Commands:
  run           Review your changes (working tree vs. the merge base) locally
  list          Validate the checks in a directory and list them
  print-schema  Print the JSON schema an agent's review must match

Run "weave-checks <command> --help" for a command's options.
`;

const POLICY_OPTIONS = {
  "checks-dir": { type: "string", default: DEFAULT_CHECKS_DIR },
  "repo-dir": { type: "string", default: "." },
  provider: { type: "string", default: PROVIDER.INHERIT },
  "allowed-intelligence": { type: "string", default: "" },
  "doc-files": { type: "string", default: "README.md" },
};

const POLICY_HELP = `  --checks-dir <dir>          Checks directory, relative to the repo (default: ${DEFAULT_CHECKS_DIR})
  --repo-dir <dir>            Repository root (default: .)
  --provider <name>           anthropic | weave-router | inherit (default: inherit)
  --allowed-intelligence <list> Comma-separated tiers: low, medium, high, maximum (default: all)
  --doc-files <list>          Markdown files in the checks directory that are docs (default: README.md)`;

function discoverFromOptions(values) {
  const checksDir = validateChecksDir(values["checks-dir"]);
  const policy = policyForRun({
    allowedIntelligence: values["allowed-intelligence"],
    docFiles: values["doc-files"],
  });
  return discoverChecks(checksDir, { repoDir: values["repo-dir"], policy });
}

const COMMANDS = {
  run: {
    help: `Usage: weave-checks run [options]

Reviews the working tree -- staged, unstaged, and untracked changes, but not
gitignored files -- against the merge base with --base, using the same prompts
and verdict pipeline as the GitHub action. No GitHub state is read or written:
there is no thread history, so nothing is deduplicated or resolved.

${POLICY_HELP}
  --base <ref>              Branch the change will merge into (default: ${DEFAULT_BASE}, or main without it)
  --no-merge-base           Diff against --base itself instead of its merge base with HEAD
  --github-merge-base <o/r> Resolve the merge base with GitHub's compare API (needs GITHUB_TOKEN
                            and HEAD pushed); for shallow clones
  --head <ref>              Review a committed range --base...<ref> instead of the working tree
  --only <slugs>            Comma-separated checks to run
  --format <fmt>            text | markdown | json (default: text)
  --output <file>           Also write the JSON results here
  --artifacts-dir <dir>     Keep prompts, transcripts, and results here (default: a temp dir)
  --parallel <n>            Checks run at once (default: 4)
  --no-fail                 Exit 0 even when a check flags findings

Providers:
  inherit        Your own Claude Code configuration, unchanged (default)
  anthropic      ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN from the environment, plus
                 WEAVE_CHECKS_PROVIDER_ENV (KEY=VALUE lines) for a gateway or Bedrock/Vertex
  weave-router   WEAVE_ROUTER_KEY from the environment; Router-billed cost
                 WEAVE_ROUTER_URL optionally overrides the Router host

Exit status: 0 when nothing was flagged, 1 when a check flagged findings, 2 on
usage errors. A neutral check (it could not reach a verdict) never fails the run.
`,
    options: {
      ...POLICY_OPTIONS,
      base: { type: "string", default: DEFAULT_BASE },
      "no-merge-base": { type: "boolean", default: false },
      "github-merge-base": { type: "string", default: "" },
      head: { type: "string", default: "" },
      only: { type: "string", default: "" },
      format: { type: "string", default: "text" },
      output: { type: "string", default: "" },
      "artifacts-dir": { type: "string", default: "" },
      parallel: { type: "string", default: "4" },
      "no-fail": { type: "boolean", default: false },
    },
    async run(values) {
      if (!["text", "markdown", "json"].includes(values.format)) {
        throw new UsageError(
          `--format must be text, markdown, or json, got ${JSON.stringify(values.format)}`,
        );
      }
      const repoDir = repoRoot(values["repo-dir"]);
      const checksDir = validateChecksDir(values["checks-dir"]);
      const providerName = values.provider || DEFAULT_LOCAL_PROVIDER;
      // Built before any git work so a missing credential fails immediately.
      const provider = createProvider(providerName, {
        env: process.env,
        providerEnv: parseProviderEnv(process.env.WEAVE_CHECKS_PROVIDER_ENV),
      });
      const matrix = selectChecks(
        discoverFromOptions({ ...values, "repo-dir": repoDir }),
        values.only,
      );

      if (spawnSync("claude", ["--version"], { stdio: "ignore" }).status !== 0) {
        throw new UsageError(
          "`claude` not found on PATH. Install Claude Code first: https://docs.claude.com/en/docs/claude-code",
        );
      }

      const artifactsDir =
        values["artifacts-dir"] ?
          path.resolve(values["artifacts-dir"])
        : mkdtempSync(path.join(os.tmpdir(), "weave-checks-run-"));
      mkdirSync(artifactsDir, { recursive: true });
      const outputPath =
        values.output ? path.resolve(values.output) : path.join(artifactsDir, "results.json");
      writeFileSync(
        path.join(artifactsDir, "matrix.json"),
        `${JSON.stringify({ check: matrix })}\n`,
      );

      const { pathspecs } = readIgnorePathspecs(path.join(repoDir, checksDir));
      const base = await localDiffBase(repoDir, values);
      const prepared =
        values.head ?
          writeRangeDiff({
            repoDir,
            base,
            head: values.head,
            outDir: artifactsDir,
            ignorePathspecs: pathspecs,
          })
        : writeWorkingTreeDiff({
            repoDir,
            base,
            outDir: artifactsDir,
            // A run must never review its own output (gitdiff.mjs).
            excludePaths: [artifactsDir, outputPath],
            ignorePathspecs: pathspecs,
          });
      if (prepared.diff.trim() === "") {
        throw new UsageError(
          `no changes between ${base.slice(0, 12)} and ${values.head || "the working tree"} — nothing to check.`,
        );
      }

      const parallel = positiveInteger(values.parallel, 4);
      process.stderr.write(
        `Weave Checks: ${matrix.length} check(s) against ${base.slice(0, 12)} (${parallel} at a time, provider ${provider.id})\n`,
      );
      const summary = await runChecks({
        repoDir,
        tempDir: artifactsDir,
        checks: matrix,
        diff: prepared.diff,
        stat: prepared.stat,
        schemaText: JSON.stringify(RESULT_SCHEMA),
        parallel,
        provider,
        settingsDir: null,
      });
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

      if (values.format === "json") {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else if (values.format === "markdown") {
        process.stdout.write(renderMarkdown(summary));
      } else {
        process.stdout.write(
          renderText(summary, { color: process.stdout.isTTY === true && !process.env.NO_COLOR }),
        );
        process.stdout.write(`Artifacts: ${artifactsDir}\n`);
      }
      // Only a finding fails the run. A neutral outcome is an operational
      // miss, and blocking a commit on one would train people to pass
      // --no-fail by reflex.
      if (summary.totals.flagged > 0 && !values["no-fail"]) process.exitCode = 1;
    },
  },

  list: {
    help: `Usage: weave-checks list [options]

Validates every check file and lists it. Exits non-zero on the first
malformed check, the same way the action's discovery step does.

${POLICY_HELP}
  --format <text|json>      Output format (default: text)
`,
    options: { ...POLICY_OPTIONS, format: { type: "string", default: "text" } },
    run(values) {
      const matrix = discoverFromOptions(values);
      if (values.format === "json") {
        process.stdout.write(`${JSON.stringify({ check: matrix }, null, 2)}\n`);
      } else if (values.format === "text") {
        for (const entry of matrix)
          process.stdout.write(`${describeEntry(entry, values.provider)}\n`);
      } else {
        throw new Error(`--format must be text or json, got ${JSON.stringify(values.format)}`);
      }
    },
  },

  "print-schema": {
    help: `Usage: weave-checks print-schema [--kind result|resolution|dedup]
`,
    options: { kind: { type: "string", default: "result" } },
    run(values) {
      const schemas = { result: RESULT_SCHEMA, resolution: RESOLUTION_SCHEMA, dedup: DEDUP_SCHEMA };
      const schema = schemas[values.kind];
      if (schema === undefined)
        throw new Error(`unknown schema kind ${JSON.stringify(values.kind)}`);
      process.stdout.write(`${JSON.stringify(schema)}\n`);
    },
  },

  // Mints the Weave Checks App installation token every later step uses, and
  // masks it before it can reach any log.
  "mint-token": {
    internal: true,
    async run() {
      const env = process.env;
      const oidcToken = await requestOidcToken({ env });
      const { token, repository } = await exchangeForAppToken({ oidcToken });
      process.stdout.write(`::add-mask::${token}\n`);
      if (repository && env.GITHUB_REPOSITORY && repository !== env.GITHUB_REPOSITORY) {
        throw new Error(`Weave issued a token for ${repository}, not ${env.GITHUB_REPOSITORY}`);
      }
      writeOutputs(env.GITHUB_OUTPUT, { token });
      console.error(
        `Authenticated as the Weave Checks GitHub App for ${repository ?? env.GITHUB_REPOSITORY}.`,
      );
    },
  },

  "revoke-token": {
    internal: true,
    async run() {
      const env = process.env;
      if (!env.WEAVE_CHECKS_APP_TOKEN) return;
      const outcome = await revokeAppToken({
        token: env.WEAVE_CHECKS_APP_TOKEN,
        apiUrl: env.GITHUB_API_URL || "https://api.github.com",
      });
      console.error(
        outcome.revoked ?
          "Revoked the Weave Checks App token."
        : `Could not revoke the Weave Checks App token (${outcome.error ?? `HTTP ${outcome.status}`}); it expires within an hour.`,
      );
    },
  },

  "create-aggregate": {
    internal: true,
    async run() {
      const env = process.env;
      const { aggregateName } = brandingFromEnv(env);
      let id;
      try {
        id = await createAggregate({
          rest: githubClient(env),
          repository: requiredEnv("GITHUB_REPOSITORY"),
          headSha: requiredEnv("HEAD_SHA"),
          aggregateName,
          detailsUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
        });
      } catch (error) {
        throw new Error(
          `could not create the aggregate check run: ${error.message}${permissionHint(error)}`,
        );
      }
      writeOutputs(env.GITHUB_OUTPUT, { id });
    },
  },

  prepare: {
    internal: true,
    async run() {
      const env = process.env;
      const repoDir = requiredEnv("REPO_DIR");
      const outDir = requiredEnv("WEAVE_CHECKS_TEMP_DIR");
      const headSha = requiredEnv("HEAD_SHA");
      const checksDir = validateChecksDir(env.WEAVE_CHECKS_DIR || DEFAULT_CHECKS_DIR);
      const useDefaultChecks = parseBoolean(
        "use-default-checks",
        env.WEAVE_CHECKS_USE_DEFAULT_CHECKS,
        false,
      );
      mkdirSync(outDir, { recursive: true });

      console.error(verifyCheckout({ repoDir, headSha }));
      const policy = policyForRun({
        allowedIntelligence: env.WEAVE_CHECKS_ALLOWED_INTELLIGENCE,
        docFiles: env.WEAVE_CHECKS_DOC_FILES,
      });
      const matrix = discoverChecksWithDefaults(checksDir, {
        repoDir,
        policy,
        useDefaultChecks,
        starterChecksDir: useDefaultChecks ? requiredEnv("WEAVE_CHECKS_STARTER_DIR") : undefined,
      });
      for (const entry of matrix)
        console.error(
          `discovered ${describeEntry(entry, env.WEAVE_CHECKS_PROVIDER || "anthropic")}`,
        );
      const checkDigest = checkSetDigest(matrix, repoDir);

      const { pathspecs, ignorePath } = readIgnorePathspecs(path.join(repoDir, checksDir));
      console.error(
        pathspecs.length === 0 ?
          `no ignored paths in ${checksDir}/.ignore`
        : `ignoring ${pathspecs.length} path(s) from ${path.relative(repoDir, ignorePath)}: ${pathspecs.join(" ")}`,
      );
      const prepared = await preparePullRequest({
        rest: githubClient(env),
        repoDir,
        outDir,
        repository: requiredEnv("GITHUB_REPOSITORY"),
        prNumber: requiredEnv("PR_NUMBER"),
        baseSha: requiredEnv("BASE_SHA"),
        headSha,
        aggregateName: brandingFromEnv(env).aggregateName,
        checkDigest,
        ignorePathspecs: pathspecs,
        diffBase: env.WEAVE_CHECKS_DIFF_BASE || undefined,
        fetchEnv: fetchAuthEnv(
          env.GITHUB_SERVER_URL || "https://github.com",
          env.WEAVE_CHECKS_APP_TOKEN,
        ),
      });
      writeFileSync(path.join(outDir, "matrix.json"), `${JSON.stringify({ check: matrix })}\n`);

      if (env.GITHUB_STEP_SUMMARY) {
        // Deliberately headless: the worker's own table header follows it.
        writeFileSync(env.GITHUB_STEP_SUMMARY, `_Reviewing from ${prepared.note}._\n\n`, {
          flag: "a",
        });
      }
      writeOutputs(env.GITHUB_OUTPUT, {
        count: matrix.length,
        "merge-base": prepared.mergeBaseSha,
        "review-base": prepared.reviewBaseSha,
      });
    },
  },

  "close-aggregate": {
    internal: true,
    async run() {
      const env = process.env;
      const tempDir = requiredEnv("WEAVE_CHECKS_TEMP_DIR");
      const { aggregateName } = brandingFromEnv(env);
      // Summary first: it only reads local files, so it lands even when the
      // PATCH below cannot.
      writeStepSummary({
        summaryPath: path.join(tempDir, "summary.md"),
        stepSummaryPath: env.GITHUB_STEP_SUMMARY,
        aggregateName,
      });
      const closed = await closeAggregate({
        rest: githubClient(env),
        repository: requiredEnv("GITHUB_REPOSITORY"),
        checkRunId: env.CHECK_RUN_ID,
        completePath: path.join(tempDir, "complete"),
        aggregateName,
      });
      console.error(
        closed ?
          "Closed the incomplete aggregate check run as failure."
        : "Aggregate already closed.",
      );
    },
  },

  report: {
    internal: true,
    run() {
      const env = process.env;
      const tempDir = requiredEnv("WEAVE_CHECKS_TEMP_DIR");
      const outcome = report({
        resultsPath: path.join(tempDir, "results.json"),
        summaryPath: path.join(tempDir, "summary.md"),
        outputPath: env.GITHUB_OUTPUT,
        failOnFindings: parseBoolean("fail-on-findings", env.WEAVE_CHECKS_FAIL_ON_FINDINGS, false),
      });
      if (!outcome.ok) {
        console.error(outcome.message);
        process.exitCode = 1;
      }
    },
  },
};

class UsageError extends Error {}

function selectChecks(matrix, only) {
  const slugs = only
    .split(",")
    .map(slug => slug.trim())
    .filter(slug => slug !== "");
  if (slugs.length === 0) return matrix;
  const known = new Set(matrix.map(check => check.slug));
  const unknown = slugs.filter(slug => !known.has(slug)).sort();
  if (unknown.length > 0) {
    throw new UsageError(
      `unknown check(s): ${unknown.join(", ")}\navailable: ${[...known].sort().join(", ")}`,
    );
  }
  const selected = new Set(slugs);
  return matrix.filter(check => selected.has(check.slug));
}

async function localDiffBase(repoDir, values) {
  if (!values["github-merge-base"]) {
    return resolveDiffBase({
      repoDir,
      base: values.base,
      useMergeBase: !values["no-merge-base"],
      head: values.head || "HEAD",
    });
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new UsageError("--github-merge-base needs GITHUB_TOKEN or GH_TOKEN");
  const sha = ref => gitLine(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoDir });
  const mergeBase = await resolveMergeBase({
    rest: createGitHubClient({
      apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
      token,
    }),
    repository: values["github-merge-base"],
    baseSha: sha(values.base),
    headSha: sha(values.head || "HEAD"),
  });
  // A shallow clone may not have the merge base yet.
  if (gitLine(["cat-file", "-t", mergeBase], { cwd: repoDir, allowFailure: true }) === null) {
    gitLine(["fetch", "--no-tags", "--depth=1", "origin", mergeBase], { cwd: repoDir });
  }
  return mergeBase;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Missing ${name}`);
  return value;
}

function githubClient(env) {
  return createGitHubClient({
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    token: env.WEAVE_CHECKS_APP_TOKEN,
  });
}

async function main(argv) {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    process.stdout.write(USAGE);
    return;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    process.stderr.write(`Unknown command "${name}".\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (command.internal) {
    await command.run();
    return;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(command.help);
    return;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: command.options,
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(`${error.message}\n\n${command.help}`);
  }
  await command.run(values);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`weave-checks: ${error.message}\n`);
  // Usage errors exit 2, so a script can tell "you called me wrong" from
  // "a check flagged something" (1).
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
