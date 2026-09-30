// Retrying HTTP transport for every GitHub API call Weave Checks makes
// (worker.mjs's `github()` and `graphql()` both sit on requestWithRetry).
//
// GitHub returns 5xx considerably more often than its status page suggests:
// during a partial outage a single check-run PATCH answers 503 "No server is
// currently available to service your request" while the request either side
// of it succeeds. Before this module every such blip was terminal -- the throw
// out of `github()` escaped the per-check try block (it happened inside a
// cosmetic aggregate-table repaint, which sat outside it), unwound the worker
// pool, and abandoned every check. One transient 503 cost a whole run.
//
// The policy lives here, in one place, so that (a) it is unit testable
// (githubapi.test.mjs) without standing up a fake GitHub, and (b) the REST and
// GraphQL paths cannot drift apart -- GraphQL needs body-level retry
// classification that REST doesn't, but both need the same ladder, the same
// jitter, and the same Retry-After handling.
//
// Retry safety: a handful of the calls this transport carries are
// non-idempotent (POST a review, POST a resolution reply, POST a check run).
// Retrying those after a 5xx could in principle double-post, if the write had
// committed and only the response was lost. We retry them anyway: GitHub's
// 502/503 during an incident is overwhelmingly a gateway rejection that never
// reached the handler, the alternative outcome is losing the entire run, and
// the cross-run dedup judge already exists to swallow a duplicated finding on
// the next pass.

// Delays BEFORE each attempt, so the first attempt is immediate. Six attempts
// with ~31s of total sleep: long enough to ride out the seconds-long 503
// windows a GitHub incident produces, short enough that a genuinely down API
// fails the job in well under a minute instead of holding a runner for the
// job's whole timeout.
const RETRY_DELAYS_MS = [0, 1000, 2000, 4000, 8000, 16000];

// Same reasoning as the Router cost lookup: with a 16-wide pool, sixteen checks
// that trip the same transient error would otherwise re-fire in lockstep and
// turn one blip into a synchronized retry storm against the API that is
// already struggling. Reduction factor rather than full jitter so the
// jittered delay still averages near the base delay.
const RETRY_JITTER_FRACTION = 0.5;

// Bounds each attempt's own request, not just the sleeps between them. undici
// applies only a headers timeout (minutes long) with no overall request
// deadline, so a connection GitHub accepts and then stalls would never return
// and never let the ladder advance. 30s is generous for the REST/GraphQL calls
// here (the largest is a check-run PATCH with a ~60KB summary) while still
// bounding a stalled socket.
const REQUEST_TIMEOUT_MS = 30_000;

// Ceiling on a server-supplied wait. GitHub's primary rate-limit reset can be
// up to an hour out; sleeping that long in CI is worse than failing the run
// with a clear message, so a longer instruction is clamped and the ladder
// simply runs out.
const MAX_RETRY_AFTER_MS = 60_000;

// GitHub's 5xx bodies are sometimes a full HTML error page. Those end up in a
// thrown Error message, which ends up in a check-run summary -- a surface with
// a hard 65535-byte cap -- and in the job log, where a wall of markup buries
// the one line a reader needs. Sized to comfortably fit the genuinely useful
// long body, a 422 from POST /pulls/{n}/reviews enumerating which suggestion
// failed diff validation, while still bounding an error page.
const MAX_ERROR_BODY_CHARS = 2000;

// Substrings that mark a GraphQL `errors` entry as transient. GitHub answers
// several of its own internal failures with HTTP 200 and an error payload, so
// status-code classification alone would treat an outage as a permanent
// answer. Matched case-insensitively against the message.
const RETRYABLE_GRAPHQL_MESSAGES = [
  // GitHub's generic internal-failure message on the GraphQL endpoint.
  "something went wrong while executing your query",
  "timeout",
  "timed out",
  // Secondary rate limit, GraphQL flavour.
  "was submitted too quickly",
  "please wait a few minutes",
  "abuse detection",
  "no server is currently available",
];

// GraphQL `errors[].type` values worth another attempt. Everything else
// (NOT_FOUND, FORBIDDEN, UNPROCESSABLE, ...) is a permanent answer.
const RETRYABLE_GRAPHQL_TYPES = new Set(["RATE_LIMITED", "SERVICE_UNAVAILABLE"]);

