---
name: Defensive Programming
description: Flags unnecessary defensive checks that obscure ordinary control flow
intelligence: low
---

Review changed code for defensive checks that add ceremony without protecting a real boundary or invariant.

## When to Check

Only when the PR adds a null/undefined check, `try`/`catch`, validation branch, or fallback path in production code. If it does not, PASS immediately.

## Flag

- A check for a state the surrounding type system or invariant already guarantees
- A catch block that only swallows an error or returns a default where the caller needs the failure
- Redundant validation after an existing boundary validator already established the condition

## Do Not Flag

- External API, filesystem, database, parsing, or user-input boundaries
- Recovery that preserves a documented product behavior
- Validation required for security, privacy, billing, or data integrity

## Severity

- **Warning**: Defensive ceremony that obscures otherwise straightforward logic
- **Error**: A defensive fallback silently hides a real operational or data-integrity failure
