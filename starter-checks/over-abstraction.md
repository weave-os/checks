---
name: Over-Abstraction
description: Flags abstractions that add indirection without supporting a real variation point
intelligence: medium
---

Review changed production code for new abstractions whose only implementation or configuration does not justify the added indirection.

## When to Check

Only when the PR adds an interface, factory, strategy, provider, adapter, or registry. If it does not, PASS immediately.

## Flag

- An interface with one implementation and no realistic second implementation
- A factory that always constructs one concrete type
- A strategy/registry introduced for only one or two fixed cases where a direct conditional is clearer

## Do Not Flag

- A required framework extension point or dependency-injection boundary
- A stable integration/API boundary expected to have independent implementations
- A seam that is needed for tests, capability policies, or plugin discovery

## Severity

- **Error**: Indirection that obscures the actual behavior and has no active variation point
- **Warning**: Premature abstraction with no evidence of a second use
