#!/usr/bin/env bash
# autopilot [--push] [--no-commit] [--no-diagrams] "<feature request>"
# autopilot --resume <feature>
#   Runs /feature-autopilot with live viewers (macOS Terminal, Windows mintty from Git Bash, Linux terminals/tmux). If Claude stops before the feature is
#   accepted, blocked or escalated, autopilot waits for any builder/QA call still running, then starts a fresh
#   Claude that resumes from what is on disk (up to AUTOPILOT_RESUMES times, default 3).
#   --resume <feature>  skip the request and resume that feature now (name as in .sdlc/features/).
#   After an accepted feature the leader commits it on a branch (autopilot/<feature>) via sdlc-ship.
#   --push       also push that branch (never a protected branch, see PROTECTED_BRANCHES in autopilot.env). Default: commit locally, no push.
#   --no-commit  leave everything uncommitted.
#   When the feature ends, the diagrams hub (.sdlc/features/<f>/diagrams/index.html) is opened in your browser: `open` on
#   macOS, `start` on Windows, `xdg-open` on Linux. AUTOPILOT_NO_OPEN=1 skips that.
#   COMMIT_SDLC=no (in the project's .sdlc/autopilot.env) never commits anything under .sdlc/ and hides it from git
#                locally (.git/info/exclude); it stays on disk to read. Default yes.
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
#   Four terminal windows follow the run (opencode, trace, the leader, and the local jev proxy's log
#   when jev is set up). When the feature ends accepted they are closed together; when it does not, they stay
#   open so you can read what happened. AUTOPILOT_KEEP_WINDOWS=1 keeps them open anyway, AUTOPILOT_NO_CLAUDE_WINDOW=1
#   leaves the leader window out, AUTOPILOT_NO_JEV_WINDOW=1 leaves the proxy log out and JEV_PROXY_LOG points at
#   another log. AUTOPILOT_NO_WINDOWS=1 opens none and AUTOPILOT_TERMINAL=<name> forces a terminal (see viewer_kind);
#   when none is found the three commands are printed so you can run them yourself. On macOS each close waits for Terminal to report its tab idle (up to AUTOPILOT_CLOSE_WAIT ticks of
#   0.25 s) so it does not raise the "terminate running processes?" dialog.
# Add to ~/.zshrc:  alias autopilot='bash ~/pct102-ai-skills/tools/autopilot.sh'
set -euo pipefail
export AI_SKILLS_HOME=${AI_SKILLS_HOME:-$(cd "$(dirname "$0")/.." && pwd)}
. "$AI_SKILLS_HOME/tools/oc-compat.sh"
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
# COMMIT_SDLC=no: keep .sdlc/ out of git in this clone from the first minute (a no-op otherwise)
node "$AI_SKILLS_HOME/tools/sdlc-ship.mjs" --ignore-sdlc || true
# The server can run shell commands for whoever reaches it, so it gets a per-run password (inherited by oc-agent).
export OPENCODE_SERVER_PASSWORD=${OPENCODE_SERVER_PASSWORD:-$(openssl rand -hex 16)}
export OPENCODE_PASSWORD=$OPENCODE_SERVER_PASSWORD   # opencode 2.x clients read this name
# Builder and QA run unattended, so nothing may wait for a human to click "Allow". `opencode run --auto` only answers
# the requests its own client sees; a session on this server (the live view) still asks for things like
# "Access external directory /tmp". The server's own permission rule settles it for every client. OC_AUTO=0 turns it off.
. "$AI_SKILLS_HOME/tools/model-setting.sh"
oc_auto=$(model_setting OC_AUTO); [ "${oc_auto:-1}" = 1 ] && export OPENCODE_PERMISSION=${OPENCODE_PERMISSION:-'{"*":"allow","external_directory":"allow","doom_loop":"allow"}'}
# Non-secret Jev routing (backend, model, account id, endpoint) comes from the same
# files so a project can pin e.g. JEV_BACKEND=clef; the proxy daemon started below
# and the leader both inherit it. Provider keys are never exported here by design.
model_export_env
opencode serve --port "$port" >.sdlc/opencode-server.log 2>&1 &
server_pid=$!
trap 'kill $server_pid 2>/dev/null || true' EXIT
sleep 3

