import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  routerEnvironment,
  routerSessionCost,
  weaveRouterProvider,
} from "./providers/weave-router.mjs";

const SESSION_ID = "a2c7f8a4-6bcb-4c17-a0c1-e2c3d0877fc1";
const ROUTER_KEY = "rk_test";

function fakeFetch(responses) {
  let call = 0;
  const urls = [];
  const requests = [];
  const fn = async (url, options) => {
    urls.push(url);
    requests.push({ url, options });
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return response;
  };
  fn.urls = urls;
  fn.requests = requests;
  fn.callCount = () => call;
  return fn;
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: name => headers[name] ?? null },
  };
}

describe("routerEnvironment", () => {
  it("points ANTHROPIC_BASE_URL at the router and carries the key and cluster in custom headers", () => {
    const env = routerEnvironment(ROUTER_KEY, "low");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://router.weaveos.com");
    assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /X-Weave-Router-Key: rk_test/);
    assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /X-Weave-Force-Cluster: low/);
    assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /X-Weave-User-Email: weave-checks@weaveos\.com/);
    // A real Anthropic key here would put traffic on per-API billing instead
    // of the router's own accounting -- assert it's the placeholder, not a
    // plausible sk- key, so a future edit can't quietly introduce per-API spend.
    assert.equal(env.ANTHROPIC_API_KEY, "placeholder-router-authenticates-via-header");
  });
});

