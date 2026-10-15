#!/usr/bin/env bash
# autopilot [--push] [--no-commit] [--no-diagrams] "<feature request>"
# autopilot --resume <feature>
#   Runs /feature-autopilot with live viewers (macOS Terminal). If Claude stops before the feature is
#   accepted, blocked or escalated, autopilot waits for any builder/QA call still running, then starts a fresh
#   Claude that resumes from what is on disk (up to AUTOPILOT_RESUMES times, default 3).
#   --resume <feature>  skip the request and resume that feature now (name as in .sdlc/features/).
#   After an accepted feature the leader commits it on a branch (autopilot/<feature>) via sdlc-ship.
#   --push       also push that branch (never a protected branch, see PROTECTED_BRANCHES in autopilot.env). Default: commit locally, no push.
#   --no-commit  leave everything uncommitted.
#   --no-diagrams  skip the extra Claude pass that draws the architecture and workflow diagrams from the code
#                  (the trace diagram, and the status diagram while the feature is not accepted, are generated from
#                  recorded facts and always made).
#   When the plan's usage window is spent ("You've hit your session limit · resets 8:10pm (Asia/Saigon)") the run
#   waits for the window to reopen and then resumes, instead of spending its resumes on calls that cannot succeed.
#   AUTOPILOT_LIMIT_WAIT=0 turns the waiting off; AUTOPILOT_LIMIT_WAITS (default 4) bounds how many times one run
#   waits; AUTOPILOT_LIMIT_MAX_WAIT (default 21600 s) is how far ahead it will wait before telling you to resume
#   later by hand. Each leader call is classified in .sdlc/claude/leader-<n>.json and recorded in the trace.
#   A leader that ends without writing .sdlc/features/<f>/status.json never started the feature, so there is
#   nothing to resume. Measured on real runs, that happens when the leader judges the request "already done"
#   and ends its turn. Rather than only report it, autopilot tells the leader what is missing and asks it to
#   start, up to AUTOPILOT_START_RETRIES times (default 2); set it to 0 to report on the first ended call.
#   On macOS four Terminal windows follow the run (opencode, trace, the leader, and the local jev proxy's log
#   when jev is set up). When the feature ends accepted they are closed together; when it does not, they stay
#   open so you can read what happened. AUTOPILOT_KEEP_WINDOWS=1 keeps them open anyway, AUTOPILOT_NO_CLAUDE_WINDOW=1
#   leaves the leader window out, AUTOPILOT_NO_JEV_WINDOW=1 leaves the proxy log out and JEV_PROXY_LOG points at
#   another log. Each close waits for Terminal to report its tab idle (up to AUTOPILOT_CLOSE_WAIT ticks of
#   0.25 s) so it does not raise the "terminate running processes?" dialog.
# Add to ~/.zshrc:  alias autopilot='bash ~/pct102-ai-skills/tools/autopilot.sh'
set -euo pipefail
export AI_SKILLS_HOME=${AI_SKILLS_HOME:-$(cd "$(dirname "$0")/.." && pwd)}
resume=""
while :; do
  case "${1:-}" in
    --resume) resume=${2:?--resume needs a feature name}; shift 2 ;;
    --push) export AUTOPILOT_PUSH=1; shift ;;
    --no-commit) export AUTOPILOT_NO_COMMIT=1; shift ;;
    --no-diagrams) export AUTOPILOT_NO_DIAGRAMS=1; shift ;;
    *) break ;;
  esac
done
if [ -n "$resume" ]; then
  feat=$resume; req=""
  [ -d ".sdlc/features/$feat" ] || { echo "no .sdlc/features/$feat in $PWD" >&2; exit 3; }
