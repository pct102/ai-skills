# Selftest for tools/claude-follow.mjs, the live view of what the leader (headless claude -p) is doing.
#
# Proves, with a fixture transcript:
#   - it finds the project's transcript from the working directory (non-alphanumerics become "-")
#   - it prints what Claude said, each tool call and a short line of each result
#   - it keeps running totals: turns, tokens written, context size (one turn counted once, however many lines it has)
#   - files older than --since are ignored; a newer session file (a resumed run) is picked up
#   - a missing transcript is reported, not a crash
#
# Run from the repository root:  bash tools/selftest/claude-follow-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CF="$(cd "$HERE/../.." && pwd)/tools/claude-follow.mjs"
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT

PROJ="$T/My_Project.v2"; mkdir -p "$PROJ"
KEY="$(printf '%s' "$(cd "$PROJ" && pwd -P)" | sed 's/[^A-Za-z0-9]/-/g')"
DIR="$T/cfg/projects/$KEY"; mkdir -p "$DIR"

node -e '
const fs=require("fs");const out=process.argv[1];
const L=[];
const ts=(s)=>new Date(Date.UTC(2026,9,4,1,0,s)).toISOString();
L.push({type:"user",timestamp:ts(0),message:{role:"user",content:"/feature-autopilot feature name: demo"}});
// turn 1 has two lines (text, then tool_use) with the same message id: it must count once
L.push({type:"assistant",timestamp:ts(1),message:{id:"m1",usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:1000,cache_creation_input_tokens:200},content:[{type:"text",text:"Reading the plan first."}]}});
L.push({type:"assistant",timestamp:ts(2),message:{id:"m1",usage:{input_tokens:10,output_tokens:40,cache_read_input_tokens:1000,cache_creation_input_tokens:200},content:[{type:"tool_use",name:"Bash",input:{command:"cat plan.md\nsecond line"}}]}});
L.push({type:"user",timestamp:ts(3),message:{role:"user",content:[{type:"tool_result",content:"# Plan\nbody"}]}});
L.push({type:"assistant",timestamp:ts(4),message:{id:"m2",usage:{input_tokens:12,output_tokens:60,cache_read_input_tokens:1500,cache_creation_input_tokens:300},content:[{type:"tool_use",name:"Edit",input:{file_path:"/p/js/rules.js"}}]}});
L.push({type:"user",timestamp:ts(5),message:{role:"user",content:[{type:"tool_result",is_error:true,content:[{type:"text",text:"no such file"}]}]}});
fs.writeFileSync(out,L.map((x)=>JSON.stringify(x)).join("\n")+"\n");
' "$DIR/s1.jsonl"

out="$(node "$CF" --cwd "$PROJ" --base "$T/cfg" --once 2>&1)"
check "it announces the session" "1" "$(printf '%s' "$out" | grep -c 'Claude session s1')"
check "it prints what Claude said" "1" "$(printf '%s' "$out" | grep -c '💬 Reading the plan first.')"
check "it prints a tool call, the command squeezed onto one line" "1" "$(printf '%s' "$out" | grep -c '🔧 Bash: cat plan.md second line')"
check "it prints an edit with its file" "1" "$(printf '%s' "$out" | grep -c '🔧 Edit /p/js/rules.js')"
check "it prints a result line" "1" "$(printf '%s' "$out" | grep -c '↳ # Plan body')"
check "an error result is marked" "1" "$(printf '%s' "$out" | grep -c '✗ no such file')"
check "the prompt that started the run is shown" "1" "$(printf '%s' "$out" | grep -c '👤 /feature-autopilot feature name: demo')"
check "totals count a turn once: 2 turns, 100 written (40 + 60), context from the last turn" "1" "$(printf '%s' "$out" | tail -1 | grep -c 'Σ turns=2 written=100 context=1.8k')"

# --since: an old file is ignored, a newer one is shown
touch -t 202601010000 "$DIR/s1.jsonl"
cp "$DIR/s1.jsonl" "$DIR/s2.jsonl"; touch "$DIR/s2.jsonl"
since=$(( $(date +%s) - 60 ))
out="$(node "$CF" --cwd "$PROJ" --base "$T/cfg" --since "$since" --once 2>&1)"
check "--since ignores the older session file" "0 1" "$(printf '%s' "$out" | grep -c 'session s1') $(printf '%s' "$out" | grep -c 'session s2')"

out="$(node "$CF" --cwd "$T/nowhere" --base "$T/cfg" --once 2>&1)"; rc=$?
check "no transcript is reported, not a crash" "0 1" "$rc $(printf '%s' "$out" | grep -c 'no Claude session found')"

# following: a line appended later is printed
rm -f "$DIR/s2.jsonl"
( node "$CF" --cwd "$PROJ" --base "$T/cfg" > "$T/follow.out" 2>&1 & echo $! > "$T/follow.pid" )
sleep 2
node -e 'require("fs").appendFileSync(process.argv[1],JSON.stringify({type:"assistant",timestamp:new Date().toISOString(),message:{id:"m9",usage:{output_tokens:7},content:[{type:"text",text:"appended while following"}]}})+"\n")' "$DIR/s1.jsonl"
touch "$DIR/s1.jsonl"
sleep 3
kill "$(cat "$T/follow.pid")" 2>/dev/null
check "a line appended while following is printed" "1" "$(grep -c 'appended while following' "$T/follow.out")"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
