#!/usr/bin/env bash
# oc-wait — wait for ANY running opencode call of a feature (every lane, builder and qa) in ONE command.
#
#   oc-wait.sh <feature> [seconds]      default 500
#
# Why: waiting lane by lane means the leader (Claude) makes one tool call per lane per 500 s, and each call re-reads
# its whole context. One call that returns as soon as something finishes costs far fewer turns.
#
# It returns when at least one call has finished (or died) that it has not reported before, printing, for each,
# a header, the path of the full reply and the last 40 lines of it. Read the full reply file only if you need it.
# Calls started with `oc-agent.sh --async [--lane X]` are the ones it watches.
#
# Exit: 0 finished, all rc 0 | 1 finished, at least one rc != 0 (the headers say which) | 70 a worker died without a
#       result | 75 nothing finished in time, still running: call again | 76 nothing is running and nothing is unreported
set -euo pipefail
feature=${1:?usage: oc-wait.sh <feature> [seconds]}
limit=${2:-500}
top=.sdlc/features/$feature/.oc
[ -d "$top" ] || { echo "no $top in $PWD" >&2; exit 3; }

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }

# prints "<state> <dir> <role> <n> <start>" per call not yet reported; state: FINISHED | RUNNING | DEAD
scan() {
  local d cf role n start
  for d in "$top" "$top"/lane-*; do
    [ -d "$d" ] || continue
    for cf in "$d"/*.current; do
      [ -s "$cf" ] || continue
      role=$(basename "$cf" .current)
      read -r n start < "$cf"
      [ -f "$d/$role-$n.reported" ] && continue
      if [ -f "$d/$role-$n.done" ]; then echo "FINISHED $d $role $n $start"
      elif [ -s "$d/$role.pid" ] && kill -0 "$(cat "$d/$role.pid")" 2>/dev/null; then echo "RUNNING $d $role $n $start"
      elif [ $(( $(date +%s) - start )) -lt 15 ]; then echo "RUNNING $d $role $n $start"   # --async is still starting
      else echo "DEAD $d $role $n $start"
      fi
    done
  done
}
actor() { local lane=""; case "$1" in */lane-*) lane=${1##*/lane-} ;; esac; echo "$2${lane:+-$lane}"; }

# A running lane past its slice budget is probably stalled, not just slow. Report-only:
# the wait contract (exit codes, FINISHED/RUNNING/DEAD) never changes, so nothing is killed
# and no result is invented. The leader reads the marker and decides (usually: read the
# lane's reply/err, then `sdlc-slices reset` if the work is lost).
slice_budget() { # <lane-id> -> budget_min or empty
  node -e 'let d={}; try { d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")) } catch (e) { process.exit(0) }
    const s = (d.slices || []).find((x) => x && x.id === process.argv[2]);
    if (s && Number.isFinite(+s.budget_min)) console.log(s.budget_min);' \
    ".sdlc/features/$feature/slices.json" "$1" 2>/dev/null || true
}
stalled_note() { # prints "" or " (over budget, possibly stalled: ...)"
  local s d r n st id b mins out=""
  while read -r s d r n st; do
    [ -n "$s" ] || continue
    case "$d" in */lane-*) id=${d##*/lane-} ;; *) continue ;; esac
    b=$(slice_budget "$id")
    [ -n "$b" ] || continue
    if [ $(( $(date +%s) - st )) -gt $(( b * 60 )) ]; then
      mins=$(( ($(date +%s) - st) / 60 ))
      out="${out:+$out, }$(actor "$d" "$r") ${mins}m > ${b}m"
    fi
  done <<< "$1"
  [ -n "$out" ] && printf ' (over budget, possibly stalled: %s)' "$out" || true
}

waited=0
while :; do
  rows=$(scan)
  ready=$(printf '%s\n' "$rows" | grep -E '^(FINISHED|DEAD) ' || true)
  running=$(printf '%s\n' "$rows" | grep -E '^RUNNING ' || true)
  if [ -n "$ready" ]; then
    rc=0
    while read -r state d role n start; do
      [ -n "$state" ] || continue
      a=$(actor "$d" "$role")
      if [ "$state" = DEAD ]; then
        echo "== $a call $n: DEAD, ended without a result (see $d/$role.err and $d/$role-$n.jsonl) =="
        rc=70
      else
        code=$(cat "$d/$role-$n.done")
        secs=$(( $(mtime "$d/$role-$n.done") - start ))
        echo "== $a call $n: rc=$code after ${secs}s. Full reply: $d/$role-$n.md =="
        tail -n 40 "$d/$role-$n.md" 2>/dev/null || true
        [ "$code" != 0 ] && [ "$rc" = 0 ] && rc=1
      fi
      : > "$d/$role-$n.reported"
    done <<< "$ready"
    still=$(printf '%s\n' "$running" | grep -c . || true)
    [ "$still" -gt 0 ] && echo "(still running: $(printf '%s\n' "$running" | while read -r s d r n st; do actor "$d" "$r"; done | paste -sd, -). Call oc-wait.sh again$(stalled_note "$running").)"
    exit "$rc"
  fi
  if [ -z "$running" ]; then echo "nothing is running and nothing is unreported"; exit 76; fi
  if [ "$waited" -ge "$limit" ]; then
    echo "STILL RUNNING: $(printf '%s\n' "$running" | while read -r s d r n st; do echo "$(actor "$d" "$r") (${n}, $(( $(date +%s) - st ))s)"; done | paste -sd, -)$(stalled_note "$running")"
    echo "Call oc-wait.sh again. Do not end your turn while calls are pending."
    exit 75
  fi
  sleep 2; waited=$((waited + 2))
done
