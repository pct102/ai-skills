---
name: pct102-qa-lead-check
description: Lead QA sweep of a project's deployed dev environment. Crawls QA_ENV_URL plus the pages listed in QA_URLS with ui-qa, groups what it finds by what a fixer changes together, files each group as one complete GitHub issue (labels ui-qa, auto-fix) with screenshots, and writes a detailed markdown report. Runs until done, then stops. Use to open the day's issues for a project; not for fixing them (pct102-dev-lead-fix) or testing one issue (pct102-qa-verify).
---

# QA Lead: Check

## Purpose

Find UI defects across the whole app and file them as **few, complete, non-overlapping issues**, so one fix does not silently close three tickets. Stage 1 of the loop `check → fix → verify`; each stage reads issue labels, so any can be rerun.

## Run

From the project root, with `QA_ENV_URL` (and optionally `QA_URLS`, `MAX_NEW_ISSUES`, `QA_SCOUT_MAX_PAGES`) in `.sdlc/autopilot.env`:

1. **Preview first** when unsure: `node ${AI_SKILLS_HOME}/tools/sdlc-daily.mjs check --dry-run` writes the drafts and the report, files nothing. Show the user the drafts and ask before filing.
2. **File:** `node ${AI_SKILLS_HOME}/tools/sdlc-daily.mjs check`. Filing is outward-facing: the user's request to run this skill is the permission; a dry run is the way to ask first.
3. **Read the report** it prints (`.sdlc/daily/check-<date>-<time>.md`) and give the user the summary: issues created (links), how many problems each holds, which pages were covered, issues skipped because one was already open, and any issue whose **images attached is 0** (the upload failed: say so, do not call it complete).

## How issues are formed

One issue per **area**: runtime errors, color/contrast/dark mode, layout/responsive, interaction/motion, design quality. Each issue lists every problem once with its pages, viewport/theme, expected result and screenshot, plus notes for the fixer. An open issue with the same title is left alone (no daily comment noise). Stable titles: `[ui-qa] <area> on <host>`.

## Limits and boundaries

Black-box and safe mode (GET only, only the host in `QA_ENV_URL`). Uses `gh image` for screenshots, which signs in with the user's browser GitHub session: say so once per session. The crawl misses unlinked pages (list them in `QA_URLS`) and pages behind login. Never edit the app, never touch issues without the `ui-qa` label. If the report shows false positives, tell the user; do not file by hand to "fix" it.
