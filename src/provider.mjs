// The boundary between the engine and whatever serves the Claude CLI's
// requests. runner.mjs only ever sees this contract, never a concrete
// provider, so adding one never touches the review pipeline.
//
// A provider is a frozen object:
//
//   id            -- "anthropic" | "weave-router" | "inherit"
//   costLabel     -- how the cost it reports is described to a reader
//                    ("router cost", "client-reported cost")
//   dropEnv       -- names removed from the inherited environment before the
//                    CLI child starts, for secrets only the coordinator needs
//   envFor({ model, cluster, slug, suffix })
//                 -- env overlaid on the child after dropEnv is applied
//   resolveCost({ sessionId, resultEvent, model, cluster })
//                 -- Promise<{ cost, error }> or { cost, error }; a null cost
//                    means unknown, never zero, and `error` says why
//   validateCheck(check)
//                 -- optional; an error string for a check this provider
//                    cannot serve (Weave Router needs a cluster), else null

import { anthropicProvider } from "./providers/anthropic.mjs";
import { inheritProvider } from "./providers/inherit.mjs";
import {
  ROUTER_KEY_ENV,
  WEAVE_API_KEY_ENV,
  weaveRouterProvider,
} from "./providers/weave-router.mjs";

export const PROVIDER = Object.freeze({
  ANTHROPIC: "anthropic",
  WEAVE_ROUTER: "weave-router",
  INHERIT: "inherit",
});

// Tells hooks in the caller's Claude Code setup that this session is an
// automated check, not a person at a prompt.
export const PROMPT_INITIATOR_ENV = "WEAVE_PROMPT_INITIATOR";
export const AUTOMATION_PROMPT_INITIATOR = "automation";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Parses `KEY=VALUE` lines (the action's `provider-env` input) into an env
// object. Blank lines and `#` comments are skipped; the value is everything
// after the first `=`, untrimmed. A key repeated on several lines is joined
// with newlines, which is how ANTHROPIC_CUSTOM_HEADERS takes more than one
// header. Anything else is an error rather than a silently dropped setting.
export function parseProviderEnv(text) {
  const env = {};
  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    const separator = rawLine.indexOf("=");
    const key = separator === -1 ? "" : rawLine.slice(0, separator).trim();
    if (!ENV_NAME.test(key)) {
      throw new Error(`provider-env line is not KEY=VALUE: ${JSON.stringify(rawLine)}`);
    }
    const value = rawLine.slice(separator + 1);
    env[key] = Object.hasOwn(env, key) ? `${env[key]}\n${value}` : value;
  }
  return env;
}

// Builds the named provider from an environment: `env` is where credentials
// live (process.env in the worker, the local CLI's own env), and `providerEnv`
// is the parsed `provider-env` overlay. Only the selected provider's secrets
// are read, so an Anthropic consumer never needs a Weave key.
//
// WEAVE_ROUTER_BASE_URL / WEAVE_API_BASE_URL override the Router's service
// endpoints, for a self-hosted or staging Router; unset means production.
export function createProvider(name, { env = {}, providerEnv = {} } = {}) {
  switch (name) {
    case PROVIDER.ANTHROPIC:
      return anthropicProvider({
        env: providerEnv,
        apiKey: env.WEAVE_CHECKS_ANTHROPIC_API_KEY,
        oauthToken: env.WEAVE_CHECKS_CLAUDE_CODE_OAUTH_TOKEN,
      });
    case PROVIDER.WEAVE_ROUTER:
      return weaveRouterProvider({
        routerKey: env[ROUTER_KEY_ENV],
        weaveAPIKey: env[WEAVE_API_KEY_ENV],
        ...(env.WEAVE_ROUTER_BASE_URL ? { baseUrl: env.WEAVE_ROUTER_BASE_URL } : {}),
        ...(env.WEAVE_API_BASE_URL ? { apiBaseUrl: env.WEAVE_API_BASE_URL } : {}),
      });
    case PROVIDER.INHERIT:
      return inheritProvider();
    default:
      throw new Error(
        `unknown provider "${name}" (expected one of: ${Object.values(PROVIDER).join(", ")})`,
      );
  }
}

// Env construction for one CLI child, in the one order that is safe:
//
//   1. start from the inherited environment,
//   2. remove every dropEnv name (provider secrets, caller overrides),
//   3. overlay the provider's env,
//   4. set the automation initiator last, so nothing can unset it.
//
// Dropping before overlaying is what lets a provider both scrub an inherited
// variable and set its own value for the same name (Weave Router drops the
// runner's ANTHROPIC_* credentials and supplies its placeholder key). A spawn
// env value of `undefined` would also omit a variable, but deleting keeps the
// returned object honest for tests.
export function childEnvironment({ baseEnv, dropEnv = [], providerEnv = {} }) {
  const env = { ...baseEnv };
  for (const name of dropEnv) {
    delete env[name];
  }
  return {
    ...env,
    ...providerEnv,
    [PROMPT_INITIATOR_ENV]: AUTOMATION_PROMPT_INITIATOR,
  };
}
