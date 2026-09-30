---
name: No Tautological Tests
description: Flags tests that only confirm their own setup or repeat the implementation without checking real behavior
intelligence: medium
---

Tests must exercise real application logic and detect a meaningful regression. Inspect what
produces the actual value and what establishes the expectation: a passing assertion must
provide evidence beyond the test's own setup or the implementation restated as its oracle.

Judge a regression in production code with the test and its expected values held fixed.
Literal expected values are independent expectations; do not assume they change when the
implementation changes. A short implementation can still contain real application logic.

## When to Check

Only when the PR adds or materially changes tests, assertions, or test helpers. Otherwise,
PASS immediately. Examples of test locations include Go `*_test.go` files, frontend
`*.test.ts` / `*.test.tsx` files, and Python `test_*.py` files; these are not an exhaustive list.

## Flag

- Self-comparisons and constant assertions such as `assert.Equal(t, got, got)`,
  `expect(true).toBe(true)`, or comparing a fixture to itself without exercising application
  code.
- Expected values computed at runtime by the same production function or copied algorithm used
  to produce the actual value, so the same bug changes both sides and the test stays green.
- Tests that invoke only a mock or fake and assert its configured result, replace the
  behavior under test with a stub, or assert only that a mock was called without checking
  a meaningful effect or interaction contract of the real code under test.
- Tests that only verify language or framework guarantees: a trivial constructor returns
  an instance, a field retains its assigned value, or a getter echoes that field, with no
  application validation, transformation, defaults, or other behavior exercised.
- Tests that call real code but discard its outcome and assert only unrelated setup;
  for example, a table-driven loop whose assertions never depend on the current input.

For each finding, explain why the assertion cannot detect the behavior it claims to test
and recommend an independent expectation or meaningful observable outcome. If the test
protects no application behavior, recommend removing it. Read the relevant implementation
and surrounding test before assuming a small assertion is trivial; do not flag on syntax
or assertion count alone.

## Do Not Flag

- Small tests that protect real validation, branching, transformation, defaults, or side
  effects. An error, boolean, nil, or empty-result assertion can be sufficient when that
  outcome is the contract being tested. For example, `assert not valid_discount(-1)` checks
  a real boundary even if `valid_discount` is just `0 <= percent <= 100`.
- Mocks used to isolate dependencies while exercising real application code. Assertions
  about a required payload, destination, call count, or ordering are meaningful when those
  interactions are the observable contract. A fixed expected payload catches an incorrect
  value sent by production code; it does not need a separate assertion on each helper.
- Golden fixtures, independently specified expected values, and independent reference
  implementations that pin a compatibility contract, including a frozen historical oracle.
- Property or metamorphic tests that check a meaningful invariant across distinct inputs
  or operations and would fail for a plausible incorrect implementation.
- Characterization and refactor tests that preserve existing behavior, even when they pass
  before and after the refactor; distinct boundary cases may share an expected result.
- Illustrative code snippets in documentation or fixture source used to test tooling.

## Severity

- **Warning**: An assertion is tautological or the test exercises no meaningful application
  behavior, creating apparent coverage without protecting against the claimed regression.
