// Anthropic provider: the Claude CLI talks to Anthropic directly, or to any
// Anthropic-compatible endpoint the caller configures. Selected with
// `provider: anthropic`.
//
// Credentials come from the job's own environment -- ANTHROPIC_API_KEY or
// CLAUDE_CODE_OAUTH_TOKEN -- which the child inherits unchanged. `env` is an
// explicit overlay for everything else: ANTHROPIC_BASE_URL for a gateway,
// ANTHROPIC_CUSTOM_HEADERS, CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
// and their region settings. It is applied after the inherited environment,
// so a value here always wins.
//
// There is no provider-side session-cost API in this mode, so cost is the
// CLI's own client-reported estimate (client-cost.mjs), and Weave secrets are
// never required.

import { CLIENT_COST_LABEL, clientReportedCost } from "./client-cost.mjs";

export function anthropicProvider({ env = {} } = {}) {
  const overlay = Object.freeze({ ...env });
  return Object.freeze({
    id: "anthropic",
    costLabel: CLIENT_COST_LABEL,
    dropEnv: [],
    envFor: () => ({ ...overlay }),
    resolveCost: ({ resultEvent }) => clientReportedCost(resultEvent),
  });
}
