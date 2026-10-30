---
name: pct102-qa-lead-verify
description: Lead QA pass over a project's ready-for-test GitHub issues. For each one whose fix PR is merged and whose dev deploy succeeded, runs a fresh agent with pct102-qa-verify on the deployed dev URL (own screenshots, verdict comment, verified or needs-fix, closes the issue on a pass), then writes a detailed markdown report. Runs until every issue is checked, then stops. Use after pct102-dev-lead-fix; not for one issue (pct102-qa-verify) or a fresh sweep (pct102-qa-lead-check).
---

# QA Lead: Verify

## Purpose

Stage 3 of `check → fix → verify`: independently prove each fix on the deployed dev environment and close what is proven.

## Run

From the project root, with `QA_ENV_URL`, `AGENT_CMD`, and optionally `PR_BASE` in `.sdlc/autopilot.env`:

`node ${AI_SKILLS_HOME}/tools/sdlc-daily.mjs verify`

Then read the report (`.sdlc/daily/verify-<date>-<time>.md`) and tell the user: issues verified and closed, issues failed (`needs-fix`: what is still wrong, with the evidence), issues skipped and why (fix PR not merged yet, dev not deployed yet: they stay `ready-for-test` for the next run), follow-up defects the agent drafted, and any issue with **0 images attached**.

## What it does

For each open `ready-for-test` issue the script first checks, with no tokens spent, that the fix PR is merged into `PR_BASE` and that the branch's deploy status is `success`. Only then it launches `AGENT_CMD` with the qa-verify prompt (`--env <QA_ENV_URL> --close`): it re-runs the original check on the deployed URL, sweeps neighbouring pages, comments the verdict with its own screenshots, labels `verified` or `needs-fix`, and closes on a pass. It also looks at the other open `auto-fix` issues: when one fix resolved them too, they are verified in the same pass.

## Limits and boundaries

Tests only the host in `QA_ENV_URL`, safe mode. The agent never edits the app. A fix that is not live is never marked: it is skipped. New defects found become drafts for the user, not filed issues, unless the user says otherwise. Images use `gh image` (browser GitHub session) on the user's machine.
