import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isRetryableGraphQLBody,
  isRetryableGraphQLErrors,
  isRetryableStatus,
  requestWithRetry,
  retryAfterMs,
  truncateBody,
} from "./githubapi.mjs";

const URL_UNDER_TEST = "https://api.github.com/repos/o/r/check-runs/1";

// A ladder with non-zero delays so a test can prove sleeps happen, short
// enough that a stubbed sleepFn makes the suite instant either way.
const FAST_LADDER = [0, 1, 2, 3];

function headers(entries = {}) {
  const lowered = new Map(
    Object.entries(entries).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
  return { get: (name) => lowered.get(name.toLowerCase()) ?? null };
}

function response(status, body = "", headerEntries = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(headerEntries),
    text: async () => body,
  };
}

// Plays back a scripted list of outcomes. An Error entry is thrown (transport
// failure); anything else is returned as the response. The last entry repeats,
// so a test only has to script up to the point it cares about.
function fakeFetch(outcomes) {
  let calls = 0;
  const fn = async () => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
    calls += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  fn.callCount = () => calls;
  return fn;
}

function recorder() {
  const slept = [];
  const logged = [];
  return {
    slept,
    logged,
    sleepFn: async (ms) => {
      slept.push(ms);
    },
    logFn: (message) => {
      logged.push(message);
    },
  };
}

describe("isRetryableStatus", () => {
  it("retries the transient classes", () => {
    for (const status of [408, 429, 500, 502, 503, 504, 599]) {
      assert.equal(isRetryableStatus(status), true, `status ${status}`);
    }
  });

  it("does not retry a permanent answer", () => {
    for (const status of [400, 401, 404, 409, 410, 422]) {
      assert.equal(isRetryableStatus(status), false, `status ${status}`);
    }
  });

  // The distinction that matters most: a secondary-rate-limit 403 is worth
  // another attempt, a permissions 403 never is. Retrying the latter would burn
  // the whole ladder on an answer that cannot change.
  it("retries a secondary-rate-limit 403 but not a permissions 403", () => {
    assert.equal(
      isRetryableStatus(
        403,
        '{"message":"You have exceeded a secondary rate limit."}',
      ),
      true,
    );
    assert.equal(
      isRetryableStatus(
        403,
        '{"message":"Resource not accessible by integration"}',
      ),
      false,
    );
  });
});

describe("isRetryableGraphQLErrors", () => {
  it("recognizes GitHub's transient GraphQL failures", () => {
    assert.equal(
      isRetryableGraphQLErrors([
        { message: "Something went wrong while executing your query." },
      ]),
      true,
    );
    assert.equal(isRetryableGraphQLErrors([{ type: "RATE_LIMITED" }]), true);
    assert.equal(
      isRetryableGraphQLErrors([
        { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." },
      ]),
      true,
    );
  });

  it("treats a real query error as permanent", () => {
    assert.equal(
      isRetryableGraphQLErrors([
        { type: "NOT_FOUND", message: "Could not resolve to a node" },
      ]),
      false,
    );
    assert.equal(isRetryableGraphQLErrors([]), false);
    assert.equal(isRetryableGraphQLErrors(undefined), false);
  });
});

describe("isRetryableGraphQLBody", () => {
  it("retries a 200 that is not JSON at all", () => {
    // GitHub serving an HTML error page through the GraphQL route. This is the
    // one place "unparseable" means "try again" rather than "broken contract".
    assert.equal(isRetryableGraphQLBody("<html>unicorn</html>"), true);
  });

  it("does not retry a successful payload", () => {
    assert.equal(
      isRetryableGraphQLBody(JSON.stringify({ data: { repository: {} } })),
      false,
    );
  });
});

describe("retryAfterMs", () => {
  it("prefers an explicit Retry-After over the ladder", () => {
    assert.equal(retryAfterMs(headers({ "Retry-After": "7" })), 7000);
  });

  it("clamps a long wait rather than parking the runner", () => {
    assert.equal(retryAfterMs(headers({ "Retry-After": "3600" })), 60_000);
  });

  it("reads the primary rate-limit reset when there is no Retry-After", () => {
    const nowMs = 1_700_000_000_000;
    const resetEpochSeconds = nowMs / 1000 + 10;
    assert.equal(
      retryAfterMs(
        headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetEpochSeconds),
        }),
        nowMs,
      ),
      10_000,
    );
  });

  it("ignores a reset that is not actually exhausted or already past", () => {
    const nowMs = 1_700_000_000_000;
    assert.equal(
      retryAfterMs(
        headers({
          "x-ratelimit-remaining": "42",
          "x-ratelimit-reset": String(nowMs / 1000 + 10),
        }),
        nowMs,
      ),
      null,
    );
    assert.equal(
      retryAfterMs(
        headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(nowMs / 1000 - 10),
        }),
        nowMs,
      ),
      null,
    );
    assert.equal(retryAfterMs(headers()), null);
  });
});