const DEFAULT_SLEEP = (ms, abortSignal) => {
  // Honour a caller-supplied AbortSignal so a cancellation during backoff
  // doesn't have to wait out the full sleep. resolve() on abort is a
  // deliberate choice: requestWithRetry checks callerSignal.aborted right
  // after, so a synthetic "done" doesn't actually let another attempt run.
  if (abortSignal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
};

// Trims a response body down to something safe to embed in an error message,
// keeping the head (where GitHub's `{"message": ...}` lives) and saying how
// much was dropped so a reader knows the truncation happened.
export function truncateBody(text, maxChars = MAX_ERROR_BODY_CHARS) {
  if (typeof text !== "string") return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… (${text.length - maxChars} more chars)`;
}

// 408/429/5xx are the standard retry classes. The 403 case is GitHub-specific
// and load bearing: a tripped SECONDARY rate limit comes back as 403, not 429,
// and is named only in the body -- while a plain 403 (the App lacks a scope,
// branch protection forbids the review dismissal) is permanent and must fail
// immediately rather than burning six attempts on an answer that won't change.
export function isRetryableStatus(status, bodyText = "") {
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  if (status === 403) {
    return /secondary rate limit|abuse detection|rate limit exceeded|please wait a few minutes/i.test(
      bodyText,
    );
  }
  return false;
}

export function isRetryableGraphQLErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.some(error => {
    if (RETRYABLE_GRAPHQL_TYPES.has(error?.type)) return true;
    const message = typeof error?.message === "string" ? error.message : "";
    const lowered = message.toLowerCase();
    return RETRYABLE_GRAPHQL_MESSAGES.some(needle => lowered.includes(needle));
  });
}

// Body-level retry predicate for the GraphQL endpoint, passed to
// requestWithRetry as `shouldRetryResponse`. An HTTP 200 whose body isn't JSON
// at all is GitHub serving an HTML error page through the GraphQL route --
// transient, and the one case where "unparseable" should mean "try again"
// rather than "report a broken contract".
export function isRetryableGraphQLBody(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return true;
  }
  return isRetryableGraphQLErrors(json?.errors);
}

// Reads a server-supplied wait out of the response headers, in preference to
// our own ladder: when GitHub says when to come back, it knows better than we
// do. Returns null when the headers carry no instruction.
//
// `Retry-After` (seconds) accompanies a secondary-rate-limit 403/429.
// `x-ratelimit-remaining: 0` plus `x-ratelimit-reset` (absolute epoch seconds)
// is the primary rate limit, which has no Retry-After.
export function retryAfterMs(headers, nowMs = Date.now()) {
  const read = name => {
    const value = headers?.get?.(name);
    return value === null || value === undefined || value === "" ? null : value;
  };

  const retryAfter = read("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    }
  }

  const remaining = read("x-ratelimit-remaining");
  const reset = read("x-ratelimit-reset");
  if (remaining === "0" && reset !== null) {
    const resetEpochSeconds = Number(reset);
    if (Number.isFinite(resetEpochSeconds)) {
      const waitMs = resetEpochSeconds * 1000 - nowMs;
      if (waitMs > 0) return Math.min(waitMs, MAX_RETRY_AFTER_MS);
    }
  }

  return null;
}

// Performs one GitHub request, retrying the transient failure classes above.
//
// Resolves to `{ ok, status, text, headers, attempts }` for any response that
// actually arrived -- including a permanent 4xx and including a retryable
// response whose attempts ran out. Callers decide what a non-ok status means;
// this function's only job is to stop transient failures from reaching them.
//
// Throws only when no response ever arrived (DNS failure, connection reset,
// our own per-attempt timeout, on every attempt). That is the one outcome a
// caller cannot interpret from a status code, so it surfaces as an exception
// carrying the last transport error and the attempt count.
export async function requestWithRetry(
  url,
  init = undefined,
  {
    fetchFn = fetch,
    sleepFn = DEFAULT_SLEEP,
    retryDelaysMs = RETRY_DELAYS_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
    randomFn = Math.random,
    nowFn = Date.now,
    logFn = message => console.error(message),
    // What to call this request in retry logs. The caller passes something
    // human-readable ("PATCH repos/o/r/check-runs/123") because a bare URL in
    // a job log doesn't say which check was talking.
    label = init?.method ?? "GET",
    // Optional body-level classification for an otherwise-ok response, used by
    // the GraphQL path where a transient failure arrives as HTTP 200.
    shouldRetryResponse = null,
  } = {},
) {
  const callerSignal = init?.signal ?? undefined;
  const initWithoutSignal =
    callerSignal === undefined ? init : (
      Object.fromEntries(Object.entries(init).filter(([key]) => key !== "signal"))
    );
  const maxAttempts = retryDelaysMs.length;
  let lastTransportError = null;
  // The most recent actual HTTP response, even one the ladder decided to
  // retry past. Kept so that if every attempt after it is a transport
  // failure (never another response), the caller still gets GitHub's real
  // status and body instead of a bare "no response" error.
  let lastResponse = null;
  let nextDelayMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // A caller-supplied signal cancels the whole retry loop, not just the
    // in-flight attempt -- honour it before the in-flight work, and make
    // the backoff sleep itself abort so cancellation does not hang on a
    // sleep that can run up to tens of seconds.
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new Error(`${label}: aborted by caller`);
    }
    if (nextDelayMs > 0) {
      await sleepFn(nextDelayMs, callerSignal);
      if (callerSignal?.aborted) {
        throw callerSignal.reason ?? new Error(`${label}: aborted by caller`);
      }
    }

    let response = null;
    let text = null;
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal =
        callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
      response = await fetchFn(url, {
        ...initWithoutSignal,
        signal: combinedSignal,
      });
      text = await response.text();
    } catch (error) {
      // No response at all: DNS, connection reset, or our own timeout above
      // (including one that fired while the body was still streaming). Always
      // retryable -- the next attempt gets a fresh connection -- unless the
      // caller itself is why we aborted, in which case another attempt would
      // just repeat the cancellation.
      if (callerSignal?.aborted) throw error;
      lastTransportError = error.message ?? String(error);
      response = null;
    }

    if (response !== null) {
      const retryable =
        response.ok ?
          shouldRetryResponse !== null && shouldRetryResponse(text)
        : isRetryableStatus(response.status, text);
      const result = {
        ok: response.ok,
        status: response.status,
        text: text ?? "",
        headers: response.headers,
        attempts: attempt,
      };
      if (!retryable || attempt === maxAttempts) {
        if (retryable) {
          logFn(
            `Weave Checks: ${label} still failing after ${attempt} attempt(s) (HTTP ${response.status}); giving up`,
          );
        }
        return result;
      }
      lastResponse = result;
      nextDelayMs =
        retryAfterMs(response.headers, nowFn()) ?? jitter(retryDelaysMs[attempt], randomFn);
      logFn(
        `Weave Checks: ${label} returned HTTP ${response.status}; retrying in ${Math.round(nextDelayMs)}ms (attempt ${attempt}/${maxAttempts})`,
      );
      continue;
    }

    if (attempt === maxAttempts) break;
    nextDelayMs = jitter(retryDelaysMs[attempt], randomFn);
    logFn(
      `Weave Checks: ${label} failed to reach GitHub (${lastTransportError}); retrying in ${Math.round(nextDelayMs)}ms (attempt ${attempt}/${maxAttempts})`,
    );
  }

  if (lastResponse !== null) {
    logFn(
      `Weave Checks: ${label} failed to reach GitHub on the final attempt (${lastTransportError}); returning the last response received (HTTP ${lastResponse.status}) instead of an error`,
    );
    return { ...lastResponse, attempts: maxAttempts };
  }

  throw new Error(
    `${label}: no response from GitHub after ${maxAttempts} attempt(s): ${lastTransportError}`,
  );
}

// `retryDelaysMs[attempt]` is the base delay before attempt N+1; index 0 is
// the always-immediate first attempt. The loop only schedules delays when
// another attempt remains, so the index is always in range.
function jitter(baseDelayMs, randomFn) {
  return baseDelayMs * (1 - RETRY_JITTER_FRACTION + randomFn() * RETRY_JITTER_FRACTION);
}
