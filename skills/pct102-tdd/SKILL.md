---
name: pct102-tdd
description: Applies the red-green-refactor loop from obra/superpowers and mattpocock/skills to behavior changes and regression fixes. Use before editing implementation logic when a durable test can capture the contract; prefer the installed test-driven-development or tdd skill when available.
---

# Personal TDD Adapter

Use the installed `test-driven-development` skill from `obra/superpowers` or `tdd` from `mattpocock/skills` first.

Before writing a test, agree on the public seam being tested and read the project's `CONTEXT.md` or equivalent vocabulary when present.

For each vertical slice:

1. Write one behavior-focused test.
2. Run it and confirm it fails for the intended missing behavior.
3. Implement the minimum code required to pass.
4. Run the focused test.
5. Run related tests.
6. Refactor only after green, or leave refactoring to the review stage.
7. Run the full project test suite before completion.

Tests should describe observable behavior through a public interface, not private implementation. Do not weaken or delete a test to make it pass. If the expectation is wrong, return to the feature contract or diagnose the defect first.
