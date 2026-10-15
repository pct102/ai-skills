# Selftest for tools/oc-agent.sh with a fake opencode.
#
# Proves the wrapper tells the truth about how a call ended:
#   - a normal reply exits 0 and is saved
#   - our own watchdog ending a slow call is reported as 124 (timeout), with the partial reply kept
#   - someone else killing opencode (for example the server stopping) is NOT reported as a timeout
#   - --async returns at once, --wait reports "still running" (75) then the result
#   - a worker that died without a result is reported (70)
#   - a call that writes nothing for OC_STALL seconds is ended as stalled (125), not as a timeout
#   - a call that keeps writing is not stalled
#   - lanes keep separate files, numbering and trace actors, and can run at the same time
#
# Run from the repository root:  bash tools/selftest/oc-agent-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OC="$(cd "$HERE/../.." && pwd)/tools/oc-agent.sh"
pass=0
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi
}

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/p"
cat > "$T/bin/opencode" <<'FAKE'
#!/bin/sh
[ "$1" = export ] && exit 1
echo '{"type":"text","sessionID":"s","part":{"type":"text","text":"partial"}}'
echo $$ > "$FAKEPID"
exec sleep "${FAKE_SLEEP:-0}"
FAKE
chmod +x "$T/bin/opencode"
echo "do it" > "$T/p/prompt.md"
cd "$T/p" || exit 1
export PATH="$T/bin:$PATH" FAKEPID="$T/fake.pid"
last_rc() { grep '"reply"' ".sdlc/features/$1/trace.jsonl" | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).rc)))'; }

t=$SECONDS
out="$(bash "$OC" builder ok "$T/p/prompt.md" 2>/dev/null)"; rc=$?
check "a foreground call inside \$(...) returns promptly: no timer left holding stdout open" "1" "$([ $((SECONDS - t)) -lt 10 ] && echo 1 || echo 0)"
check "normal call exits 0" "0" "$rc"
check "…and returns the reply" "partial" "$out"

FAKE_SLEEP=30 OC_TIMEOUT=2 bash "$OC" builder slow "$T/p/prompt.md" >/dev/null 2>&1; rc=$?
check "our watchdog ending a slow call exits 124" "124" "$rc"
check "…and records 124 in the trace" "124" "$(last_rc slow)"
check "…and keeps what the agent had written" "1" "$(grep -c partial .sdlc/features/slow/.oc/builder-1.md)"

# someone else kills opencode: not a timeout
rm -f "$FAKEPID"
FAKE_SLEEP=30 OC_TIMEOUT=60 bash "$OC" builder killed "$T/p/prompt.md" >/dev/null 2>&1 &
W=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$FAKEPID" ] && break; sleep 0.5; done
kill -TERM "$(cat "$FAKEPID")" 2>/dev/null
wait "$W"; rc=$?
check "opencode killed from outside exits 143, not 124" "143" "$rc"
check "…and the trace says 143 too" "143" "$(last_rc killed)"

# async + wait
rm -f "$FAKEPID"
FAKE_SLEEP=5 bash "$OC" --async builder as "$T/p/prompt.md" >/dev/null 2>&1
for _ in 1 2 3 4 5 6; do [ -s .sdlc/features/as/.oc/builder.pid ] && break; sleep 0.5; done
check "--async leaves a worker pid for --wait to watch" "1" "$([ -s .sdlc/features/as/.oc/builder.pid ] && echo 1 || echo 0)"
bash "$OC" --wait builder as 1 >/dev/null 2>&1; rc=$?
check "--wait reports still running (75)" "75" "$rc"
out="$(bash "$OC" --wait builder as 30 2>/dev/null)"; rc=$?
check "--wait then returns the reply with exit 0" "0" "$rc"
check "…the reply" "partial" "$out"

# a worker that dies without a result
rm -f "$FAKEPID"
FAKE_SLEEP=30 bash "$OC" --async builder dead "$T/p/prompt.md" >/dev/null 2>&1
sleep 1
kill -KILL "$(cat .sdlc/features/dead/.oc/builder.pid)" 2>/dev/null
sleep 1
bash "$OC" --wait builder dead 5 >/dev/null 2>&1; rc=$?
check "a worker killed without a result is reported (70)" "70" "$rc"