else
  req=${1:?usage: autopilot [--push] [--no-commit] [--no-diagrams] "<feature request>"   |   autopilot --resume <feature>}
  feat=$(printf %s "$req" | tr A-Z a-z | tr -cs a-z0-9 - | sed 's/^-//;s/-$//')
  [ ${#feat} -gt 44 ] && feat=$(printf %s "${feat:0:44}" | sed 's/-[^-]*$//')   # cut at a word boundary
  feat=${feat:-feature-$(date +%H%M%S)}
fi
port=$(node -e 's=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
url=http://127.0.0.1:$port

mkdir -p .sdlc
# The server can run shell commands for whoever reaches it, so it gets a per-run password (inherited by oc-agent).
export OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD:-$(openssl rand -hex 16)}
opencode serve --port "$port" >.sdlc/opencode-server.log 2>&1 &
trap 'kill $! 2>/dev/null || true' EXIT
sleep 3

win_ids=(); win_ttys=(); win_pats=()
# Opens a Terminal window running $1 and remembers its id, tty, and a pattern that matches its own
# command line, so it can be stopped and closed again at the end.
open_window() {   # <command> <pattern>
  local out
  out=$(osascript -e 'tell application "Terminal"' -e "do script \"cd '$PWD' && export OPENCODE_SERVER_PASSWORD='$OPENCODE_SERVER_PASSWORD' && $1\"" -e 'set w to front window' \
          -e 'return (id of w as string) & " " & (tty of selected tab of w)' -e 'end tell' 2>/dev/null) || return 0
  if [ -n "$out" ]; then win_ids+=("${out%% *}"); win_ttys+=("${out#* }"); win_pats+=("$2"); fi
  return 0
}
# The pids attached to a Terminal window's tty.
# `ps -t`, not `pgrep -t`: measured on macOS with a process running on a Terminal window's tty,
# `pgrep -t ttys002` prints nothing before and after the signals, so `pkill -t` was a no-op and the
# windows survived the kill entirely. That is why every close raised the "do you want to terminate
# running processes?" dialog.
tty_pids() { ps -t "$1" -o pid= 2>/dev/null | tr -d ' ' || true; }
# Stops what runs in a window and closes it, without that dialog. Terminal raises the dialog whenever a
# window it is told to close still has a process, and killing is not instantaneous, so: stop the
# processes (by their tty, and by the command line as a second net), wait until Terminal itself reports
# the tab idle — the same flag that raises the question — escalating once to SIGKILL, and close only
# then. A tab that still never settles is closed anyway rather than hanging the run.
close_window() {   # <window id> <tty> <command pattern>
  local id=$1 tty=$2 pat=$3 t=${2#/dev/} pids tick=0 busy
  pids=$(tty_pids "$t")
  if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; fi
  pkill -f "$pat" 2>/dev/null || true
  while [ "$tick" -lt "${AUTOPILOT_CLOSE_WAIT:-16}" ]; do
    busy=$(osascript -e "tell application \"Terminal\" to return busy of selected tab of (first window whose id is $id)" 2>/dev/null || echo false)
    [ "$busy" != "true" ] && break
    if [ "$tick" = 4 ]; then
      pids=$(tty_pids "$t")
      if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null || true; fi
      pkill -9 -f "$pat" 2>/dev/null || true
    fi
    tick=$((tick + 1)); sleep 0.25
  done
  osascript -e "tell application \"Terminal\" to close (every window whose id is $id) saving no" >/dev/null 2>&1 || true
}
# Closes the windows opened above. A window you already closed is skipped, and so is one whose tty now
# belongs to something else, so nothing of yours is ever killed.
close_windows() {
  local i id tty now
  for ((i = 0; i < ${#win_ids[@]}; i++)); do
    id=${win_ids[$i]}; tty=${win_ttys[$i]}
    now=$(osascript -e "tell application \"Terminal\" to return tty of selected tab of (first window whose id is $id)" 2>/dev/null || true)
    [ -n "$now" ] && [ "$now" = "$tty" ] || continue
    close_window "$id" "$tty" "${win_pats[$i]}"
  done
  return 0
}

if [ "$(uname)" = Darwin ]; then
  # four live views: the agents (opencode), the message trace, the leader (what headless Claude is doing,
  # read from Claude's own transcript because `claude -p` prints nothing until it ends), and the local jev
  # proxy's log. The proxy writes both its streams to that file, and it is the service the agents' jev tool
  # talks to — without it in view a run looks like it never routes through the proxy at all. Opened only when
  # that log exists, so a project without jev still gets three windows. The second argument is the pattern
  # that finds each one again when the run ends.
  open_window "opencode attach $url" "opencode attach $url"
  open_window "node '$AI_SKILLS_HOME/tools/sdlc-trace.mjs' --feature $feat --follow" "sdlc-trace.mjs --feature $feat --follow"
  if [ -z "${AUTOPILOT_NO_CLAUDE_WINDOW:-}" ]; then
    open_window "node '$AI_SKILLS_HOME/tools/claude-follow.mjs' --cwd '$PWD' --since $(date +%s)" "claude-follow.mjs --cwd $PWD"
  fi
  jev_log=${JEV_PROXY_LOG:-$HOME/.config/jev-cli/proxy.log}
  if [ -z "${AUTOPILOT_NO_JEV_WINDOW:-}" ] && [ -f "$jev_log" ]; then
    open_window "tail -n 40 -f '$jev_log'" "tail -n 40 -f $jev_log"
  fi
fi

phase_of() { node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).phase||"")}catch{}' ".sdlc/features/$feat/status.json"; }

# The leader's own last words, from the JSON result of a call. A run that ends without status.json is
# otherwise only "nothing to resume", which says nothing about why — measured on a real run where the
# leader quietly did the work itself instead of running the procedure, so the diagnosis was sitting in
# .sdlc/claude/leader-N.json the whole time and nobody was shown it.
leader_said() {   # <json file>
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.result||j.error||"").trim())}catch{}' "$1" 2>/dev/null || true
}

# ---- calling the leader, and telling a spent usage window from an ordinary stop -----------------
# The leader used to be called with its exit code thrown away, so every reason it stopped looked the
# same and the loop below answered all of them by resuming. That is right for a turn that ended, and
# useless for a spent plan window: "You've hit your session limit · resets 8:10pm (Asia/Saigon)"
# cannot be retried, only waited out, so three of those retries burned in seconds and ended the run.
# The call now asks for the JSON result and tools/claude-stop.mjs classifies it:
#   done   the turn ended                -> resume, as before
#   limit  the plan's window is spent    -> wait for the reset, then resume (costs no resume)
#   other  it died for another reason    -> resume, as before
# When the CLI cannot report JSON, or the result cannot be read, the kind comes from the exit code —
# done at 0, other otherwise — which is exactly the behaviour that existed before.
CLAUDE_DIR=.sdlc/claude
claude_stop=done; claude_wait=0; claude_why="the leader has not run yet"; claude_run_n=0
# Read --help into a variable rather than piping into `grep -q`: grep stops at the first match, and
# under `set -o pipefail` the SIGPIPE that gives claude would report the flag as missing.
claude_json=0
. "$AI_SKILLS_HOME/tools/model-setting.sh"
leader_args=(); leader_model=$(model_setting LEADER_MODEL); [ -n "$leader_model" ] && leader_args=(--model "$leader_model")
case "$(claude --help 2>/dev/null || true)" in *--output-format*) claude_json=1 ;; esac

