# Weave Checks

[![Tests](https://github.com/weave-os/checks/actions/workflows/test.yml/badge.svg)](https://github.com/weave-os/checks/actions/workflows/test.yml)

Advisory, per-concern code review for GitHub pull requests. Write one Markdown file for each review concern; Weave Checks runs a read-only agent against each check's criteria and the pull request's changed lines. Findings appear as review comments or on the check run. Operational misses stay neutral instead of masquerading as a pass or a finding.

This repository contains the reusable GitHub workflow (and the action it runs), the `@weave-os/checks` local CLI/package, a small set of generic starter checks, and an optional library of situational checks. **Your check definitions remain in your repository**; opt into the starter checks with `use-default-checks: true` when you want them alongside your own.

> The generic starter-check corpus and per-concern review format adapt material and design from [Continue Checks](https://github.com/continuedev/checks), Copyright 2025 Continue Dev, Inc., Apache-2.0. See [`NOTICE`](NOTICE) for attribution and [`LICENSE`](LICENSE) for this package's license.

## GitHub workflow

Call the reusable workflow as a job, pinned to a full 40-character commit SHA of this repository:

```yaml
name: Weave Checks
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  weave-checks:
    uses: weave-os/checks/.github/workflows/weave-checks.yml@<40-character-commit-sha>
    permissions:
      id-token: write
    secrets:
      weave-router-key: ${{ secrets.WEAVE_ROUTER_KEY }}
```

Pin a commit SHA, not `main` or a tag: Weave issues the App token only to approved commits of this workflow, so a movable ref would stop working when it moves. The job needs nothing but `id-token: write`; every GitHub call it makes is as the Weave Checks App. Pull requests from forks get no OIDC token, so the workflow skips them. It runs on `pull_request` events only; never call it from `pull_request_target`.

### Setup: install the Weave Checks App

Check runs, reviews, and replies always come from the **Weave Checks** GitHub App. The action never posts as `github-actions[bot]`, and you never handle an App key.

1. **Install the App.** Open [github.com/apps/weave-checks](https://github.com/apps/weave-checks/installations/new), choose your organization, and select the repositories that will run Weave Checks. The App needs Checks and Pull requests write access for check runs and reviews, plus Contents write so it can resolve review threads. GitHub gates `resolveReviewThread` behind Contents write even though it changes no repository files. The action uses a repository-scoped installation token and never asks Claude to use it, but the token itself has permission to write repository contents.
2. **Grant `id-token: write`** to the calling job, as in the example above. The job's own `GITHUB_TOKEN` needs nothing else: even the checkout is made as the App.
3. **Pass your model provider credentials** as secrets (see [Provider setup](#provider-setup)). A called workflow cannot read your secrets unless you pass them in.

**How the workflow authenticates:** at the start of the job it requests a GitHub OIDC token with the audience `weave-checks`. That token is GitHub's signed statement of which repository is running, and which reusable workflow at which commit (`job_workflow_ref` and `job_workflow_sha`). The workflow runs the action from that same commit, so the code Weave approves is the code that runs. The action sends the token to Weave, which checks it and returns a Weave Checks App installation token. Weave takes the repository from the OIDC token's signed claims, not from anything in the request. The returned token is scoped to that one repository with the App's review permissions, and it expires within an hour. The action uses it for every GitHub call and revokes it when the job finishes. It is never a workflow output.

**If authentication fails, the job stops before creating any check run,** with one of these explanations:

- **`id-token: write` is missing** from the calling job.
- **The workflow is not an approved commit** of `weave-os/checks/.github/workflows/weave-checks.yml`, or the action was run directly as a step. Pin a released commit SHA.
- **The App is not installed** on the repository's owner, or not on this repository. Add it from the App's installation settings.
- **The pull request changes the workflow file that runs Weave Checks.** Weave refuses to issue a token for it, so a pull request cannot rewrite the job that holds the App token. Checks run normally again once the change merges.

### Provider setup

The workflow defaults to `provider: weave-router`, as in the example above. Set a repository or organization secret named `WEAVE_ROUTER_KEY` and pass it as `weave-router-key`. The same key authenticates Router requests and session-cost lookups; no separate Weave API key is needed. Router mode requires an `intelligence` value on every check; the tier becomes the Router force-cluster, and the model alias is derived from the same value. The key is supplied to CLI requests via the `X-Weave-Router-Key` header and used directly for cost lookups.

The production Router URL is used by default. For a self-hosted or staging Router, set the workflow's `weave-router-url` input to its host URL (for example, `${{ vars.WEAVE_ROUTER_URL }}`).

With `provider: anthropic`, pass an Anthropic API key, Claude Code OAuth credentials, or an Anthropic-compatible endpoint through the `provider-env` secret. The Router key is not needed. Example for a gateway, with a repository secret `WEAVE_CHECKS_PROVIDER_ENV` holding the lines to pass:

```yaml
with:
  provider: anthropic
secrets:
  provider-env: ${{ secrets.WEAVE_CHECKS_PROVIDER_ENV }}
```

```text
ANTHROPIC_BASE_URL=https://llm-gateway.example.com
ANTHROPIC_CUSTOM_HEADERS=X-Workspace: code-review
```

`provider-env` is a secret because it usually carries credentials; its values are set only on the agent process. Other examples include `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK=1`, and `CLAUDE_CODE_USE_VERTEX=1`. For Bedrock/Vertex, configure the relevant cloud identity/region in the job as appropriate.

### Costs

Weave Router mode reports the cost from its session-cost API, including Router-side auxiliary inference. Anthropic-compatible modes use the Claude CLI's client-reported estimate when available; a gateway or cloud provider can bill differently. A missing measurement is reported as unknown, never as $0. There is no per-invocation cost ceiling.

## Check files

Put one `.md` file per criterion in a directory (the action default is `.weave-checks/`):

```markdown
---
name: Error Context
description: Requires actionable context when reporting an error
intelligence: medium
---

When changed code logs or returns an error, require enough context to identify
which operation failed without exposing secrets or user content.
```

`name`, `description`, and `intelligence` are required. Intelligence must be one of `low`, `medium`, `high`, or `maximum`; it is the only model-selection field in frontmatter. The package maps `low` to Claude Code's rolling `haiku` alias, `medium` to `sonnet`, and `high` or `maximum` to `opus`. On Weave Router, the same tier is sent as the force-cluster. Full aliases track the latest model in each family; they avoid version pins but can change behavior as Claude Code updates its alias target.

Frontmatter is a deliberately restricted, dependency-free format rather than full YAML: use one unquoted, single-line plain value per key. Quoted values, inline comments, lists/maps, tags, and block scalars are rejected instead of being silently misread.

Check filenames (without `.md`) must contain only lowercase ASCII letters, digits, and hyphens; the filename becomes the check slug and comment-history marker. A `README.md` in the checks directory is treated as documentation by default. Set `doc-files` to customize this list.

Add a `.ignore` file beside the checks to exclude repository-relative git pathspecs from every review diff, for example:

```text
# Large generated output
vendor
build/generated/*.go
```

Blank lines and `#` comments are ignored. Unsafe patterns that can exclude the whole repository or escape its root fail discovery rather than silently disabling review.

The 11 generic checks in [`starter-checks/`](starter-checks/) are available as optional defaults. Set `use-default-checks: true` to run them alongside any checks in your configured `checks-dir`; without that setting, only your directory is used. The additional checks in [`checks-library/`](checks-library/) target concerns that may make sense for some repositories but are not universal defaults; see its README before adopting any. Checks are distributed under this package's Apache-2.0 license; see [`NOTICE`](NOTICE) for attribution.

## Local CLI

Run the checks against the current working tree without GitHub access:

```sh
npx @weave-os/checks list --checks-dir .weave-checks
npx @weave-os/checks run --checks-dir .weave-checks --base origin/main
```

`run` reviews staged, unstaged, and untracked changes (but not gitignored files) relative to the merge base with `--base`, by default `origin/main` or `main` if no `origin/main` exists. Use `--head <ref>` to review a committed range instead. The local runner defaults to `provider: inherit`, loading the current user's Claude Code configuration; select `anthropic` or `weave-router` explicitly for a different provider. Router mode reads `WEAVE_ROUTER_KEY` from the environment; `WEAVE_ROUTER_URL` optionally overrides the default production host. The same router key authenticates the session-cost endpoint. Example:

```sh
export WEAVE_ROUTER_KEY="rk_..."
# Optional override for a self-hosted or staging Router:
# export WEAVE_ROUTER_URL="https://<your-router-host>"
npx @weave-os/checks run --provider weave-router --checks-dir .weave-checks --base origin/main
```

For an Anthropic-compatible gateway, for example:

```sh
WEAVE_CHECKS_PROVIDER_ENV='ANTHROPIC_BASE_URL=https://llm-gateway.example.com' \
npx @weave-os/checks run --provider anthropic --checks-dir .weave-checks --base origin/main --format markdown
```

`run` exits 1 when at least one check flags findings, 2 for invalid options or setup, and 0 when there are no findings. Use `--no-fail` to report findings without a non-zero exit. Neutral operational misses do not fail the run. `--format` supports `text`, `markdown`, and `json`; `--output <file>` writes the JSON result as well. Prompts, transcripts, and per-check results are stored in a temporary directory by default; `--artifacts-dir` keeps them at the path you choose. These artifacts contain the diff and agent output, so handle them as repository data.

`list --format json` prints the validated matrix. `print-schema` prints the result schema; `print-schema --kind resolution` and `--kind dedup` print the judge schemas.

## Workflow inputs and outputs

### Inputs

| Input                 | Default         | Purpose                                                                                                  |
| --------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `provider`            | `weave-router`  | `weave-router`, or `anthropic` (direct or any Anthropic-compatible endpoint).                            |
| `weave-router-url`    | production URL  | Router host URL for `weave-router`; defaults to `https://router.weaveos.com`.                            |
| `checks-dir`          | `.weave-checks` | Check definitions, relative to the repo root.                                                            |
| `use-default-checks`  | `false`         | Also run this package's starter checks alongside `checks-dir`.                                           |
| `doc-files`           | `README.md`     | Comma-separated Markdown files in `checks-dir` that are documentation, not checks.                       |
| `diff-base`           | `incremental`   | Incremental review after verifying a fully-reviewed ancestor, or `merge-base` for the full PR every run. |
| `concurrency`         | `16`            | Checks run at once.                                                                                      |
| `claude-code-version` | `latest`        | `@anthropic-ai/claude-code` version; pin it for reproducible reviews.                                    |
| `fail-on-findings`    | `false`         | Fail the job on findings, without changing check-run conclusions.                                        |
| `upload-diagnostics`  | `false`         | Upload prompts and transcripts as a workflow artifact.                                                   |
| `runs-on`             | `ubuntu-latest` | Runner label for the job.                                                                                |
| `timeout-minutes`     | `30`            | Job timeout.                                                                                             |

### Secrets

| Secret                                          | Purpose                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `weave-router-key`                              | Router key used for requests and session-cost lookups, only for Router mode.    |
| `anthropic-api-key` / `claude-code-oauth-token` | Anthropic credentials; provide one if the selected endpoint needs them.         |
| `provider-env`                                  | Extra `KEY=VALUE` environment for Anthropic-compatible providers, one per line. |

### Outputs

`pass`, `flagged`, `neutral`, and `total-cost`. Result counts distinguish findings (`flagged`) from operational misses (`neutral`). `total-cost` is empty when any contributing cost is unknown. Reviews are posted inline as `COMMENT` reviews; resolution and deduplication judges always run when they have work. These behaviors are fixed, not configurable. There are no per-invocation cost ceilings.

## Behavior and safety boundaries

- The action creates the aggregate check run before its repository checkout and preparation. Its always-run cleanup closes it as neutral if setup or the worker stops before closing it. The step summary is written even after setup errors.
- Both the incremental review diff and the full merge-base PR diff are prepared. Resolution judges use the full scope; incremental review is used only when the previous aggregate proves all checks read the earlier diff and the reviewed commit is an ancestor of the current head. If the base branch moves, affected files are re-diffed from the current merge base. Uncertainty widens the diff rather than skipping unseen code.
- Every child and aggregate conclusion is `success` or `neutral`. Findings are visible in comments/check summaries; only `fail-on-findings: true` makes the job fail. This does not make a GitHub check conclusion `failure`.
- Diagnostics include prompts, changed code, tool results, and transcripts. They are not uploaded by default. Enable them only if the repository's privacy and retention policy allows it.
- Tool permissions are read-only for the agent. The action and Claude Code CLI still process untrusted pull-request content; nothing in the job executes pull-request code or checks out the PR head before minting the App token.

## Releasing the workflow

Consumers pin a commit of `.github/workflows/weave-checks.yml`, and Weave's token exchange accepts only commits on its versioned allowlist. Roll a release forward in this order:

1. Merge the change to `main` and note the commit SHA.
2. Add that SHA to the exchange's allowlist and deploy it.
3. Publish the SHA in the release notes and docs.
4. Migrate consumers to the new SHA, then remove SHAs no consumer should still run.

This repository's own self-check calls the workflow from the pull request's commit, so it tests the change under review. The exchange must accept `weave-os/checks` at any commit for that to work.

## Publishing

The npm package is `@weave-os/checks`. As in the Weave Router release flow, each release starts with a version-bump PR; merging does not publish by itself. Once the version change is on `main`, pushing a `checks-v<version>` tag starts the publisher. The tag must point to a commit reachable from `main` and match `package.json` exactly.

The workflow verifies the tag/version and main ancestry, runs the tests, installs the packed tarball into a clean consumer directory and validates both bundled check collections, then publishes with provenance. It uses npm trusted publishing (OIDC), with `id-token: write` limited to the publish job; no npm token is stored in GitHub.

### One-time npm setup

npm requires a package to exist before you can configure its trusted publisher. The registry currently has no `@weave-os/checks` package, so the initial package bootstrap cannot use this OIDC workflow. After the initial release commit is on `main`, run the first publish once from a maintainer machine using npm's normal authenticated CLI flow:

```sh
npm login
npm publish --access public
```

Then immediately configure the trusted publisher in npmjs.com → `@weave-os/checks` → **Settings → Trusted Publisher**:

- Provider: GitHub Actions
- Organization: `weave-os`
- Repository: `checks`
- Workflow filename: `publish-npm.yml`
- Allow direct publishing with `npm publish` (the workflow does not use staged publishing)

Do not push a `checks-v<version>` tag for the version published manually; the workflow would correctly reject trying to publish that immutable version again. The manual bootstrap will not carry GitHub Actions provenance; subsequent tagged releases will. Revoke any temporary npm token after the bootstrap. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for current requirements.

### Release a version after setup

1. Update `version` in `package.json` in a PR. Use the normal test checks and merge the bump to `main`.
2. From an up-to-date local `main`, create and push an annotated tag for that exact version:

   ```sh
   version="$(node -p "require('./package.json').version")"
   git tag -a "checks-v${version}" -m "Release checks v${version}"
   git push origin "checks-v${version}"
   ```

3. Follow the **Publish npm** workflow in GitHub Actions. A failed run does not publish; fix the issue and rerun it, or publish a new version if that version already reached npm.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