describe("routerSessionCost", () => {
  it("takes a session ID and looks up the cost", async () => {
    const fetchFn = fakeFetch([jsonResponse(200, { actual_cost_usd_micros: 23418 })]);
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
    });
    assert.equal(cost, 0.023418);
    assert.equal(error, null);
    assert.equal(fetchFn.urls[0], `https://router.weaveos.com/v1/sessions/${SESSION_ID}/cost`);
    assert.equal(fetchFn.requests[0].options.headers.Authorization, "Bearer rk_test");
  });

  it("uses the configured Router URL and removes its trailing slash", async () => {
    const fetchFn = fakeFetch([jsonResponse(200, { actual_cost_usd_micros: 500_000 })]);
    const { cost } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      routerUrl: "https://router.staging.example/",
    });
    assert.equal(cost, 0.5);
    assert.equal(fetchFn.urls[0], `https://router.staging.example/v1/sessions/${SESSION_ID}/cost`);
    assert.equal(fetchFn.requests[0].options.headers.Authorization, "Bearer rk_test");
  });

  it("returns a null cost and an error on an empty session ID", async () => {
    const fetchFn = fakeFetch([jsonResponse(200, {})]);
    for (const bad of ["", undefined, null, 0, {}, [], true]) {
      const { cost, error } = await routerSessionCost(bad, ROUTER_KEY, {
        fetchFn,
      });
      assert.equal(cost, null, `cost for ${JSON.stringify(bad)}`);
      assert.match(error, /no session ID/);
    }
    assert.equal(fetchFn.callCount(), 0);
  });

  it("retries on 404 (telemetry not yet committed) and succeeds", async () => {
    const fetchFn = fakeFetch([
      jsonResponse(404, {}),
      jsonResponse(404, {}),
      jsonResponse(200, { actual_cost_usd_micros: 100 }),
    ]);
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async () => {},
      retryDelaysMs: [0, 1, 1, 1],
    });
    assert.equal(cost, 0.0001);
    assert.equal(error, null);
    assert.equal(fetchFn.callCount(), 3);
  });

  it("gives up after exhausting retries on persistent 404", async () => {
    const fetchFn = fakeFetch([jsonResponse(404, {})]);
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async () => {},
      retryDelaysMs: [0, 1],
    });
    assert.equal(cost, null);
    assert.match(error, /404/);
    assert.equal(fetchFn.callCount(), 2);
  });

  it("does not retry a 401 (wrong or revoked router key)", async () => {
    const fetchFn = fakeFetch([jsonResponse(401, {})]);
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async () => {},
      retryDelaysMs: [0, 1, 1],
    });
    assert.equal(cost, null);
    assert.match(error, /401/);
    assert.equal(fetchFn.callCount(), 1);
  });

  it("retries a 429", async () => {
    const fetchFn = fakeFetch([
      jsonResponse(429, {}),
      jsonResponse(200, { actual_cost_usd_micros: 500 }),
    ]);
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async () => {},
      retryDelaysMs: [0, 1],
    });
    assert.equal(cost, 0.0005);
    assert.equal(error, null);
  });

  it("uses the 429's Retry-After hint for the next attempt's delay instead of the fixed ladder", async () => {
    const fetchFn = fakeFetch([
      jsonResponse(429, {}, { "Retry-After": "3" }),
      jsonResponse(200, { actual_cost_usd_micros: 500 }),
    ]);
    const sleeps = [];
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async ms => {
        sleeps.push(ms);
      },
      // The fixed ladder's second entry is 250ms -- if the hint is ignored
      // this test fails by observing ~250ms (jittered) instead of ~3000ms.
      retryDelaysMs: [0, 250],
    });
    assert.equal(cost, 0.0005);
    assert.equal(error, null);
    assert.equal(sleeps.length, 1);
    // The hint is a floor: jitter only adds up to 50% on top of the 3000ms
    // hint (RETRY_JITTER_FRACTION = 0.5), never shortens it.
    assert.ok(sleeps[0] >= 3000 && sleeps[0] <= 4500, `sleep was ${sleeps[0]}ms`);
  });

  it("caps an oversized Retry-After hint instead of honoring it verbatim", async () => {
    const fetchFn = fakeFetch([
      jsonResponse(429, {}, { "Retry-After": "600" }),
      jsonResponse(200, { actual_cost_usd_micros: 500 }),
    ]);
    const sleeps = [];
    const { cost } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async ms => {
        sleeps.push(ms);
      },
      retryDelaysMs: [0, 250],
    });
    assert.equal(cost, 0.0005);
    // Capped at MAX_RETRY_AFTER_MS (8000ms), the floor -- jitter only adds up
    // to 50% on top of it.
    assert.ok(sleeps[0] >= 8000 && sleeps[0] <= 12000, `sleep was ${sleeps[0]}ms`);
  });

  it("falls back to the fixed ladder when a 429 carries no Retry-After header", async () => {
    const fetchFn = fakeFetch([
      jsonResponse(429, {}),
      jsonResponse(200, { actual_cost_usd_micros: 500 }),
    ]);
    const sleeps = [];
    const { cost } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async ms => {
        sleeps.push(ms);
      },
      retryDelaysMs: [0, 250],
    });
    assert.equal(cost, 0.0005);
    // Jittered to 50%-100% of the ladder's own 250ms entry, not the 8000ms cap.
    assert.ok(sleeps[0] >= 125 && sleeps[0] <= 250, `sleep was ${sleeps[0]}ms`);
  });

  it("falls back to the fixed ladder when Retry-After is not a valid number", async () => {
    const fetchFn = fakeFetch([
      jsonResponse(429, {}, { "Retry-After": "not-a-number" }),
      jsonResponse(200, { actual_cost_usd_micros: 500 }),
    ]);
    const sleeps = [];
    const { cost } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async ms => {
        sleeps.push(ms);
      },
      retryDelaysMs: [0, 250],
    });
    assert.equal(cost, 0.0005);
    assert.ok(sleeps[0] >= 125 && sleeps[0] <= 250, `sleep was ${sleeps[0]}ms`);
  });

  it("does not let a 429's Retry-After hint leak into a later unrelated 404/5xx retry", async () => {
    // First 429 carries a hint; the retry after IT is a 5xx with no hint --
    // the ladder's own next entry should be used, not a stale hint.
    const fetchFn = fakeFetch([
      jsonResponse(429, {}, { "Retry-After": "3" }),
      jsonResponse(503, {}),
      jsonResponse(200, { actual_cost_usd_micros: 500 }),
    ]);
    const sleeps = [];
    const { cost } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async ms => {
        sleeps.push(ms);
      },
      retryDelaysMs: [0, 250, 500],
    });
    assert.equal(cost, 0.0005);
    assert.equal(sleeps.length, 2);
    // sleeps[0]: the hinted 3000ms floor before the 5xx attempt, plus up to 50% jitter on top.
    assert.ok(sleeps[0] >= 3000 && sleeps[0] <= 4500, `sleeps[0] was ${sleeps[0]}ms`);
    // sleeps[1]: back to the ladder's own third entry (500ms), not the stale hint.
    assert.ok(sleeps[1] >= 250 && sleeps[1] <= 500, `sleeps[1] was ${sleeps[1]}ms`);
  });

  it("retries a 5xx", async () => {
    const fetchFn = fakeFetch([
      jsonResponse(503, {}),
      jsonResponse(200, { actual_cost_usd_micros: 500 }),
    ]);
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async () => {},
      retryDelaysMs: [0, 1],
    });
    assert.equal(cost, 0.0005);
    assert.equal(error, null);
  });

  it("treats a missing actual_cost_usd_micros as an unknown cost, not zero", async () => {
    const fetchFn = fakeFetch([jsonResponse(200, { session_id: SESSION_ID })]);
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
    });
    assert.equal(cost, null);
    assert.match(error, /actual_cost_usd_micros/);
  });

  it("resolves cost for a session that exits after producing a session ID", async () => {
    const fetchFn = fakeFetch([jsonResponse(200, { actual_cost_usd_micros: 2_000_000 })]);
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
    });
    assert.equal(cost, 2);
    assert.equal(error, null);
  });

  it("propagates a network-level failure as retryable", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return jsonResponse(200, { actual_cost_usd_micros: 42 });
    };
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async () => {},
      retryDelaysMs: [0, 1],
    });
    assert.equal(cost, 0.000042);
    assert.equal(error, null);
    assert.equal(calls, 2);
  });

  it("retries when the timeout aborts the response body read", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => {
            const error = new Error("The operation timed out");
            error.name = "TimeoutError";
            throw error;
          },
        };
      }
      return jsonResponse(200, { actual_cost_usd_micros: 42 });
    };
    const { cost, error } = await routerSessionCost(SESSION_ID, ROUTER_KEY, {
      fetchFn,
      sleepFn: async () => {},
      retryDelaysMs: [0, 1],
    });
    assert.equal(cost, 0.000042);
    assert.equal(error, null);
    assert.equal(calls, 2);
  });
});