claude_run() {   # <prompt>; sets claude_stop, claude_wait, claude_why
  claude_run_n=$((claude_run_n + 1))
  local n=$claude_run_n rc=0 t0=$SECONDS json err stop_line json_args=()
  mkdir -p "$CLAUDE_DIR"
  json=$CLAUDE_DIR/leader-$n.json; err=$CLAUDE_DIR/leader-$n.err
  [ "$claude_json" = 1 ] && json_args=(--output-format json)
  OC_ATTACH=$url claude -p "$1" --dangerously-skip-permissions ${leader_args[@]+"${leader_args[@]}"} ${json_args[@]+"${json_args[@]}"} >"$json" 2>"$err" || rc=$?
  stop_line=$(node "$AI_SKILLS_HOME/tools/claude-stop.mjs" --rc "$rc" --elapsed "$((SECONDS - t0))" \
    --min-wait "${AUTOPILOT_LIMIT_MIN_WAIT:-30}" --file "$json" --file "$err" 2>/dev/null || true)
  { read -r claude_stop; read -r claude_wait; read -r claude_why; } <<<"$stop_line" || true
  case "$claude_stop" in
    done|limit|other) ;;
    *) claude_stop=$([ "$rc" = 0 ] && echo done || echo other); claude_wait=0
       claude_why="the result could not be read (rc=$rc); see $json" ;;
  esac
  case "$claude_wait" in ''|*[!0-9]*) claude_wait=0 ;; esac
  node "$AI_SKILLS_HOME/tools/sdlc-trace.mjs" --feature "$feat" --log --from leader --to leader --kind note \
    --rc "$rc" --note "leader call $n ended $claude_stop after $((SECONDS - t0))s: $claude_why" 2>/dev/null || true
  echo "autopilot: leader call $n ended '$claude_stop' after $((SECONDS - t0))s — $claude_why"
  return 0
}

