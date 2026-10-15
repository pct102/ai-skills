#!/usr/bin/env bash
# oc-agent.sh — call one opencode agent role, keeping its session between calls.
#
#   oc-agent.sh [--lane <name>] <role> <feature> <prompt-file>          run and wait (short calls)
#   oc-agent.sh [--lane <name>] --async <role> <feature> <prompt-file>  start detached, return at once (long calls)
#   oc-agent.sh [--lane <name>] --wait  <role> <feature> [seconds]      wait up to N s (default 500) for the async call
#                                                                       exit 75 = still running, call --wait again
#
# role     builder | qa   (picks the model; each role keeps its own session)
# --lane   a parallel line of work, normally one slice (a-z, 0-9, _; starts with a letter). Each lane has its own
#          session and files under .oc/lane-<name>/, so several builders can run at once without sharing context.
#          In the trace the lane shows as its own actor: builder-<name>.
# feature  feature name; sessions live in .sdlc/features/<feature>/.oc/
# prompt   file whose contents are sent as the message
#
# Exit: 0 ok | 124 our watchdog hit OC_TIMEOUT | 125 stalled (no new output for OC_STALL s) | 143/137 killed from outside
#       75 --wait: still running | 70 --wait: the worker died without a result
#
# Env: BUILDER_MODEL (default opencode/muse-spark-1.3-contributor-free), QA_MODEL (default opencode-go/deepseek-v4.1-flash),
#      also per lane (BUILDER_MODEL_<LANE>) and from autopilot.env
#      OC_TIMEOUT    seconds per call (default 1800). On expiry the call returns rc=124 with the partial
#                    reply and keeps the session, so the leader can send "continue".
#      OC_STALL      seconds with no new output before the call is treated as stalled (default 600, 0 = off).
#                    A tool call logs only when it finishes, so keep this above your slowest test run.
#      OC_AUTO       1 (default) passes --auto so headless runs never block on a permission prompt;
#                    run in a worktree/branch. 0 disables it.
#      OC_ATTACH     URL of a running opencode server (e.g. http://localhost:4096). The sessions then
#                    appear there, so `opencode attach <url>` in another terminal shows them live.
#      OC_DIR        directory the agent works in (the worktree); defaults to the current directory
# Output: the agent's reply on stdout, also saved to .oc/<role>-<n>.md. Exit code is opencode's.
set -euo pipefail

mode=run; lane=""
while :; do
  case "${1:-}" in
    --async) mode=async; shift ;;
    --wait) mode=wait; shift ;;
    --lane) lane=${2:?--lane needs a name}; shift 2 ;;
    *) break ;;
  esac
done
case "$lane" in ""|[a-z]*) ;; *) echo "lane must start with a lowercase letter: $lane" >&2; exit 3 ;; esac
case "$lane" in *[!a-z0-9_]*) echo "lane may contain only a-z, 0-9 and _: $lane" >&2; exit 3 ;; esac

role=${1:?role: builder|qa}; feature=${2:?feature}
actor=$role${lane:+-$lane}   # the name this call has in the trace
if [ "$mode" = wait ]; then prompt=""; else prompt=${3:?prompt file}; fi
case "$role" in
  builder) default_model=opencode/muse-spark-1.3-contributor-free ;;
  qa)      default_model=opencode-go/deepseek-v4.1-flash ;;
  *) echo "unknown role: $role" >&2; exit 3 ;;
esac
# Model, first match wins: OC_MODEL, <ROLE>_MODEL_<LANE>, <ROLE>_MODEL, the default. Settings come from the
# environment or autopilot.env (see autopilot.env.example).
. "$(dirname "$0")/model-setting.sh"
upper_role=$(printf %s "$role" | tr a-z A-Z); upper_lane=$(printf %s "$lane" | tr a-z A-Z)
model=${OC_MODEL:-}
[ -z "$model" ] && [ -n "$lane" ] && model=$(model_setting "${upper_role}_MODEL_${upper_lane}")
[ -z "$model" ] && model=$(model_setting "${upper_role}_MODEL")
model=${model:-$default_model}
command -v opencode >/dev/null || { echo "opencode not on PATH" >&2; exit 3; }
[ "$mode" = wait ] || [ -f "$prompt" ] || { echo "no prompt file: $prompt" >&2; exit 3; }

