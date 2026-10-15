# pct102-ai-skills

Personal AI software delivery skills.

## Included workflows

- `app-sdlc`: top-level product and project orchestrator
- `feature-lifecycle`: one feature from contract to verified delivery
- `feature-autopilot`: hands-off feature delivery; Claude leads, opencode agents build (in parallel slices when the feature is big) and QA writes and runs the e2e suite from a test contract; QA is a required, machine-checked gate
- `feature-diagrams`: after acceptance, draws how the feature is built and what the user does (Archify)
- `bug-fix`: reproduce, isolate, confirm, regress, fix, verify
- `pct102-frontend-patterns`: frontend component selection, integration, motion, accessibility, and visual QA

`tools/` is the part that decides whether work actually passed. See **The machine layer**
below.

## Install

Keep one clone and link it, so `git pull` updates every agent:

```bash
bash tools/link-skills.sh --hook   # --hook re-links after every git pull (new skills appear)
```

### Project `.gitignore` for autopilot runs

`sdlc-ship` never stages these, but ignoring them keeps `git status` readable:

```gitignore
.sdlc/opencode-server.log
.sdlc/claude/
.sdlc/features/*/.oc/
.sdlc/features/*/trace.*
.sdlc/features/*/evidence/
.sdlc/features/*/evidence.json
.sdlc/features/*/status.json
test-results/
playwright-report/
```

## Dependency model

Reusable capabilities such as `grill-me`, `brainstorm`, `ponytail`, `jev`, `tdd`, and code-review skills are dependency contracts rather than copied implementations. Read `references/dependencies.md` before installing or wiring external skills.

`tools/` has no dependencies beyond Node 18+ and a POSIX shell. That is deliberate: the
component that grants acceptance should not be able to fail to install.

## External references

- `obra/superpowers`: brainstorming, worktrees, plans, subagent execution, TDD, review, verification, and branch finishing
- `mattpocock/skills`: `grill-me`, `grilling`, `tdd`, and `code-review`
- `DietrichGebert/ponytail`: lazy senior developer ladder and intensity modes
- React Bits: frontend component reference catalog
- `public-apis/public-apis`: API discovery and provider evaluation catalog
- `cth9191/site-clone`: authorized site teardown and measured rebuild reference
- `NVIDIA/SkillSpector`: external skill and MCP installation security gate
- `ItsssssJack/SlopMonster`: English user-facing copy quality reference
- `chaseai-yt/claudex-loop`: optional cross-model plan and implementation review
- `microsoft/playwright-mcp`: browser exploration, QA, and visual verification
- `tt-a1i/archify`: validated architecture, workflow, sequence, data-flow, and lifecycle diagrams (vendored, MIT, at `skills/archify/`)
- `garrytan/gstack`: selected product, design, engineering, QA, release, and safety patterns
- `msitarzewski/agency-agents`: selective specialist role catalog
- Local Jev service (`tools/jev-proxy/`, backed by a free Google AI Studio key): bounded `noul`, `choice`, and `score` routing decisions

## Safety: autopilot runs unattended

`autopilot` starts the leader with `claude -p --dangerously-skip-permissions` and the builder/QA with `opencode --auto`, so agents run shell commands and edit files without asking. Run it only on a throwaway branch or git worktree, ideally in a container or VM, and never in a directory holding credentials you care about. The local opencode server gets a random per-run password and listens on `127.0.0.1` only. opencode 2.x only enforces that password on its `/api` routes: measured on 2.0.27, the older routes (`/session`, `/project`, `/config`) answer without it. The server never leaves loopback, but any process on this machine can reach those routes, so run autopilot on a machine you trust.

## Issue tracker (optional)

Set `ISSUE_TRACKER=github` or `jira` in `autopilot.env` and the QA agent files an issue for each product defect it finds, reusing an open one with the same title (`tools/sdlc-issue.mjs`). GitHub uses your `gh auth login`; for Jira set `JIRA_EMAIL` and `JIRA_API_TOKEN` in your shell or in that project's git-ignored `.sdlc/autopilot.env`.

**The tracker is chosen per project**, never globally: leave `ISSUE_TRACKER` unset in the shared `autopilot.env` and set it (plus the Jira site, project and credentials) in `<project>/.sdlc/autopilot.env`, so one project can use GitHub and another Jira. Run the tools from the project root. Source control is separate: commits and pushes use plain `git` against that project's own `origin` (GitHub, GitLab, anything). On Jira, `tools/sdlc-issue.mjs` can also `get` a ticket, list its `comments`, add a `comment` and `attach` evidence files (`--key ABC-123 --attach file`); attachments that look like credentials are refused.