describe("truncateBody", () => {
  it("leaves a short body alone and bounds a long one", () => {
    assert.equal(truncateBody('{"message":"nope"}'), '{"message":"nope"}');
    const truncated = truncateBody("x".repeat(1000), 100);
    assert.ok(truncated.startsWith("x".repeat(100)));
    assert.match(truncated, /900 more chars/);
    assert.equal(truncateBody(undefined), "");
  });
});

describe("requestWithRetry", () => {
  // The exact failure this module exists for: a 503 on a check-run PATCH
  // that used to be fatal for every check in the run.
  it("retries a 503 and returns the eventual success", async () => {
    const fetchFn = fakeFetch([
      response(503, '{"message": "No server is currently available"}'),
      response(503, '{"message": "No server is currently available"}'),
      response(200, '{"id": 1}'),
    ]);
    const { sleepFn, logFn, slept } = recorder();
    const result = await requestWithRetry(
      URL_UNDER_TEST,
      { method: "PATCH" },
      { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.text, '{"id": 1}');
    assert.equal(result.attempts, 3);
    assert.equal(fetchFn.callCount(), 3);
    assert.equal(slept.length, 2);
  });

  it("returns a permanent 4xx immediately without retrying", async () => {
    const fetchFn = fakeFetch([response(422, '{"message": "Validation Failed"}')]);
    const { sleepFn, logFn, slept } = recorder();
    const result = await requestWithRetry(
      URL_UNDER_TEST,
      { method: "POST" },
      { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.attempts, 1);
    assert.equal(fetchFn.callCount(), 1);
    assert.deepEqual(slept, []);
  });

  it("gives the caller the last retryable response when the ladder runs out", async () => {
    const fetchFn = fakeFetch([response(503, "down")]);
    const { sleepFn, logFn } = recorder();
    const result = await requestWithRetry(
      URL_UNDER_TEST,
      { method: "PATCH" },
      { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
    );
    // Resolves rather than throws: the caller (worker.mjs's github()) owns the
    // error message, and a status is information the transport shouldn't eat.
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.attempts, FAST_LADDER.length);
    assert.equal(fetchFn.callCount(), FAST_LADDER.length);
  });

  it("retries a transport failure and throws only when none ever lands", async () => {
    const fetchFn = fakeFetch([new Error("ECONNRESET")]);
    const { sleepFn, logFn } = recorder();
    await assert.rejects(
      requestWithRetry(
        URL_UNDER_TEST,
        { method: "GET" },
        {
          fetchFn,
          sleepFn,
          logFn,
          retryDelaysMs: FAST_LADDER,
          label: "GET repos/o/r",
        },
      ),
      /GET repos\/o\/r: no response from GitHub after 4 attempt\(s\): ECONNRESET/,
    );
    assert.equal(fetchFn.callCount(), FAST_LADDER.length);
  });

  it("recovers when a transport failure is followed by a response", async () => {
    const fetchFn = fakeFetch([new Error("EAI_AGAIN"), response(200, "{}")]);
    const { sleepFn, logFn } = recorder();
    const result = await requestWithRetry(
      URL_UNDER_TEST,
      { method: "GET" },
      { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
    );
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  });

  it("returns the last real response when trailing attempts are transport failures", async () => {
    // A 503 (retryable, so the ladder keeps going) followed by nothing but
    // connection resets: GitHub did answer once, so the caller should see
    // that answer rather than a bare "no response" error.
    const fetchFn = fakeFetch([
      response(503, '{"message": "No server is currently available"}'),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
    ]);
    const { sleepFn, logFn } = recorder();
    const result = await requestWithRetry(
      URL_UNDER_TEST,
      { method: "PATCH" },
      { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(
      result.text,
      '{"message": "No server is currently available"}',
    );
    assert.equal(result.attempts, FAST_LADDER.length);
  });

  it("preserves a caller-supplied signal alongside the timeout", async () => {
    const controller = new AbortController();
    let seenSignal;
    const fetchFn = async (url, init) => {
      seenSignal = init.signal;
      return response(200, "{}");
    };
    const { sleepFn, logFn } = recorder();
    await requestWithRetry(
      URL_UNDER_TEST,
      { method: "GET", signal: controller.signal },
      { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
    );
    // The signal actually passed to fetch must abort when the caller's own
    // signal aborts -- proves it's combined with the timeout, not replaced.
    assert.equal(seenSignal.aborted, false);
    controller.abort();
    assert.equal(seenSignal.aborted, true);
  });

  it("stops retrying once the caller's signal aborts", async () => {
    const controller = new AbortController();
    const fetchFn = fakeFetch([response(503, "down")]);
    const { logFn } = recorder();
    const sleepFn = async () => {
      // Abort between attempts, during the backoff sleep.
      controller.abort();
    };
    await assert.rejects(
      requestWithRetry(
        URL_UNDER_TEST,
        { method: "PATCH", signal: controller.signal },
        { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
      ),
    );
    // Aborted before the ladder ran out, so far fewer than FAST_LADDER.length
    // attempts were made.
    assert.ok(fetchFn.callCount() < FAST_LADDER.length);
  });

  it("aborts out of backoff sleep immediately when the caller's signal fires", async () => {
    // Use the production sleep implementation, rather than a stub that
    // resolves immediately: this proves a mid-sleep abort ends the actual
    // backoff rather than merely being observed before the next attempt.
    const controller = new AbortController();
    let fetchCalls = 0;
    const fetchFn = async () => {
      fetchCalls += 1;
      // The first two one-millisecond backoffs complete normally. Queue the
      // abort after the third transient response so it fires while the third,
      // one-second backoff is actually pending.
      if (fetchCalls === 3) {
        setTimeout(() => controller.abort(), 0);
      }
      return response(503, "down");
    };
    const { logFn } = recorder();
    const startedAt = Date.now();
    await assert.rejects(
      requestWithRetry(
        URL_UNDER_TEST,
        { method: "PATCH", signal: controller.signal },
        {
          fetchFn,
          logFn,
          retryDelaysMs: [0, 1, 1, 1_000],
        },
      ),
    );
    assert.equal(fetchCalls, 3);
    // A non-abort-aware sleep would wait the entire final second before the
    // retry loop sees controller.signal.aborted. Leave CI scheduling headroom
    // while requiring the cancellation to cut that wait substantially short.
    assert.ok(Date.now() - startedAt < 500);
  });

  it("tolerates a missing init object entirely", async () => {
    // The previous fix touched init.signal directly -- callers that pass
    // no init at all would have crashed. We have no such caller in this
    // repo, but several test sites and any future caller that follows the
    // older 2-arg signature would; cover the contract either way.
    const fetchFn = fakeFetch([response(200, '{"ok": true}')]);
    const { sleepFn, logFn } = recorder();
    const result = await requestWithRetry(
      URL_UNDER_TEST,
      undefined,
      { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
    );
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.equal(fetchFn.callCount(), 1);
  });

  it("tolerates an init object with no signal field", async () => {
    const fetchFn = fakeFetch([response(200, '{"ok": true}')]);
    const { sleepFn, logFn } = recorder();
    const result = await requestWithRetry(
      URL_UNDER_TEST,
      { method: "GET" },
      { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
    );
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.equal(fetchFn.callCount(), 1);
  });

  it("honours Retry-After in place of the ladder", async () => {
    const fetchFn = fakeFetch([
      response(429, "slow down", { "Retry-After": "5" }),
      response(200, "{}"),
    ]);
    const { sleepFn, logFn, slept } = recorder();
    await requestWithRetry(
      URL_UNDER_TEST,
      { method: "GET" },
      { fetchFn, sleepFn, logFn, retryDelaysMs: FAST_LADDER },
    );
    assert.deepEqual(slept, [5000]);
  });

  it("retries an ok response the caller classifies as transient", async () => {
    // The GraphQL shape: HTTP 200 carrying GitHub's own internal error.
    const transient = JSON.stringify({
      errors: [{ message: "Something went wrong while executing your query." }],
    });
    const fetchFn = fakeFetch([
      response(200, transient),
      response(200, '{"data": {}}'),
    ]);
    const { sleepFn, logFn } = recorder();
    const result = await requestWithRetry(
      URL_UNDER_TEST,
      { method: "POST" },
      {
        fetchFn,
        sleepFn,
        logFn,
        retryDelaysMs: FAST_LADDER,
        shouldRetryResponse: isRetryableGraphQLBody,
      },
    );
    assert.equal(result.text, '{"data": {}}');
    assert.equal(result.attempts, 2);
  });

  it("logs every retry so a job log explains the delay", async () => {
    const fetchFn = fakeFetch([response(502, "bad gateway"), response(200, "{}")]);
    const { sleepFn, logFn, logged } = recorder();
    await requestWithRetry(
      URL_UNDER_TEST,
      { method: "PATCH" },
      {
        fetchFn,
        sleepFn,
        logFn,
        retryDelaysMs: FAST_LADDER,
        label: "PATCH repos/o/r/check-runs/1",
      },
    );
    assert.equal(logged.length, 1);
    assert.match(logged[0], /PATCH repos\/o\/r\/check-runs\/1/);
    assert.match(logged[0], /HTTP 502/);
    assert.match(logged[0], /attempt 1\/4/);
  });

  it("keeps the jittered delay inside the ladder's bounds", async () => {
    const fetchFn = fakeFetch([response(503, "down")]);
    const { sleepFn, logFn, slept } = recorder();
    await requestWithRetry(
      URL_UNDER_TEST,
      { method: "PATCH" },
      {
        fetchFn,
        sleepFn,
        logFn,
        retryDelaysMs: [0, 1000, 2000, 4000],
        // Extremes of Math.random()'s range, alternating, so both ends of the
        // jitter window are exercised.
        randomFn: (() => {
          let call = 0;
          return () => (call++ % 2 === 0 ? 0 : 0.999999);
        })(),
      },
    );
    assert.deepEqual(
      slept.map((ms, index) => {
        const base = [1000, 2000, 4000][index];
        return ms >= base * 0.5 && ms <= base;
      }),
      [true, true, true],
    );
  });
});