dir=.sdlc/features/$feature/.oc${lane:+/lane-$lane}
mkdir -p "$dir"
sess_file=$dir/$role.session
next_n() { echo $(( $(ls "$dir"/"$role"-*.jsonl 2>/dev/null | wc -l || true) + 1 )); }
cur=$dir/$role.current   # "<n> <start-epoch>" of the latest async call

if [ "$mode" = wait ]; then
  [ -s "$cur" ] || { echo "no async call recorded for $role/$feature" >&2; exit 3; }
  read -r wn wstart < "$cur"
  limit=${3:-500}; waited=0
  while [ ! -f "$dir/$role-$wn.done" ]; do
    if [ -f "$dir/$role.pid" ] && ! kill -0 "$(cat "$dir/$role.pid")" 2>/dev/null; then
      echo "DEAD: $actor call $wn ended without a result (see $dir/$role.err and $dir/$role-$wn.jsonl)"; exit 70
    fi
    [ "$waited" -ge "$limit" ] && {
      echo "STILL RUNNING: $actor call $wn, $(( $(date +%s) - wstart ))s elapsed, $(wc -c < "$dir/$role-$wn.jsonl" 2>/dev/null || echo 0) bytes of output so far."
      echo "Call --wait again. Do not end your turn while this is pending."; exit 75; }
    sleep 2; waited=$((waited + 2))
  done
  cat "$dir/$role-$wn.md" 2>/dev/null || true
  exit "$(cat "$dir/$role-$wn.done")"
fi

if [ "$mode" = async ]; then
  n=$(next_n)
  echo "$n $(date +%s)" > "$cur"; rm -f "$dir/$role-$n.done" "$dir/$role.pid"
  # setsid via perl (stock macOS has none): the call survives the Bash tool's timeout and Ctrl-C.
  lane_args=(); [ -n "$lane" ] && lane_args=(--lane "$lane")
  OC_RUN_N=$n perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' bash "$0" ${lane_args[@]+"${lane_args[@]}"} "$role" "$feature" "$prompt" \
    >"$dir/$role.run.out" 2>&1 </dev/null &
  echo "started $actor call $n. Next: bash $0 ${lane_args[*]:-} --wait $role $feature"
  exit 0
fi

n=${OC_RUN_N:-$(next_n)}
echo $$ > "$dir/$role.pid"
out=$dir/$role-$n.md
raw=$dir/$role-$n.jsonl

args=(run -m "$model" --format json --title "$feature/$actor")
[ "${OC_AUTO:-1}" = 1 ] && args+=(--auto)
[ -n "${OC_ATTACH:-}" ] && args+=(--attach "$OC_ATTACH")
[ -n "${OC_DIR:-}" ] && args+=(--dir "$OC_DIR")
[ -s "$sess_file" ] && args+=(-s "$(cat "$sess_file")")

trace_log() { node "$(dirname "$0")/sdlc-trace.mjs" --feature "$feature" --log "$@" 2>/dev/null || true; }
trace_log --from leader --to "$actor" --kind prompt --file "$prompt" --note "[$model] $(head -c 60 "$prompt" | tr '\n' ' ')"
t0=$SECONDS   # bash builtin: the kill handler must not depend on an external command like `date`

# If we are killed (tool timeout, Ctrl-C) leave a record instead of a prompt with no reply.
on_kill() {
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  trace_log --from "$actor" --to leader --kind reply --rc 143 --ms $(( (SECONDS - t0) * 1000 )) \
    --note "oc-agent killed before opencode replied; see $raw"
  echo 143 > "$dir/$role-$n.done"
  exit 143
}
trap on_kill TERM INT HUP

