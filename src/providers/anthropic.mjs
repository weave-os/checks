// Anthropic provider: the Claude CLI talks to Anthropic directly, or to any
// Anthropic-compatible endpoint the caller configures. Selected with
// `provider: anthropic`.
//
// Credentials come from the job's own environment -- ANTHROPIC_API_KEY or
// CLAUDE_CODE_OAUTH_TOKEN, which the child inherits unchanged -- or, in the
// action, from `apiKey`/`oauthToken`, which are set on the child only when
// non-empty (an empty ANTHROPIC_API_KEY is still "set" to the CLI). `env` is
// an explicit overlay for everything else: ANTHROPIC_BASE_URL for a gateway,
// ANTHROPIC_CUSTOM_HEADERS, CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
// and their region settings. It is applied last, so a value there always
// wins.
//
// `oauthToken` may hold several tokens, one per line, from several
// subscription seats. Agent calls take them in turn, and a call refused for a
// seat's usage limit is rerun on the next token that has not hit it (see
// failover below), so one seat running out no longer turns every check
// neutral.
//
// There is no provider-side session-cost API in this mode, so cost is the
// CLI's own client-reported estimate (client-cost.mjs), and Weave secrets are
// never required -- or passed on, if the job happens to have them.

import { CLIENT_COST_LABEL, clientReportedCost } from "./client-cost.mjs";
import { COORDINATOR_ONLY_ENV } from "./secrets.mjs";

// What the CLI prints as its result, then exits 1, when a seat is out, e.g.
// "You've hit your org's monthly spend limit · ... · your weekly limit resets 10am (UTC)".
const USAGE_LIMIT_RESULT = /hit your .*limit/i;

export function hitUsageLimit(invocation) {
  return (
    invocation?.code !== 0 &&
    typeof invocation?.cli?.result === "string" &&
    USAGE_LIMIT_RESULT.test(invocation.cli.result)
  );
}

export function anthropicProvider({ env = {}, apiKey = "", oauthToken = "" } = {}) {
  const tokens = [
    ...new Set(
      oauthToken
        .split(/\r?\n/)
        .map(token => token.trim())
        .filter(Boolean),
    ),
  ];
  const limited = new Set();
  let calls = 0;
  // Round-robin over the tokens still under their limit; once every one is
  // limited, keep rotating so each call still reports the CLI's own error.
  const nextToken = () => {
    const usable = tokens.filter(token => !limited.has(token));
    const pool = usable.length > 0 ? usable : tokens;
    return pool[calls++ % pool.length];
  };
  return Object.freeze({
    id: "anthropic",
    costLabel: CLIENT_COST_LABEL,
    dropEnv: [...COORDINATOR_ONLY_ENV],
    envFor: () => {
      const token = tokens.length > 0 ? nextToken() : "";
      return {
        ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
        ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
        ...env,
      };
    },
    // Called with the env envFor() returned and the finished invocation.
    // True means: that token hit its usage limit and another one has not, so
    // rerun the call. A token set through `env` is not ours to rotate.
    failover: (childEnv, invocation) => {
      const token = childEnv.CLAUDE_CODE_OAUTH_TOKEN;
      if (!tokens.includes(token) || !hitUsageLimit(invocation)) return false;
      limited.add(token);
      return limited.size < tokens.length;
    },
    resolveCost: ({ resultEvent }) => clientReportedCost(resultEvent),
  });
}
