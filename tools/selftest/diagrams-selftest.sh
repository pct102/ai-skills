# Selftest for tools/sdlc-diagrams.mjs.
#
# Proves the diagram step reports recorded facts and nothing else:
#   - a trace becomes a sequence diagram that passes archify's own validation
#   - a status becomes a lifecycle diagram that passes too, and shows the current phase, while the feature is not accepted
#   - once the feature is accepted the lifecycle diagram is not made, and one left by an earlier run is removed
#   - no per-feature copy of the autopilot process map is made, and one left by an older run is removed
#   - failed and timed-out calls are drawn as such, and counted in the Problems card
#   - a feature with no trace or status is skipped, not invented
#   - re-running replaces the previous output instead of failing on stale receipts
#   - the hub lists every html in the folder, including one the leader drew
#
# Needs no browser: the browser gate is switched off (--no-browser).
# Run from the repository root:  bash tools/selftest/diagrams-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DIAG="$REPO/tools/sdlc-diagrams.mjs"
pass=0
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi
}

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
cd "$T" || exit 1
F=.sdlc/features/demo
mkdir -p "$F"
cat > "$F/trace.jsonl" <<'J'
{"ts":"2026-10-02T07:00:00.000Z","from":"leader","to":"leader","kind":"decision","note":"spec drafted"}
{"ts":"2026-10-02T07:00:01.000Z","from":"leader","to":"builder","kind":"prompt","file":".sdlc/features/demo/.oc/prompts/01-build.md","note":"[opencode/muse-spark-1.3-contributor-free] You are the BUILDER"}
{"ts":"2026-10-02T07:30:00.000Z","from":"builder","to":"leader","kind":"reply","rc":124,"ms":1799000,"note":"(verified: opencode/muse-spark-1.3-contributor-free) I'll start by reading"}
{"ts":"2026-10-02T07:30:05.000Z","from":"leader","to":"builder","kind":"prompt","file":".sdlc/features/demo/.oc/prompts/02-continue.md","note":"[opencode/muse-spark-1.3-contributor-free] Continue"}
{"ts":"2026-10-02T07:35:00.000Z","from":"builder","to":"leader","kind":"reply","rc":0,"ms":295000,"note":"(verified: opencode/muse-spark-1.3-contributor-free) Done: 3 files"}
{"ts":"2026-10-02T07:36:00.000Z","from":"verify","to":"leader","kind":"verify","rc":0,"note":"evidence.json"}
J
printf '{ "feature": "demo", "phase": "validating", "budget": 2, "repair_iterations": 1, "last_run": { "at": "2026-10-02T07:36:00.000Z", "result": "fail", "passed": 2, "failed": 1 } }\n' > "$F/status.json"

out="$(node "$DIAG" --feature demo --no-browser 2>&1)"; rc=$?
check "generates the trace and the status diagrams, exit 0" "0" "$rc"
check "sequence html exists" "1" "$([ -s $F/diagrams/trace.sequence.html ] && echo 1 || echo 0)"
check "lifecycle html exists" "1" "$([ -s $F/diagrams/lifecycle.html ] && echo 1 || echo 0)"

J=$F/diagrams/trace.sequence.json
check "the sequence JSON passes archify validation" "0" "$(node "$REPO/skills/archify/bin/archify.mjs" validate sequence $J --quality showcase >/dev/null 2>&1; echo $?)"
check "the lifecycle JSON passes archify validation" "0" "$(node "$REPO/skills/archify/bin/archify.mjs" validate lifecycle $F/diagrams/lifecycle.json --quality showcase >/dev/null 2>&1; echo $?)"
count() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(eval(process.argv[2]))' "$1" "$2"; }
check "5 calls drawn, the self-decision is not an arrow" "5" "$(count $J 'j.messages.length')"
check "the timed-out reply is drawn as a failure" "security" "$(count $J 'j.messages.find(m=>/timeout/.test(m.label)).variant')"
check "prompts are named by their file" "1" "$(count $J 'j.messages.filter(m=>m.label==="prompt: build").length')"
check "the Problems card counts the timeout" "1" "$(count $J 'j.cards.find(c=>c.title==="Problems").items.filter(i=>/rc=124/.test(i)).length')"
check "the Models card says verified" "1" "$(count $J 'j.cards.find(c=>c.title==="Models").items.filter(i=>/verified/.test(i)).length')"
check "lifecycle marks the current phase" "NOW" "$(count $F/diagrams/lifecycle.json 'j.states.find(s=>s.id==="validating").tag')"
check "no process map is made" "0" "$(ls $F/diagrams/process.* 2>/dev/null | wc -l | tr -d ' ')"

