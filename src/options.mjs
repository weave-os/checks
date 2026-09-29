// Option handling shared by the CLI's local commands and the action's steps,
// so a flag and its action input can never mean two different things.

import path from "node:path";

import { policyFrom } from "./parse.mjs";
import { PROVIDER } from "./provider.mjs";

// Splits a comma- or newline-separated list input, dropping blanks.
export function splitList(value) {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function parseBoolean(name, value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
}

// The frontmatter policy for a run. Weave Router serves a check from its
// declared cluster, so that provider always requires one, whatever the
// caller asked for.
export function policyForRun({ provider, allowedModels, allowedClusters, requireCluster, defaultModel, docFiles }) {
  return policyFrom({
    allowedModels: splitList(allowedModels),
    allowedClusters: splitList(allowedClusters),
    requireCluster: requireCluster === true || provider === PROVIDER.WEAVE_ROUTER,
    defaultModel: defaultModel || null,
    docFiles: splitList(docFiles),
  });
}

// The checks directory is joined onto the repository root and recorded in
// each check's path, so it must name a real subdirectory of the repo -- never
// the root itself (every README.md-adjacent Markdown file would become a
// check) and never outside it.
export function validateChecksDir(checksDir) {
  if (typeof checksDir !== "string" || checksDir.trim() === "") {
    throw new Error("checks-dir must be a repository-relative directory");
  }
  if (path.isAbsolute(checksDir) || /^[A-Za-z]:[\\/]/.test(checksDir)) {
    throw new Error(`checks-dir "${checksDir}" must be relative to the repository root`);
  }
  const normalized = path.posix.normalize(checksDir.replaceAll("\\", "/")).replace(/\/+$/, "");
  if (normalized === "." || normalized === "") {
    throw new Error("checks-dir cannot be the repository root");
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`checks-dir "${checksDir}" escapes the repository root`);
  }
  return normalized;
}
