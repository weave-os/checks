// Weave Router provider: the checks talk to the Weave Router instead of
// api.anthropic.com. Selected with `provider: weave-router`.
//
// Two separate concerns:
//
//   1. routerEnvironment() — the env that points the Claude Code CLI at the
//      Weave Router instead of api.anthropic.com.
//   2. routerSessionCost() — the authoritative cost of one CLI invocation,
//      read back from Weave's public API.
//
// (2) is not optional bookkeeping. Once traffic goes through the router, the
// CLI's own `total_cost_usd` is wrong: it prices the response against Claude
// Code's local table for the model it *asked* for, so it cannot account for the
// model the router actually selected, a provider-binding fallback, or Weave's
// pricing. The cost column on every check run is the most-watched number in
// this action, so it reads the committed per-session total from the router's
// own telemetry instead.
//
// Kept as a plain ESM module with no dependencies, like parse.mjs and
// history.mjs, so the action can run it with bare `node` and so the retry
// and error-mapping rules are unit testable (router.test.mjs).

import { COORDINATOR_ONLY_ENV } from "./secrets.mjs";

export const ROUTER_BASE_URL = "https://router.weaveos.com";
export const WEAVE_API_BASE_URL = "https://app.weaveos.com/api/v1";
const USD_MICROS_PER_USD = 1_000_000;

// Router telemetry is written asynchronously, so a session that has only just
// finished can legitimately 404 for a moment. These are the delays BEFORE each
// attempt, so the first attempt is immediate. With the one-second per-request
// deadline below, a completely stalled cost endpoint takes at most ~13.75s
// (six request deadlines plus these sleeps) -- long enough to outlast the
// write, short enough that a dozen checks waiting on it in parallel never dominate
// the job's wall-clock.
const COST_RETRY_DELAYS_MS = [0, 250, 500, 1000, 2000, 4000];

// Jitter (the standard fix for synchronized retry storms) is applied at the
// call site below via Math.random(). Without it, a dozen parallel checks that all
// start their retry ladder off the same transient 429/5xx would re-fire in
// lockstep, turning one outage into a dozen synchronized reconnect attempts.
// Reduction factor so the jittered delay still averages near the base --
// full jitter (delay * random()) would compress the ladder into the cheap end.
const RETRY_JITTER_FRACTION = 0.5;

// Bounds each attempt's own request, not just the sleeps between them.
// undici only applies a headers timeout (minutes long, not seconds) with no
// overall request deadline, so a connection that accepts and then stalls
// would otherwise never return and never let the retry ladder advance. The
// API is same-region and returns a tiny JSON body, so a one-second budget
// bounds an outage without rejecting normal cost lookups.
const COST_REQUEST_TIMEOUT_MS = 1000;

// Upper bound on how long a single `Retry-After` hint (see
// parseRetryAfterMs() below) can push a retry delay out to, before jitter.
// The endpoint's own rate limiter already tells us exactly how long its
// bucket needs to refill, which is far more precise than guessing via a
// fixed ladder -- but honoring an arbitrarily large value verbatim would let
// one response stall a check for minutes. Capping keeps a hinted wait inside
// the same rough budget as the fixed ladder (COST_RETRY_DELAYS_MS tops out
// at 4s; a hinted wait can jitter up to 1.5x this cap since jitter is only
// ever added on top of a hint, never subtracted -- see the retry loop below).
const MAX_RETRY_AFTER_MS = 8000;

