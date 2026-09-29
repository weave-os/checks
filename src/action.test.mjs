// Contract tests for action.yml. The package has no YAML dependency, so these
// read the file's fixed two-space layout directly; a reformat that breaks
// them should fail loudly rather than pass vacuously.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACTION = readFileSync(path.join(ROOT, "action.yml"), "utf8");

function section(text, start, end) {
  const from = text.indexOf(`\n${start}:\n`);
  assert.notEqual(from, -1, `missing ${start}:`);
  const to = end === null ? text.length : text.indexOf(`\n${end}:\n`, from);
  return text.slice(from, to);
}

const INPUTS = [...section(ACTION, "inputs", "outputs").matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
const INPUT_DEFAULTS = Object.fromEntries(
  [...section(ACTION, "inputs", "outputs").matchAll(/^ {2}([a-z0-9-]+):\n(?: {4}.*\n)*? {4}default: (.*)$/gm)].map((m) => [m[1], m[2]]),
);
const OUTPUTS = [...section(ACTION, "outputs", "runs").matchAll(/^ {2}([a-z0-9-]+):\n(?: {4}.*\n)*? {4}value: (.*)$/gm)].map(
  (m) => ({ name: m[1], value: m[2] }),
);

// Splits runs.steps into one text block per step.
const STEPS = section(ACTION, "runs", null)
  .split(/\n(?= {4}- name: )/)
  .slice(1)
  .map((block) => ({
    name: /- name: (.+)/.exec(block)[1],
    id: /\n {6}id: (\S+)/.exec(block)?.[1] ?? null,
    if: /\n {6}if: (.+)/.exec(block)?.[1] ?? null,
    uses: /\n {6}uses: (\S+)/.exec(block)?.[1] ?? null,
    block,
  }));

const step = (name) => {
  const found = STEPS.find((s) => s.name === name);
  assert.ok(found, `missing step "${name}"`);
  return found;
};
const indexOf = (name) => STEPS.findIndex((s) => s.name === name);

describe("action.yml", () => {
  it("is a composite action", () => {
    assert.match(ACTION, /\nruns:\n {2}using: composite\n/);
  });

  // A composite action can neither grant permissions nor read secrets; saying
  // otherwise in the file would mislead a reader.
  it("declares no permissions and reads no secrets", () => {
    assert.doesNotMatch(ACTION, /^ *permissions:/m);
    assert.doesNotMatch(ACTION, /\$\{\{\s*secrets\./);
    assert.doesNotMatch(ACTION, /pull_request_target/);
  });

  it("creates the aggregate before checkout and before anything that can fail on the repo", () => {
    assert.ok(indexOf("Create aggregate check run") < indexOf("Check out the PR merge commit"));
    assert.ok(indexOf("Create aggregate check run") < indexOf("Prepare diffs and discover checks"));
    assert.equal(indexOf("Set up Node"), 0);
  });

  it("always closes the aggregate and reports, after the worker", () => {
    for (const name of ["Close aggregate check run", "Report results"]) {
      assert.match(step(name).if, /^always\(\) && steps\.aggregate\.outputs\.id != ''$/);
      assert.ok(indexOf(name) > indexOf("Run checks"));
    }
    assert.ok(indexOf("Close aggregate check run") < indexOf("Report results"));
  });

  it("uploads diagnostics only when asked", () => {
    assert.equal(INPUT_DEFAULTS["upload-diagnostics"], '"false"');
    assert.match(step("Upload diagnostics").if, /inputs\.upload-diagnostics == 'true'/);
  });

  it("never fails on findings by default", () => {
    assert.equal(INPUT_DEFAULTS["fail-on-findings"], '"false"');
    assert.match(step("Report results").block, /WEAVE_CHECKS_FAIL_ON_FINDINGS: \$\{\{ inputs\.fail-on-findings \}\}/);
  });

  it("checks out without persisting credentials", () => {
    assert.match(step("Check out the PR merge commit").block, /persist-credentials: false/);
  });

  it("pins every third-party action to a full commit SHA", () => {
    for (const { name, uses } of STEPS.filter((s) => s.uses !== null)) {
      assert.match(uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, name);
    }
  });

  // Inputs reach scripts through env only; `${{ }}` inside a run: script is
  // shell injection waiting for a crafted input.
  it("never interpolates expressions into a run script", () => {
    for (const { name, block } of STEPS) {
      const run = /\n {6}run: ([\s\S]*)$/.exec(block)?.[1] ?? "";
      assert.doesNotMatch(run, /\$\{\{/, name);
    }
  });

  it("uses every declared input", () => {
    for (const input of INPUTS) {
      assert.match(section(ACTION, "runs", null), new RegExp(`inputs\\.${input}\\b`), input);
    }
  });

  it("maps every output to a step that exists", () => {
    const ids = new Set(STEPS.map((s) => s.id).filter(Boolean));
    assert.deepEqual(
      OUTPUTS.map((o) => o.name),
      ["aggregate-check-run-id", "pass", "flagged", "neutral", "total-cost", "review-base", "summary-path", "results-path"],
    );
    for (const { name, value } of OUTPUTS) {
      const id = /steps\.([a-z-]+)\.outputs/.exec(value)?.[1];
      assert.ok(ids.has(id), `${name} reads missing step ${id}`);
    }
  });

  it("documents caller-owned permissions, token/secrets passing, and fork limits", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    for (const phrase of ["cannot grant GitHub permissions", "cannot read the caller's secrets", "checks: write", "pull-requests: write", "read-only access", "pull_request_target"]) {
      assert.ok(readme.includes(phrase), `README should explain ${phrase}`);
    }
    assert.match(readme, /upload-diagnostics.*false/s);
  });

  it("self-check uses Router credentials, same-repository pull_request, and the approved policy", () => {
    const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "self-check.yml"), "utf8");
    assert.match(workflow, /pull_request:/);
    assert.doesNotMatch(workflow, /^  pull_request_target:/m);
    assert.match(workflow, /head\.repo\.full_name == github\.repository/);
    assert.match(workflow, /secrets\.WEAVE_ROUTER_KEY/);
    assert.match(workflow, /secrets\.WEAVE_API_KEY/);
    assert.match(workflow, /provider: weave-router/);
    assert.match(workflow, /allowed-intelligence: low,medium,high,maximum/);
    assert.doesNotMatch(workflow, /allowed-models:|allowed-clusters:|require-cluster:/);
    assert.match(workflow, /checkout: false/);
  });

  it("uses trusted npm publishing with OIDC only in the publish job", () => {
    const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "publish_npm.yml"), "utf8");
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /npm publish --provenance --access public/);
    assert.match(workflow, /checks-v\*/);
    assert.match(workflow, /merge-base --is-ancestor/);
    assert.match(workflow, /workflow=publish_npm\.yml/);
    for (const uses of workflow.matchAll(/^\s+uses: (.+)$/gm)) {
      assert.match(uses[1], /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}/, uses[1]);
    }
  });

  it("defaults to the generic provider and Weave branding", () => {
    assert.equal(INPUT_DEFAULTS.provider, "anthropic");
    assert.equal(INPUT_DEFAULTS["checks-dir"], ".weave-checks");
    assert.equal(INPUT_DEFAULTS["aggregate-name"], "Weave Checks");
    assert.equal(INPUT_DEFAULTS["marker-prefix"], "weave-check");
    assert.equal(INPUT_DEFAULTS["review-event"], "COMMENT");
  });

  // Every env name the worker reads must be one the action sets, or the input
  // silently does nothing.
  it("passes the worker every setting it reads", () => {
    const worker = readFileSync(path.join(ROOT, "src", "worker.mjs"), "utf8");
    const provider = readFileSync(path.join(ROOT, "src", "provider.mjs"), "utf8");
    const branding = readFileSync(path.join(ROOT, "src", "branding.mjs"), "utf8");
    const read = new Set(
      [...`${worker}${provider}${branding}`.matchAll(/env(?:\.|\[")(WEAVE_[A-Z_]+|[A-Z_]+_PATH|MASTER_CHECK_RUN_ID|PR_NUMBER|HEAD_SHA|REPO_DIR)/g)].map((m) => m[1]),
    );
    const workerStep = step("Run checks").block;
    // Endpoint overrides are for self-hosted Routers, set through the job env.
    const optional = new Set(["WEAVE_ROUTER_BASE_URL", "WEAVE_API_BASE_URL", "SCHEMA_PATH"]);
    for (const name of read) {
      if (optional.has(name)) continue;
      assert.match(workerStep, new RegExp(`\\n {8}${name}: `), name);
    }
  });
});