# Waits out a spent usage window. Nothing is lost while we wait: the feature's state is on disk, and
# a builder/QA call already running keeps going (wait_for_workers below catches its result when the
# wait is over). Returns 1 when the window is further away than AUTOPILOT_LIMIT_MAX_WAIT (default
# 6 h), so a weekly limit reports instead of holding the terminal for a day.
wait_for_claude_reset() {   # <seconds>
  local left=${1:-0} cap=${AUTOPILOT_LIMIT_MAX_WAIT:-21600} deadline reopen
  case "$left" in ''|*[!0-9]*) left=0 ;; esac
  [ "$left" -gt "$cap" ] && return 1
  deadline=$(( $(date +%s) + left ))
  reopen=$(date -r "$deadline" '+%H:%M' 2>/dev/null || date -d "@$deadline" '+%H:%M' 2>/dev/null || echo '?')
  echo "autopilot: waiting for the leader's usage window to reopen (around $reopen, ${left}s). The feature state is on disk; a running builder or QA call is not lost."
  while :; do
    left=$((deadline - $(date +%s)))
    [ "$left" -le 0 ] && break
    if [ "$left" -gt 300 ]; then sleep 300; else sleep "$left"; fi
    left=$((deadline - $(date +%s)))
    [ "$left" -gt 0 ] && echo "autopilot: still waiting for Claude — about $((left / 60)) min left."
  done
  echo "autopilot: the usage window should be open again; resuming the feature."
  return 0
}

# A builder or QA call started with --async lives on after Claude stops. Stopping the server now would kill it
# and lose its work, so wait for it to finish.
workers_running() {
  local pf r n d top=".sdlc/features/$feat/.oc"
  # the plain builder/qa calls live in .oc/, parallel lanes in .oc/lane-<name>/
  for pf in "$top"/*.pid "$top"/lane-*/*.pid; do
    [ -f "$pf" ] || continue
    d=$(dirname "$pf"); r=$(basename "$pf" .pid)
    { [ -s "$pf" ] && [ -s "$d/$r.current" ]; } || continue
    read -r n _ < "$d/$r.current"
    [ -f "$d/$r-$n.done" ] && continue
    kill -0 "$(cat "$pf")" 2>/dev/null || continue
    if [ "$d" = "$top" ]; then echo "$r"; else echo "$r-${d##*/lane-}"; fi
  done
  return 0
}
wait_for_workers() {
  local limit=$(( ${OC_TIMEOUT:-1800} + 60 )) waited=0 who
  while who=$(workers_running); [ -n "$who" ] && [ "$waited" -lt "$limit" ]; do
    [ "$waited" -eq 0 ] && echo "autopilot: Claude stopped while a call was still running; waiting for it so its work is not lost ($(echo $who))..."
    sleep 5; waited=$((waited + 5))
  done
}

