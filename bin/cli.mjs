#!/usr/bin/env node
// weave-checks: the package's command-line entry point.
//
//   weave-checks list           Validate and list the checks in a directory.
//   weave-checks print-schema   Print the structured-output JSON schema.
//
// Action internals (run by action.yml; configured through the environment
// the action sets, not flags):
//
//   weave-checks create-aggregate | prepare | close-aggregate | report

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { brandingFromEnv } from "../src/branding.mjs";
import { closeAggregate, createAggregate, report, writeOutputs, writeStepSummary } from "../src/ci.mjs";
import { DEFAULT_CHECKS_DIR, describeEntry, discoverChecks } from "../src/discover.mjs";
import { createGitHubClient, permissionHint } from "../src/github.mjs";
import { readIgnorePathspecs } from "../src/ignore.mjs";
import { parseBoolean, policyForRun, validateChecksDir } from "../src/options.mjs";
import { DEDUP_SCHEMA, RESOLUTION_SCHEMA, RESULT_SCHEMA } from "../src/parse.mjs";
import { fetchAuthEnv, preparePullRequest, verifyCheckout } from "../src/prepare.mjs";
import { PROVIDER } from "../src/provider.mjs";

const USAGE = `Usage: weave-checks <command> [options]

Commands:
  list          Validate the checks in a directory and list them
  print-schema  Print the JSON schema an agent's review must match

Run "weave-checks <command> --help" for a command's options.
`;

const POLICY_OPTIONS = {
  "checks-dir": { type: "string", default: DEFAULT_CHECKS_DIR },
  "repo-dir": { type: "string", default: "." },
  provider: { type: "string", default: PROVIDER.INHERIT },
  "allowed-models": { type: "string", default: "" },
  "allowed-clusters": { type: "string", default: "" },
  "require-cluster": { type: "boolean", default: false },
  "default-model": { type: "string", default: "" },
  "doc-files": { type: "string", default: "README.md" },
};

const POLICY_HELP = `  --checks-dir <dir>        Checks directory, relative to the repo (default: ${DEFAULT_CHECKS_DIR})
  --repo-dir <dir>          Repository root (default: .)
  --provider <name>         anthropic | weave-router | inherit (default: inherit)
  --allowed-models <list>   Comma-separated model allowlist (default: any well-formed name)
  --allowed-clusters <list> Comma-separated cluster allowlist
  --require-cluster         Fail a check with no cluster (always on for weave-router)
  --default-model <model>   Model for a check that declares none
  --doc-files <list>        Markdown files in the checks directory that are docs (default: README.md)`;

function discoverFromOptions(values) {
  const checksDir = validateChecksDir(values["checks-dir"]);
  const policy = policyForRun({
    provider: values.provider,
    allowedModels: values["allowed-models"],
    allowedClusters: values["allowed-clusters"],
    requireCluster: values["require-cluster"],
    defaultModel: values["default-model"],
    docFiles: values["doc-files"],
  });
  return discoverChecks(checksDir, { repoDir: values["repo-dir"], policy });
}

const COMMANDS = {
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
        for (const entry of matrix) process.stdout.write(`${describeEntry(entry)}\n`);
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
      if (schema === undefined) throw new Error(`unknown schema kind ${JSON.stringify(values.kind)}`);
      process.stdout.write(`${JSON.stringify(schema)}\n`);
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
        throw new Error(`could not create the aggregate check run: ${error.message}${permissionHint(error)}`);
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
      mkdirSync(outDir, { recursive: true });

      console.error(verifyCheckout({ repoDir, headSha }));
      const { pathspecs, ignorePath } = readIgnorePathspecs(path.join(repoDir, checksDir));
      console.error(
        pathspecs.length === 0
          ? `no ignored paths in ${checksDir}/.ignore`
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
        ignorePathspecs: pathspecs,
        diffBase: env.WEAVE_CHECKS_DIFF_BASE || undefined,
        fetchEnv: fetchAuthEnv(env.GITHUB_SERVER_URL || "https://github.com", env.WEAVE_CHECKS_GITHUB_TOKEN),
      });

      const policy = policyForRun({
        provider: env.WEAVE_CHECKS_PROVIDER,
        allowedModels: env.WEAVE_CHECKS_ALLOWED_MODELS,
        allowedClusters: env.WEAVE_CHECKS_ALLOWED_CLUSTERS,
        requireCluster: parseBoolean("require-cluster", env.WEAVE_CHECKS_REQUIRE_CLUSTER, false),
        defaultModel: env.WEAVE_CHECKS_DEFAULT_MODEL,
        docFiles: env.WEAVE_CHECKS_DOC_FILES,
      });
      const matrix = discoverChecks(checksDir, { repoDir, policy });
      for (const entry of matrix) console.error(`discovered ${describeEntry(entry)}`);
      writeFileSync(path.join(outDir, "matrix.json"), `${JSON.stringify({ check: matrix })}\n`);

      if (env.GITHUB_STEP_SUMMARY) {
        // Deliberately headless: the worker's own table header follows it.
        writeFileSync(env.GITHUB_STEP_SUMMARY, `_Reviewing from ${prepared.note}._\n\n`, { flag: "a" });
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
      console.error(closed ? "Closed the incomplete aggregate check run as neutral." : "Aggregate already closed.");
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

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`Missing ${name}`);
  return value;
}

function githubClient(env) {
  return createGitHubClient({
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    token: env.WEAVE_CHECKS_GITHUB_TOKEN,
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
  const { values } = parseArgs({ args: rest, options: command.options, strict: true, allowPositionals: false });
  await command.run(values);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`weave-checks: ${error.message}\n`);
  process.exitCode = process.exitCode || 1;
}