## Configuration and secrets

No keys live in this repo. Copy `autopilot.env.example` to `autopilot.env` (git-ignored) to choose the leader, builder and QA models. Provider logins stay outside the repo (`claude login`, `opencode auth login`); the Jev proxy reads `GEMINI_API_KEY` or `~/.config/jev-cli/gemini_key.txt` (see `tools/jev-proxy/README.md`).

## Repository layout

```text
skills/
  app-sdlc/
  feature-lifecycle/
  bug-fix/
  pct102-frontend-patterns/
  archify/                   ← vendored renderer for diagrams (MIT, pinned; see VENDORED.md)
references/
  dependencies.md
tools/
  sdlc-verify.mjs            ← grants or refuses `accepted`
  sdlc-dispatch.mjs          ← decides which lanes may run in parallel
  sdlc-slices.mjs            ← splits a feature into slices for parallel builders and audits file ownership
  oc-wait.sh                 ← waits for every running lane in one command
  claude-follow.mjs          ← live view of what the leader (headless Claude) is doing, with token totals
  claude-stop.mjs            ← why a leader call ended, and how long to wait when the usage window is spent
  sdlc-resume.sh             ← the scheduled, unattended pass
  autopilot.sh               ← `autopilot "<request>"`: server, live viewers, Claude, trace
  link-skills.sh             ← symlink skills/* into ~/.claude/skills (Claude + opencode read it)
  sdlc-issue.mjs             ← QA files/looks up a GitHub issue or Jira ticket per product defect (opt-in)
  sdlc-ship.mjs              ← commits one accepted feature: owned files only, never a protected branch (`PROTECTED_BRANCHES`)
  sdlc-diagrams.mjs          ← trace + status as Archify diagrams, one hub page per feature
  oc-agent.sh                ← calls an opencode builder/qa agent, keeps its session
  selftest/                  ← run-all.sh is the gate for the three tools above
```

The repository is intentionally source-oriented. An installer or agent-specific adapter can later copy or link these skills into a target project.

## The machine layer

`skills/` says what should happen. `tools/` decides whether it did. The split matters: an
agent that reads only the skills can talk itself into believing a feature is finished.

| file | owns | refuses to be overridden by |
| --- | --- | --- |
| `.sdlc/features/<f>/acceptance.yaml` | the definition of done | an agent's summary |
| `.sdlc/features/<f>/ownership.json` | which paths a lane may edit | prose in `plan.md` |
| `.sdlc/features/<f>/status.json` | the phase, the repair count, gate approvals | a self-reported status |
| `.sdlc/features/<f>/evidence.json` | the recorded check results | a claim that checks passed |

`evidence.md` is written for a human. It is never evidence on its own.

```bash
# does this feature actually pass?
node tools/sdlc-verify.mjs --feature <name>

# which lanes may run at the same time?
node tools/sdlc-dispatch.mjs

# unattended pass: resume what was interrupted, escalate what is stuck
bash tools/sdlc-resume.sh --run --exec '<command with {feature} and {worktree}>'
```

`sdlc-verify` exits `0` all passed, `1` something failed, `2` a human gate is pending,
`3` the contract or state is invalid. `sdlc-resume` exits `2` it did work, `1` a human is
needed, `0` nothing to do.

### Why the repair budget is a number

`status.json` counts failed validations against the feature's `budget` and moves the lane
to `escalated` on its own. An escalated lane does not recover by being re-run. Only
`--reset-repair` returns it to `validating`, and that is a triage decision for a person.

The alternative — a loop that retries until it happens to pass — is how an unattended run
quietly burns a day of tokens and reports success. See
`skills/app-sdlc/references/state-schema.md`.

### Why ownership is a file

Parallel lanes are only safe if the collision check is mechanical. `sdlc-dispatch` compares
the static directory prefixes in every `ownership.json` and defers overlapping lanes with a
`file_conflict:<lane>` reason. It is deliberately conservative: it may defer a lane that
would have been safe, and it will never admit two lanes that might touch the same file.

### Tests

```bash
bash tools/selftest/run-all.sh
```

76 assertions covering the three guarantees that make the rest trustworthy: acceptance
cannot be granted by accident, a failing lane cannot loop forever, and a parallel lane
cannot silently collide. A change to `tools/` that breaks them has broken the guarantee
that `accepted` means verified.

## License

MIT, see `LICENSE`. Vendored `skills/archify/` keeps its own license.
