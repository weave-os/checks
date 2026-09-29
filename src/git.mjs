// The one way this package runs git: an argument array through spawnSync,
// never a shell string, so a path or ref can never be re-parsed as syntax.
//
// Output is returned as the raw Buffer git wrote. Diffs and stats are handed
// to agents and to parseAddedLines() byte-for-byte: trimming would drop the
// final newline and any significant trailing whitespace, and decoding then
// re-encoding would mangle a non-UTF-8 file's hunk.

import { spawnSync } from "node:child_process";

// Diffs of large PRs routinely exceed Node's 1 MiB default buffer, and a
// truncated diff would silently review less than the PR changed.
const MAX_BUFFER_BYTES = 512 * 1024 * 1024;

export class GitError extends Error {
  constructor(args, result) {
    const stderr = result.stderr?.toString("utf8").trim() ?? "";
    super(
      `git ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`})${stderr === "" ? "" : `: ${stderr}`}`,
    );
    this.name = "GitError";
    this.status = result.status;
    this.stderr = stderr;
  }
}

// Runs `git <args>` in `cwd` and returns stdout as a Buffer. Throws GitError
// on a non-zero exit unless `allowFailure`, in which case it returns null.
// `env` is merged over process.env (e.g. GIT_INDEX_FILE for a scratch index).
export function git(args, { cwd, env = undefined, allowFailure = false, input = undefined } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: env === undefined ? process.env : { ...process.env, ...env },
    input,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (result.error !== undefined || result.status !== 0) {
    if (allowFailure) return null;
    throw new GitError(args, result);
  }
  return result.stdout;
}

// `git` for callers that want text: one line of output, trailing newline
// removed. Only for refs, SHAs, and paths -- never for diff content.
export function gitLine(args, options) {
  const out = git(args, options);
  return out === null ? null : out.toString("utf8").replace(/\n$/, "");
}