[ -z "$resume" ] && claude_run "/feature-autopilot feature name: $feat. You are the leader of this run: do not write product code and do not run git commit — your first job is the feature state, .sdlc/features/$feat/status.json. Request: $req"

# Claude can stop early: its turn ends, or the plan's usage window is spent. The state is on disk, so
# start a fresh Claude that continues from it, a bounded number of times. accepted, blocked and
# escalated are the only real endings. A spent window is waited out rather than retried, and does not
# spend a resume, so a limit no longer ends the run the way it used to.
tries=0; limit_waits=0; start_tries=0
while :; do
  wait_for_workers
  p=$(phase_of)
  case "$p" in
    "")
      # No status.json means the leader never started the feature: no spec, no acceptance contract,
      # nothing to resume. A measured run reaches this by judging the request "already done" and ending
      # its turn — the code may even exist, but none of it was verified and no evidence is on disk. So do
      # not only report it: tell the leader what is missing and give the run a bounded number of chances
      # to actually start, which is what turns this failure back into a run.
      if [ "$start_tries" -lt "${AUTOPILOT_START_RETRIES:-2}" ]; then
        start_tries=$((start_tries + 1))
        echo "autopilot: feature '$feat' never started: .sdlc/features/$feat/status.json was not written. Asking the leader to start the procedure (attempt $start_tries of ${AUTOPILOT_START_RETRIES:-2})."
        start_prompt="/feature-autopilot feature name: $feat. CORRECTION: the previous call ended without writing .sdlc/features/$feat/status.json, so the feature never started and there is nothing to resume. You are the leader: do not write product code and do not run git commit. Start it now, in this order: write spec.md, plan.md, test-contract.md, acceptance.yaml and ownership.json, then run node $AI_SKILLS_HOME/tools/sdlc-verify.mjs --feature $feat --set-phase building, then send the builder. \"The work is already done\" is not a reason to skip: say what you found in spec.md and run the procedure against what is missing, so the code that exists is actually verified and evidence exists."
        [ -n "$req" ] && start_prompt="$start_prompt Request: $req"
        claude_run "$start_prompt"
        continue
      fi
      # Out of chances: report, and show the leader's own last message. It is the only place the reason
      # exists, and "nothing to resume" alone reads like a tool bug instead of a run that never happened.
      echo "autopilot: the leader ended without starting feature '$feat' after $start_tries corrective call(s): .sdlc/features/$feat/status.json was never written, so there is no spec, plan or acceptance contract, and nothing to resume."
      said=$(leader_said "$CLAUDE_DIR/leader-${claude_run_n:-1}.json")
      if [ -n "$said" ]; then
        echo "autopilot: what the leader said before it stopped:"
        printf '%s\n' "$said" | head -12 | sed 's/^/    /'
        echo "autopilot: (full message: $CLAUDE_DIR/leader-${claude_run_n:-1}.json)"
      fi
      echo "autopilot: this usually means the leader did the work itself instead of running the procedure. Re-run and keep the request to the feature, without git instructions."
      break ;;
    accepted|blocked|escalated) break ;;
  esac
  if [ "$tries" -ge "${AUTOPILOT_RESUMES:-3}" ]; then
    echo "autopilot: still in phase '$p' after $tries resume(s); the last leader call ended '$claude_stop' ($claude_why). Stopping. To continue: autopilot --resume $feat"
    break
  fi
  if [ "$claude_stop" = limit ]; then
    if [ "${AUTOPILOT_LIMIT_WAIT:-1}" != 1 ]; then
      echo "autopilot: the leader's usage window is spent and AUTOPILOT_LIMIT_WAIT=0, so nothing is waited for. Stopping. To continue once it reopens: autopilot --resume $feat"
      break
    fi
    if [ "$limit_waits" -ge "${AUTOPILOT_LIMIT_WAITS:-4}" ]; then
      echo "autopilot: the leader's usage window was spent $limit_waits time(s) in this run; stopping rather than waiting again. To continue: autopilot --resume $feat"
      break
    fi
    limit_waits=$((limit_waits + 1))
    echo "autopilot: the leader's usage window is spent ($claude_why); waiting instead of retrying (wait $limit_waits of ${AUTOPILOT_LIMIT_WAITS:-4})."
    if ! wait_for_claude_reset "$claude_wait"; then
      echo "autopilot: the window reopens in ${claude_wait}s, further than AUTOPILOT_LIMIT_MAX_WAIT (${AUTOPILOT_LIMIT_MAX_WAIT:-21600}s); stopping. To continue after it reopens: autopilot --resume $feat"
      break
    fi
    claude_stop=done   # the wait is over, so what follows is an ordinary resume
  fi
  tries=$((tries + 1))
  echo "autopilot: Claude stopped while the feature was in phase '$p'; resuming ($tries of ${AUTOPILOT_RESUMES:-3})..."
  claude_run "/feature-autopilot feature name: $feat. RESUME: the previous run stopped before the feature was accepted. Do not start over and do not ask the user anything. Read .sdlc/features/$feat (spec.md, plan.md, acceptance.yaml, status.json, decisions.md, trace.jsonl and sdlc-slices.mjs status $feat if slices.json exists, and the newest builder-N.md and qa-N.md in .oc/ and in each .oc/lane-*/) and compare with the files on disk, then continue from the first step that is not done. A builder or QA call (or several lanes) may have finished after the run stopped: read its output file before sending the work again."
