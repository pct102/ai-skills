# Matt Pocock Skills Reference

Source: `https://github.com/mattpocock/skills` (MIT, plugin `mattpocock-skills` 1.3.1, all 27 skills installed at user scope)

## Use

These skills are installed, not copied here (see `dependencies.md`). This page says which ones this repository leans on, which overlap
with `tools/`, and which are worth wiring next. Where a skill and a `tools/` gate disagree, the gate wins: `tools/` decides whether it did.

## Already adapted

`grill-me`, `grilling`, `grill-with-docs` (`pct102-grill-me`), `tdd` (`pct102-tdd`), `code-review` (`pct102-review-code`),
`diagnosing-bugs` (`bug-fix`), `prototype`, `research`, `domain-modeling`, `codebase-design`, `wizard`, `writing-for-agents`.

## Added to the contract

| Skill | What it does | Where it fits here | Verdict |
| --- | --- | --- | --- |
| `retro` | Reads a session's logs and proposes environment fixes: navigation, automated checks, standards, tool economy, no-ops | Run on a finished autopilot run (`trace.jsonl`, `status.json`, `evidence.json`). The homeplan `s2-4` analysis was this by hand | **Adopt now**, manual |
| `git-guardrails-claude-code` | PreToolUse hook that blocks `git push`, `reset --hard`, `clean -f`, `branch -D`, `checkout .` | Autopilot runs the leader with `--dangerously-skip-permissions`; this is the missing safety net. Not in the plugin (lives under `skills/misc/`) | **Adopt**, after checking its `reset --hard` rule against worktree resets |
| `handoff` | Writes a redacted hand-off document to `$TMPDIR` with suggested skills | Overlaps `sdlc-resume-context`; keep ours for runs, use this for interactive sessions | Optional |
| `to-spec`, `to-tickets`, `implement-spec`, `implement` | Conversation to spec to tracer-bullet tickets with blocking edges to parallel implementers on an integration branch | Same shape as `slices.json` (`owns`, `depends`, waves) plus `sdlc-slices`. Ours adds the file-ownership audit and the machine gates; theirs adds an issue-tracker front end | **Do not replace**; borrow the tracer-bullet rule for slice planning |
| `triage` | State machine over issues and external PRs, writes agent-ready briefs | `sdlc-issue.mjs` files defects but does not triage them | Optional, only for projects with a real tracker |
| `wayfinder` | Plans work bigger than one session as a map of decision tickets | Roadmap-level work above one autopilot feature (`.sdlc/roadmap.md`) | Optional |
| `improve-codebase-architecture` | Scans for deepening opportunities, HTML report, then grills | Pairs with `archify`; run before planning a large feature | Optional |
| `ask-matt` | Router over the skills above | Not needed; `app-sdlc` already routes | Skip |
| `wait-what`, `teach`, `to-questionnaire`, `setup-*`, `in-progress/*` | Conversation or setup helpers; `in-progress` is unstable upstream | No autopilot role | Skip |

## Ideas for autopilot, not built

1. **Retro as the last pass.** After `accepted`, a short pass that applies the `retro` categories to the run's trace and writes `retro.md`
   next to `evidence.md`. The `repair_iterations_used` field now keeps the data this needs.
2. ~~Guardrail hook for the leader.~~ Done: `tools/hooks/leader-git-guard.sh`, passed to the leader with `--settings` in `autopilot.sh`, so
   interactive sessions are untouched. `sdlc-ship` pushes from its own process and is not affected. Builders (opencode) are not covered.
3. **Tracer-bullet check in `slices.json`.** `to-tickets` requires each slice to be a complete vertical path that is verifiable alone.
   `sdlc-slices plan` checks overlap only; a slice that is a horizontal layer is not flagged.