// Parses the `Retry-After` header the rate limiter sets on a 429 (the Weave
// API always emits delay-seconds, never an HTTP-date) into milliseconds. Returns null for a
// missing, non-numeric, or non-positive value so the caller falls back to
// the fixed retry ladder unchanged -- a malformed or absent header should
// never make cost lookups worse than they were before this hint existed.
function parseRetryAfterMs(headerValue) {
  if (headerValue === null || headerValue === undefined || headerValue === "") {
    return null;
  }
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

// Stable identity under which Weave Checks traffic appears in the Router
// report. Set to a domain-rooted mailbox rather than any one engineer's
// personal email so that router telemetry, cost rollups, and per-user
// reports that group by this header attribute CI spend to the Weave Checks
// service and not to whichever engineer happened to mint the router key.
export const WEAVE_CHECKS_USER_EMAIL = "weave-checks@weaveos.com";

// Env for the Claude Code CLI. ANTHROPIC_BASE_URL moves the traffic; the router
// key rides in its own header, exactly as the `npx @weave-os/router` installer
// writes it into ANTHROPIC_CUSTOM_HEADERS for a developer machine.
//
// ANTHROPIC_API_KEY is a placeholder, not a credential: the CLI refuses to run
// headless without an API-key-shaped value in the environment, but the router
// authenticates the request from X-Weave-Router-Key and never forwards this
// string upstream. It is deliberately not a real key -- a real one here would
// put every check on per-API Anthropic billing, bypassing the router's own
// credit/subscription accounting.
//
// The check's `intelligence` chooses a rolling CLI model alias (`haiku`,
// `sonnet`, or `opus`) and the matching Router cluster. The alias is passed to
// the CLI as `--model` and is the anchor for per-check cost comparisons; it
// does not pin the model Router serves. Which model actually serves the review
// is constrained by `X-Weave-Force-Cluster`, set here from that same
// intelligence tier: Router picks its best-scoring eligible model in the
// cluster on each turn. Since intelligence is required and validated during
// discovery, this header is always present.
export function routerEnvironment(
  routerKey,
  cluster,
  { baseUrl = ROUTER_BASE_URL, userEmail = WEAVE_CHECKS_USER_EMAIL } = {},
) {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: "placeholder-router-authenticates-via-header",
    ANTHROPIC_CUSTOM_HEADERS: [
      `X-Weave-Router-Key: ${routerKey}`,
      `X-Weave-Force-Cluster: ${cluster}`,
      // Identifies the row in router telemetry as a Weave Checks CI
      // invocation under the service mailbox, not under whichever
      // engineer minted the router key.
      `X-Weave-User-Email: ${userEmail}`,
      // Tags the traffic as a CI invocation so it stays separable from
      // engineers' interactive sessions in the Router report.
      "X-App: weave-checks",
    ].join("\n"),
  };
}

