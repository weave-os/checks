// Product names, check-run names, and comment markers, in one place.
//
// Every string here is something a consumer might want to rebrand, and most
// of them are also read back later: the worker finds its own child check runs
// by name, and history.mjs finds its own review comments by marker. Deriving
// both the write and the read from the same helper is what keeps a rename
// from silently orphaning a PR's existing runs or comments.
//
// The defaults are Weave's, byte-for-byte. Prompts, check-run names, and the
// markers already sitting on Weave PRs depend on them, so changing a default
// is a migration, not a copy edit.

import { SLUG_PATTERN } from "./parse.mjs";

export const DEFAULT_BRANDING = Object.freeze({
  // Names one check in agent prompts: `the advisory Weave Check "<name>"`.
  productName: "Weave Check",
  // Prefix of each child check run: `Weave Check / <name>`.
  checkRunPrefix: "Weave Check",
  // The aggregate check run, and the prefix of its titles.
  aggregateName: "Weave Checks",
  // Comment marker: `<!-- weave-check:<slug> -->`.
  markerPrefix: "weave-check",
});

// The marker every Weave Checks comment carried before the prefix was
// configurable. Always read, whatever the configured prefix, so a consumer
// that rebrands keeps recognizing the comments already on its open PRs.
export const LEGACY_MARKER_PREFIX = DEFAULT_BRANDING.markerPrefix;

// Builds a branding object from caller overrides, rejecting values that would
// corrupt what they are embedded in. Empty or absent overrides keep the
// default, so an action input left blank behaves like one never set.
export function brandingFrom(overrides = {}) {
  const branding = { ...DEFAULT_BRANDING };
  for (const key of Object.keys(DEFAULT_BRANDING)) {
    const value = overrides[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || /[\r\n]/.test(value) || value.trim() !== value) {
      throw new Error(`${key} must be a single line without surrounding whitespace`);
    }
    branding[key] = value;
  }
  // The prefix is interpolated into a regex and an HTML comment, so it gets
  // the same vocabulary as the slugs it precedes.
  if (!SLUG_PATTERN.test(branding.markerPrefix)) {
    throw new Error(
      `markerPrefix "${branding.markerPrefix}" must use only lowercase letters, digits, and hyphens`,
    );
  }
  return Object.freeze(branding);
}

export function brandingFromEnv(env) {
  return brandingFrom({
    productName: env.WEAVE_CHECKS_PRODUCT_NAME,
    checkRunPrefix: env.WEAVE_CHECKS_CHECK_RUN_PREFIX,
    aggregateName: env.WEAVE_CHECKS_AGGREGATE_NAME,
    markerPrefix: env.WEAVE_CHECKS_MARKER_PREFIX,
  });
}

// The one place a child check run's name is built. createCheckRun() writes it
// and every read-back matches against it; two separate interpolations would
// drift the moment either one changed.
export function childCheckRunName(branding, check) {
  return `${branding.checkRunPrefix} / ${check.name}`;
}
