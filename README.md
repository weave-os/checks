# Weave Checks

[![Tests](https://github.com/weave-os/checks/actions/workflows/test.yml/badge.svg)](https://github.com/weave-os/checks/actions/workflows/test.yml)

Advisory, per-concern code review for GitHub pull requests. Write one Markdown file for each review concern; Weave Checks runs a read-only agent against each check's criteria and the pull request's changed lines. Findings appear as review comments or on the check run. Operational misses stay neutral instead of masquerading as a pass or a finding.

This repository contains the reusable GitHub Action, the `@weave-os/checks` local CLI/package, and a small set of generic starter checks. **Your check definitions remain in your repository**: the action does not impose a universal coding policy.

> The generic starter-check corpus and per-concern review format adapt material and design from [Continue Checks](https://github.com/continuedev/checks), Copyright 2025 Continue Dev, Inc., Apache-2.0. See [`NOTICE`](NOTICE) for attribution and [`LICENSE`](LICENSE) for this package's license.

## GitHub Action

```yaml
name: AI review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  id-token: write

jobs:
  checks:
    # Pull requests from forks get no OIDC token, so the action cannot
    # authenticate for them. Never switch to pull_request_target to work around it.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name: Run Weave Checks
        uses: weave-os/checks@v1
        with:
          provider: anthropic
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          checks-dir: .weave-checks
```

### Setup: install the Weave Checks App

Check runs, reviews, and replies always come from the **Weave Checks** GitHub App. The action never posts as `github-actions[bot]`, and you never handle an App key.

1. **Install the App.** Open [github.com/apps/weave-checks](https://github.com/apps/weave-checks/installations/new), choose your organization, and select the repositories that will run Weave Checks. The App needs Checks and Pull requests write access for check runs and reviews, plus Contents write so it can resolve review threads. GitHub gates `resolveReviewThread` behind Contents write even though it changes no repository files. The action uses a repository-scoped installation token and never asks Claude to use it, but the token itself has permission to write repository contents.
2. **Grant `id-token: write`** in the workflow, as in the example above. The job's own `GITHUB_TOKEN` needs no write access; `contents: read` is only for checkout.
3. **Pass your model provider credentials** as inputs (see [Provider setup](#provider-setup)). Composite actions cannot read your secrets unless you pass them in.

**How the action authenticates:** at the start of the job it requests a GitHub OIDC token with the audience `weave-checks`. That token is GitHub's signed statement of which repository and workflow is running. The action sends it to Weave, which checks it and returns a Weave Checks App installation token. Weave takes the repository from the OIDC token's signed claims, not from anything in the request. The returned token is scoped to that one repository with the App's review permissions, and it expires within an hour. The action uses it for every GitHub call and revokes it when the job finishes.

**If authentication fails, the job stops before creating any check run,** with one of these explanations:

- **`id-token: write` is missing**, or the pull request comes from a fork. Forks never receive OIDC tokens; skip them with the `if:` shown above. **Do not use `pull_request_target`** to work around this, since it would give an agent reading fork-controlled code your secrets.
- **The App is not installed** on the repository's owner, or not on this repository. Add it from the App's installation settings.
- **The pull request changes the workflow file that runs Weave Checks.** Weave refuses to issue a token for it, so a pull request cannot rewrite the job that holds the App token. Checks run normally again once the change merges.

### Provider setup

The action defaults to `provider: anthropic`. It supports either an Anthropic API key, Claude Code OAuth credentials, or any Anthropic-compatible endpoint configured through `provider-env`. Example for a gateway:

```yaml
      - uses: weave-os/checks@v1
        with:
          provider: anthropic
          provider-env: |
            ANTHROPIC_BASE_URL=https://llm-gateway.example.com
            ANTHROPIC_CUSTOM_HEADERS=X-Workspace: code-review
```

If the gateway needs a secret, pass it through `provider-env` from a GitHub Actions secret. The value is set only on the agent process. Other examples include `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_USE_BEDROCK=1`, and `CLAUDE_CODE_USE_VERTEX=1`. For Bedrock/Vertex, configure the relevant cloud identity/region in the job as appropriate.

For **Weave Router**, set repository or organization secrets named `WEAVE_ROUTER_KEY` and `WEAVE_API_KEY`, then pass both explicitly:

```yaml
      - uses: weave-os/checks@v1
        with:
          provider: weave-router
          weave-router-key: ${{ secrets.WEAVE_ROUTER_KEY }}
          weave-api-key: ${{ secrets.WEAVE_API_KEY }}
          allowed-intelligence: low,medium,high,maximum
```

Router mode requires an `intelligence` value on every check and both secrets. The intelligence tier also becomes the Router force-cluster; the model alias is derived from the same value. The Weave API key is never passed to an agent. Anthropic-compatible modes do **not** require either Weave key.

### Costs

- `weave-router`: cost comes from Weave's session-cost API. It is Router-reported and includes Router-side auxiliary inference. Both Router credentials are required to report that cost.
- `anthropic` and `inherit`: cost comes from the Claude CLI's `total_cost_usd`, when available. This is the CLI's **client-reported estimate**, not provider-billed cost; a gateway or cloud provider can bill differently. A missing measurement is reported as unknown, never as $0.

The main review has a CLI-enforced `review-budget` ceiling. The resolution and dedup judges each have their own budget. This ceiling uses the CLI's own estimate; it cannot cap auxiliary costs recorded by a Router or a third-party provider.

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

`name`, `description`, and `intelligence` are required. Intelligence must be one of `low`, `medium`, `high`, or `maximum`; it is the only model-selection field in frontmatter. The package maps `low` to Claude Code's rolling `haiku` alias, `medium` to `sonnet`, and `high` or `maximum` to `opus`. On Weave Router, the same tier is sent as the force-cluster. Full aliases track the latest model in each family; they avoid version pins but can change behavior as Claude Code updates its alias target. The action's `allowed-intelligence` input can restrict the accepted tiers.

Frontmatter is a deliberately restricted, dependency-free format rather than full YAML: use one unquoted, single-line plain value per key. Quoted values, inline comments, lists/maps, tags, and block scalars are rejected instead of being silently misread.

Check filenames (without `.md`) must contain only lowercase ASCII letters, digits, and hyphens; the filename becomes the check slug and comment-history marker. A `README.md` in the checks directory is treated as documentation by default. Set `doc-files` to customize this list.

Add a `.ignore` file beside the checks to exclude repository-relative git pathspecs from every review diff, for example:

```text
# Large generated output
vendor
build/generated/*.go
```

Blank lines and `#` comments are ignored. Unsafe patterns that can exclude the whole repository or escape its root fail discovery rather than silently disabling review.

The 14 generic checks in [`starter-checks/`](starter-checks/) are examples to copy and adapt. They are not automatically imposed by the action. Starter checks are distributed under this package's Apache-2.0 license; see [`NOTICE`](NOTICE) for attribution.

## Local CLI

Run the checks against the current working tree without GitHub access:

```sh
npx @weave-os/checks list --checks-dir .weave-checks
npx @weave-os/checks run --checks-dir .weave-checks --base origin/main
```

`run` reviews staged, unstaged, and untracked changes (but not gitignored files) relative to the merge base with `--base`, by default `origin/main` or `main` if no `origin/main` exists. Use `--head <ref>` to review a committed range instead. The local runner defaults to `provider: inherit`, loading the current user's Claude Code configuration; select `anthropic` or `weave-router` explicitly for a different provider. Router mode reads `WEAVE_ROUTER_KEY` and `WEAVE_API_KEY` from the environment. Example:

```sh
WEAVE_CHECKS_PROVIDER=anthropic \
WEAVE_CHECKS_PROVIDER_ENV='ANTHROPIC_BASE_URL=https://llm-gateway.example.com' \
npx @weave-os/checks run --checks-dir .weave-checks --base origin/main --format markdown
```

`run` exits 1 when at least one check flags findings, 2 for invalid options or setup, and 0 when there are no findings. Use `--no-fail` to report findings without a non-zero exit. Neutral operational misses do not fail the run. `--format` supports `text`, `markdown`, and `json`; `--output <file>` writes the JSON result as well. Prompts, transcripts, and per-check results are stored in a temporary directory by default; `--artifacts-dir` keeps them at the path you choose. These artifacts contain the diff and agent output, so handle them as repository data.

`list --format json` prints the validated matrix. `print-schema` prints the result schema; `print-schema --kind resolution` and `--kind dedup` print the judge schemas.

## Action inputs and outputs

### Key inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `provider` | `anthropic` | `anthropic` (direct/compatible endpoint) or `weave-router`. |
| `anthropic-api-key` / `claude-code-oauth-token` | empty | Anthropic credentials; provide one if the selected endpoint needs them. |
| `provider-env` | empty | Extra `KEY=VALUE` environment for Anthropic-compatible providers. |
| `weave-router-key` / `weave-api-key` | empty | The two required Router credentials, only for Router mode. |
| `checks-dir` | `.weave-checks` | Check definitions, relative to the repo root. |
| `allowed-intelligence` | empty | Optional comma-separated allowlist: `low`, `medium`, `high`, `maximum`. |
| `diff-base` | `incremental` | Incremental review after verifying a fully-reviewed ancestor, or `merge-base` for the full PR every run. |
| `inline-comments` | `true` | Post suggestions as review comments; otherwise list them in the check-run summary. |
| `resolution-judge` / `dedup-judge` | `true` | Resolve old findings and suppress duplicates. |
| `fail-on-findings` | `false` | Fail the final action step on findings, without changing check-run conclusions. |
| `upload-diagnostics` | `false` | Opt in to uploading prompts and transcripts as a workflow artifact. |
| `checkout` | `true` | Check out the PR merge ref. Set false if the calling job already checked out the PR. |

Other inputs configure concurrency, three budgets, review event, the dedup judge's rolling alias and cluster, Node and Claude CLI versions, documentation filenames, and product/check-run/aggregate/marker branding. See [`action.yml`](action.yml) for the complete reference.

### Outputs

`aggregate-check-run-id`, `pass`, `flagged`, `neutral`, `total-cost`, `review-base`, `summary-path`, and `results-path`. Result counts distinguish findings (`flagged`) from operational misses (`neutral`). `total-cost` is empty when any contributing cost is unknown. The JSON at `results-path` contains per-check results and the same totals.

## Behavior and safety boundaries

- The action creates the aggregate check run before its optional repository checkout and preparation. Its always-run cleanup closes it as neutral if setup or the worker stops before closing it. The step summary is written even after setup errors.
- Both the incremental review diff and the full merge-base PR diff are prepared. Resolution judges use the full scope; incremental review is used only when the previous aggregate proves all checks read the earlier diff and the reviewed commit is an ancestor of the current head. If the base branch moves, affected files are re-diffed from the current merge base. Uncertainty widens the diff rather than skipping unseen code.
- Every child and aggregate conclusion is `success` or `neutral`. Findings are visible in comments/check summaries; only `fail-on-findings: true` makes the final action step fail. This does not make a GitHub check conclusion `failure`.
- Markers are written with the configured prefix. The reader also recognizes legacy `weave-check` markers so existing comments remain in history after a rebrand.
- Diagnostics include prompts, changed code, tool results, and transcripts. They are not uploaded by default. Enable them only if the repository's privacy and retention policy allows it.
- Tool permissions are read-only for the agent. The action and Claude Code CLI still process untrusted pull-request content; grant only the necessary workflow permissions and avoid exposing unrelated credentials.

## Publishing

The npm package is `@weave-os/checks`. As in the Weave Router release flow, each release starts with a version-bump PR; merging does not publish by itself. Once the version change is on `main`, pushing a `checks-v<version>` tag starts the publisher. The tag must point to a commit reachable from `main` and match `package.json` exactly.

The workflow verifies the tag/version and main ancestry, runs the tests, installs the packed tarball into a clean consumer directory and validates the bundled starter checks, then publishes with provenance. It uses npm trusted publishing (OIDC), with `id-token: write` limited to the publish job; no npm token is stored in GitHub.

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
- Workflow filename: `publish_npm.yml`
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
