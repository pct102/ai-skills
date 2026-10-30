---
name: pct102-dev-lead-fix
description: Lead dev pass over a project's open auto-fix GitHub issues. Takes them one by one, runs a fresh agent with pct102-dev-fix on each in its own git worktree (fix, before/after screenshots, PR into the dev branch, ready-for-test), merges each PR only through a deterministic gate, and writes a detailed markdown report. Runs until the queue is empty, then stops. Use after pct102-qa-lead-check, or to clear a backlog of auto-fix issues; not for one issue (pct102-dev-fix) or features (feature-autopilot).
---

# Dev Lead: Fix

## Purpose

Stage 2 of `check → fix → verify`: turn every open `auto-fix` issue into a merged fix on the dev branch, with proof, without the user babysitting.

## Run

From the project root, with `AGENT_CMD` (for example `opencode run`: the command that takes a prompt as its last argument), and optionally `PR_BASE` (default `dev`), `MAX_DEV_ISSUES`, `MAX_FIX_ATTEMPTS`, `AGENT_TIMEOUT_MIN`, merge limits in `.sdlc/autopilot.env`:

`node ${AI_SKILLS_HOME}/tools/sdlc-daily.mjs fix`

Then read the report (`.sdlc/daily/fix-<date>-<time>.md`) and tell the user: issues fixed and merged (issue, PR, files), issues left (and why: out of scope, cannot reproduce, checks failed, gate refused), issues handed to a person (`needs-human`), and any issue with **0 images attached**.

## What it does per issue

Skips issues already `ready-for-test`, `needs-human` or `verified`. Counts attempts with `fix-attempt-N` labels: after `MAX_FIX_ATTEMPTS` the issue goes to `needs-human`. Creates a worktree off `origin/<PR_BASE>` (the user's checkout is never touched), runs the agent with the dev-fix skill (before/after screenshots, checks, fix branch pushed, PR opened, evidence comment, `ready-for-test`), then runs the **merge gate**.

## Merge gate

Squash-merges only if the PR is open into `PR_BASE` (never `main`), head is `fix/*`, no conflicts, within `MERGE_MAX_FILES`/`MERGE_MAX_LINES`, touches no protected path (`.github/`, `.env*`, `vercel.json`, `package.json`, lockfiles, migrations, middleware), and every non-Vercel check passes with at least one present. Otherwise the PR stays open and the issue gets `needs-human` plus a comment with the reason. Run the gate alone with `sdlc-daily.mjs merge <pr>`.

## Limits and boundaries

One issue at a time (dev-fix starts the app for screenshots; parallel runs would fight over ports). `AGENT_CMD` runs unattended with whatever permissions its CLI is given; the user chose that. Only `auto-fix` issues are touched. Never push anything but `fix/*`, never merge into `main`, never close issues (verify does).
