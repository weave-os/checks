import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APP_INSTALL_URL,
  EXCHANGE_ERROR,
  OIDC_AUDIENCE,
  TokenExchangeError,
  exchangeForAppToken,
  requestOidcToken,
  revokeAppToken,
} from "./apptoken.mjs";

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () =>
      body === undefined ? ""
      : typeof body === "string" ? body
      : JSON.stringify(body),
  };
}

function recordingFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  fn.calls = calls;
  return fn;
}

const quiet = { sleepFn: async () => {}, logFn: () => {} };

describe("requestOidcToken", () => {
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/request?api-version=2.0",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-token",
  };

  it("requests a token for the Weave Checks audience with the runtime bearer", async () => {
    const fetchFn = recordingFetch([reply(200, { value: "oidc.jwt" })]);

    assert.equal(await requestOidcToken({ env, fetchFn, ...quiet }), "oidc.jwt");

    const url = new URL(fetchFn.calls[0].url);
    assert.equal(url.searchParams.get("audience"), OIDC_AUDIENCE);
    assert.equal(url.searchParams.get("api-version"), "2.0");
    assert.equal(fetchFn.calls[0].init.headers.Authorization, "Bearer runtime-token");
    assert.equal(OIDC_AUDIENCE, "weave-checks");
  });

  // No fallback identity: a job without id-token: write (or a fork PR) must
  // fail with instructions, not quietly post as some other account.
  it("explains the missing id-token permission", async () => {
    await assert.rejects(
      requestOidcToken({ env: {}, fetchFn: recordingFetch([]) }),
      error =>
        error instanceof TokenExchangeError &&
        /id-token: write/.test(error.message) &&
        /forks/.test(error.message),
    );
  });

  it("rejects an OIDC response with no token", async () => {
    await assert.rejects(
      requestOidcToken({ env, fetchFn: recordingFetch([reply(200, {})]), ...quiet }),
      /carried no token/,
    );
  });
});

describe("exchangeForAppToken", () => {
  it("posts the OIDC token as a bearer and returns the installation token", async () => {
    const fetchFn = recordingFetch([
      reply(200, {
        token: "ghs_app",
        expires_at: "2026-09-29T12:00:00Z",
        repository: "acme/widgets",
      }),
    ]);

    const result = await exchangeForAppToken({
      oidcToken: "oidc.jwt",
      exchangeUrl: "https://weave.test/x",
      fetchFn,
      ...quiet,
    });

    assert.deepEqual(result, {
      token: "ghs_app",
      expiresAt: "2026-09-29T12:00:00Z",
      repository: "acme/widgets",
    });
    assert.equal(fetchFn.calls[0].url, "https://weave.test/x");
    assert.equal(fetchFn.calls[0].init.method, "POST");
    assert.equal(fetchFn.calls[0].init.headers.Authorization, "Bearer oidc.jwt");
    // The OIDC token is the only input: the repository comes from its signed
    // claims on Weave's side, never from a request field the caller controls.
    assert.equal(fetchFn.calls[0].init.body, undefined);
  });

  it("tells the user to install the App when it is not installed", async () => {
    const fetchFn = recordingFetch([
      reply(404, {
        code: EXCHANGE_ERROR.NOT_INSTALLED,
        message: "The Weave Checks App is not installed for acme",
      }),
    ]);

    await assert.rejects(
      exchangeForAppToken({ oidcToken: "t", fetchFn, ...quiet }),
      error =>
        error instanceof TokenExchangeError &&
        error.code === EXCHANGE_ERROR.NOT_INSTALLED &&
        error.message.includes(APP_INSTALL_URL),
    );
  });

  it("explains a repository missing from the installation and a changed workflow", async () => {
    for (const [code, hint] of [
      [EXCHANGE_ERROR.REPOSITORY_NOT_SELECTED, /not on this repository/],
      [EXCHANGE_ERROR.WORKFLOW_CHANGED, /changes the workflow/],
      [EXCHANGE_ERROR.NOT_ALLOWED, /not enabled for Weave Checks/],
    ]) {
      await assert.rejects(
        exchangeForAppToken({
          oidcToken: "t",
          fetchFn: recordingFetch([reply(403, { code, message: "no" })]),
          ...quiet,
        }),
        error => error.code === code && hint.test(error.message),
        code,
      );
    }
  });

  it("retries a transient 5xx and then succeeds", async () => {
    const fetchFn = recordingFetch([reply(503, "unavailable"), reply(200, { token: "ghs_app" })]);

    const { token } = await exchangeForAppToken({ oidcToken: "t", fetchFn, ...quiet });

    assert.equal(token, "ghs_app");
    assert.equal(fetchFn.calls.length, 2);
  });

  it("does not retry a refusal", async () => {
    const fetchFn = recordingFetch([
      reply(401, { code: EXCHANGE_ERROR.INVALID_TOKEN, message: "bad audience" }),
    ]);

    await assert.rejects(
      exchangeForAppToken({ oidcToken: "t", fetchFn, ...quiet }),
      /invalid_oidc_token/,
    );
    assert.equal(fetchFn.calls.length, 1);
  });

  it("rejects a success response with no token", async () => {
    await assert.rejects(
      exchangeForAppToken({ oidcToken: "t", fetchFn: recordingFetch([reply(200, {})]), ...quiet }),
      /carried no token/,
    );
  });
});

describe("revokeAppToken", () => {
  it("revokes the installation token with a DELETE", async () => {
    const fetchFn = recordingFetch([reply(204)]);

    assert.deepEqual(
      await revokeAppToken({ token: "ghs_app", apiUrl: "https://api.test", fetchFn }),
      { revoked: true, status: 204 },
    );
    assert.equal(fetchFn.calls[0].url, "https://api.test/installation/token");
    assert.equal(fetchFn.calls[0].init.method, "DELETE");
    assert.equal(fetchFn.calls[0].init.headers.Authorization, "Bearer ghs_app");
  });

  it("reports rather than throws when revocation fails", async () => {
    const outcome = await revokeAppToken({
      token: "t",
      fetchFn: async () => {
        throw new Error("offline");
      },
    });
    assert.deepEqual(outcome, { revoked: false, status: null, error: "offline" });
  });
});
