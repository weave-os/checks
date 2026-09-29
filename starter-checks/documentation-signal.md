---
name: Documentation Signal
description: Flags documentation that repeats code without preserving a non-obvious contract or rationale
intelligence: low
---

Review changed comments and documentation for text that adds no information beyond the adjacent code or signature.

## When to Check

Only when the PR adds or materially changes comments, JSDoc, docstrings, or Markdown prose next to production code. If it does not, PASS immediately.

## Flag

- A comment that paraphrases an obvious identifier or expression without explaining why
- Boilerplate documentation that restates a function's name and parameters but omits constraints, side effects, or rationale

## Do Not Flag

- Documentation of a non-obvious invariant, security/privacy rule, performance constraint, external-service behavior, or rollout rationale
- Public API documentation that provides useful generated-reference metadata
- Comments required by a linter, framework, or exported interface convention

## Severity

- **Info**: Filler documentation that can be removed without losing meaning
