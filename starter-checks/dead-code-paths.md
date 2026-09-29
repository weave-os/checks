---
name: Dead-Code Paths
description: Flags newly added unused parameters, unreachable branches, and hypothetical features with no active caller
intelligence: low
---

Review changed production code for dead paths or speculative features that have no active behavior or caller.

## When to Check

Only when the PR adds a parameter, conditional branch, feature flag, configuration option, or code path. If it does not, PASS immediately.

## Flag

- A new parameter or option that is never read
- A branch made unreachable by the surrounding condition or fixed constants
- A feature path added solely for a hypothetical future use with no current caller, UI, or configuration path

## Do Not Flag

- Required forward-compatible API fields, generated interfaces, or framework hooks
- Explicitly documented staged-rollout code with a real upcoming consumer
- A fallback that is reachable through an external API or configuration value

## Severity

- **Warning**: Newly introduced dead or unreachable code that will mislead future readers
- **Error**: A dormant path that changes security, billing, or data-integrity behavior if accidentally activated
