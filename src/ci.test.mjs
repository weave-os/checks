import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { closeAggregate, createAggregate, report, writeStepSummary } from "./ci.mjs";
import { GitHubError, permissionHint } from "./github.mjs";

const ROOTS = [];
after(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});
function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), "weave-checks-ci-"));
  ROOTS.push(root);
  return root;
}

function recordingRest(response = {}) {
  const calls = [];
  const rest = async (method, apiPath, body) => {
    calls.push({ method, apiPath, body });
    return response;
  };
  rest.calls = calls;
  return rest;
}

describe("createAggregate", () => {
  it("creates an in-progress run under the aggregate name and returns its id", async () => {
    const rest = recordingRest({ id: 99 });
    const id = await createAggregate({
      rest,
      repository: "o/r",
      headSha: "abc",
      aggregateName: "Acme Checks",
      detailsUrl: "https://github.com/o/r/actions/runs/1",
    });
    assert.equal(id, 99);
    assert.deepEqual(rest.calls[0], {
      method: "POST",
      apiPath: "repos/o/r/check-runs",
      body: {
        name: "Acme Checks",
        head_sha: "abc",
        status: "in_progress",
        details_url: "https://github.com/o/r/actions/runs/1",
        output: {
          title: "Acme Checks: preparing",
          summary: "Checking out the PR and discovering checks...",
        },
      },
    });
  });

  it("fails when GitHub returns no id", async () => {
    await assert.rejects(
      createAggregate({
        rest: recordingRest({}),
        repository: "o/r",
        headSha: "abc",
        aggregateName: "A",
      }),
      /returned no id/,
    );
  });
});

describe("closeAggregate", () => {
  it("does nothing when the worker already closed the aggregate", async () => {
    const root = scratch();
    const completePath = path.join(root, "complete");
    writeFileSync(completePath, "completed\n");
    const rest = recordingRest();

    assert.equal(
      await closeAggregate({
        rest,
        repository: "o/r",
        checkRunId: "5",
        completePath,
        aggregateName: "A",
      }),
      false,
    );
    assert.equal(rest.calls.length, 0);
  });

  it("closes an aggregate the worker never reached as failure", async () => {
    const rest = recordingRest();

    const closed = await closeAggregate({
      rest,
      repository: "o/r",
      checkRunId: "5",
      completePath: path.join(scratch(), "missing"),
      aggregateName: "Acme Checks",
    });

    assert.equal(closed, true);
    assert.equal(rest.calls[0].method, "PATCH");
    assert.equal(rest.calls[0].apiPath, "repos/o/r/check-runs/5");
    assert.equal(rest.calls[0].body.status, "completed");
    assert.equal(rest.calls[0].body.conclusion, "failure");
    assert.equal(rest.calls[0].body.output.title, "Acme Checks: coordinator error");
  });

  it("does nothing when no aggregate was created", async () => {
    const rest = recordingRest();
    assert.equal(
      await closeAggregate({
        rest,
        repository: "o/r",
        checkRunId: "",
        completePath: "/nope",
        aggregateName: "A",
      }),
      false,
    );
    assert.equal(rest.calls.length, 0);
  });
});

describe("writeStepSummary", () => {
  it("appends the worker's table, or a fallback when there is none", () => {
    const root = scratch();
    const stepSummaryPath = path.join(root, "step.md");
    writeFileSync(stepSummaryPath, "_Reviewing from x._\n\n");
    writeStepSummary({
      summaryPath: path.join(root, "missing.md"),
      stepSummaryPath,
      aggregateName: "Acme Checks",
    });
    assert.match(
      readFileSync(stepSummaryPath, "utf8"),
      /^_Reviewing from x\._\n\n## Acme Checks\n\nThe coordinator did not produce a summary/,
    );

    const summaryPath = path.join(root, "summary.md");
    writeFileSync(summaryPath, "**Acme Checks** — table\n");
    writeStepSummary({ summaryPath, stepSummaryPath, aggregateName: "Acme Checks" });
    assert.match(readFileSync(stepSummaryPath, "utf8"), /\*\*Acme Checks\*\* — table\n$/);
  });
});

describe("report", () => {
  function results(root, totals) {
    const resultsPath = path.join(root, "results.json");
    writeFileSync(resultsPath, JSON.stringify({ totals }));
    return resultsPath;
  }

  it("publishes the tallies as outputs", () => {
    const root = scratch();
    const outputPath = path.join(root, "output");
    const resultsPath = results(root, { pass: 3, flagged: 1, neutral: 0, cost: 0.42 });

    const outcome = report({
      resultsPath,
      summaryPath: "/s.md",
      outputPath,
      failOnFindings: false,
    });

    assert.equal(outcome.ok, true);
    assert.equal(
      readFileSync(outputPath, "utf8"),
      `summary-path=/s.md\nresults-path=${resultsPath}\npass=3\nflagged=1\nneutral=0\ntotal-cost=0.42\n`,
    );
  });

  it("publishes an unknown cost as empty, never zero", () => {
    const root = scratch();
    const outputPath = path.join(root, "output");
    report({
      resultsPath: results(root, { pass: 1, flagged: 0, neutral: 0, cost: null }),
      summaryPath: "/s",
      outputPath,
      failOnFindings: false,
    });
    assert.match(readFileSync(outputPath, "utf8"), /^total-cost=$/m);
  });

  it("fails only on findings, and only when asked", () => {
    const root = scratch();
    const flagged = results(root, { pass: 1, flagged: 2, neutral: 0, cost: null });
    assert.equal(
      report({
        resultsPath: flagged,
        summaryPath: "/s",
        outputPath: path.join(root, "o1"),
        failOnFindings: false,
      }).ok,
      true,
    );
    const outcome = report({
      resultsPath: flagged,
      summaryPath: "/s",
      outputPath: path.join(root, "o2"),
      failOnFindings: true,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /2 check\(s\) flagged findings/);
  });

  // Neutral is an operational miss, not a finding.
  it("does not fail on neutral checks", () => {
    const root = scratch();
    const neutral = results(root, { pass: 0, flagged: 0, neutral: 3, cost: null });
    assert.equal(
      report({
        resultsPath: neutral,
        summaryPath: "/s",
        outputPath: path.join(root, "o"),
        failOnFindings: true,
      }).ok,
      true,
    );
  });

  it("reports nothing without results, leaving the worker's own failure to speak", () => {
    const root = scratch();
    const outputPath = path.join(root, "o");
    const outcome = report({
      resultsPath: path.join(root, "missing.json"),
      summaryPath: "/s",
      outputPath,
      failOnFindings: true,
    });
    assert.equal(outcome.ok, true);
    assert.doesNotMatch(readFileSync(outputPath, "utf8"), /flagged=/);
  });
});

describe("permissionHint", () => {
  it("points a 403 at the Weave Checks App installation, not the workflow token", () => {
    assert.match(
      permissionHint(new GitHubError("x", 403)),
      /Weave Checks App needs Checks and Pull requests write/,
    );
    assert.doesNotMatch(permissionHint(new GitHubError("x", 403)), /GITHUB_TOKEN|permissions:/);
    assert.equal(permissionHint(new GitHubError("x", 500)), "");
    assert.equal(permissionHint(new Error("x")), "");
  });
});
