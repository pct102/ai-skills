---
name: feature-autopilot
description: Runs one feature end to end with no human in the loop. Claude is the feature leader; opencode agents are the builder and the QA. Use when the user wants to hand over a feature and come back to a verified result; not for decisions that need product judgment from the user.
---

# Feature Autopilot

## Purpose

The user states a feature once. You (the leader) replace the interview by talking to a
builder agent, write the contract, have the builder implement it, have a separate QA agent
prove it with Playwright evidence, and loop on defects until `sdlc-verify` says `accepted`
or the repair budget escalates.

Roles are separate processes with separate models, so no agent grades its own work:

| role | who | does | never does |
| --- | --- | --- | --- |
| leader | you (Claude) | spec, test contract, slices, review, routing, final report | write product code |
| builder | `oc-agent.sh builder` (one lane per slice) | design, implementation, its own unit tests, fixes | write the e2e suite, decide acceptance |
| qa | `oc-agent.sh qa` | write the Playwright suite from the test contract, run it, screenshots, bug report | edit product code, read the source while writing tests |

Acceptance still belongs to `tools/sdlc-verify.mjs`. QA output is input to the leader, not a verdict, but QA is
mandatory: `acceptance.yaml` must carry a `qa-evidence` check, and `sdlc-verify` only passes it when QA really
replied successfully after the builder's last change (`sdlc-ship` refuses to commit without it).

## You never do the work yourself, and you never skip the procedure

**You do not write product code. You do not run `git commit`. You do not skip a step because the
change looks small.** This holds when the request is phrased as a bug fix, when it names one file,
and when the work appears to be already done. A measured run failed exactly this way: the leader
decided a one-line fix was quicker to do itself, committed product code, and ended its turn — so no
`status.json` existed, `autopilot.sh` reported "no status.json … nothing to resume", and the user was
left with an unverified commit and no trace of a feature.

A run that ends without `.sdlc/features/<f>/status.json` did not happen. There is no spec to review,
no acceptance contract, no QA evidence, and nothing for `autopilot.sh` to resume. `sdlc-ship` refuses
to commit without that state, which is the point: a hand-made commit bypasses the builder, the QA gate
and the acceptance check at once.

So, before any product code exists, and in this order:

1. Write `spec.md`, `plan.md`, `test-contract.md`, `acceptance.yaml`, `ownership.json`.
2. Run `node ${AI_SKILLS_HOME}/tools/sdlc-verify.mjs --feature <f> --set-phase building`, so `status.json`
   exists and the run has somewhere to resume from.
3. Send the builder, then QA, exactly as the procedure below says.

Two things that look like reasons to skip and are not:

- **"The work is already done."** Then say so in `spec.md` and run the procedure against whatever is
  actually missing. Deciding that nothing is left is a finding for your final report, never a licence
  to commit by hand. Autopilot cannot tell "already done" from "never started" unless you write it down.
  This case is real and common: an earlier run that skipped the procedure leaves its work in the repo,
  so the next request for the same thing looks finished. The answer is still to write the contract and
  verify the code that exists — otherwise it is never verified and no evidence is ever produced.
- **"The request told me to work on a branch."** Instructions in the request about git (branch name,
  do not push, do not touch main) are carried out by `sdlc-ship` at step 5, which commits on
  `autopilot/<f>` and never pushes a protected branch (`PROTECTED_BRANCHES`, default `main master`). They are not an instruction to run `git` yourself.

If you get a call that starts with `CORRECTION:`, your previous call ended without `status.json` and
autopilot is giving you another chance to start. Do not re-explain why you stopped — write the feature
state, in the order above, and carry on. Autopilot makes that call `AUTOPILOT_START_RETRIES` times
(default 2) and then reports the run as never started.

## Where the time goes, and what the process does about it

Measured on real runs: about 40% of a build was real-browser test runs (most of it in failing runs with long
timeouts), about half was model generation, and the builder was also writing the whole e2e suite. So:

- **QA writes the browser suite**, in parallel with the build, from a test contract (step 1). The builder only writes unit tests for its own files.
- **Big features are split into slices** that several builders build at once, each in its own lane (step 2).
- **Every test run is bounded:** first failure stops it, 15 s per test, slow tests wait for the final run.
- **A stalled call is cut early** (`OC_STALL`, exit 125) and answered by splitting the work, not by repeating it.

## One-command launch