// Resolves one CLI invocation's actual cost in USD via
// GET /router/sessions/{session_id}/cost.
//
// `sessionId` comes from the first event in the invocation's stream-json
// transcript (splitStreamJson()). Keep it opaque: the router's public
// contract only requires a non-empty ID no longer than 128 bytes; it is NOT a
// UUID contract. The worker extracts it once and hands it here rather than
// making this helper guess whether a string is a session ID or raw JSON.
//
// Returns `{ cost, error }` where a null cost means "this invocation may have
// cost money, we just can't see how much" -- never 0. The distinction is load
// bearing: the worker propagates null through every sum it appears in and
// renders it as "—", whereas a 0 would present a billed-but-unmeasured run as
// verified-free. `error` is non-null exactly when `cost` is null, so the check's
// summary can say why the number is missing.
//
// One invocation is one session: the worker runs each agent call as its own
// non-persistent `claude -p`, so the session total the endpoint returns is that
// invocation's total and nothing else. It includes router-originated auxiliary
// inference (handover and compaction summaries) that the CLI never sees, which
// is spend the org is charged for and the local estimate silently omits.
export async function routerSessionCost(
  sessionId,
  weaveAPIKey,
  {
    fetchFn = fetch,
    sleepFn = ms => new Promise(resolve => setTimeout(resolve, ms)),
    retryDelaysMs = COST_RETRY_DELAYS_MS,
    apiBaseUrl = WEAVE_API_BASE_URL,
  } = {},
) {
  if (typeof sessionId !== "string" || sessionId === "") {
    return {
      cost: null,
      error: "Claude CLI output carried no session ID, so cost is unknown",
    };
  }

  const url = `${apiBaseUrl}/router/sessions/${encodeURIComponent(sessionId)}/cost`;
  let lastError = null;
  // Overrides the ladder's next delay when the previous attempt's 429 carried
  // a `Retry-After` hint -- see parseRetryAfterMs() above. `null` means "no
  // hint yet, use the fixed ladder unchanged".
  let retryAfterHintMs = null;

  for (const delayMs of retryDelaysMs) {
    // A rate-limit hint from the endpoint itself is strictly more
    // informative than the fixed ladder's guess: it says exactly how long
    // this organization's bucket needs to refill, whereas the ladder is
    // sized for the endpoint's other failure mode (telemetry not yet
    // committed, a transient 5xx). Prefer the hint when both are known.
    const hintMs = retryAfterHintMs;
    const baseDelayMs = hintMs ?? delayMs;
    retryAfterHintMs = null;
    // Jitter the delay (excluding the 0-immediate first attempt) so a
    // transient outage does not turn a dozen checks firing in lockstep into
    // a dozen synchronized reconnect storms. A Retry-After hint is the server's
    // authoritative floor for its rate-limit bucket, so it only gets jitter
    // added on top -- shortening it the way the ladder's own guess gets
    // shortened would retry before the bucket refills and draw another 429.
    let jitteredDelayMs;
    if (baseDelayMs === 0) {
      jitteredDelayMs = 0;
    } else if (hintMs !== null) {
      jitteredDelayMs = baseDelayMs + Math.random() * baseDelayMs * RETRY_JITTER_FRACTION;
    } else {
      jitteredDelayMs =
        baseDelayMs * (1 - RETRY_JITTER_FRACTION + Math.random() * RETRY_JITTER_FRACTION);
    }
    if (jitteredDelayMs > 0) await sleepFn(jitteredDelayMs);

    let response;
    try {
      response = await fetchFn(url, {
        headers: { "X-API-Key": weaveAPIKey },
        signal: AbortSignal.timeout(COST_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Network-level failure (DNS, connection reset, abort -- including our
      // own timeout above) is retryable: the next attempt gets a fresh
      // connection.
      lastError = `session cost request failed: ${error.message ?? error}`;
      continue;
    }

    if (response.ok) {
      let body;
      try {
        body = await response.json();
      } catch (error) {
        // A timeout while reading the response body is the same retryable
        // transport failure as a timeout before headers. AbortSignal.timeout()
        // reports TimeoutError in Node; AbortError keeps this robust for a
        // fetch implementation that uses that DOMException name instead.
        if (error?.name === "TimeoutError" || error?.name === "AbortError") {
          lastError = `session cost request failed: ${error.message ?? error}`;
          continue;
        }
        // A 200 that isn't JSON is a broken response, not a transient one --
        // retrying would just fetch the same bytes again.
        return {
          cost: null,
          error: `session cost response was not valid JSON: ${error.message ?? error}`,
        };
      }
      // Money is integer USD micros end to end. Anything else means the
      // contract moved, and silently coercing it would put a wrong dollar
      // figure on a check run, which is worse than an honest "—".
      if (!Number.isSafeInteger(body?.actual_cost_usd_micros) || body.actual_cost_usd_micros < 0) {
        return {
          cost: null,
          error: "session cost response had no valid actual_cost_usd_micros integer",
        };
      }
      return {
        cost: body.actual_cost_usd_micros / USD_MICROS_PER_USD,
        error: null,
      };
    }

    lastError = `session cost endpoint returned HTTP ${response.status}`;
    // 404 is the expected transient here (telemetry not yet committed), and
    // 429/5xx are the usual "try again" classes. Every other 4xx -- a revoked
    // or wrong-org API key (401/403), a session ID the router's contract
    // rejects (400) -- is a permanent answer that no amount of retrying
    // changes, so stop and report it immediately.
    const retryable = response.status === 404 || response.status === 429 || response.status >= 500;
    if (!retryable) break;

    // A 429 carries the rate limiter's own `Retry-After` (the Weave API
    // always sets this on the org's bucket, in seconds) --
    // use it for the next iteration's delay instead of guessing from the
    // fixed ladder. A 404/5xx has no such hint and falls through to the
    // ladder unchanged.
    if (response.status === 429) {
      retryAfterHintMs = parseRetryAfterMs(response.headers?.get?.("Retry-After"));
    }
  }

  return { cost: null, error: lastError };
}

// Environment names the provider reads its two secrets from. Named once so
// the credential lookup and the child-environment scrub cannot disagree.
export const ROUTER_KEY_ENV = "WEAVE_ROUTER_KEY";
export const WEAVE_API_KEY_ENV = "WEAVE_API_KEY";

// Builds the provider. Both keys are required: without the router key every
// agent call fails at the first request, and without the Weave API key every
// check completes with an unknown cost. Failing at construction makes either
// misconfiguration obvious instead of surfacing as a row of identical neutral
// checks.
export function weaveRouterProvider({
  routerKey,
  weaveAPIKey,
  baseUrl = ROUTER_BASE_URL,
  apiBaseUrl = WEAVE_API_BASE_URL,
  userEmail = WEAVE_CHECKS_USER_EMAIL,
  costOptions = {},
} = {}) {
  if (typeof routerKey !== "string" || routerKey === "") {
    throw new Error(`provider weave-router requires ${ROUTER_KEY_ENV}`);
  }
  if (typeof weaveAPIKey !== "string" || weaveAPIKey === "") {
    throw new Error(`provider weave-router requires ${WEAVE_API_KEY_ENV} for session cost`);
  }
  return Object.freeze({
    id: "weave-router",
    costLabel: "router cost",
    // Neither Weave secret is needed by the CLI child: the router key already
    // rides in ANTHROPIC_CUSTOM_HEADERS, and the Weave API key is only for
    // the coordinator's cost lookup (both are in COORDINATOR_ONLY_ENV).
    // Direct auth-token and OAuth variables are removed; any inherited API key
    // is replaced by the router placeholder in the provider env overlay.
    dropEnv: [...COORDINATOR_ONLY_ENV, "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
    envFor: ({ cluster }) => routerEnvironment(routerKey, cluster, { baseUrl, userEmail }),
    resolveCost: ({ sessionId }) =>
      routerSessionCost(sessionId, weaveAPIKey, { apiBaseUrl, ...costOptions }),
  });
}
