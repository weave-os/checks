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
  checks: write
  pull-requests: write

jobs:
  checks:
    # A pull_request job from a fork receives a read-only GITHUB_TOKEN. This
    # example skips forks; adopters should choose and document their own safe
    # fork policy. Never switch to pull_request_target to work around it.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name: Run Weave Checks
        uses: weave-os/checks@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          provider: anthropic
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          checks-dir: .weave-checks
```

### Permissions, tokens, and forks

A composite action **cannot grant GitHub permissions** and **cannot read the caller's secrets unless the caller passes them in**. The workflow job must grant `checks: write` to create and update check runs, `pull-requests: write` to post inline review comments and manage review threads, and `contents: read` to check out the repository. Pass a token explicitly using the `github-token` input; its default is `${{ github.token }}`. Add permission and explicitly pass any provider credentials the selected mode needs.

For `pull_request` events from forks, GitHub gives `GITHUB_TOKEN` read-only access and withholds repository secrets. A write failure is expected in that case. The example skips fork PRs; maintainers who choose a different fork policy must weigh access against the risk of exposing credentials to untrusted changes. **Do not use `pull_request_target`** to give an agent access to secrets while it reads fork-controlled code.

### Provider setup

The action defaults to `provider: anthropic`. It supports either an Anthropic API key, Claude Code OAuth credentials, or any Anthropic-compatible endpoint configured through `provider-env`. Example for a gateway:

```yaml
      - uses: weave-os/checks@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
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
          github-token: ${{ secrets.GITHUB_TOKEN }}
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
| `github-token` | `${{ github.token }}` | Token for check runs and pull-request reviews; caller must grant permissions. |
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

The npm package is `@weave-os/checks`. Git tags use `checks-v<version>` and must point to a commit reachable from `main` with a matching `package.json` version. Publishing uses npm trusted publishing (OIDC), not a long-lived npm token. Before the first release, configure npmjs.com → `@weave-os/checks` → **Trusted Publisher** with:

- Provider: GitHub Actions
- Organization: `weave-os`
- Repository: `checks`
- Workflow filename: `publish_npm.yml`

The release workflow verifies the tag/version and main ancestry, runs the test suite, then publishes with provenance. The repository owner must complete the npm trusted-publisher setup; this project does not attempt to publish automatically outside the tagged workflow.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
