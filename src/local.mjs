// Runs every Weave Check against a local working-branch diff, with no GitHub
// involvement at all. This is the engine behind `weave-checks run`
// (bin/cli.mjs), which prepares the diff and the check matrix, then calls
// runChecks() -- or any other wrapper that writes the same inputs and invokes
// this script with them in its environment.
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
// Output contract (OUTPUT_PATH, and the CLI's `--format json`):
//
//   { "provider": "<id>", "costLabel": "<how cost was measured>",
//     "checks": [ { slug, name, model, cluster, outcome, reason, error,
//                   suggestions: [...], proseFallbacks: [...], rejected: [...],
//                   cost, durationMs } ],
//     "totals": { pass, flagged, neutral, cost, durationMs } }
//
// `outcome` is "pass", "flagged" (the check found something), or "neutral"
// (it could not reach a verdict).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { OUTCOME, RESULT_SCHEMA, parseAddedLines, publicOutcome } from "./parse.mjs";
import { PROVIDER, createProvider, parseProviderEnv } from "./provider.mjs";
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

// A developer's machine is already configured the way they want their agent
// to run, so a local run uses it unless told otherwise.
export const DEFAULT_LOCAL_PROVIDER = PROVIDER.INHERIT;

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
    // Optional: the schema is a constant of this package, so a wrapper only
    // passes one to pin a different version of it.
    schemaText: env.SCHEMA_PATH
      ? readFileSync(env.SCHEMA_PATH, "utf8")
      : JSON.stringify(RESULT_SCHEMA),
    parallel: positiveInteger(env.PARALLEL, DEFAULT_PARALLEL),
    // Only the selected provider's credentials are read: `inherit` and
    // `anthropic` need no Weave key, and `weave-router` fails here, before
    // any agent runs, if either of its two is missing.
    provider: createProvider(env.WEAVE_CHECKS_PROVIDER || DEFAULT_LOCAL_PROVIDER, {
      env,
      providerEnv: parseProviderEnv(env.WEAVE_CHECKS_PROVIDER_ENV),
    }),
    productName: env.WEAVE_CHECKS_PRODUCT_NAME || undefined,
    // Optional: a directory of `settings-<cluster>.json` files a wrapper
    // generated, one per cluster a selected check declares -- typically the
    // engineer's own settings with that cluster's routing header added, so a
    // check is served from the SAME cluster it would be in CI. A check with no
    // cluster gets no overlay.
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
    const settingsPath = config.settingsDir === null || check.cluster === null
      ? null
      : path.join(config.settingsDir, `settings-${check.cluster}.json`);
    const dropEnv = ["WEAVE_API_KEY"];
    if (settingsPath !== null) {
      // Once the generated --settings overlay exists, inherited routing
      // variables must not compete with it. Without an overlay, preserve
      // shell-provided routing env.
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
        // Under `inherit`, `settingSources: null` lets the engineer's own
        // Claude Code settings load -- that's what supplies their endpoint and
        // login. An explicit provider gets CI's isolation instead
        // (`--setting-sources ""`), so a settings-file `env` block can't
        // quietly override the provider the engineer asked for.
        // `settingsPath`, when set, layers a cluster overlay on TOP via
        // `--settings` (highest precedence); drop the inherited routing vars
        // so that overlay is the only source of truth.
        provider: config.provider,
        productName: config.productName,
        settingSources: config.provider.id === PROVIDER.INHERIT ? null : "",
        settingsPath,
        dropEnv,
        onCostError: ({ slug, suffix, error }) =>
          process.stderr.write(`[${slug}/${suffix}] cost unavailable: ${error}\n`),
      });
    } catch (error) {
      // A throw here is an infrastructure failure (unreadable check file,
      // spawn failure), not a verdict. Report it as this check's neutral
      // outcome so one broken check doesn't abandon the rest.
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

  return {
    provider: config.provider.id,
    costLabel: config.provider.costLabel,
    checks: checkResults,
    totals: checkTotalsFor(checkResults),
  };
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
    outcome: publicOutcome(checkResult.outcome),
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

// Tallies summarized checks, whose `outcome` is already the public name.
function checkTotalsFor(checkResults) {
  const count = (outcome) =>
    checkResults.filter((checkResult) => checkResult.outcome === publicOutcome(outcome)).length;
  return {
    pass: count(OUTCOME.PASS),
    flagged: count(OUTCOME.FAIL),
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
