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
// There is no provider-side session-cost API in this mode, so cost is the
// CLI's own client-reported estimate (client-cost.mjs), and Weave secrets are
// never required -- or passed on, if the job happens to have them.

import { CLIENT_COST_LABEL, clientReportedCost } from "./client-cost.mjs";
import { COORDINATOR_ONLY_ENV } from "./secrets.mjs";

export function anthropicProvider({ env = {}, apiKey = "", oauthToken = "" } = {}) {
  const overlay = Object.freeze({
    ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
    ...(oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken } : {}),
    ...env,
  });
  return Object.freeze({
    id: "anthropic",
    costLabel: CLIENT_COST_LABEL,
    dropEnv: [...COORDINATOR_ONLY_ENV],
    envFor: () => ({ ...overlay }),
    resolveCost: ({ resultEvent }) => clientReportedCost(resultEvent),
  });
}
