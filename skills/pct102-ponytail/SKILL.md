---
name: pct102-ponytail
description: Applies the DietrichGebert/ponytail lazy senior developer discipline to coding, refactoring, fixes, and reviews. Use when a solution may be over-engineered; prefer the installed ponytail skill when available and preserve required security, accessibility, data integrity, and observability.
---

# Personal Ponytail Adapter

Use the installed `ponytail` skill from `DietrichGebert/ponytail` first. If it is unavailable, apply the source ladder after understanding the actual flow:

1. Does this need to exist? Skip speculative need.
2. Is it already in the codebase? Reuse it.
3. Does the standard library cover it? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency cover it? Reuse it instead of adding another.
6. Can the correct behavior be expressed in one clear line?
7. Only then write the minimum sufficient code.

Use the source intensity levels when useful:

- `lite`: build the request and name the lazier alternative
- `full`: enforce the ladder and preserve safety
- `ultra`: challenge speculative requirements before adding code
- `off`: use normal project conventions

For bug fixes, find and fix the shared root cause rather than patching every caller. Keep required input validation, error handling, security, accessibility, data integrity, and a runnable check for non-trivial logic. Do not use Ponytail to skip understanding the code path.

Mark a deliberate simplification only when the ceiling is real and the upgrade path is explicit. Use Jev to classify whether a proposed shortcut is contract-required, merely preferred, or an unapproved assumption; do not use it to bypass requirements.