win_ids=(); win_ttys=(); win_pats=(); win_pidfiles=()
# Which terminal shows the live views: Terminal.app on macOS (osascript), mintty on Windows (it ships with Git for
# Windows), and on Linux tmux (when you are inside it) or the first of gnome-terminal, konsole, xfce4-terminal,
# x-terminal-emulator, xterm when a display is available. AUTOPILOT_NO_WINDOWS=1 opens none;
# AUTOPILOT_TERMINAL=<name> forces one. Empty means none found, and the commands are printed for you to run by hand.
viewer_kind() {
  [ -n "${AUTOPILOT_NO_WINDOWS:-}" ] && return 0
  [ -n "${AUTOPILOT_TERMINAL:-}" ] && { echo "$AUTOPILOT_TERMINAL"; return 0; }
  case "$(uname)" in
    Darwin) echo osascript ;;
    MINGW*|MSYS*|CYGWIN*) if command -v mintty >/dev/null 2>&1; then echo mintty; fi ;;
    *)
      if [ -n "${TMUX:-}" ] && command -v tmux >/dev/null 2>&1; then echo tmux
      elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        for t in gnome-terminal konsole xfce4-terminal x-terminal-emulator xterm; do
          if command -v "$t" >/dev/null 2>&1; then echo "$t"; break; fi
        done
      fi ;;
  esac
  return 0
}
viewer=$(viewer_kind)

