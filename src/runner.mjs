// The GitHub-agnostic half of a Weave Check run: spawn the Claude CLI, parse
// its stream-json output, price the session through the provider, and turn the
// structured result into a verdict validated against the diff.
//
// Two entry points consume this module:
//
//   - worker.mjs   -- the CI coordinator. Adds everything GitHub: check runs,
//                     review threads, resolution/dedup judges, the aggregate
//                     status table.
//   - local.mjs    -- `weave-checks run`. Runs the same review against a
//                     local `git diff` and reports to the terminal.
//
// Everything here is deliberately free of GitHub state so that the local path
// cannot drift from what CI actually does: both callers run the SAME
// invocation argv, the SAME prompt scaffolding, and the SAME verdict
// pipeline. The two callers differ only in what they pass in (`provider`,
// `settingSources`, `historySection`) and what they do with the result.
//
// Dependency-free ESM by the same rule as parse.mjs/history.mjs: `node
// runner.mjs` needs no install step. It imports parse.mjs and streamsplit.mjs
// (verdict + transcript parsing) and provider.mjs's env helper only. It must
// never import history.mjs, which is review-thread state and therefore
// GitHub-only, nor a concrete provider: the caller picks one and passes it in.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  CLI_RESULT_SUBTYPE,
  INTERPRET_OUTCOME,
  NEUTRAL_CAUSE,
  OUTCOME,
  VERDICT,
  interpretResult,
  parseStructuredOutput,
  validateResult,
} from "./parse.mjs";
import { DEFAULT_BRANDING } from "./branding.mjs";
import { childEnvironment } from "./provider.mjs";
import { splitStreamJson } from "./streamsplit.mjs";

// Every artifact a single agent invocation leaves behind is `<slug>.<suffix>`
// under the run's temp dir, so CI's diagnostics upload and the local
// `--keep-artifacts` directory hold byte-identical files for the same run.
export function resultPath(tempDir, slug, suffix) {
  return path.join(tempDir, `${slug}.${suffix}`);
}

