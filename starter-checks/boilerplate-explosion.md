---
name: Boilerplate Explosion
description: Flags trivial operations spread across unnecessary classes, functions, or files
intelligence: low
---

Review changed production code for trivial operations split into extra layers that a reader must navigate without gaining a reusable boundary.

## When to Check

Only when the PR adds a new class, function, file, wrapper, or indirection around a small operation. If it does not, PASS immediately.

## Flag

- A one-use wrapper that only forwards arguments or renames a single expression
- A new class/file for logic that fits clearly and locally at its only call site
- Several repetitive setup objects that could be a small data structure or loop

## Do Not Flag

- A boundary used by more than one caller
- Extracted logic that gives a testable, security, persistence, or integration seam
- Code following an established framework registration pattern

## Severity

- **Error**: New ceremony readers must traverse to understand a simple operation
- **Warning**: A likely one-use wrapper that can be inlined without losing a useful boundary