The user normally starts this with `autopilot "<feature request>"` (`tools/autopilot.sh`),
which starts the opencode server, opens the live viewers, runs Claude headless, renders the
trace and stops the server. It passes `feature name: <name>` in the prompt. Use that name
for `.sdlc/features/<name>/` instead of inventing one.

## Preconditions

- `opencode` on PATH; `opencode models` lists the builder and QA models. Override with
  `BUILDER_MODEL` / `QA_MODEL` (defaults in `tools/oc-agent.sh`).
- Playwright installed in the project (`npx playwright --version`). If not, the first QA round installs it.
- Run Claude headless with permissions skipped, in a clean branch or worktree:
  `claude -p "/feature-autopilot <feature request>" --dangerously-skip-permissions`

If a precondition fails, report it and stop. Do not fall back to doing the builder's or QA's job yourself.

## Autonomous question policy

Do not ask the user. For every question the interview would ask:

1. Answer it from the repo, `.sdlc/intent.md`, or `stack.md` when possible.
2. Otherwise put it to the builder as a design question, take the best-argued answer, and
   append `Q / chosen / why` to `.sdlc/decisions.md`.
3. Hard stops (write `blocked_reason`, report, exit): production deploy, destructive data
   action, billing or credential change, missing credentials, a requirement that
   contradicts `intent.md`, or scope growing beyond the stated feature.

## Procedure

Prompts go in `.sdlc/features/<f>/.oc/prompts/NN-<name>.md`. Call:
`bash ${AI_SKILLS_HOME}/tools/oc-agent.sh <builder|qa> <f> <prompt-file>`

A call can take many minutes (a build or a QA run drives a real browser), and the Bash tool
kills a foreground command after at most 10 minutes. Use two modes:

- **Short calls** (spec questions): run in the foreground, Bash `timeout: 600000`.
- **Builds and QA**: start the call detached, then poll. Never use `run_in_background`.
  ```bash
  bash ${AI_SKILLS_HOME}/tools/oc-agent.sh --async <role> <f> <prompt-file>   # returns at once
  bash ${AI_SKILLS_HOME}/tools/oc-agent.sh --wait  <role> <f> 500             # foreground, Bash timeout: 600000
  ```
  `--wait` prints the reply and exits with the call's exit code when it is done. Exit `75` means
  *still running*: call `--wait` again, straight away. Exit `70` means the call died without a result.

**Never end your turn while a call is pending.** You run headless (`claude -p`): when you stop
calling tools the whole run exits and kills anything you started. "I will wait for the
notification" is the failure; call `--wait` in a loop instead. Check on a slow call by reading
the tail of `.oc/<role>-N.jsonl` between waits. If one call passes about 45 minutes with no
new output, stop and report it instead of waiting forever.

