// Runs every Weave Check against a local working-branch diff, with no GitHub
// involvement at all. This is the engine behind `wv checks run`
// (cli/wv/commands/checks.py), which prepares the diff, the check matrix, and
// the result schema, then invokes this script.
//
// Deliberately NOT a second implementation of the review: the agent argv, the
// prompt scaffolding, and the verdict pipeline all come from runner.mjs, the
// same module the CI worker uses. What this script does not do is everything
// that needs GitHub state:
//
//   - No resolution judge. There are no review threads to reconcile against;
//     a local run is always a fresh look at the current diff.
//   - No dedup judge. Nothing has been posted, so nothing can be a duplicate.
//   - No check runs, reviews, or comments. Findings are written to a summary
//     JSON that the CLI renders in the terminal.
//
// The consequence worth knowing: a local run can flag something CI would
// suppress as already-reported on the PR. That is the right trade for a
// pre-push tool -- it errs toward showing the engineer more, not less.
//
// Output contract (OUTPUT_PATH), consumed by cli/wv/commands/checks.py:
//
//   { "checks": [ { slug, name, model, cluster, outcome, reason, error,
//                   suggestions: [...], proseFallbacks: [...], rejected: [...],
//                   cost, durationMs } ],
//     "totals": { pass, fail, neutral, cost, durationMs } }

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { OUTCOME, parseAddedLines } from "./parse.mjs";
import {
  evaluateCheck,
  formatDuration,
  formatUsd,
  resultPath,
  runPool,
  totalCost,
  totalDuration,
} from "./runner.mjs";

const DEFAULT_PARALLEL = 4;

// Reads and validates the run's configuration from `env`. Taking the
// environment as an argument (rather than reading process.env inline) is what
// makes the parsing testable without spawning the script.
export function readConfig(env) {
  const required = (name) => {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`Missing ${name}`);
    return value;
  };
  return {
    repoDir: required("REPO_DIR"),
    tempDir: required("TEMP_DIR"),
    outputPath: required("OUTPUT_PATH"),
    checks: JSON.parse(readFileSync(required("MATRIX_PATH"), "utf8")).check,
    diff: readFileSync(required("DIFF_PATH"), "utf8"),
    stat: readFileSync(required("STAT_PATH"), "utf8"),
    schemaText: readFileSync(required("SCHEMA_PATH"), "utf8"),
    parallel: positiveInteger(env.PARALLEL, DEFAULT_PARALLEL),
    // Optional locally, unlike CI: without it the router cost lookup is
    // skipped and every check reports an unknown cost rather than failing the
    // run. Most engineers do not have a Weave API key to hand, and a missing
    // cost column is not a reason to refuse to review a diff.
    weaveAPIKey: env.WEAVE_API_KEY || null,
    // Optional: a directory of `settings-<cluster>.json` files the CLI
    // generated (see wv/commands/checks.py's _write_cluster_settings), one
    // per cluster a selected check declares. Each mirrors `wv mr claude`'s
    // generated settings file -- the engineer's own settings, with
    // X-Weave-Force-Cluster added -- so a check is served from the SAME
    // cluster it would be in CI, not whatever the engineer's own routing
    // happens to prefer. Absent when --no-force-cluster was passed.
    settingsDir: env.SETTINGS_DIR || null,
  };
}