done
node "$AI_SKILLS_HOME/tools/sdlc-trace.mjs" --feature "$feat" --render || true

# A separate, short pass draws the two diagrams that need a model (how it is built, what the user does).
# It was a last step of the main run and got skipped; as its own pass it cannot be forgotten.
D=".sdlc/features/$feat/diagrams"
phase=$(phase_of)
diagrams_missing() { [ ! -f "$D/architecture.html" ] || [ ! -f "$D/workflow.html" ]; }
manual_cmd="claude -p \"/feature-diagrams feature name: $feat\" --dangerously-skip-permissions"
if ! diagrams_missing; then
  :   # both exist already
elif [ -n "${AUTOPILOT_NO_DIAGRAMS:-}" ]; then
  echo "autopilot: diagrams pass skipped (--no-diagrams). To draw them: $manual_cmd"
elif [ "$phase" != accepted ]; then
  echo "autopilot: diagrams pass skipped: the feature's phase is '${phase:-unknown}', not 'accepted', and unproven work is not drawn. Once it is accepted: $manual_cmd"
else
  echo "drawing the architecture and workflow diagrams..."
  claude -p "/feature-diagrams feature name: $feat" --dangerously-skip-permissions ${leader_args[@]+"${leader_args[@]}"} || true
  diagrams_missing && echo "autopilot: the diagrams pass ended but architecture.html and/or workflow.html are still missing. Try again with: $manual_cmd"
fi
node "$AI_SKILLS_HOME/tools/sdlc-diagrams.mjs" --feature "$feat" || true
hub=".sdlc/features/$feat/diagrams/index.html"
[ -f "$hub" ] || hub=".sdlc/features/$feat/trace.html"
echo "diagrams: $hub"
open "$hub" 2>/dev/null || true
if [ ${#win_ids[@]} -gt 0 ]; then
  if [ "$(phase_of)" != accepted ]; then
    echo "autopilot: the feature is '$(phase_of)', not accepted, so the trace windows stay open for you to read."
  elif [ -n "${AUTOPILOT_KEEP_WINDOWS:-}" ]; then
    echo "autopilot: accepted. AUTOPILOT_KEEP_WINDOWS is set, so the trace windows stay open."
  else
    close_windows
  fi
fi
