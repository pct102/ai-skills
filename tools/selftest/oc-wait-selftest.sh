# Selftest for tools/oc-wait.sh: one command that waits for any running lane.
#
# Proves:
#   - nothing running and nothing unreported exits 76
#   - a running call that does not finish in time exits 75 and names the lane
#   - a finished call is reported at once (exit 0, header, tail of the reply) even while another lane still runs
#   - a finished call is reported only once
#   - a non-zero rc is exit 1 and shown in the header; a dead worker is exit 70
#   - a call that is still starting (no pid yet) counts as running, not dead
#   - it returns as soon as a call finishes during the wait
#   - plain (lane-less) calls and lane calls both work
#
# Run from the repository root:  bash tools/selftest/oc-wait-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
W="$(cd "$HERE/../.." && pwd)/tools/oc-wait.sh"
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'kill $(cat "$T"/*.pid 2>/dev/null) 2>/dev/null; rm -rf "$T"' EXIT
cd "$T" || exit 1

D=.sdlc/features/f/.oc
fresh() { rm -rf .sdlc; mkdir -p "$D"; }
# call <dir> <role> <n> <age-seconds>: records a call started <age> seconds ago
call() { mkdir -p "$1"; echo "$3 $(( $(date +%s) - $4 ))" > "$1/$2.current"; }
live_pid() { sleep 60 & echo $! > "$1"; echo $! >> "$T/all.pid"; }
finish() { echo "$4" > "$1/$2-$3.done"; printf 'reply of %s\n' "$2" > "$1/$2-$3.md"; }
w() { bash "$W" f "$@" 2>&1; }
rc() { bash "$W" f "$@" >/dev/null 2>&1; echo $?; }

fresh
check "nothing running, nothing unreported: 76" "76" "$(rc 2)"

fresh; call "$D/lane-ui" builder 1 100; live_pid "$D/lane-ui/builder.pid"
check "a running call that does not finish in time: 75" "75" "$(rc 2)"
check "…and the message names the lane" "1" "$(w 2 | grep -c 'builder-ui')"

fresh; call "$D/lane-ui" builder 1 100; live_pid "$D/lane-ui/builder.pid"
call "$D/lane-rules" builder 1 100; finish "$D/lane-rules" builder 1 0
out="$(w 2)"; code=$?
check "a finished lane is reported at once while another still runs: 0" "0" "$code"
check "…the header names the finished lane" "1" "$(printf '%s' "$out" | grep -c '== builder-rules call 1: rc=0')"
check "…the reply tail is shown" "1" "$(printf '%s' "$out" | grep -c 'reply of builder')"
check "…and it says which lane is still running" "1" "$(printf '%s' "$out" | grep -c 'still running: builder-ui')"
check "the same finished call is not reported twice (75: only ui left)" "75" "$(rc 2)"

fresh; call "$D/lane-ui" builder 2 100; finish "$D/lane-ui" builder 2 124
out="$(w 2)"; code=$?
check "a non-zero rc is exit 1" "1" "$code"
check "…and the header shows it" "1" "$(printf '%s' "$out" | grep -c 'rc=124')"
check "after reporting, nothing is left: 76" "76" "$(rc 2)"

fresh; call "$D/lane-ui" builder 1 100; echo 999999 > "$D/lane-ui/builder.pid"
check "a worker whose pid is gone and has no result: 70" "70" "$(rc 2)"

fresh; call "$D/lane-ui" builder 1 1
check "a call that is still starting (no pid yet) is running, not dead: 75" "75" "$(rc 2)"

fresh; call "$D" qa 1 100; finish "$D" qa 1 0
out="$(w 2)"
check "a plain call without a lane is named by its role" "1" "$(printf '%s' "$out" | grep -c '== qa call 1')"

fresh; call "$D/lane-ui" builder 1 100; seq 1 100 | sed 's/^/line /' > "$D/lane-ui/builder-1.md"; echo 0 > "$D/lane-ui/builder-1.done"
out="$(w 2)"
check "only the last 40 lines of a long reply are printed" "1 0" "$(printf '%s' "$out" | grep -c '^line 100$') $(printf '%s' "$out" | grep -c '^line 1$')"
check "…and the full reply path is given" "1" "$(printf '%s' "$out" | grep -c 'builder-1.md')"

fresh; call "$D/lane-ui" builder 1 100; live_pid "$D/lane-ui/builder.pid"
( sleep 3; echo 0 > "$D/lane-ui/builder-1.done"; echo done > "$D/lane-ui/builder-1.md" ) &
t=$SECONDS
code=$(rc 30)
check "it returns as soon as a call finishes during the wait" "0 1" "$code $([ $((SECONDS - t)) -lt 15 ] && echo 1 || echo 0)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