export function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Runs every check in `config.checks` through the shared runner and returns
// the summary object written to OUTPUT_PATH. `evaluate` is injectable so the
// pool, artifact writing, and summary shaping are testable without spawning a
// real agent.
export async function runChecks(config, { evaluate = evaluateCheck } = {}) {
  const addedLines = parseAddedLines(config.diff);
  const checkResults = await runPool(config.checks, config.parallel, async (check) => {
    process.stderr.write(`Weave Checks: running ${check.slug}...\n`);
    const settingsPath = config.settingsDir === null
      ? null
      : path.join(config.settingsDir, `settings-${check.cluster}.json`);
    const dropEnv = ["WEAVE_API_KEY"];
    if (settingsPath !== null) {
      // Match `wv mr claude`: once the generated --settings overlay exists,
      // inherited routing variables must not compete with it. Without an
      // overlay (--no-force-cluster), preserve shell-provided routing env.
      dropEnv.push(
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_CUSTOM_HEADERS",
      );
    }
    let checkResult;
    try {
      checkResult = await evaluate({
        check,
        repoDir: config.repoDir,
        tempDir: config.tempDir,
        diff: config.diff,
        stat: config.stat,
        addedLines,
        schemaText: config.schemaText,
        // No history: a local run has no review threads to compare against.
        //
        // `settingSources: null` lets the engineer's own Claude Code settings
        // load (CI passes "" to keep a runner's config out of a check) --
        // that's what supplies the router base URL and key. `settingsPath`,
        // when set, layers a forced cluster on TOP of those settings via
        // `--settings` (highest precedence), the same mechanism `wv mr
        // claude` uses to redirect the router without touching the user's
        // own settings file. Drop the inherited routing vars just as `wv mr
        // claude` does, so the settings overlay is the only source of truth.
        extraEnv: {},
        settingSources: null,
        settingsPath,
        dropEnv,
        weaveAPIKey: config.weaveAPIKey,
        onCostError: ({ slug, suffix, error }) =>
          process.stderr.write(`[${slug}/${suffix}] cost unavailable: ${error}\n`),
      });
    } catch (error) {
      // A throw here is an infrastructure failure (unreadable check file,
      // spawn failure), not a verdict. Report it as this check's neutral
      // outcome so one broken check doesn't abandon the other sixteen.
      checkResult = {
        outcome: OUTCOME.NEUTRAL,
        error: error.message ?? String(error),
        cost: null,
        duration: null,
      };
    }
    writeFileSync(
      resultPath(config.tempDir, check.slug, "result.json"),
      `${JSON.stringify(checkResult, null, 2)}\n`,
    );
    process.stderr.write(
      `Weave Checks: ${check.slug} -> ${checkResult.outcome} (${formatUsd(checkResult.cost)}, ${formatDuration(checkResult.duration)})\n`,
    );
    return summarizeCheck(check, checkResult);
  });

  return { checks: checkResults, totals: checkTotalsFor(checkResults) };
}

// Flattens one check's normalized result into the JSON the CLI renders. Only
// the fields the terminal output needs travel here; the full result (denials,
// turn count, raw rejections) stays in the per-check `result.json` artifact.
function summarizeCheck(check, checkResult) {
  return {
    slug: check.slug,
    name: check.name,
    model: check.model,
    cluster: check.cluster,
    outcome: checkResult.outcome,
    reason: checkResult.reason ?? null,
    error: checkResult.error ?? null,
    suggestions: (checkResult.accepted ?? []).map((suggestion) => ({
      file: suggestion.file,
      line: suggestion.line,
      start_line: suggestion.start_line,
      comment: suggestion.comment,
      replacement: suggestion.replacement ?? null,
    })),
    proseFallbacks: (checkResult.proseFallbacks ?? []).map((entry) => ({
      file: entry.suggestion.file,
      line: entry.suggestion.line,
      why: entry.why,
    })),
    rejected: (checkResult.rejected ?? []).map((entry) => ({
      file: entry.suggestion?.file ?? null,
      line: entry.suggestion?.line ?? null,
      why: entry.why,
    })),
    cost: checkResult.cost ?? null,
    durationMs: checkResult.duration ?? null,
  };
}

function checkTotalsFor(checkResults) {
  const count = (outcome) =>
    checkResults.filter((checkResult) => checkResult.outcome === outcome).length;
  return {
    pass: count(OUTCOME.PASS),
    fail: count(OUTCOME.FAIL),
    neutral: count(OUTCOME.NEUTRAL),
    cost: totalCost(checkResults.map((checkResult) => checkResult.cost)),
    durationMs: totalDuration(checkResults.map((checkResult) => checkResult.durationMs)),
  };
}

async function main() {
  const config = readConfig(process.env);
  mkdirSync(config.tempDir, { recursive: true });
  mkdirSync(path.dirname(config.outputPath), { recursive: true });
  const summary = await runChecks(config);
  writeFileSync(config.outputPath, `${JSON.stringify(summary, null, 2)}\n`);
}

// The CLI owns the terminal rendering and the exit code (it knows about
// --format and --no-fail), so this script exits non-zero only when it could
// not produce a summary at all. A check that flags something is a successful
// run of this script, not a failure of it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`Weave Checks local runner failed: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
