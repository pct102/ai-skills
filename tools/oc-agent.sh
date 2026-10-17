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
# Env: BUILDER_MODEL (default: muse-spark-1.3-contributor, then free models), QA_MODEL (default opencode-go/deepseek-v4.1-flash),
#      also per lane (BUILDER_MODEL_<LANE>) and from autopilot.env. A model value may be a comma list = fallback chain
#      (next model when one hits its usage limit; exit 76 when all are exhausted).
#      OC_TIMEOUT    seconds per call (default 1800). On expiry the call returns rc=124 with the partial
#                    reply and keeps the session, so the leader can send "continue".
#      OC_STALL      seconds with no new output before the call is treated as stalled (default 600, 0 = off).
#                    A tool call logs only when it finishes, so keep this above your slowest test run.
#      OC_AUTO       (also settable in autopilot.env) 1 (default) passes --auto so headless runs never block on a permission prompt;
#                    run in a worktree/branch. 0 disables it.
#      OC_ATTACH     URL of a running opencode server (e.g. http://localhost:4096). The sessions then
#                    appear there, so `opencode attach <url>` (opencode 2.x: `opencode --server <url>`) in another
#                    terminal shows them live. See oc-compat.sh for the 1.x / 2.x differences.
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
  builder) default_model=opencode-go/muse-spark-1.3-contributor,opencode/mimo-v2.6-flash-free,opencode/glm-5.3-flash-free,opencode/nemotron-3-ultra-free,opencode/deepseek-v4.1-flash-free ;;
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
# A comma list is a fallback chain: the first model not marked exhausted runs; if it hits its usage limit
# mid-call, the next one is tried (same session). Exhausted models are remembered for OC_EXHAUST_HOURS (6).
models=$(printf %s "$model" | tr -d ' ')
command -v opencode >/dev/null || { echo "opencode not on PATH" >&2; exit 3; }
. "$(dirname "$0")/oc-compat.sh"
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

trace_log() { node "$(dirname "$0")/sdlc-trace.mjs" --feature "$feature" --log "$@" 2>/dev/null || true; }
trace_log --from leader --to "$actor" --kind prompt --file "$prompt" --note "[$model] $(head -c 60 "$prompt" | tr '\n' ' ')"
t0=$SECONDS   # bash builtin: the kill handler must not depend on an external command like `date`

# If we are killed (tool timeout, Ctrl-C) leave a record instead of a prompt with no reply.
on_kill() {
  lease_release 2>/dev/null
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  trace_log --from "$actor" --to leader --kind reply --rc 143 --ms $(( (SECONDS - t0) * 1000 )) \
    --note "oc-agent killed before opencode replied; see $raw"
  echo 143 > "$dir/$role-$n.done"
  exit 143
}
trap on_kill TERM INT HUP

# Portable timeout (stock macOS has no `timeout`): opencode in the background, a watchdog beside it.
ptxt=$(cat "$prompt")
oc_auto=$(model_setting OC_AUTO); oc_auto=${oc_auto:-1}   # autopilot.env or the environment; 1 = allow every permission request
# Same rule for a call that starts its own local server (no OC_ATTACH): never wait for a permission click.
[ "$oc_auto" = 1 ] && export OPENCODE_PERMISSION=${OPENCODE_PERMISSION:-'{"*":"allow","external_directory":"allow","doom_loop":"allow"}'}
exhausted_file=$dir/../exhausted-models   # shared by all lanes of the feature
is_exhausted() { [ -f "$exhausted_file" ] && awk -v m="$1" -v now="$(date +%s)" -v h="${OC_EXHAUST_HOURS:-6}" \
  '$1==m && now-$2 < ($3==""?h:$3)*3600 {f=1} END{exit !f}' "$exhausted_file"; }
# The limit shows up as "Free usage exceeded" (opencode then retries for hours, silently): cut that call short.
limit_hit() { grep -q -i -E 'free usage exceeded|usage limit|rate.?limit|too many requests|\b429\b|quota exceeded|insufficient (credit|balance)' "$dir/$role.err" 2>/dev/null ||
  grep -i -E '"type":"error"' "$raw" 2>/dev/null | grep -q -i -E 'usage exceeded|usage limit|rate.?limit|too many requests|429|quota|insufficient'; }
