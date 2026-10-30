---
name: pct102-daily-loop
description: Runs the unattended daily QA loop for one project: a scout stage crawls the deployed dev URL with ui-qa and files new issues, a dev stage runs pct102-dev-fix on each auto-fix issue and gate-merges its PR into dev, a qa stage runs pct102-qa-verify on each ready-for-test issue and closes it when the fix is live. Use to set up, run or debug the loop, or to change its schedule and limits; not for fixing or verifying a single issue (use pct102-dev-fix or pct102-qa-verify).
---

# Daily Loop

## Purpose

`ui-qa` finds defects, `dev-fix` fixes them, `qa-verify` proves and closes them. This skill chains them every day with no one watching. The stages are driven by **issue labels, not by the clock**, so a late or repeated run is harmless.

```
scout (05:00)   ui-qa crawl of QA_ENV_URL + QA_URLS  -> new issues [ui-qa, auto-fix]
dev   (09:00)   dev-fix per auto-fix issue            -> PR into dev -> merge gate -> [ready-for-test]
qa    (15:00)   qa-verify per ready-for-test issue    -> [verified] + comment with images + issue closed
                 FAIL -> [needs-fix] -> the next dev stage retries, at most MAX_FIX_ATTEMPTS, then [needs-human]
```

## Run it

From the project root, with `.sdlc/autopilot.env` set (see `autopilot.env.example`): `QA_ENV_URL`, `AGENT_CMD`, optional `QA_URLS`, `PR_BASE`, limits.

```
node ${AI_SKILLS_HOME}/tools/sdlc-daily.mjs scout | dev | qa
node ${AI_SKILLS_HOME}/tools/sdlc-daily.mjs merge <pr>     # the merge gate alone
node ${AI_SKILLS_HOME}/tools/sdlc-daily.mjs install        # writes launchd plists for the three times; prints the launchctl lines
```

`install` loads nothing: the user runs the printed `launchctl bootstrap` lines. The Mac must be awake; a missed calendar time runs when it wakes. Every stage appends to `.sdlc/daily/<date>.md`; agent output goes to `.sdlc/daily/logs/`.

## What each stage does

- **scout**: no LLM. `ui-qa` crawls `QA_ENV_URL` (depth 2, `QA_SCOUT_MAX_PAGES`) and each `QA_URLS` entry, then files issues with `--new-only`: an open issue with the same title is left alone, so there is no daily noise. Caps: `MAX_NEW_ISSUES`.
- **dev**: for each open `auto-fix` issue not yet `ready-for-test`/`needs-human`, runs `AGENT_CMD` with the dev-fix prompt in a **git worktree** off `origin/<PR_BASE>`, so the user's checkout is never touched. One issue at a time: dev-fix starts the app for evidence, so parallel fixers would fight over ports. Then the **merge gate** decides.
- **qa**: for each `ready-for-test` issue, only if its fix PR is merged and the dev branch deploy is `success` (a script check, no tokens), runs `AGENT_CMD` with the qa-verify prompt `--env <QA_ENV_URL> --close`.

## Merge gate (deterministic)

Merges (squash) only if: PR open, base is `PR_BASE` and not a protected branch, head is `fix/*`, no conflicts, at most `MERGE_MAX_FILES` files and `MERGE_MAX_LINES` lines, no protected path (`.github/`, `.env*`, `vercel.json`, `package.json`/lockfile, migrations, supabase, middleware: `MERGE_BLOCK_PATHS`), and every non-Vercel check passes with at least one present (`MERGE_REQUIRE_CI=0` to waive). Vercel checks are ignored: skipped or failing preview builds say nothing about the code. Otherwise the PR stays open, the issue gets `needs-human` and a comment saying why. `main` is never touched.

## Safety

Only issues labelled `auto-fix` are touched, so a person's own issues are left alone. Only the one host in `QA_ENV_URL` is tested, safe mode (GET only). Nothing is pushed except `fix/*` branches. A lock file stops two stages from overlapping. `AGENT_CMD` must be able to run git, gh and node; granting that is the user's call, and an unattended agent can do whatever its permissions allow, so use a CLI and permission mode you trust. Image upload uses `gh image` and the browser GitHub session, so it works only on the user's own machine while signed in.

## Limits

Crawl finds only linked pages (list the rest in `QA_URLS`); pages behind login need a `--auth` state and are not covered yet. The loop fixes small UI defects, not features. If the repo has no CI workflow the gate refuses every PR: copy `references/github-ci.yml` to `.github/workflows/ci.yml` first.
