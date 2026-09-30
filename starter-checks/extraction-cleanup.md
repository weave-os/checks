---
name: Extraction Cleanup
description: When code is deleted or extracted to another workspace, verifies that string-based references in surviving config and infrastructure files are also cleaned up
intelligence: low
---

When a PR deletes or moves substantial code (directories, feature modules, route trees), check that the cleanup is complete. String-based references to deleted code survive in config and infrastructure files because no type checker connects them.

## When to Check

Only when the PR **deletes directories or moves files between workspaces**. If the PR only modifies files within existing modules, PASS immediately.

## The Pattern

Every feature has tendrils — string references in config files, maps, arrays, and comments that mention the feature by path or name. When the feature is deleted, the type checker catches broken imports but misses string-based references. These become dead code that silently persists.

## What to Check

1. **Identify what was deleted** — which paths, route prefixes, feature names, or module identifiers were removed
2. **Search surviving files for those identifiers** — look for string literals, map keys, array entries, object properties, comments, and config values that reference the deleted code
3. **Focus on infrastructure files** — routing config, middleware, build config, package.json scripts, env var references, redirect rules, public path lists, feature flag checks, and similar config-as-code

The check is not about finding every dead string in the codebase. It's about the specific strings that correspond to what this PR deleted.

## Severity

- **Error**: Config actively routes, rewrites, or processes requests for code that no longer exists — causes silent 404s, wasted build steps, or wrong behavior
- **Warning**: Dead entries in maps, arrays, or comments that reference deleted code — no runtime impact but accumulates cruft
