// A minimal GitHub REST client for the action's own steps (aggregate
// creation and cleanup, PR preparation), on the same retrying transport the
// worker uses, so every call the action makes rides out the same transient
// 5xx and secondary-rate-limit windows.

import { requestWithRetry, truncateBody } from "./githubapi.mjs";

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export function createGitHubClient({
  apiUrl = "https://api.github.com",
  token,
  fetchFn = fetch,
  sleepFn = undefined,
  logFn = undefined,
}) {
  if (typeof token !== "string" || token === "") {
    throw new Error("a GitHub token is required (the action's github-token input)");
  }
  const transport = {
    fetchFn,
    ...(sleepFn === undefined ? {} : { sleepFn }),
    ...(logFn === undefined ? {} : { logFn }),
  };
  return async function rest(method, apiPath, body = undefined) {
    const response = await requestWithRetry(
      `${apiUrl}/${apiPath}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { label: `${method} ${apiPath}`, ...transport },
    );
    if (!response.ok) {
      throw new GitHubError(
        `${method} ${apiPath}: ${response.status} ${truncateBody(response.text)} (after ${response.attempts} attempt(s))`,
        response.status,
      );
    }
    if (response.text === "") return null;
    try {
      return JSON.parse(response.text);
    } catch (error) {
      throw new GitHubError(
        `${method} ${apiPath}: ${response.status} response was not valid JSON (${error.message}): ${truncateBody(response.text)}`,
        response.status,
      );
    }
  };
}

// Explains the 403 every fork PR produces: `pull_request` runs from a fork
// get a read-only GITHUB_TOKEN, and a composite action cannot grant itself
// more. Appended to errors from write calls so the log says what to fix.
export function permissionHint(error) {
  if (!(error instanceof GitHubError) || (error.status !== 403 && error.status !== 404)) return "";
  return (
    " -- the token needs `checks: write` and `pull-requests: write` (grant them in the calling" +
    " workflow's `permissions:`). Pull requests from forks get a read-only GITHUB_TOKEN under" +
    " `pull_request`; skip them with an `if:` on the job."
  );
}