# the leader may add its own diagram; the hub must list it
echo '<html><head><title>Feature architecture</title></head><body>x</body></html>' > $F/diagrams/architecture.html
mkdir -p $F/diagrams/receipts/trace.sequence && echo stale > $F/diagrams/receipts/trace.sequence/old.json
echo '<html><head><title>How autopilot delivers a feature</title></head></html>' > $F/diagrams/process.workflow.html; echo '{}' > $F/diagrams/process.json
node "$DIAG" --feature demo --no-browser >/dev/null 2>&1; rc=$?
check "re-running over existing output succeeds" "0" "$rc"
check "…and clears that diagram's stale receipts first" "0" "$([ -e $F/diagrams/receipts/trace.sequence/old.json ] && echo 1 || echo 0)"
check "hub lists the leader's own diagram" "1" "$(grep -c 'Feature architecture' $F/diagrams/index.html)"
check "hub lists the generated ones" "2" "$(grep -c 'Autopilot trace\|Feature status' $F/diagrams/index.html)"
check "a process map left by an older run is removed, and not listed" "0 0" "$(ls $F/diagrams/process.* 2>/dev/null | wc -l | tr -d ' ') $(grep -c 'How autopilot' $F/diagrams/index.html)"

# the hub says what is not drawn yet, and stops saying it once it is
check "hub flags the workflow diagram as not drawn" "1" "$(grep -c 'What the user does (workflow)' $F/diagrams/index.html)"
echo '<html><head><title>Player flow</title></head><body>x</body></html>' > $F/diagrams/workflow.html
node "$DIAG" --feature demo --no-browser >/dev/null 2>&1
check "…and drops the flag once workflow.html exists" "0" "$(grep -c 'not drawn yet' $F/diagrams/index.html)"
# an accepted feature has no status map: it would only repeat the end of the line
printf '{ "feature": "demo", "phase": "accepted", "budget": 2, "repair_iterations": 1 }\n' > "$F/status.json"
out="$(node "$DIAG" --feature demo --no-browser 2>&1)"; rc=$?
check "accepted: the run still succeeds" "0" "$rc"
check "…says why the status map was skipped" "1" "$(printf '%s' "$out" | grep -c 'lifecycle: skipped, the feature is accepted')"
check "…removes the status map left from when it was not accepted" "0" "$(ls $F/diagrams/lifecycle.* 2>/dev/null | wc -l | tr -d ' ')"
check "…and the hub no longer lists it, but still lists the trace" "0 1" "$(grep -c 'Feature status' $F/diagrams/index.html) $(grep -c 'Autopilot trace' $F/diagrams/index.html)"
# the shape examples shipped with the feature-diagrams skill must stay valid
for t in architecture workflow; do
  check "feature-diagrams example.$t.json validates" "0" "$(node "$REPO/skills/archify/bin/archify.mjs" validate $t "$REPO/skills/feature-diagrams/references/example.$t.json" --quality showcase >/dev/null 2>&1; echo $?)"
done