// Spawns one `claude -p` invocation and returns everything downstream needs
// from it. Writes the prompt, transcript, session id, and stderr to
// `tempDir` as a side effect.
//
// The caller controls the things that differ between CI and local:
//
//   - `provider`       -- the provider.mjs contract: the env overlaid on the
//                         child, the secrets scrubbed from it, and how the
//                         session is priced. Null means no overlay and an
//                         unknown cost.
//   - `settingSources` -- when a string (CI passes ""), it is forwarded as
//                         `--setting-sources <value>` so a runner's settings,
//                         hooks, and plugins can't influence a check. When
//                         null (local), the flag is omitted. Local can also
//                         pass `settingsPath`: a generated settings overlay
//                         for this check's cluster.
//   - `dropEnv`        -- extra names to scrub on top of the provider's own.
//
// `model` null omits `--model`, so the CLI's own default serves the check.
// `cost` is null (rendered as "—") whenever it is unknown, never 0.
// `onCostError` receives `{ slug, suffix, error }` when the provider could not
// price the session, so the caller can surface it wherever its own summary
// lives.
export async function runClaude({
  slug,
  suffix,
  model,
  cluster = null,
  schemaText,
  promptText,
  repoDir,
  tempDir,
  provider = null,
  settingSources = null,
  settingsPath = null,
  dropEnv = [],
  onCostError = null,
}) {
  const promptPath = resultPath(tempDir, slug, `${suffix}.prompt.txt`);
  const transcriptPath = resultPath(tempDir, slug, `${suffix}.transcript.jsonl`);
  const sessionPath = resultPath(tempDir, slug, `${suffix}.session.txt`);
  const stderrPath = resultPath(tempDir, slug, `${suffix}.stderr`);
  writeFileSync(promptPath, promptText);

  // The CLI is invoked with stream-json instead of single-blob json. The
  // stream-json terminal `result` event carries every field the verdict
  // pipeline used to read off the single-blob JSON (`subtype`, `is_error`,
  // `result`/prose, `structured_output`), AND the stream itself is the full
  // transcript of what the agent saw and did -- assistant turns, tool_use
  // blocks, their results, hook stderr. That gives the diagnostics artifact a
  // faithful record of an invocation without an extra rerun.
  const cliArgs = [
    "-p",
    ...(model === null || model === undefined ? [] : ["--model", model]),
    // Stream-json requires --verbose in print mode. The verbose flag is also
    // what forces the per-turn `assistant` events to ship (without it the
    // stream collapses to just init + result).
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    schemaText,
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    "Read",
    "Glob",
    "Grep",
    "Bash(git diff *)",
    "Bash(git show *)",
    ...(settingSources === null ? [] : ["--setting-sources", settingSources]),
    // `--settings` takes highest precedence and is merged over whatever
    // `--setting-sources` loaded. Local may pass a generated file here (a
    // per-cluster overlay); CI never does.
    ...(settingsPath === null ? [] : ["--settings", settingsPath]),
    "--no-session-persistence",
  ];

  const processResult = await new Promise(resolve => {
    // The provider's `dropEnv` names variables the coordinator needs but the
    // CLI child does not (Weave Router drops the Weave API key, which only
    // the post-run cost lookup uses). Scrubbing is simpler here than
    // hand-rolling an allowlist of the vars the child DOES need.
    const child = spawn("claude", cliArgs, {
      cwd: repoDir,
      env: childEnvironment({
        baseEnv: process.env,
        dropEnv: [...(provider?.dropEnv ?? []), ...dropEnv],
        providerEnv: provider?.envFor({ model, cluster, slug, suffix }) ?? {},
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", error => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", exitCode => resolve({ code: exitCode ?? -1, stdout, stderr }));
    child.stdin.end(readFileSync(promptPath));
  });

  // Flush the transcript first; everything downstream reads from the parsed
  // view, not the raw stdout, so writing the lines out before parsing means
  // a parse failure still leaves an artifact on disk to read.
  const { transcript, resultEvent, sessionId } = splitStreamJson(processResult.stdout);
  writeFileSync(transcriptPath, `${transcript.join("\n")}\n`);
  writeFileSync(sessionPath, `${sessionId ?? ""}\n`);
  writeFileSync(stderrPath, processResult.stderr);

  // The downstream verdict pipeline reads a single `cli` shape, which is
  // now synthesized from the terminal `result` event. Returning null when
  // the stream carried no terminal event (CLI crashed before emitting one)
  // is treated by every reader the same as a malformed stdout: it reports
  // an unknown cost and a neutral outcome.
  // No provider means no cost lookup was even attempted -- report an unknown
  // cost with no error, since "we chose not to ask" is not a failure the
  // caller should surface as one.
  const { cost, error } =
    provider === null ?
      { cost: null, error: null }
    : await provider.resolveCost({ sessionId, resultEvent, model, cluster });
  if (error !== null) {
    onCostError?.({ slug, suffix, error });
  }
  return {
    code: processResult.code,
    stderr: processResult.stderr,
    sessionId,
    cli: synthesizeCli(resultEvent),
    cost,
    costError: error,
    costLabel: provider?.costLabel ?? null,
    transcript,
  };
}

// Turns a stream-json terminal `result` event into the legacy single-blob
// `cli` shape the verdict pipeline still consumes. Returns null when the
// stream carried no terminal event (CLI crashed before emitting one), which
// every downstream reader treats the same as a malformed stdout.
export function synthesizeCli(resultEvent) {
  if (resultEvent === null) return null;
  // The CLI exposes every field the verifier reads directly on the result
  // event. Reusing the same field names as the old `--output-format json`
  // blob means interpretResult() / parseStructuredOutput() / the cost path
  // can keep their existing shapes -- only the read source moved, not the
  // shape.
  return {
    is_error: resultEvent.is_error,
    subtype: resultEvent.subtype,
    api_error_status: resultEvent.api_error_status,
    result: resultEvent.result,
    structured_output: resultEvent.structured_output,
    permission_denials: resultEvent.permission_denials ?? [],
    num_turns: resultEvent.num_turns,
    duration_ms: resultEvent.duration_ms,
    // Kept for providers with no billing API of their own, which report the
    // CLI's client-side estimate (providers/client-cost.mjs), and for the
    // per-model breakdown in diagnostics.
    total_cost_usd: resultEvent.total_cost_usd,
    modelUsage: resultEvent.modelUsage,
  };
}

// Shared first phase of every agent invocation: turn `{ code, stdout, stderr }`
// into either a parsed `cli` object (on the happy path) or an `error` string
// (caller decides whether to fail closed, fail open, or treat a sub-class as
// retryable). The bodies of the callers (worker.mjs's judgeResolutions and
// judgeDuplicates, and normalize() below) were copy-pasted code up to this
// exact fork point. Each caller's remaining work is its specific success
// handling and the presentation of the error to its own return shape.
//
// `parseStructuredOutput` is called only when the CLI surfaced success AND the
// structured_output field is usable, because parseStructuredOutput throws on a
// malformed JSON string while the other two phases only need a structural check.
export function decodeAgentInvocation(invocation, { label }) {
  if (invocation.code !== 0) {
    return { ok: false, error: exitError(invocation, `${label} CLI`) };
  }
  const cli = invocation.cli;
  if (
    !cli ||
    typeof cli !== "object" ||
    cli.is_error === true ||
    cli.subtype !== CLI_RESULT_SUBTYPE.SUCCESS
  ) {
    return {
      ok: false,
      error: `${label} reported ${cli?.subtype ?? cli?.api_error_status ?? "an error"}`,
      cli,
    };
  }
  let structuredResult;
  try {
    structuredResult = parseStructuredOutput(cli);
  } catch (error) {
    return {
      ok: false,
      error: `${label} structured_output was a string but not valid JSON: ${error.message}`,
      cli,
    };
  }
  if (
    !structuredResult ||
    typeof structuredResult !== "object" ||
    Array.isArray(structuredResult)
  ) {
    return {
      ok: false,
      error: `${label} returned no structured_output object`,
      cli,
    };
  }
  return { ok: true, cli, resultObject: structuredResult };
}

// Renders a non-zero CLI exit as a diagnosable one-line error.
//
// The exit code alone is not diagnosable: `claude -p` exits 1 for a prompt
// that exceeded the context window, a 401, a hook rejection, and a plain
// crash alike -- and the reason is only ever in the terminal `result` event,
// never in the exit status or on stderr. A run where every check reported a
// bare "Claude CLI exited 1" cost a full debugging session to trace back to
// one oversized diff. When the stream did carry a terminal event (the common
// case -- the CLI reports the failure, then exits non-zero), append its
// `result` text; only a CLI that died before emitting one falls back to the
// bare code.
function exitError(invocation, label = "Claude CLI") {
  const detail =
    typeof invocation.cli?.result === "string" && invocation.cli.result.trim() !== "" ?
      `: ${invocation.cli.result.trim().split("\n")[0].slice(0, 200)}`
    : "";
  return `${label} exited ${invocation.code}${detail}`;
}

export function normalize(invocation, addedLines) {
  if (invocation.code !== 0) {
    // A non-zero exit may still have spent tokens before the CLI terminated.
    // Read the cost the same way every other path does rather than reporting a
    // failed invocation as free.
    return {
      outcome: OUTCOME.NEUTRAL,
      cause: NEUTRAL_CAUSE.INFRASTRUCTURE,
      error: exitError(invocation),
      cost: invocationCost(invocation),
      duration: invocationDuration(invocation),
    };
  }
  // No terminal result event. Same posture as a malformed stdout pre-stream:
  // mark cost and duration unknown and treat as a definite neutral. A
  // missing `cli` here typically means the CLI exited 0 but the stream was
  // truncated (rare) -- the transcript is still kept as a diagnostic artifact.
  if (invocation.cli === null) {
    return {
      outcome: OUTCOME.NEUTRAL,
      cause: NEUTRAL_CAUSE.INFRASTRUCTURE,
      error: "Claude stream-json output had no terminal result event",
      cost: invocationCost(invocation),
      duration: null,
    };
  }
  const cli = invocation.cli;
  const interpreted = interpretResult(cli);
  if (interpreted.outcome !== INTERPRET_OUTCOME.OK) {
    // outcome === "retryable" means: the CLI exited cleanly and the model
    // had a working session, but skipped the structured-output tool. Worth
    // asking once more; see evaluateCheck(). Anything else (CLI crash, parse
    // error) is a definite neutral -- a retry would repeat the same miss.
    //
    // `cli` can itself be a valid-JSON `null` and `duration_ms` can be missing
    // or non-numeric -- normalize every such case to `null` (unknown), not
    // `undefined`, so sumFiniteNumbers() recognizes it as an unknown component
    // rather than silently skipping it.
    const cost = invocationCost(invocation);
    const duration = typeof cli?.duration_ms === "number" ? cli.duration_ms : null;
    return interpreted.outcome === INTERPRET_OUTCOME.RETRYABLE ?
        {
          outcome: OUTCOME.NEUTRAL,
          cause: interpreted.cause ?? NEUTRAL_CAUSE.INVALID_OUTPUT,
          ...interpreted.value,
          retryable: true,
          cost,
          duration,
        }
      : {
          outcome: OUTCOME.NEUTRAL,
          cause: interpreted.cause ?? NEUTRAL_CAUSE.INFRASTRUCTURE,
          ...interpreted.value,
          cost,
          duration,
        };
  }
  // The structured_output route (the common case once the model cooperates)
  // needs the full result validated against the diff. interpretResult already
  // walked the same three checks decodeAgentInvocation would, so reusing it
  // here avoids forcing the helper to layer on top of itself.
  return validateAndFinalize(interpreted.value, invocation, cli, addedLines);
}

// Follows normalize() through the result-validating and outcome-rendering
// shared last stage. Kept separate from interpretResult() so the verdict-vs-
// diff validation can be unit tested once and reused if a second caller ever
// needs the same rendering rules.
export function validateAndFinalize(resultObject, invocation, cli, addedLines) {
  // Normalized once so every return below emits `number | null`, never
  // `undefined` -- see the null-vs-undefined note in normalize().
  const cost = invocationCost(invocation);
  const duration = typeof cli.duration_ms === "number" ? cli.duration_ms : null;

  let validated;
  try {
    validated = validateResult(resultObject, addedLines);
  } catch (error) {
    // The agent still billed tokens for this invocation; the structured
    // result simply couldn't be diff-validated. Preserve the spend so a
    // neutral run from a parse-time miss doesn't look free.
    return {
      outcome: OUTCOME.NEUTRAL,
      cause: NEUTRAL_CAUSE.INVALID_OUTPUT,
      error: `Invalid structured result: ${error.message}`,
      cost,
      duration,
    };
  }

  if (validated.verdict === VERDICT.FAIL && validated.accepted.length === 0) {
    return {
      outcome: OUTCOME.NEUTRAL,
      cause: NEUTRAL_CAUSE.INVALID_OUTPUT,
      error: "FAIL had no valid anchored findings after diff validation.",
      proseFallbacks: validated.proseFallbacks,
      rejected: validated.rejected,
      cost,
      duration,
    };
  }

  return {
    outcome: validated.verdict === VERDICT.PASS ? OUTCOME.PASS : OUTCOME.FAIL,
    reason: validated.reason,
    accepted: validated.accepted,
    proseFallbacks: validated.proseFallbacks,
    rejected: validated.rejected,
    denials: cli.permission_denials ?? [],
    cost,
    turns: cli.num_turns,
    duration,
  };
}

// Builds the review prompt. `historySection`, when provided, is the rendered
// "previously flagged issues" block -- GitHub review-thread state, which only
// worker.mjs has. When it is null (the local path) both the section and the
// don't-repeat instruction are omitted rather than shown as an empty block,
// since a local run has no prior comments to repeat.
export function promptFor(
  check,
  { repoDir, diff, stat, historySection = null, productName = DEFAULT_BRANDING.productName },
) {
  const criteria = readFileSync(check.criteriaPath ?? path.join(repoDir, check.path), "utf8");
  return [
    `You are running the advisory ${productName} "${check.name}" on a pull request.`,
    "",
    "Review ONLY changed lines in the diff below.",
    "- Read adjacent repository files only when needed to judge a changed line.",
    "- Do NOT modify files. You have read-only tools.",
    "- Do NOT report pre-existing issues this diff did not introduce.",
    "- Provide literal replacements only for lines present in the diff.",
    "- Set PASS when the changed lines do not violate the criteria.",
    "- Set FAIL only for a violation of the criteria below.",
    "- Every finding needs a repo-relative file, line (and start_line for a range),",
    "  a concrete comment, and a replacement when one is possible.",
    // Unconditional, and deliberately not part of the history block: both
    // clauses govern how the diff itself is swept and scored, so a local run
    // (no history) needs them exactly as much as CI does. Dropping either one
    // lets a check report only the first matching line, or funnel a genuine
    // criteria match into a "noted but passing" verdict -- which is how the
    // same check ends up flip-flopping on byte-identical lines across runs.
    "- Once you find one instance of a violated pattern, sweep the entire diff",
    "  again for every other occurrence before finalizing your verdict — report",
    "  all of them in this pass. You might only get one shot at a given line,",
    "  so partial coverage forces the next commit to re-trigger this check for",
    "  sites the diff was already making you look at.",
    '- A match to the criteria\'s "Flag" conditions IS a violation — set FAIL.',
    "  Severity (Warning vs. Error) is the only knob for how serious a match is;",
    '  do not funnel a genuine match into a "noted but passing" verdict just',
    "  because the example looks minor. Otherwise the same check can flip-flop",
    "  on byte-identical lines across runs.",
    ...(historySection === null ?
      []
    : [
        "- Do NOT repeat a finding that matches one already listed under",
        '  "Previously flagged issues" below -- it has already been reported on this PR, including',
        "  any marked (already resolved): a human dismissed it, and that stands even if the",
        "  underlying code was never actually changed.",
      ]),
    "",
    "## Review criteria",
    "",
    criteria,
    "",
    ...(historySection === null ?
      []
    : ["## Previously flagged issues by this check on this PR", "", historySection, ""]),
    "## Changed files",
    "",
    "```",
    stat,
    "```",
    "",
    "## Diff",
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

// One check's own review, end to end: build the prompt, run the agent, and
// normalize the verdict against the diff. Retries once if the model had a
// working session (CLI exit 0, subtype success) but skipped the
// structured-output tool call -- normalize() flags that case via `retryable`.
// Every other neutral cause (CLI crash, malformed JSON, an invalid result once
// parsed) is left alone: retrying those would just repeat the same failure. The
// retry overwrites the first attempt's diagnostic files, since only the final
// outcome matters for debugging a check that still ends up neutral.
//
// `onAttempt` is called once per attempt (initial + retry) with
// `(label, invocation)` so a caller can attach the per-attempt session and
// transcript to its own summary -- the on-disk transcript has the retry's
// bytes only, but a summary usually wants to show both.
export async function evaluateCheck({
  check,
  repoDir,
  tempDir,
  diff,
  stat,
  addedLines,
  schemaText,
  historySection = null,
  productName = DEFAULT_BRANDING.productName,
  provider = null,
  settingSources,
  settingsPath = null,
  dropEnv,
  onAttempt,
  onCostError,
}) {
  const invoke = () =>
    runClaude({
      slug: check.slug,
      suffix: "claude",
      model: check.model,
      cluster: check.cluster,
      schemaText,
      promptText: promptFor(check, { repoDir, diff, stat, historySection, productName }),
      repoDir,
      tempDir,
      provider,
      settingSources,
      settingsPath,
      dropEnv,
      onCostError,
    });

  const invocation = await invoke();
  onAttempt?.("Main review", invocation);
  const normalizedResult = normalize(invocation, addedLines);
  if (normalizedResult.outcome !== OUTCOME.NEUTRAL || !normalizedResult.retryable) {
    return normalizedResult;
  }
  // retryable here means the CLI finished a working session but skipped
  // structured output -- normalize() does NOT mark CLI crashes or truncated
  // streams retryable, because those would just repeat the same miss. A
  // lockstep retry of the skip-structured-output case across the 16-wide
  // pool would still pile every check onto the same transient outage; a
  // small jittered pause spreads them out. The range is short on purpose --
  // this is not a multi-attempt ladder, just one retry of a single agent
  // call.
  await new Promise(resolve => setTimeout(resolve, 250 + Math.random() * 250));
  const retryInvocation = await invoke();
  onAttempt?.("Main review (retry)", retryInvocation);
  const retryResult = normalize(retryInvocation, addedLines);
  return {
    ...retryResult,
    // Preserve the retry's verdict and diagnostics while accounting for all
    // primary-agent execution.
    cost: totalCost([normalizedResult.cost, retryResult.cost]),
    duration: totalDuration([normalizedResult.duration, retryResult.duration]),
  };
}

// Reads the provider-resolved cost off a finished agent invocation. runClaude
// attaches it (see there): under Weave Router it is the committed per-session
// total from the router's own telemetry, otherwise the CLI's client-reported
// estimate. A direct passthrough -- every provider guarantees `cost` is either
// null (lookup couldn't produce a number, or was never attempted) or a finite
// number, so this never needs to re-validate that. Null is never collapsed to
// 0, exactly as invocationDuration() does for a missing duration. The total is
// summed across all agent phases by totalCost().
export function invocationCost(invocation) {
  return invocation.cost;
}

// Reads duration_ms off an agent invocation's parsed `cli` object. This
// mirrors invocationCost so that partial failures still contribute
// wall-clock time to the summary. Inlined rather than sharing a
// metric-key helper: duration_ms is the only field this shape is used for.
export function invocationDuration(invocation) {
  const cli = invocation.cli;
  if (cli === null) return null;
  return typeof cli.duration_ms === "number" ? cli.duration_ms : null;
}

// Sums the numeric, finite values in `values`, treating `null` as "unknown"
// rather than "zero": if any entry is null, the whole sum is unknown (null)
// rather than silently reporting a partial total as if it were complete.
// Non-numeric, non-null entries (undefined, NaN) are skipped -- those only
// arise from an agent phase that legitimately didn't run and already
// reports an explicit 0 elsewhere, not from a missing measurement.
function sumFiniteNumbers(values) {
  let sum = 0;
  for (const v of values) {
    if (v === null) return null;
    if (typeof v === "number" && Number.isFinite(v)) sum += v;
  }
  return sum;
}

// Sums cost across the agent calls a single check ran. Accepts an array of
// numeric cost values and returns the rounded-down USD total, or null
// (unknown) if any contributing invocation's cost couldn't be read --
// see sumFiniteNumbers().
export function totalCost(values) {
  const sum = sumFiniteNumbers(values);
  if (sum === null) return null;
  // Round to 4 dp -- dollars that small don't render meaningfully below two
  // places anyway, but the aggregation needs extra precision so a dozen checks
  // don't drift by a penny. The display formatter below rounds again to 2dp.
  return Math.round(sum * 10000) / 10000;
}

// Sums duration across the agent calls a single check ran. Returns null
// (unknown) if any contributing invocation's duration couldn't be read --
// see sumFiniteNumbers().
export function totalDuration(values) {
  const sum = sumFiniteNumbers(values);
  return sum === null ? null : Math.round(sum);
}

export function formatUsd(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) {
    const tenths = seconds.toFixed(1);
    // toFixed(1) can round up to "60.0" at the boundary (e.g. 59995ms),
    // which would render as "60.0s" instead of rolling into a minute.
    return tenths === "60.0" ? "1m0s" : `${tenths}s`;
  }
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}m${remainder}s`;
}

// Runs `tasks` with at most `concurrency` in flight, preserving input order in
// the returned array. Both entry points need the same bounded pool: CI runs 16
// checks at once on a big runner, a laptop runs a handful.
export async function runPool(items, concurrency, run) {
  const results = new Array(items.length);
  const queue = items.map((item, index) => ({ item, index }));
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const { item, index } = queue.shift();
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}
