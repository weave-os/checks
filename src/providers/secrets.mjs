// Environment variables that hold secrets for the coordinator, never for an
// agent. Every provider scrubs these from the Claude CLI child: a review
// agent reads untrusted PR content, and anything in its environment is one
// prompt injection away from ending up in a review comment.
//
//   WEAVE_CHECKS_APP_TOKEN   -- the short-lived Weave Checks App installation token
//   GITHUB_TOKEN, GH_TOKEN     -- the same, under the names tools look for
//   WEAVE_CHECKS_ANTHROPIC_API_KEY, WEAVE_CHECKS_CLAUDE_CODE_OAUTH_TOKEN
//                              -- the action's credential inputs, which the
//                                 anthropic provider re-exports under the
//                                 names the CLI reads
//   WEAVE_ROUTER_KEY, WEAVE_API_KEY
//                              -- Weave Router's key (it rides in a header
//                                 instead) and the cost-lookup key
export const COORDINATOR_ONLY_ENV = Object.freeze([
  "WEAVE_CHECKS_APP_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "WEAVE_CHECKS_ANTHROPIC_API_KEY",
  "WEAVE_CHECKS_CLAUDE_CODE_OAUTH_TOKEN",
  "WEAVE_ROUTER_KEY",
  "WEAVE_API_KEY",
]);
