---
name: pct102-grill-me
description: Interviews the user one decision-bearing question at a time to expose assumptions, constraints, and unresolved product decisions. Use before locking a feature contract or when a plan is still ambiguous; prefer the installed grill-me and grilling skills from mattpocock/skills when available.
---

# Personal Grill Adapter

Use the installed `grill-me` or `grilling` skill from `mattpocock/skills` first. The upstream `grill-me` entry is a manual user-invoked skill that delegates to `grilling`; this adapter lets the personal orchestrator use the same discipline as an internal alignment phase.

If neither is available:

1. Inspect the repository before asking questions it can answer.
2. Ask one decision-bearing question at a time.
3. Cover purpose, user, scope, non-goals, constraints, trade-offs, failure behavior, acceptance evidence, and approval boundaries.
4. Prefer multiple choices only when the options are real and the user can judge them.
5. Separate facts discovered from the repository from assumptions that need the user's answer.
6. Write resolved decisions to the owning workflow's intent or spec artifact.
7. Stop when the remaining questions require human judgment.

Use Jev as a fast routing aid, not as the interviewer: classify whether the next unresolved branch blocks progress, needs a user choice, or can be deferred. Ask the user the actual product question. Do not let a classifier manufacture consent or requirements.

Do not create a parallel planning process. The grill output feeds `app-sdlc` or `feature-lifecycle` and must pass the owning workflow's approval gate.
