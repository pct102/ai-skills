---
name: pct102-ui-qa
description: Black-box UI QA of a running web app from its URL alone. Crawls pages, then checks clicks, dropdowns, scroll, keyboard focus, drag, live resize, four responsive viewports, dark mode, contrast and transitions, and drafts GitHub issues for what breaks. Use when the user gives a URL (localhost or staging) and wants its UI tested; not for reading source code, backend-only work, or business-logic tests.
---

# UI QA

## Purpose

Test what a person sees and does, given only a URL. No source is read, so it costs minutes, not a repo scan, and works on any stack. It finds observable defects; it cannot know whether a result is *correct* for the business.

## Input

`<url>` (required). Optional: `--depth 1`, `--max-pages 5`, `--max-clicks 25`, `--auth <storageState.json>` (pages behind login), `--issue-min medium|low|high`, `--out <dir>`.

The engine is `${AI_SKILLS_HOME}/tools/ui-qa.mjs` (deterministic, no tokens spent). This skill runs it, then adds the judgment a script lacks.

## Workflow

1. **Safety gate.** Only localhost, private IPs or a staging URL the user named. If the URL looks like production, stop and ask; `--allow-remote` is the user's call, `--allow-destructive` (unblocks POST/DELETE and delete/pay/submit buttons) only on explicit request. Never fill or submit forms.
2. **Run** from a project that has Playwright (`npm i --no-save playwright && npx playwright install chromium` otherwise):
   `node ${AI_SKILLS_HOME}/tools/ui-qa.mjs <url> [flags]`
   Exit 1 means high-severity findings, not a crash; a crash prints `ui-qa:` with the cause.
3. **Read** `<out>/report.md` and `findings.json`. For each medium/high finding, open its screenshot (`<out>/screens/…`) and confirm it with your own eyes (method: `skills/feature-autopilot/references/brief-qa-visual.md`). Drop false positives; say which and why. Low findings stay in the report only.
4. **Re-check visually** what the script cannot judge: mid-transition frames, odd spacing, a dark theme that is technically contrasty but ugly, a mobile menu that works but looks broken. Use Playwright MCP (`references/playwright-mcp.md`) for a live look if a screenshot is not enough.
5. **Show the user** the summary (counts, top findings, coverage line, "Not covered") and the issue drafts in `<out>/issues/`. Ask before filing: filing is outward-facing.
6. **File on approval:** `node ${AI_SKILLS_HOME}/tools/ui-qa.mjs file <out> [--with-images]`. Needs `ISSUE_TRACKER=github` (optional `ISSUE_GITHUB_REPO`, `ISSUE_LABELS`) in `./.sdlc/autopilot.env`; with it off nothing is sent. One issue per defect category, listing every page and viewport. An open issue with the same title is reused, and the rerun adds a comment with the new findings.
   - `--with-images` (GitHub only) also uploads up to 4 screenshots per issue with the `gh image` extension and posts them as an evidence comment. That extension signs in with the user's **browser GitHub session cookie** through an unofficial endpoint, so use it only when the user asks for it, say so before the first run, and never print or store the token. Screenshots may show app data: confirm they are fine to upload. If the upload fails the comment lists the local file names instead; say that in your report.
   - Without the flag, screenshot paths stay local.

## What it checks

| Area | How |
|---|---|
| Responsive | 375 / 768 / 1024 / 1440 px: horizontal scroll with the offending element, touch targets under 24px, broken images, live resize on the same page |
| Dark mode | `prefers-color-scheme: dark` pass: contrast failures that appear only in dark, pages that ignore it, theme-toggle button re-checked in its toggled state |
| Events | Hover + click every safe control (blocked by overlay, no visible response, dialog ignores Esc), every `<select>` option, `[draggable]` drag, scroll to bottom (layout shift), Tab through focus stops |
| Transitions | Transitions/animations over 800ms after hover or click; animations that ignore `prefers-reduced-motion` |
| Health | Uncaught exceptions, console errors, 4xx/5xx and failed requests, pages returning errors |

Severity: high = crash, exception, page error, 5xx. Medium = console error, overflow, broken image, contrast under 3:1, blocked control, big layout shift. Low = everything else. Issues default to medium and above.

## Limits (say them to the user)

- Canvas/WebGL content, business-logic correctness, forms and anything behind login (without `--auth`) are not covered; drag only runs on `draggable` elements.
- "Click changed nothing" is a hint, not proof. Contrast skips text over images and gradients.
- Images need the `gh image` extension and a browser signed in to GitHub; Jira gets text only.
- First run has no baseline, so no pixel diff; it reports absolute defects only.
- The crawl follows same-origin links to `--depth`/`--max-pages`; a big app needs a few runs on chosen URLs.

## Boundaries

Do not edit the app to make findings go away; report them. For a confirmed defect the user wants fixed, hand off to `bug-fix`. Use `pct102-frontend-patterns` when the question is how to build the UI, not whether it works.