# stall detector
FAKE_SLEEP=30 OC_TIMEOUT=60 OC_STALL=2 bash "$OC" builder stall "$T/p/prompt.md" >/dev/null 2>&1; rc=$?
check "no output for OC_STALL seconds exits 125" "125" "$rc"
check "…and the trace says 125, not 124" "125" "$(last_rc stall)"
check "…and leaves no marker file behind" "0" "$(ls .sdlc/features/stall/.oc/*.stalled 2>/dev/null | wc -l | tr -d ' ')"

cat > "$T/bin/opencode" <<'FAKE'
#!/bin/sh
[ "$1" = export ] && exit 1
i=0
while [ $i -lt 5 ]; do
  echo '{"type":"text","sessionID":"s","part":{"type":"text","text":"tick"}}'
  i=$((i + 1)); sleep 1
done
FAKE
OC_TIMEOUT=60 OC_STALL=3 bash "$OC" builder steady "$T/p/prompt.md" >/dev/null 2>&1; rc=$?
check "a call that keeps writing is not stalled" "0" "$rc"
OC_TIMEOUT=60 OC_STALL=0 bash "$OC" builder nostall "$T/p/prompt.md" >/dev/null 2>&1; rc=$?
check "OC_STALL=0 turns the detector off" "0" "$rc"

# lanes
cat > "$T/bin/opencode" <<'FAKE'
#!/bin/sh
[ "$1" = export ] && exit 1
echo '{"type":"text","sessionID":"s-'"$FAKE_ID"'","part":{"type":"text","text":"from '"$FAKE_ID"'"}}'
sleep 2
FAKE
FAKE_ID=a bash "$OC" --lane alpha --async builder lanes "$T/p/prompt.md" >/dev/null 2>&1
FAKE_ID=b bash "$OC" --lane beta --async builder lanes "$T/p/prompt.md" >/dev/null 2>&1
for _ in 1 2 3 4 5 6; do [ -s .sdlc/features/lanes/.oc/lane-alpha/builder.pid ] && [ -s .sdlc/features/lanes/.oc/lane-beta/builder.pid ] && break; sleep 0.5; done
check "two lanes have their own worker pids at the same time" "2" "$(ls .sdlc/features/lanes/.oc/lane-*/builder.pid 2>/dev/null | wc -l | tr -d ' ')"
out_a="$(bash "$OC" --lane alpha --wait builder lanes 30 2>/dev/null)"; rc_a=$?
out_b="$(bash "$OC" --lane beta --wait builder lanes 30 2>/dev/null)"; rc_b=$?
check "each lane returns its own reply" "from a|from b" "$out_a|$out_b"
check "…both exit 0" "0 0" "$rc_a $rc_b"
check "each lane keeps its own session" "s-a s-b" "$(cat .sdlc/features/lanes/.oc/lane-alpha/builder.session) $(cat .sdlc/features/lanes/.oc/lane-beta/builder.session)"
check "the trace shows each lane as its own actor" "1 1" "$(grep -c '"from":"builder-alpha"' .sdlc/features/lanes/trace.jsonl) $(grep -c '"from":"builder-beta"' .sdlc/features/lanes/trace.jsonl)"
FAKE_ID=a bash "$OC" --lane alpha builder lanes "$T/p/prompt.md" >/dev/null 2>&1
check "a lane numbers its own calls" "2 1" "$(ls .sdlc/features/lanes/.oc/lane-alpha/builder-*.jsonl | wc -l | tr -d ' ') $(ls .sdlc/features/lanes/.oc/lane-beta/builder-*.jsonl | wc -l | tr -d ' ')"
bash "$OC" --lane "Bad Lane" builder lanes "$T/p/prompt.md" >/dev/null 2>&1; rc=$?
check "a bad lane name is refused (3)" "3" "$rc"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
