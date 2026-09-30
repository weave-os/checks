---
name: Redundant Type Annotations
description: Flags type annotations that duplicate information already inferred by the compiler
intelligence: low
---

Review changed TypeScript or Go code for explicit type annotations that only restate an initializer or an already-constrained function signature.

## When to Check

Only when changed TypeScript or Go code adds an explicit variable, parameter, return, or generic type annotation. If it does not, PASS immediately.

## Flag

- A local variable type exactly inferred from its initializer
- A return type that restates an obvious literal/object expression in a private helper where inference remains clear
- A generic annotation that adds no constraint or documentation beyond inference

## Do Not Flag

- Public API, exported function, interface, or schema-bound types
- Annotations that prevent unwanted widening, document a non-obvious contract, or improve overload resolution
- Types required by the language or framework

## Severity

- **Warning**: Redundant annotation that adds noise without clarifying a boundary or contract