# 429 / "too many requests" is a burst limit: rest that model for OC_COOLDOWN_HOURS (0.15 = 9 min), not the 6 h of a spent quota.
limit_hours() {
  if grep -q -i -E 'too many requests|\b429\b' "$dir/$role.err" 2>/dev/null ||
     grep -i -E '"type":"error"' "$raw" 2>/dev/null | grep -q -i -E 'too many requests|429|rate.?limit'; then
    # Each repeat within 2 h doubles the rest: 9, 18, 36 ... min, capped at OC_EXHAUST_HOURS (6 h).
    awk -v m="$model" -v now="$(date +%s)" -v base="${OC_COOLDOWN_HOURS:-0.15}" -v cap="${OC_EXHAUST_HOURS:-6}" \
      '$1==m && now-$2 < 7200 {n++} END{h=base*(2^n); print (h>cap?cap:h)}' "$exhausted_file" 2>/dev/null || echo "${OC_COOLDOWN_HOURS:-0.15}"
  else echo "${OC_EXHAUST_HOURS:-6}"; fi
}
# One call per model at a time (OC_MODEL_SLOTS, default 1), across all lanes, features and projects: a lease is a
# directory holding the pid of the oc-agent that owns it; a dead pid frees it. Parallel lanes therefore spread over
# the chain instead of all hitting the first model.
lease_root=${OC_LEASE_DIR:-${TMPDIR:-/tmp}/oc-leases}; mkdir -p "$lease_root"; my_lease=""
lease_take() {
  local m=${1//\//_} k d
  for k in $(seq 1 "${OC_MODEL_SLOTS:-1}"); do
    d=$lease_root/$m.$k
    if ! mkdir "$d" 2>/dev/null; then
      kill -0 "$(cat "$d/pid" 2>/dev/null)" 2>/dev/null && continue
      rm -rf "$d"; mkdir "$d" 2>/dev/null || continue
    fi
    echo $$ > "$d/pid"; my_lease=$d; return 0
  done
  return 1
}
lease_release() { [ -n "$my_lease" ] && rm -rf "$my_lease"; my_lease=""; }
set +e
while :; do
  model=""; any=0
  for m in ${models//,/ }; do
    is_exhausted "$m" && continue
    any=1; lease_take "$m" && { model=$m; break; }
  done
  if [ -z "$model" ]; then
    [ "$any" = 1 ] && { sleep 5; continue; }   # every usable model is busy with another call: wait for a slot
    break
  fi
  tried=1
  args=(run -m "$model" --format json --title "$feature/$actor")
  [ "$oc_auto" = 1 ] && args+=(--auto)
  [ -n "${OC_ATTACH:-}" ] && args+=("$(oc_attach_flag)" "$OC_ATTACH")
  [ -n "${OC_DIR:-}" ] && ! oc_is_v2 && args+=(--dir "$OC_DIR")   # opencode 2.x has no --dir: it runs from the directory
  [ -s "$sess_file" ] && args+=(-s "$(cat "$sess_file")")

if [ -n "${OC_DIR:-}" ] && oc_is_v2; then
  absdir=$(cd "$dir" && pwd)
  ( cd "$OC_DIR" && exec opencode "${args[@]}" "$ptxt" >"$absdir/$(basename "$raw")" 2>"$absdir/$role.err" ) &
else
  opencode "${args[@]}" "$ptxt" >"$raw" 2>"$dir/$role.err" &
fi
pid=$!
rm -f "$dir/$role-$n.timedout" "$dir/$role-$n.stalled" "$dir/$role-$n.limited"
# The watchdog polls once a second instead of sleeping for the whole limit: a long `sleep` left behind when the
# call ends would keep this script's stdout open, and anything waiting for it to close (a $(...), a tool call)
# would hang for up to OC_TIMEOUT.
( i=0; idle=0; last=-1; limit=${OC_TIMEOUT:-1800}; stall=${OC_STALL:-600}
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1; i=$((i + 1))
    if [ "$i" -ge "$limit" ]; then : > "$dir/$role-$n.timedout"; kill "$pid" 2>/dev/null; break; fi
    size=$(wc -c < "$raw" 2>/dev/null || echo 0)
    if [ "$size" = "$last" ]; then idle=$((idle + 1)); else idle=0; last=$size; fi
    [ $((i % 5)) -eq 0 ] && limit_hit && { : > "$dir/$role-$n.limited"; kill "$pid" 2>/dev/null; break; }
    if [ "$stall" -gt 0 ] && [ "$idle" -ge "$stall" ]; then : > "$dir/$role-$n.stalled"; kill "$pid" 2>/dev/null; break; fi
  done ) &
wd=$!
wait "$pid"; rc=$?
kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  lease_release
  # opencode exits 0 after retrying a 429 for ~75 s and leaves only an error event, so rc alone proves nothing: a call
  # that ended on a limit error and wrote no reply text counts as limited too.
  if [ -f "$dir/$role-$n.limited" ] || { limit_hit && { [ "$rc" != 0 ] || ! grep -q '"type":"text"' "$raw" 2>/dev/null; }; }; then
    rm -f "$dir/$role-$n.limited"
    echo "$model $(date +%s) $(limit_hours)" >> "$exhausted_file"
    echo "[$actor] $model hit its usage limit, trying the next model in the chain" >&2
    trace_log --from "$actor" --to leader --kind note --note "$model hit its usage limit; falling back" || true
    : > "$raw"; continue
  fi
  break
done
trap - TERM INT HUP
if [ -z "${tried:-}" ]; then
  echo "all models in the chain are exhausted: $models. Wait, or add models to ${upper_role}_MODEL (comma list)." >&2
  echo 76 > "$dir/$role-$n.done"; exit 76
fi
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
  oc_export "$(cat "$sess_file")" >"$dir/$role.export.json" 2>"$dir/$role.export.err" || true
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