# A run names one actor per lane (`builder-core`, `builder-lightwell`, `qa-e2e` …). Drawn as one lifeline
# each, a trace with that many lanes no longer fits archify's canvas: its validate gate then refuses the
# whole render and no HTML is written, which is what used to leave this diagram missing from the hub. The
# lanes are folded into their roles and named on the arrow instead, so this must validate with as many
# lanes as a real run has, and must still say which lane a call belonged to.
mkdir -p .sdlc/features/lanes
cat > .sdlc/features/lanes/trace.jsonl <<'J'
{"ts":"2026-10-02T07:00:00.000Z","from":"leader","to":"builder-core","kind":"prompt","file":".sdlc/features/lanes/.oc/prompts/10-core.md","note":"[opencode/muse-spark-1.3-contributor-free] brief: slice core"}
{"ts":"2026-10-02T07:00:01.000Z","from":"leader","to":"builder-lightwell","kind":"prompt","file":".sdlc/features/lanes/.oc/prompts/11-lightwell.md","note":"[opencode/muse-spark-1.3-contributor-free] brief: slice lightwell"}
{"ts":"2026-10-02T07:00:02.000Z","from":"leader","to":"qa-e2e","kind":"prompt","file":".sdlc/features/lanes/.oc/prompts/01-qa.md","note":"[opencode-go/deepseek-v4.1-flash] write the suite"}
{"ts":"2026-10-02T07:06:00.000Z","from":"qa-e2e","to":"leader","kind":"reply","rc":0,"ms":358000,"note":"(verified: opencode-go/deepseek-v4.1-flash) Now I have the stable hooks and the full table of behaviours the contract asks for, twenty six rows, each with its own tier and its own assertion"}
{"ts":"2026-10-02T07:26:00.000Z","from":"builder-core","to":"leader","kind":"reply","rc":0,"ms":1560000,"note":"(verified: opencode/muse-spark-1.3-contributor-free) Building the door and label slices, then the tests that pin them"}
{"ts":"2026-10-02T07:36:00.000Z","from":"verify","to":"leader","kind":"verify","rc":0,"note":"evidence.json"}
J
node "$DIAG" --feature lanes --only trace --no-browser >/dev/null 2>&1
LJ=.sdlc/features/lanes/diagrams/trace.sequence.json
check "many lanes: the trace JSON passes archify validation" "0" "$(node "$REPO/skills/archify/bin/archify.mjs" validate sequence $LJ --quality showcase >/dev/null 2>&1; echo $?)"
check "…the lanes are folded, one lifeline per role" "4" "$(count $LJ 'j.participants.length')"
check "…and every message stays on a role lifeline" "1" "$(count $LJ "j.messages.every(m=>['leader','builder','qa','verify'].includes(m.from)&&['leader','builder','qa','verify'].includes(m.to))?1:0")"
check "…each lane call says which lane it was" "5" "$(count $LJ 'j.messages.filter(m=>/^\[/.test(m.label)).length')"
check "…the role keeps the model it ran" "1" "$(count $LJ "j.participants.filter(p=>/muse-spark/.test(p.sublabel||'')).length")"

# times: stored as UTC, shown in local time with the year and the month spelled out
TR="$REPO/tools/sdlc-trace.mjs"
mkdir -p .sdlc/features/clock
cat > .sdlc/features/clock/trace.jsonl <<'J'
{"ts":"2026-10-01T17:40:57.000Z","from":"leader","to":"builder","kind":"prompt","note":"[x/y] before midnight in Vietnam"}
{"ts":"2026-10-02T07:04:52.000Z","from":"builder","to":"leader","kind":"reply","rc":143,"ms":-1790996404000,"note":"killed"}
J
TZ=Asia/Ho_Chi_Minh node "$TR" --feature clock --render >/dev/null
check "trace.md shows local time with the month spelled out" "1" "$(grep -c '2026 October 2 00:40:57' .sdlc/features/clock/trace.md)"
check "…and a later day in full" "1" "$(grep -c '2026 October 2 14:04:52' .sdlc/features/clock/trace.md)"
check "…never the old MM-DD form" "0" "$(grep -c '10-02 14:04' .sdlc/features/clock/trace.md)"
TZ=UTC node "$TR" --feature clock --render >/dev/null
check "the same event read in UTC shows the UTC day" "1" "$(grep -c '2026 October 1 17:40:57' .sdlc/features/clock/trace.md)"
check "trace.html uses the same format" "1" "$(grep -c '2026 October 1 17:40:57' .sdlc/features/clock/trace.html)"
TZ=Asia/Ho_Chi_Minh node "$DIAG" --feature clock --only trace --no-browser >/dev/null 2>&1
check "a nonsense negative duration is not drawn" "0" "$(grep -c '1790996404' .sdlc/features/clock/diagrams/trace.sequence.json)"
check "…but the failure still is" "1" "$([ "$(grep -c 'killed' .sdlc/features/clock/diagrams/trace.sequence.json)" -ge 1 ] && echo 1 || echo 0)"
check "oc-agent's kill handler does not call date" "0" "$(sed -n '/^on_kill/,/^}/p' "$REPO/tools/oc-agent.sh" | grep -c 'date')"

