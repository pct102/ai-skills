# Claudex Loop Reference

Source: `https://github.com/chaseai-yt/claudex-loop`

## Use

Use `claudex-loop` as an optional high-assurance workflow for architectural changes, migrations, security-sensitive work, or plans with high uncertainty. It is not required for small features or routine bug fixes.

## Workflow

1. Recon: inspect the repository and write an assumptions ledger.
2. Requirements: resolve decisions that change the outcome and write observable acceptance criteria.
3. Plan review: have the other provider review the plan and code in a bounded loop.
4. Build: let the authorized builder implement only the approved plan.
5. Inspect: have the other provider inspect the final changes and proof results.
6. Record the plan hash, inspected commit, findings, decisions, and remaining uncertainty.

## Controls

Use a clean worktree, bounded permissions, explicit round budgets, and a structured verdict of `APPROVED`, `REVISE`, or `BLOCKED`. A review request does not authorize implementation. A plan change invalidates approval.

## Guardrails

Do not silently fall back to another provider. Do not let a second model commit, push, deploy, or approve production. Stop if the other CLI is unavailable; use the existing Superpowers review path as the fallback.
