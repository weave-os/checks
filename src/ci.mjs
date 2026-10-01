// The action's bookend steps: create the aggregate check run before anything
// else can fail, and always close it, summarize, and publish outputs after.
//
// Each is a small function over an injected REST client so the contract the
// action relies on -- creation before checkout, a cleanup that never
// overwrites the worker's own close, and failure on infrastructure errors -- is
// unit tested (ci.test.mjs).

import { appendFileSync, existsSync, readFileSync } from "node:fs";

import { CHECK_RUN_STATUS, GITHUB_CONCLUSION } from "./parse.mjs";

// Creates the aggregate check run: the live PR-facing status table. Runs
// before checkout so the always() cleanup can close it even if checkout or
// preparation fails, instead of leaving a required check pending forever.
export async function createAggregate({ rest, repository, headSha, aggregateName, detailsUrl }) {
  const run = await rest("POST", `repos/${repository}/check-runs`, {
    name: aggregateName,
    head_sha: headSha,
    status: CHECK_RUN_STATUS.IN_PROGRESS,
    details_url: detailsUrl,
    output: {
      title: `${aggregateName}: preparing`,
      summary: "Checking out the PR and discovering checks...",
    },
  });
  if (!Number.isInteger(run?.id)) {
    throw new Error("check-run creation returned no id");
  }
  return run.id;
}

// The last line of defence against a required check stuck `in_progress`.
// When the worker reached its own close (success or its top-level catch), it
// wrote `completePath` and this is a no-op, so the worker's specific message
// is never overwritten with this generic one. Otherwise -- a crash in
// checkout, preparation, or before the worker could PATCH because of an
// infrastructure/setup failure -- close it as failure so branch protection
// cannot accept a run that never reached the coordinator. Findings and
// unusable model output remain neutral when the worker finishes normally.
export async function closeAggregate({
  rest,
  repository,
  checkRunId,
  completePath,
  aggregateName,
}) {
  if (!checkRunId || existsSync(completePath)) return false;
  await rest("PATCH", `repos/${repository}/check-runs/${checkRunId}`, {
    status: CHECK_RUN_STATUS.COMPLETED,
    conclusion: GITHUB_CONCLUSION.FAILURE,
    output: {
      title: `${aggregateName}: coordinator error`,
      summary:
        "The coordinator stopped before producing all check results. See the workflow run's logs.",
    },
  });
  return true;
}

// Appends the worker's status table to the job's step summary, or says why
// there is none.
export function writeStepSummary({ summaryPath, stepSummaryPath, aggregateName }) {
  if (!stepSummaryPath) return;
  const body =
    existsSync(summaryPath) ?
      readFileSync(summaryPath, "utf8")
    : `## ${aggregateName}\n\nThe coordinator did not produce a summary. See the step logs above.\n`;
  appendFileSync(stepSummaryPath, body);
}

// Turns the worker's results into action outputs, and decides whether the
// job should fail. Findings never change a check run's conclusion (always
// success or neutral); `failOnFindings` is the one opt-in way to make them
// block, and it fails the *step*, not any check run.
//
// Missing results mean the worker never finished; the worker step itself has
// already failed the job in that case, so this reports nothing and does not
// pile a second failure on top.
export function report({ resultsPath, summaryPath, outputPath, failOnFindings }) {
  const outputs = { "summary-path": summaryPath, "results-path": resultsPath };
  let results = null;
  if (existsSync(resultsPath)) {
    results = JSON.parse(readFileSync(resultsPath, "utf8"));
    Object.assign(outputs, {
      pass: String(results.totals.pass),
      flagged: String(results.totals.flagged),
      neutral: String(results.totals.neutral),
      "total-cost": results.totals.cost === null ? "" : String(results.totals.cost),
    });
  }
  writeOutputs(outputPath, outputs);
  const flagged = results?.totals.flagged ?? 0;
  if (failOnFindings && flagged > 0) {
    return {
      ok: false,
      message: `${flagged} check(s) flagged findings and fail-on-findings is set.`,
    };
  }
  return { ok: true, message: null };
}

export function writeOutputs(outputPath, outputs) {
  const text = Object.entries(outputs)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
  if (outputPath) appendFileSync(outputPath, text);
  else process.stdout.write(text);
}
