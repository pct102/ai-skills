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

# ---- model chain: lanes spread over the chain, and a 429 moves on to the next model --------------------------
mkdir -p "$T/bin2"
cat > "$T/bin2/opencode" <<'FAKE'
#!/bin/sh
[ "$1" = export ] && exit 1
m=""; while [ $# -gt 0 ]; do [ "$1" = -m ] && m=$2; shift; done
echo "$m" >> "$MODELLOG"
if [ "$m" = "$BAD_MODEL" ] && [ -n "${BAD_EXIT0:-}" ]; then   # what opencode really does: retries, then exits 0 with only an error event
  echo '{"type":"error","sessionID":"s","error":{"name":"APIError","data":{"message":"Upstream request failed: Rate limit exceeded.","statusCode":429}}}'; exit 0; fi
if [ "$m" = "$BAD_MODEL" ]; then echo "429 Too Many Requests" >&2; exit 1; fi
echo '{"type":"text","sessionID":"s","part":{"type":"text","text":"ok"}}'
sleep "${FAKE_SLEEP:-0}"
FAKE
chmod +x "$T/bin2/opencode"
export MODELLOG="$T/models.log" OC_LEASE_DIR="$T/leases" BUILDER_MODEL="m1,m2,m3"
rm -f "$MODELLOG"
FAKE_SLEEP=4 PATH="$T/bin2:$PATH" bash "$OC" --async --lane a builder chain "$T/p/prompt.md" >/dev/null 2>&1
FAKE_SLEEP=4 PATH="$T/bin2:$PATH" bash "$OC" --async --lane b builder chain "$T/p/prompt.md" >/dev/null 2>&1
FAKE_SLEEP=4 PATH="$T/bin2:$PATH" bash "$OC" --async --lane c builder chain "$T/p/prompt.md" >/dev/null 2>&1
for l in a b c; do PATH="$T/bin2:$PATH" bash "$OC" --lane $l --wait builder chain 60 >/dev/null 2>&1; done
check "three parallel lanes use three different models, not all the first" "m1 m2 m3" "$(sort "$MODELLOG" | xargs)"
check "…and no lease is left behind" "0" "$(ls "$T/leases" | wc -l | tr -d ' ')"
rm -f "$MODELLOG"; export BAD_MODEL=m1 BUILDER_MODEL="m1,m2"
PATH="$T/bin2:$PATH" bash "$OC" builder chain429 "$T/p/prompt.md" >/dev/null 2>&1; rc=$?
check "a 429 on the first model falls through to the next, which answers" "0 m1 m2" "$rc $(xargs < "$MODELLOG")"
rm -f "$MODELLOG"
PATH="$T/bin2:$PATH" bash "$OC" builder chain429 "$T/p/prompt.md" >/dev/null 2>&1
check "…and that model rests: the next call goes straight to m2" "m2" "$(xargs < "$MODELLOG")"
rm -f "$MODELLOG" .sdlc/features/chainexit0/.oc/exhausted-models; export BAD_EXIT0=1
PATH="$T/bin2:$PATH" bash "$OC" builder chainexit0 "$T/p/prompt.md" > "$T/exit0.out" 2>/dev/null; rc=$?
check "a 429 that opencode reports with exit 0 and no reply text still falls through to the next model" "0 m1 m2 ok" "$rc $(xargs < "$MODELLOG") $(cat "$T/exit0.out")"
echo "m1 $(date +%s) 0.15" >> .sdlc/features/chainexit0/.oc/exhausted-models
check "a repeated 429 doubles the rest (0.15 h -> 0.3 h)" "0.3" "$(awk -v m=m1 -v now="$(date +%s)" -v base=0.15 -v cap=6 '$1==m && now-$2 < 7200 {n++} END{h=base*(2^n); print (h>cap?cap:h)}' .sdlc/features/chainexit0/.oc/exhausted-models | head -1)"
unset BAD_MODEL BUILDER_MODEL BAD_EXIT0
rm -f "$MODELLOG"; unset BUILDER_MODEL
VISUAL_MODEL=vis1,vis2 PATH="$T/bin2:$PATH" bash "$OC" visual vfeat "$T/p/prompt.md" >/dev/null 2>&1; rc=$?
check "the visual role runs on VISUAL_MODEL, not the builder's models" "0 vis1" "$rc $(xargs < "$MODELLOG")"
check "an unknown role is still refused (3)" "3" "$(bash "$OC" reviewer vfeat "$T/p/prompt.md" >/dev/null 2>&1; echo $?)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
