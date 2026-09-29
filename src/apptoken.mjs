// The action's only GitHub identity: a Weave Checks GitHub App installation
// token, obtained without the calling repository holding any App secret.
//
//   1. Ask GitHub Actions for an OIDC ID token with the Weave Checks audience.
//      The job needs `permissions: id-token: write`; the token is GitHub's
//      signed statement of which repository, workflow, and ref is running.
//   2. Send it to Weave's token exchange. Weave verifies the signature and
//      claims, finds the Weave Checks App's installation on that repository,
//      and mints an installation token scoped to that one repository with the
//      App's review permissions. The App's private key never leaves Weave.
//   3. Use that token for every GitHub call, then revoke it when the job ends.
//
// There is deliberately no fallback to GITHUB_TOKEN: check runs and review
// comments must come from the Weave Checks App or not at all.

import { requestWithRetry, truncateBody } from "./githubapi.mjs";

// The `aud` claim Weave's exchange accepts. Distinct from every other Weave
// OIDC use so a token minted for Weave Checks can never be replayed elsewhere.
export const OIDC_AUDIENCE = "weave-checks";

export const DEFAULT_TOKEN_EXCHANGE_URL = "https://app.weaveos.com/api/v1/checks/github-token";

// Where to install the App, named in every error that means "not installed".
export const APP_INSTALL_URL = "https://github.com/apps/weave-checks/installations/new";

// The exchange's documented refusal codes. Anything else is reported verbatim.
export const EXCHANGE_ERROR = Object.freeze({
  INVALID_TOKEN: "invalid_oidc_token",
  NOT_INSTALLED: "app_not_installed",
  REPOSITORY_NOT_SELECTED: "repository_not_selected",
  WORKFLOW_CHANGED: "workflow_file_changed",
  NOT_ALLOWED: "repository_not_allowed",
});

export class TokenExchangeError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "TokenExchangeError";
    this.status = status;
    this.code = code;
  }
}

// Requests the OIDC ID token from the runner's token service. Both variables
// are set by GitHub Actions only when the job grants `id-token: write`.
export async function requestOidcToken({
  env,
  audience = OIDC_AUDIENCE,
  fetchFn = fetch,
  sleepFn = undefined,
  logFn = undefined,
}) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new TokenExchangeError(
      "GitHub did not offer this job an OIDC token. Add `id-token: write` to the job's `permissions:`. " +
        "Pull requests from forks never receive one; skip them with an `if:` on the job.",
    );
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const response = await requestWithRetry(
    url.toString(),
    { headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" } },
    { label: "GET OIDC token", fetchFn, ...(sleepFn ? { sleepFn } : {}), ...(logFn ? { logFn } : {}) },
  );
  if (!response.ok) {
    throw new TokenExchangeError(
      `GitHub refused the OIDC token request: HTTP ${response.status} ${truncateBody(response.text)}`,
      { status: response.status },
    );
  }
  let value;
  try {
    value = JSON.parse(response.text).value;
  } catch {
    value = undefined;
  }
  if (typeof value !== "string" || value === "") {
    throw new TokenExchangeError("GitHub's OIDC response carried no token");
  }
  return value;
}

// What to tell a user who hit a documented refusal. Keyed by EXCHANGE_ERROR.
function refusalHint(code) {
  switch (code) {
    case EXCHANGE_ERROR.NOT_INSTALLED:
      return ` Install the Weave Checks GitHub App on this repository's owner: ${APP_INSTALL_URL}`;
    case EXCHANGE_ERROR.REPOSITORY_NOT_SELECTED:
      return " The Weave Checks App is installed, but not on this repository. Add it under the installation's repository access.";
    case EXCHANGE_ERROR.WORKFLOW_CHANGED:
      return " This pull request changes the workflow that runs Weave Checks, so Weave will not issue a token for it. Checks run again once the change merges.";
    case EXCHANGE_ERROR.NOT_ALLOWED:
      return " This repository is not enabled for Weave Checks. Contact Weave to enable it.";
    default:
      return "";
  }
}

// Trades the OIDC token for a Weave Checks App installation token. Returns
// `{ token, expiresAt, repository }`. Transient failures are retried by the
// shared transport; every refusal is a TokenExchangeError carrying Weave's
// error code, so the caller can tell "fix your setup" from "try again later".
export async function exchangeForAppToken({
  oidcToken,
  exchangeUrl = DEFAULT_TOKEN_EXCHANGE_URL,
  fetchFn = fetch,
  sleepFn = undefined,
  logFn = undefined,
}) {
  const response = await requestWithRetry(
    exchangeUrl,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${oidcToken}`, Accept: "application/json" },
    },
    { label: "POST Weave Checks token exchange", fetchFn, ...(sleepFn ? { sleepFn } : {}), ...(logFn ? { logFn } : {}) },
  );
  let body = null;
  try {
    body = JSON.parse(response.text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code = typeof body?.code === "string" ? body.code : null;
    const message = typeof body?.message === "string" ? body.message : truncateBody(response.text);
    throw new TokenExchangeError(
      `Weave refused the Weave Checks token exchange (HTTP ${response.status}${code ? `, ${code}` : ""}): ${message}.${refusalHint(code)}`,
      { status: response.status, code },
    );
  }
  if (typeof body?.token !== "string" || body.token === "") {
    throw new TokenExchangeError("Weave's token exchange response carried no token", { status: response.status });
  }
  return { token: body.token, expiresAt: body.expires_at ?? null, repository: body.repository ?? null };
}

// Revokes the installation token so it cannot outlive the job. Best-effort:
// it expires within an hour regardless, so a failure is reported, not raised.
export async function revokeAppToken({ token, apiUrl = "https://api.github.com", fetchFn = fetch }) {
  try {
    const response = await fetchFn(`${apiUrl}/installation/token`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    return { revoked: response.status === 204, status: response.status };
  } catch (error) {
    return { revoked: false, status: null, error: error.message ?? String(error) };
  }
}