# nothing recorded -> skipped, never invented
mkdir -p .sdlc/features/empty
out="$(node "$DIAG" --feature empty --no-browser 2>&1)"; rc=$?
check "an empty feature exits 0" "0" "$rc"
check "…and says it skipped both" "2" "$(printf '%s' "$out" | grep -c 'skipped')"
check "…and wrote no diagram" "0" "$(ls .sdlc/features/empty/diagrams/*.html 2>/dev/null | grep -vc index.html)"
check "an unknown feature is a usage error" "3" "$(node "$DIAG" --feature nope >/dev/null 2>&1; echo $?)"

# ---- the evidence page: tests, screenshots, earlier failed round, visual review ------------------------------------
E=.sdlc/features/ev
mkdir -p $E/evidence/round-1
printf 'p' > $E/evidence/B1-start.png; printf 'p' > $E/evidence/B2-after-drop.png; printf 'old' > $E/evidence/round-1/B2-after-drop.png
cat > $E/evidence/playwright.json <<'J'
{
  "config": {},
  "suites": [{ "title": "a.spec.ts", "file": "a.spec.ts", "specs": [
    { "title": "B1: valid <login> lands on the dashboard", "file": "a.spec.ts", "tests": [{ "status": "expected", "results": [{ "status": "passed", "duration": 120, "steps": [{ "title": "open the page", "duration": 40 }], "attachments": [] }] }] },
    { "title": "B2: dropped object snaps to the wall", "file": "a.spec.ts", "tests": [{ "status": "unexpected", "results": [{ "status": "failed", "duration": 900, "errors": [{ "message": "expected 1 got 2" }], "steps": [{ "title": "drop the sofa", "duration": 300, "error": { "message": "boom" } }], "attachments": [] }] }] }
  ] }],
  "errors": []
}
J
printf 'CHECKLIST\n- C1: sofa inside the room -> flagged\nFLAG | B2 | B2-after-drop.png | the sofa overlaps the wall on the right | spec: objects stay inside the room\nVISUAL RESULT: FLAGS 1\n' > $E/visual-review.md
printf '{"feature":"ev","phase":"accepted","budget":2}\n' > $E/status.json
out="$(node "$DIAG" --feature ev --no-browser 2>&1)"; rc=$?
P=$E/diagrams/evidence.html
check "an evidence page is made from the Playwright JSON, exit stays 0" "0" "$rc"
check "…the page exists" "1" "$([ -s $P ] && echo 1 || echo 0)"
check "…failures come before passes" "1" "$(node -e 'const h=require("fs").readFileSync(process.argv[1],"utf8");console.log(h.indexOf("t failed")>0&&h.indexOf("t failed")<h.indexOf("t passed")?1:0)' $P)"
check "…titles are escaped (no raw <login> tag)" "0" "$(grep -c '<login>' $P)"
check "…the failing test shows its error and its step" "2" "$(grep -o -E 'expected 1 got 2|drop the sofa' $P | wc -l | tr -d ' ')"
check "…a screenshot is tied to its test by id (B2-after-drop.png)" "1" "$(grep -c 'B2-after-drop.png' $P | awk '{print ($1>0)?1:0}')"
check "…the earlier failed run's picture is shown as 'before'" "1" "$(grep -c 'before (round-1)' $P | awk '{print ($1>0)?1:0}')"
check "…the visual flag is shown as a suspicion" "1" "$(grep -c 'overlaps the wall' $P | awk '{print ($1>0)?1:0}')"
check "…the hub lists the page" "1" "$(grep -c 'evidence.html' $E/diagrams/index.html | awk '{print ($1>0)?1:0}')"
printf 'not json' > $E/evidence/playwright.json
node "$DIAG" --feature ev --no-browser >/dev/null 2>&1; rc=$?
check "an unreadable JSON still exits 0 and the page says so" "0 1" "$rc $(grep -c 'Cannot read evidence/playwright.json' $P)"
rm -rf $E/evidence $E/visual-review.md
node "$DIAG" --feature ev --no-browser >/dev/null 2>&1
check "no QA files: the page is not made and a stale one is removed" "0" "$([ -e $P ] && echo 1 || echo 0)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
