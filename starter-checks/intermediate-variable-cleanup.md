---
name: Intermediate Variable Cleanup
description: Flags single-use intermediate variables that only restate the immediately following expression
intelligence: low
---

Review changed production code for an intermediate variable used exactly once in the immediately following expression, where inlining makes the code equally or more readable.

## When to Check

Only when the PR adds a local variable or constant. If it does not, PASS immediately.

## Flag

- A variable used once on the next line solely to narrate an obvious slice, conversion, or accessor
- A temporary that repeats the expression's own clear domain name without separating a meaningful calculation

## Do Not Flag

- A variable that names a non-obvious transformation, isolates a side effect, avoids repeated work, aids debugging, or makes a conditional readable
- A variable shared across branches or used more than once
- Destructuring that clarifies a public payload or database row shape

## Severity

- **Info**: A trivial one-line inline cleanup with no behavioral impact
