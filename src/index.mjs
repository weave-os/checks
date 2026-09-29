// Programmatic entry point. The supported interfaces are the `weave-checks`
// CLI and the GitHub action; this re-exports the pieces they are built from
// for callers that embed a review in their own tooling.

export { DEFAULT_BRANDING, brandingFrom, childCheckRunName } from "./branding.mjs";
export { discoverChecks } from "./discover.mjs";
export { writeRangeDiff, writeWorkingTreeDiff, resolveDiffBase } from "./gitdiff.mjs";
export { readIgnorePathspecs } from "./ignore.mjs";
export { runChecks } from "./local.mjs";
export {
  GENERIC_POLICY,
  RESULT_SCHEMA,
  SUPPORTED_CLUSTERS,
  SUPPORTED_MODELS,
  WEAVE_POLICY,
  buildMatrix,
  parseCheckFile,
  policyFrom,
} from "./parse.mjs";
export { PROVIDER, createProvider, parseProviderEnv } from "./provider.mjs";
