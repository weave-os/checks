---
name: Naming Clarity
description: Flags newly introduced names that obscure rather than communicate intent
intelligence: low
---

Review new or renamed identifiers for names that make ordinary code harder to understand.

## When to Check

Only when the PR adds or renames a variable, function, type, field, class, or file. If it does not, PASS immediately.

## Flag

- A name that repeats type or boolean information rather than the domain meaning (for example, `currentUserAuthenticationStatusBoolean` instead of `isAuthenticated`)
- A vague name (`data`, `result`, `handler`, `manager`) where nearby domain context supports a concise specific alternative
- An acronym or abbreviation that is not established in the surrounding code

## Do Not Flag

- Conventional short names in a tightly scoped loop or callback
- Existing domain terminology, external API names, or generated identifiers
- A name that is long because it captures necessary business meaning

## Severity

- **Warning**: A new name that makes the local intent materially less clear