describe("weaveRouterProvider", () => {
  const provider = () => weaveRouterProvider({ routerKey: ROUTER_KEY });

  it("sends the intelligence-derived cluster as the force-cluster header", () => {
    const env = provider().envFor({ model: "opus", intelligence: "high", cluster: "high" });
    assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /X-Weave-Force-Cluster: high/);
    assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /X-Weave-Router-Key: rk_test/);
  });

  // The router key feeds the coordinator and rides in a header; direct
  // Anthropic credentials would compete with the router placeholder.
  it("keeps the router key and direct Anthropic credentials out of the child", () => {
    for (const name of [
      "WEAVE_ROUTER_KEY",
      "WEAVE_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      assert.ok(provider().dropEnv.includes(name), name);
    }
  });

  it("prices through the session-cost endpoint, labelled as router cost", async () => {
    const fetchFn = fakeFetch([jsonResponse(200, { actual_cost_usd_micros: 1_500_000 })]);
    const routed = weaveRouterProvider({
      routerKey: ROUTER_KEY,
      costOptions: { fetchFn },
    });
    assert.equal(routed.costLabel, "router cost");
    // The CLI's own total_cost_usd is ignored: under the router it prices the
    // anchor model, not the one that served the turn.
    const { cost, error } = await routed.resolveCost({
      sessionId: SESSION_ID,
      resultEvent: { total_cost_usd: 9.99 },
    });
    assert.equal(cost, 1.5);
    assert.equal(error, null);
    assert.equal(fetchFn.urls[0], `https://router.weaveos.com/v1/sessions/${SESSION_ID}/cost`);
    assert.equal(fetchFn.requests[0].options.headers.Authorization, "Bearer rk_test");
  });

  it("requires only the router key", () => {
    assert.throws(() => weaveRouterProvider(), /requires WEAVE_ROUTER_KEY/);
    assert.equal(weaveRouterProvider({ routerKey: ROUTER_KEY }).id, "weave-router");
  });
});
