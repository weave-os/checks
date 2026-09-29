// Inherit provider: add nothing and let the Claude CLI use whatever the
// caller's own Claude Code configuration says -- its settings files, its
// login, its environment. Selected with `provider: inherit`; the local CLI's
// default, since a developer's machine is already configured the way they
// want their agent to run.
//
// Only meaningful where the caller's settings are loaded, i.e. without
// `--setting-sources ""`. CI isolates checks from the runner's settings, so
// the action does not offer this provider.

import { CLIENT_COST_LABEL, clientReportedCost } from "./client-cost.mjs";

export function inheritProvider() {
  return Object.freeze({
    id: "inherit",
    costLabel: CLIENT_COST_LABEL,
    dropEnv: [],
    envFor: () => ({}),
    resolveCost: ({ resultEvent }) => clientReportedCost(resultEvent),
  });
}