# Portable timeout (stock macOS has no `timeout`): opencode in the background, a watchdog beside it.
set +e
opencode "${args[@]}" "$(cat "$prompt")" >"$raw" 2>"$dir/$role.err" &
pid=$!
rm -f "$dir/$role-$n.timedout" "$dir/$role-$n.stalled"
# The watchdog polls once a second instead of sleeping for the whole limit: a long `sleep` left behind when the
# call ends would keep this script's stdout open, and anything waiting for it to close (a $(...), a tool call)
# would hang for up to OC_TIMEOUT.
( i=0; idle=0; last=-1; limit=${OC_TIMEOUT:-1800}; stall=${OC_STALL:-600}
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1; i=$((i + 1))
    if [ "$i" -ge "$limit" ]; then : > "$dir/$role-$n.timedout"; kill "$pid" 2>/dev/null; break; fi
    size=$(wc -c < "$raw" 2>/dev/null || echo 0)
    if [ "$size" = "$last" ]; then idle=$((idle + 1)); else idle=0; last=$size; fi
    if [ "$stall" -gt 0 ] && [ "$idle" -ge "$stall" ]; then : > "$dir/$role-$n.stalled"; kill "$pid" 2>/dev/null; break; fi
  done ) &
wd=$!
wait "$pid"; rc=$?
kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
trap - TERM INT HUP
# 124 means OUR watchdog ended the call. Any other signal (143 TERM, 137 KILL) is somebody else's kill,
# for example the server being stopped under it, and must not be reported as a timeout.
if [ -f "$dir/$role-$n.timedout" ]; then rc=124; rm -f "$dir/$role-$n.timedout"; fi
# 125: opencode wrote nothing new for OC_STALL seconds, so it is probably hung (a stuck test run, a loop).
# The leader should look at the tail of the .jsonl and re-plan rather than wait out the full timeout.
if [ -f "$dir/$role-$n.stalled" ]; then rc=125; rm -f "$dir/$role-$n.stalled"; fi
set -e

# Persist the session id and extract the assistant text from the JSON event stream.
node -e '
const fs=require("fs");const [raw,out,sf]=process.argv.slice(1);
let sid="",text=[];
for(const l of fs.readFileSync(raw,"utf8").split("\n")){
  if(!l.trim())continue;let e;try{e=JSON.parse(l)}catch{continue}
  sid=sid||e.sessionID||"";
  if(e.type==="text"&&e.part&&e.part.text)text.push(e.part.text);
}
if(sid&&!fs.existsSync(sf))fs.writeFileSync(sf,sid);
fs.writeFileSync(out,text.join("\n")||fs.readFileSync(raw,"utf8"));
' "$raw" "$out" "$sess_file"

# Ask opencode which model really answered, so the trace shows facts, not what we requested.
used=""
if [ -s "$sess_file" ]; then
  opencode export "$(cat "$sess_file")" >"$dir/$role.export.json" 2>"$dir/$role.export.err" || true
  used=$(node "$(dirname "$0")/oc-model.mjs" <"$dir/$role.export.json" 2>>"$dir/$role.export.err" || true)
fi
case ",$used," in
  ",,") tag="model unverified, see $dir/$role.export.err" ;;
  *",$model,"*) tag="verified: $model" ;;
  *) tag="MODEL MISMATCH asked $model got $used" ;;
esac
echo "[$actor] $tag" >&2

trace_log --from "$actor" --to leader --kind reply --file "$out" --rc "$rc" --ms $(( (SECONDS - t0) * 1000 )) \
   --note "($tag) $(head -c 60 "$out" | tr '\n' ' ')"
echo "$rc" > "$dir/$role-$n.done"
cat "$out"
exit $rc
