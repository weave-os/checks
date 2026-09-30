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
    throw new Error("a Weave Checks App token is required (minted by the action's first step)");
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

// Explains a 403/404 on a write call. The token is the Weave Checks App's, so
// the fix is on the App installation, never the workflow's `permissions:`.
export function permissionHint(error) {
  if (!(error instanceof GitHubError) || (error.status !== 403 && error.status !== 404)) return "";
  return (
    " -- the Weave Checks App needs Checks and Pull requests write access on this repository." +
    " If its permissions changed, an organization owner must approve the update on the installation."
  );
}