**Lanes.** Parallel work uses `--lane <name>` (a slice id, or `e2e` for QA's suite). Each lane has its own session and
files under `.oc/lane-<name>/`, and shows in the trace as `builder-<name>` / `qa-<name>`:

```bash
bash ${AI_SKILLS_HOME}/tools/oc-agent.sh --lane core --async builder <f> <prompt-file>
```

Start every lane that is ready, then wait for **all lanes with one command**, not one `--wait` per lane. Every tool call
you make re-reads your whole context, so one call that covers every lane is much cheaper:

```bash
bash ${AI_SKILLS_HOME}/tools/oc-wait.sh <f> 500       # foreground, Bash timeout: 600000
```

It returns as soon as any call finishes, printing for each finished call a header (`== builder-ui call 1: rc=0 after 1829s.
Full reply: <path> ==`) and the last 40 lines of its reply; read the full file only if you need it. It also lists the lanes
still running. Exit `0` = finished, all rc 0 | `1` = a finished call had a non-zero rc (see its header) | `70` = a worker
died without a result | `75` = nothing finished in time: call it again at once | `76` = nothing is running. Each finished
call is reported once. Do not start more lanes than 3 at once (free models have unknown concurrency limits).

`OC_TIMEOUT` (default 1800 s) bounds one call and exits `124` with the partial reply. `OC_STALL` (default 600 s)
ends a call that wrote nothing new for that long and exits `125`.

On `124`, `125`, or any non-zero exit:

1. Read `.sdlc/features/<f>/.oc/[lane-<n>/]<role>.err` and the last lines of the newest `<role>-N.jsonl`: what was it doing?
2. **Do not just send "continue".** A call that hit the clock usually had too much to do or a command that hangs.
   - `125` or a hung command: tell it which command hung and to skip or bound it.
   - `124` after steady output: the piece was too big. Cut what is left into smaller pieces (new slices in
     `slices.json`, or two prompts) with a stated budget each, and send those.
   - Never resend the same prompt (it duplicates work in the same session).
3. Two failed calls in a row for the same lane: stop that lane and report the error text verbatim.

### 1. Spec by dialogue (max 3 rounds)

1. Inspect the repo; write a draft `spec.md` (outcome, users, flows, edge cases, non-goals).
2. Send the draft to the builder: ask for gaps, risks, edge cases, and a file-level design.
   The builder keeps its session, so later calls need not repeat context.
3. Resolve each point per the question policy. Stop when a round yields no new blocking point.
4. Write, using the templates in `${AI_SKILLS_HOME}/skills/feature-lifecycle/references/` and `${AI_SKILLS_HOME}/skills/feature-autopilot/references/`:
   - `plan.md`, including an **Interfaces** section when you will slice (names, signatures, events, data shapes that cross a boundary).
   - `test-contract.md` (`test-contract-template.md`): how to open the thing, the stable hooks, one row per observable
     behaviour with a `fast` or `slow` tier. Behaviours only, never implementation. This is what QA builds from.
   - `acceptance.yaml`: the unit/lint/typecheck/build checks, plus a `qa-evidence` check whose `cmd` runs the full e2e suite.
      **Security gate:** when the feature touches auth, database, storage, files, payments, or user-generated
      content, also add a `kind: security` check running
      `node "$AI_SKILLS_HOME/tools/security-scan.mjs" . --severity high` (see `skills/security-audit/SKILL.md`).
      The leader owns this gate: a feature that ships with the scanner red is not accepted, regardless of how
      well the e2e suite passes.
   - `ownership.json`: must cover the product files **and** `e2e/<f>/**`.
5. `node ${AI_SKILLS_HOME}/tools/sdlc-verify.mjs --feature <f> --set-phase building`

### 2. Slice, or not

Read `references/web-app-structure.md`. **Slicing is the default.** A real run gave one builder a seven-file refactor: it
needed 45 minutes over three calls and hit the 30 minute call limit. Slices of the same work are small calls that run together.

`sdlc-verify.mjs --set-phase building` enforces this: if `plan.md` names three or more source files (tests and e2e files do not
count), it refuses until there is a `slices.json`, or a decision in the trace that says why one builder is enough:

```bash
node ${AI_SKILLS_HOME}/tools/sdlc-trace.mjs --feature <f> --log --from leader --to leader --kind decision --note "no-slice: <a real reason, 10+ characters>"
```

Good reasons: the files cannot be built apart (one tangled module), or each is a few lines. "Simpler", "faster" and "single
builder lane" are not reasons; the measured result is the opposite.

To split: write `slices.json` (`slices-template.json`), then
`node ${AI_SKILLS_HOME}/tools/sdlc-slices.mjs plan <f>`. It refuses overlapping files between slices that can run
together and shows the waves. Fix and rerun until it is clean. When refactoring one big file into modules, the slices own the
new files and all read the same old file; that is fine, none of them edits it. The wiring slice (entry point, `index.html`)
goes last and removes the old code.

### 3. Build and write the e2e suite, in parallel

**Builders.** Loop until `sdlc-slices.mjs status <f>` shows every slice `done`:

```bash
for id in $(node ${AI_SKILLS_HOME}/tools/sdlc-slices.mjs ready <f>); do   # at most 3 at a time
  node ${AI_SKILLS_HOME}/tools/sdlc-slices.mjs start <f> $id
  bash ${AI_SKILLS_HOME}/tools/oc-agent.sh --lane $id --async builder <f> <the slice's brief file>
done
```

Write each brief from `references/brief-builder.md`. **A brief is a short file of pointers, not a copy of the spec**: which
sections of `spec.md` and `plan.md` (by heading) are this slice's job, its `owns`, the interface names, the check command,
and the test discipline in the template. Every word you paste is Claude output you pay for, and the builder reads the
files anyway. Aim for under 25 lines.
Loop `oc-wait.sh <f> 500` until every started lane is reported. When a lane has finished with rc 0, run
`sdlc-slices.mjs done <f> <id>`. It fails the slice if the builder
touched files outside its own, or if the slice's `check` fails; send that report back to the same lane as the
fix prompt (`reset` first), then `done` again. A slice past its `budget_min` is a sign to split it, not to wait.
With no `slices.json` (you logged a `no-slice:` reason), one builder (no `--lane`) builds everything the same way, but in
pieces: no single call may be asked for more than about 3 files or 15 minutes of work. State that budget in the prompt
("stop after X and reply"), and send the next piece as a new call. Never send one prompt that says "build everything".

**QA, at the same time.** Start QA now, before the build finishes, with `references/brief-qa-write.md`:
`oc-agent.sh --lane e2e --async qa <f> <prompt-file>`. Give it `spec.md` and `test-contract.md` only: not `plan.md`, not
the builder's reasoning, and tell it not to read the product source. The suite it writes is black-box, so it can
catch what the builder got wrong. Collect its reply (files, behaviours covered, missing hooks); add any missing
hook to the contract and to the builder's next prompt.

**Join.** When every slice is `done` and QA's suite exists, review the diff yourself against the spec before QA runs
(send back anything out of scope or missing; that costs no QA round). Then run the **final fast checks** yourself
(unit tests, lint, typecheck, build) so QA does not meet obvious breakage.

### 3b. QA run

With `ISSUE_TRACKER` set (github or jira, see `autopilot.env.example`), QA also files each product defect through
`tools/sdlc-issue.mjs`; the ids show up in its defect list. Unset, nothing is sent. Credentials stay outside the repo.

Send the qa lane `references/brief-qa-run.md` (same lane, so it keeps its session): run the fast tier, then
the full suite including `@slow`, capture screenshots, reply with the table and `QA RESULT: PASS|FAIL`.
This reply is what the `qa-evidence` check looks for, and it must come after the builder's last reply.

### 4. Leader review

Do not trust the QA table. Open the screenshots (read the images), re-run the suite
yourself, and run:

`node ${AI_SKILLS_HOME}/tools/sdlc-verify.mjs --feature <f>`

- exit `0` → go to step 5
- exit `1` → each real defect becomes a fix prompt to the builder (repro + expected vs
  actual + screenshot path). Send it to the lane of the slice that owns the file at fault (`sdlc-slices.mjs reset`
  then `start`/`done`), or to the single builder; then run QA again (step 3b). A builder reply after QA's
  last one makes `qa-evidence` fail by design: QA must run again after every fix. Reject QA defects you cannot reproduce
  and say so in `evidence.md`. Reject QA tests that assert nothing meaningful and send
  them back as test defects.
- exit `2` → a manual gate is pending; stop and report it
- escalated → stop and report `blocked_reason` verbatim. Never `--reset-repair`.

### 5. Finish

1. Write `evidence.md` (criteria → screenshot → check result, defects found and fixed) and
   report per the `app-sdlc` completion report using the status from `status.json`.
2. **Diagrams.** Do not draw them here. `autopilot.sh` runs the `feature-diagrams` skill as its own pass
   once you finish, because that step was easy to skip at the end of a long run. It draws the
   architecture and the user workflow from the code, then `tools/sdlc-diagrams.mjs` adds the generated
   ones (the trace, plus the status map while the feature is not accepted) and the hub page `.sdlc/features/<f>/diagrams/index.html`. Name that file
   in your report. If you were not started by `autopilot.sh`, tell the user to run
   `claude -p "/feature-diagrams feature name: <f>" --dangerously-skip-permissions`.
3. **Commit, only if `status.json` says `accepted`** (never for `escalated` or `blocked`)
   and the environment does not set `AUTOPILOT_NO_COMMIT=1`:

   ```bash
   node ${AI_SKILLS_HOME}/tools/sdlc-ship.mjs --feature <f> --dry-run   # read the list first
   node ${AI_SKILLS_HOME}/tools/sdlc-ship.mjs --feature <f>             # add --push only if AUTOPILOT_PUSH=1
   ```

   `sdlc-ship` stages an explicit list: files matching `ownership.json` plus the feature's
   docs; never traces, `.oc/` logs, screenshots, generated state, `.env`, keys or
   `node_modules`. It commits on `autopilot/<f>` when you are on a protected branch (`PROTECTED_BRANCHES` in
   `.sdlc/autopilot.env` or `autopilot.env`, default `main master`), never force-pushes,
   and never pushes a protected branch. It refuses when the project folder is only a subfolder of a larger git
   repository (a branch switch there would change someone else's checkout): report that to the user and
   do not pass `--allow-subdir` on your own. Do not run `git add -A`, `git commit -a` or `git push` yourself.
4. Read its `-` lines. A file the feature should own but is listed as "outside ownership"
   means `ownership.json` was too narrow: fix `ownership.json`, rerun `sdlc-verify`, then ship
   again. Report the files left alone. Do not commit them by hand.
5. The `Trace` section below still applies. Trace files and rendered diagrams are not committed; the
   `architecture.json` and `workflow.json` sources are.

## Trace

Every exchange is recorded in `.sdlc/features/<f>/trace.jsonl`. `oc-agent.sh` logs the
builder and qa traffic itself. Log your own decisions, so a wrong turn can be located (`sdlc-verify` logs each of its own runs):

```bash
node ${AI_SKILLS_HOME}/tools/sdlc-trace.mjs --feature <f> --log --from leader --to leader --kind decision --note "<what and why>"
node ${AI_SKILLS_HOME}/tools/sdlc-trace.mjs --feature <f> --log --from qa --to leader --kind reply --file .sdlc/features/<f>/evidence/<step>.png   # per screenshot you reviewed
```

Run `--render` at the end of every round and at the final report. It writes `trace.md`
(Mermaid sequence diagram) and `trace.html` (diagram plus expandable full messages and
screenshots). Failed calls (`rc` non-zero) show as ❌ and open by default.

To watch live, the user runs in another terminal:
`node ${AI_SKILLS_HOME}/tools/sdlc-trace.mjs --feature <f> --follow`

To also watch the agents themselves, start one opencode server and point every call at it:

```bash
opencode serve --port 4096            # terminal A: the server (confirm the subcommand with `opencode --help`)
opencode attach http://localhost:4096 # terminal B: live TUI of the builder and qa sessions
OC_ATTACH=http://localhost:4096 claude -p "/feature-autopilot ..." --dangerously-skip-permissions
```

Sessions are titled `<feature>/<role>` (`<feature>/<role>-<lane>` for a lane). Set `OC_DIR` to the worktree when the server was
started elsewhere.

## Resuming

`autopilot.sh` starts you again, fresh, when a run stops before `accepted`, `blocked` or `escalated`; the prompt
then starts with `RESUME`. Everything you need is on disk, so do not start over and do not ask the user:

1. Read `status.json`, `spec.md`, `plan.md`, `acceptance.yaml`, `decisions.md`, `trace.jsonl`.
2. Read `sdlc-slices.mjs status <f>` and the newest `.oc/[lane-<n>/]builder-N.md` and `qa-N.md`. A call you started with `--async` may have finished
   after the previous run stopped; its reply is in that file. Use `oc-wait.sh <f>` if lanes are still running (or `oc-agent.sh --wait` for a single call).
3. Compare the spec with the files on disk, then continue from the first step that is not done
   (review, QA, verify, finish). Send the builder only what is still missing.
4. Never end your turn while a call is pending (see Procedure). That is what made the previous run stop.

## Loop bound

The bound is the feature's `budget` in `acceptance.yaml`, enforced by `sdlc-verify`. Default
2 failed validations. Spec dialogue is capped at 3 rounds. Each opencode call has a
timeout (`OC_TIMEOUT`). Hitting any bound is an escalation, not a retry.

## When the leader's own usage window runs out

The leader runs on your Claude plan, so it can hit that plan's limit in the middle of a
feature: `You've hit your session limit · resets 8:10pm (Asia/Saigon)`. `autopilot.sh` reads
every leader call's JSON result (`tools/claude-stop.mjs`) and tells three cases apart — the
turn ended, the window is spent, the call died — and **waits out a spent window instead of
retrying it**, because no retry can succeed before the reset. That wait does not spend one of
`AUTOPILOT_RESUMES`, and it is bounded by `AUTOPILOT_LIMIT_WAITS` and
`AUTOPILOT_LIMIT_MAX_WAIT` (see the header of `autopilot.sh`).

What this means for you, the resumed leader: a gap in `trace.jsonl` with a `leader call N ended
limit` note is a window being waited out, not a failure, and the feature state is exactly where
you left it. Do not re-plan around the gap and do not re-do work that finished before it. If you
were started by hand rather than by `autopilot.sh`, say plainly what the limit was and stop
rather than retrying into it.

An ordinary stop still counts against `AUTOPILOT_RESUMES` as before, so the loop is bounded
either way.

## Scale-out

For several features, run `sdlc-dispatch.mjs --exec` with a command that starts one
headless `claude -p "/feature-autopilot <f>"` per admitted lane, and schedule
`sdlc-resume.sh` as in `app-sdlc`.
