---
name: bug-fix
description: Diagnoses and repairs a confirmed defect with reproduction, root-cause isolation, a regression test, minimal fix, and full validation. Use for failing behavior, regressions, crashes, or intermittent failures; not for unconfirmed feature requests.
---

# Bug Fix

## Purpose

Repair a defect without guessing, widening scope, or hiding the failure. The workflow optimizes for confirmed root cause and prevention of recurrence.

## Inputs

Collect raw evidence first:

- failing command or user journey
- exact error and stack trace
- recent diff or commit when relevant
- environment and runtime details
- expected versus actual behavior

A vague report is allowed to enter diagnosis, but not to authorize a source-code fix.

## Workflow

### 1. Reproduce

Run the smallest command or scenario that demonstrates the failure. Capture the exact output. For intermittent failures, run enough repetitions to establish a useful signal.

If the failure cannot be reproduced, classify it as `cannot-reproduce` and request more evidence. Do not invent a fix.

### 2. Isolate

Trace backward from the observed failure through the relevant call path. Inspect only the code and data needed to locate the divergence.

Use temporary diagnostic instrumentation only when it is needed to identify the boundary. Remove it before completion.

Do not edit production source logic during reproduction or isolation.

### 3. Confirm root cause

State:

- failing input or condition
- first incorrect state or decision
- code location or boundary
- why the current behavior produces the symptom
- a minimal reproduction that would fail before the fix

If the root cause is uncertain, ask for confirmation or gather more evidence. Do not proceed to a speculative patch.

### 4. Add a regression test

Before the fix, add the smallest durable test that fails for the confirmed cause. Choose the lowest level that proves the behavior:

- unit test for isolated logic
- integration test for a boundary or persistence contract
- component test for UI behavior
- E2E test for a user journey or cross-system failure

For performance or intermittent defects, include a measurable reproduction or stability check.

### 5. Apply the minimal fix

Change only the code and configuration required by the confirmed cause. Preserve existing public contracts unless the contract change is approved.

Do not refactor unrelated code, add speculative abstractions, or change test expectations without explaining why.

### 6. Verify

Run in order:

1. the new regression test
2. related focused tests
3. the original reproduction
4. the full project test suite
5. lint, typecheck, build, and security checks as applicable — run
   `node ${AI_SKILLS_HOME}/tools/security-scan.mjs . --severity high` when the defect touches
   auth, database, storage, or user-generated content (see `skills/security-audit/SKILL.md`)
6. repeated runs for intermittent failures

A fix is not accepted when only the new test passes.

## Loop and escalation

Allow a bounded loop:

```text
reproduce → isolate → confirm → regression test → minimal fix → verify
```

Return to isolation when verification exposes a different root cause. Stop and escalate when the defect cannot be reproduced, requires an unapproved contract change, affects production data or security, or repeats after the repair budget.

Default repair budget: three diagnosis/fix iterations. The budget is a safety boundary, not a reason to repeat the same guess.

## Optional tools

Use the installed `systematic-debugging` skill from `obra/superpowers` when available. Use `pct102-ponytail` to prefer the smallest durable root-cause fix. Use `pct102-jev` only to classify evidence or rank candidate root causes with explicit criteria. For browser-visible defects, use `${AI_SKILLS_HOME}/references/playwright-mcp.md`; for an authorized visual regression, use `${AI_SKILLS_HOME}/references/site-clone.md`. Use `requesting-code-review` or `code-review` for the final diff. Deterministic tests remain the source of truth.

## Completion report

Report:

- status: `fixed` | `cannot-reproduce` | `escalated`
- root cause
- changed files and why
- regression test evidence and validation results
- evidence path: `.sdlc/features/<feature-name>/evidence.md` or inline when no feature context
- remaining uncertainty
- smallest required human decision, if any
- follow-up work, if any

Never report a bug fixed without fresh evidence from the original failure and the relevant regression coverage.