# Opens a window running $1 outside macOS. The shell inside it writes its own pid to a file and then execs the
# command, so closing the window later is just killing that pid (the window closes when its command ends).
open_window_proc() {   # <command> <title>
  local pidf inner
  mkdir -p .sdlc/viewers
  pidf="$PWD/.sdlc/viewers/$$-${#win_pidfiles[@]}.pid"; rm -f "$pidf"
  inner="cd '$PWD' && export OPENCODE_SERVER_PASSWORD='$OPENCODE_SERVER_PASSWORD' OPENCODE_PASSWORD='$OPENCODE_SERVER_PASSWORD' && echo \$\$ > '$pidf' && exec $1"
  case "$viewer" in
    mintty) mintty -t "autopilot: $2" /bin/bash -c "$inner" >/dev/null 2>&1 & ;;
    tmux) tmux new-window -d -n "$2" "bash -c $(printf %q "$inner")" >/dev/null 2>&1 || true ;;
    gnome-terminal) gnome-terminal --title="autopilot: $2" -- bash -c "$inner" >/dev/null 2>&1 & ;;
    konsole) konsole -p "tabtitle=autopilot: $2" -e bash -c "$inner" >/dev/null 2>&1 & ;;
    xfce4-terminal) xfce4-terminal --title="autopilot: $2" -x bash -c "$inner" >/dev/null 2>&1 & ;;
    *) "$viewer" -e bash -c "$inner" >/dev/null 2>&1 & ;;
  esac
  win_pidfiles+=("$pidf")
  return 0
}
close_windows_proc() {
  local i f pid
  for ((i = 0; i < ${#win_pidfiles[@]}; i++)); do
    f=${win_pidfiles[$i]}; pid=$(cat "$f" 2>/dev/null || true)
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  sleep 1
  for ((i = 0; i < ${#win_pidfiles[@]}; i++)); do
    f=${win_pidfiles[$i]}; pid=$(cat "$f" 2>/dev/null || true)
    if [ -n "$pid" ]; then kill -9 "$pid" 2>/dev/null || true; fi
    rm -f "$f"
  done
  return 0
}

# Shows a file in the default app: `open` on macOS, `start` on Windows (Git Bash), `xdg-open` on Linux when a
# display exists. AUTOPILOT_NO_OPEN=1 skips it. Never fails the run.
open_file() {   # <file>
  [ -n "${AUTOPILOT_NO_OPEN:-}" ] && return 0
  case "$(uname)" in
    Darwin) open "$1" >/dev/null 2>&1 || true ;;
    MINGW*|MSYS*|CYGWIN*) cmd //c start "" "$(cygpath -w "$1")" >/dev/null 2>&1 || true ;;
    *) if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 & fi ;;
  esac
  return 0
}

# Opens a window running $1 and remembers how to close it again at the end.
open_window() {   # <command> <pattern (macOS: finds the process again)> <title>
  case "$viewer" in
    "") return 0 ;;
    osascript) open_window_mac "$1" "$2" ;;
    *) open_window_proc "$1" "${3:-view}" ;;
  esac
}
# macOS: a Terminal window that remembers its id, tty, and a pattern that matches its own command line.
open_window_mac() {   # <command> <pattern>
  local out
  # The window and its tty are asked of the tab that `do script` returns, not of "front window", which can be a
  # different window; Terminal may need a moment before the new tab reports them, so ask again for up to 4 s.
  # When Terminal was not running, or running with every window closed, it opens an empty window of its own; the first view takes that window
  # over instead of leaving it behind as a fifth, empty one.
  out=$(osascript -e 'on run argv' -e 'set wasRunning to application "Terminal" is running' -e 'tell application "Terminal"' \
          -e 'if wasRunning and (count of windows) > 0 then' -e 'set t to do script (item 1 of argv)' -e 'else' \
          -e 'repeat 30 times' -e 'if (count of windows) > 0 then exit repeat' -e 'delay 0.1' -e 'end repeat' \
          -e 'if (count of windows) > 0 then' -e 'set t to do script (item 1 of argv) in window 1' \
          -e 'else' -e 'set t to do script (item 1 of argv)' -e 'end if' -e 'end if' \
          -e 'repeat 40 times' -e 'try' -e 'set tt to tty of t' \
          -e 'return ((id of (first window whose selected tab is t)) as string) & " " & tt' -e 'end try' \
          -e 'delay 0.1' -e 'end repeat' -e 'return ""' -e 'end tell' -e 'end run' \
          "cd '$PWD' && export OPENCODE_SERVER_PASSWORD='$OPENCODE_SERVER_PASSWORD' OPENCODE_PASSWORD='$OPENCODE_SERVER_PASSWORD' && $1" 2>/dev/null) || out=""
  if [ -n "$out" ]; then win_ids+=("${out%% *}"); win_ttys+=("${out#* }"); win_pats+=("$2")
  else echo "autopilot: a live-view window ($2) could not be tracked, so it will not be closed at the end; close it yourself." >&2; fi
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
  if [ "$viewer" != osascript ]; then close_windows_proc; return 0; fi
  local i id tty now
  for ((i = 0; i < ${#win_ids[@]}; i++)); do
    id=${win_ids[$i]}; tty=${win_ttys[$i]}
    now=$(osascript -e "tell application \"Terminal\" to return tty of selected tab of (first window whose id is $id)" 2>/dev/null || true)
    [ -n "$now" ] && [ "$now" = "$tty" ] || continue
    close_window "$id" "$tty" "${win_pats[$i]}"
  done
  return 0
}

if [ -n "$viewer" ] || [ -z "${AUTOPILOT_NO_WINDOWS:-}" ]; then
  if [ -z "$viewer" ]; then
    echo "autopilot: no terminal found to open live views in. Watch the run from other terminals in $PWD:" >&2
    echo "  $(oc_view_cmd "$url")      (password: \$OPENCODE_SERVER_PASSWORD)" >&2
    echo "  node '$AI_SKILLS_HOME/tools/sdlc-trace.mjs' --feature $feat --follow" >&2
    echo "  node '$AI_SKILLS_HOME/tools/claude-follow.mjs' --cwd '$PWD'" >&2
  fi
  # four live views: the agents (opencode), the message trace, the leader (what headless Claude is doing,
  # read from Claude's own transcript because `claude -p` prints nothing until it ends), and the local jev
  # proxy's log. The proxy writes both its streams to that file, and it is the service the agents' jev tool
  # talks to — without it in view a run looks like it never routes through the proxy at all. Opened only when
  # that log exists, so a project without jev still gets three windows. The second argument is the pattern
  # that finds each one again when the run ends.
  view_cmd=$(oc_view_cmd "$url")
  open_window "$view_cmd" "$view_cmd" "opencode"
  open_window "node '$AI_SKILLS_HOME/tools/sdlc-trace.mjs' --feature $feat --follow" "sdlc-trace.mjs --feature $feat --follow" "trace"
  if [ -z "${AUTOPILOT_NO_CLAUDE_WINDOW:-}" ]; then
    open_window "node '$AI_SKILLS_HOME/tools/claude-follow.mjs' --cwd '$PWD' --since $(date +%s)" "claude-follow.mjs --cwd $PWD" "leader"
  fi
  # jev checkpoints (tools/jev-check.sh) need the proxy up; start it if it was left stopped. Best effort: a run never depends on it.
  [ -z "${AUTOPILOT_NO_JEV_WINDOW:-}" ] && [ -x "$AI_SKILLS_HOME/tools/jev-proxy/jev-proxy" ] && \
    ! "$AI_SKILLS_HOME/tools/jev-proxy/jev-proxy" status 2>&1 | grep -qi running && \
    "$AI_SKILLS_HOME/tools/jev-proxy/jev-proxy" start >/dev/null 2>&1 || true
  jev_log=${JEV_PROXY_LOG:-$HOME/.config/jev-cli/proxy.log}
  if [ -z "${AUTOPILOT_NO_JEV_WINDOW:-}" ] && [ -f "$jev_log" ]; then
    open_window "tail -n 40 -f '$jev_log'" "tail -n 40 -f $jev_log" "jev proxy"
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
# The leader may not push, hard-reset, clean or force-delete branches: a PreToolUse hook for this session only
# (sdlc-ship pushes from its own process, which the hook does not see). Needs jq; without it the git_rule below is the only guard.
if command -v jq >/dev/null 2>&1; then
  leader_args+=(--settings "$(jq -cn --arg c "$AI_SKILLS_HOME/tools/hooks/leader-git-guard.sh" '{hooks:{PreToolUse:[{matcher:"Bash",hooks:[{type:"command",command:$c}]}]}}')")
else
  echo "autopilot: jq not found, the leader git guard hook is off (install jq)" >&2
fi
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

# ---- the leader never touches git state, and the run's starting branch is recorded ---------------
# The leader used to be told only "do not run git commit", so on real runs it helped itself to
# `git checkout -b claude/<a name it invented>` at the start of a feature. sdlc-ship then found a
# non-protected branch checked out and committed there, so the feature landed on a branch whose
# name matched nothing in .sdlc. Creating a branch is sdlc-ship's job alone, and every leader
# prompt now carries the same rule.
git_rule="Git rule: you never change git state — no git checkout -b, git switch, git branch, git commit, git push, and no gh pr create, even when the request mentions a branch name. The branch is created once, at ship time, by node $AI_SKILLS_HOME/tools/sdlc-ship.mjs --feature $feat: it commits on autopilot/$feat (exactly the feature's name in .sdlc, the name this run was started with) when the run is on a protected branch, and on the branch the run started on otherwise."
# sdlc-ship commits on whatever branch is checked out when it runs, so the branch the run starts on
# decides where the feature lands. Record it (fresh starts only, so a resume keeps the original
# baseline; ship compares against it and refuses a branch switched mid-run) and say so up front
# when it is not protected: starting on a throwaway branch commits there by design, but that choice
# should be made before the run, not discovered at ship time.
run_branch_file=".sdlc/features/$feat/run-branch"
if [ -z "$resume" ]; then
  mkdir -p ".sdlc/features/$feat"
  git rev-parse --abbrev-ref HEAD >"$run_branch_file" 2>/dev/null || true
  start_branch=$(cat "$run_branch_file" 2>/dev/null)
  protected_branches=$(model_setting PROTECTED_BRANCHES); protected_branches=${protected_branches:-main master}
  protected_branches=$(printf %s "$protected_branches" | tr ',' ' ')
  if [ -n "$start_branch" ] && [ "$start_branch" != HEAD ] &&
     ! printf ' %s ' "$protected_branches" | grep -q " $start_branch "; then
    echo "autopilot: starting on branch '$start_branch', not a protected branch ($protected_branches) — sdlc-ship will commit on it as-is. Start from main/master if you want the feature on autopilot/$feat."
  fi
fi

[ -z "$resume" ] && claude_run "/feature-autopilot feature name: $feat. You are the leader of this run: do not write product code and do not run git commit. $git_rule Your first job is the feature state, .sdlc/features/$feat/status.json. Request: $req"

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
        start_prompt="/feature-autopilot feature name: $feat. CORRECTION: the previous call ended without writing .sdlc/features/$feat/status.json, so the feature never started and there is nothing to resume. You are the leader: do not write product code and do not run git commit. $git_rule Start it now, in this order: write spec.md, plan.md, test-contract.md, acceptance.yaml and ownership.json, then run node $AI_SKILLS_HOME/tools/sdlc-verify.mjs --feature $feat --set-phase building, then send the builder. \"The work is already done\" is not a reason to skip: say what you found in spec.md and run the procedure against what is missing, so the code that exists is actually verified and evidence exists."
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
  claude_run "/feature-autopilot feature name: $feat. RESUME: the previous run stopped before the feature was accepted. Do not start over and do not ask the user anything. Start from this journal brief — it is the source of truth for where the run stands, generated from status.json, the slice plan and state, lanes in flight, the trace and prior jev answers. Do not re-derive what it lists; open only the evidence it names, then continue from the step it names as next:$(node "$AI_SKILLS_HOME/tools/sdlc-resume-context.mjs" --feature "$feat" 2>/dev/null || true) A builder or QA call (or several lanes) may have finished after the run stopped: read its output file before sending the work again. $git_rule"
done
node "$AI_SKILLS_HOME/tools/sdlc-trace.mjs" --feature "$feat" --render || true

# Visual review (opt-in: VISUAL_QA=1 in autopilot.env). A passing test only checks what it asserts, so a second opencode model, not the
# one that wrote the tests, looks at the screenshots against the spec and lists what looks wrong. Its findings go to visual-review.md and
# show on the evidence page as suspicions: they never change the acceptance result and never start a repair round. Runs as its own pass
# like the diagrams (a last step of a long run gets skipped), only for an accepted feature, and never fails the run.
visual_review=".sdlc/features/$feat/visual-review.md"
if [ "$(model_setting VISUAL_QA)" = 1 ]; then
  if [ "$(phase_of)" != accepted ]; then
    echo "autopilot: visual review skipped: the feature is '$(phase_of)', not accepted."
  elif ! ls ".sdlc/features/$feat/evidence/"*.png >/dev/null 2>&1; then
    echo "autopilot: visual review skipped: no screenshots in .sdlc/features/$feat/evidence/."
  else
    echo "visual review: a second model is looking at the screenshots (VISUAL_QA=1)..."
    mkdir -p ".sdlc/features/$feat/.oc/prompts"
    visual_prompt=".sdlc/features/$feat/.oc/prompts/visual.md"
    sed "s#<f>#$feat#g" "$AI_SKILLS_HOME/skills/feature-autopilot/references/brief-qa-visual.md" > "$visual_prompt"
    if OC_ATTACH=$url bash "$AI_SKILLS_HOME/tools/oc-agent.sh" visual "$feat" "$visual_prompt" > "$visual_review.tmp" 2>"$visual_review.err" && grep -q 'VISUAL RESULT' "$visual_review.tmp"; then
      mv "$visual_review.tmp" "$visual_review"; rm -f "$visual_review.err"
      echo "visual review: $(grep -c '^FLAG' "$visual_review" || true) item(s) flagged, see $visual_review"
    else
      rm -f "$visual_review.tmp" "$visual_review"
      echo "autopilot: the visual review did not produce a result (see $visual_review.err); the feature is unaffected."
    fi
  fi
fi

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
open_file "$hub"
if [ $(( ${#win_ids[@]} + ${#win_pidfiles[@]} )) -gt 0 ]; then
  if [ "$(phase_of)" != accepted ]; then
    echo "autopilot: the feature is '$(phase_of)', not accepted, so the trace windows stay open for you to read."
  elif [ -n "${AUTOPILOT_KEEP_WINDOWS:-}" ]; then
    echo "autopilot: accepted. AUTOPILOT_KEEP_WINDOWS is set, so the trace windows stay open."
  else
    close_windows
  fi
fi
