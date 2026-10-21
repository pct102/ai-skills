# Selftest for tools/sdlc-slices.mjs.
#
# Proves the rules that make parallel builders safe:
#   - a plan with two concurrent slices on the same files, a cycle, a missing dependency or a bad id is refused
#   - slices that depend on each other may share files; independent ones may not
#   - ready honours dependencies and never offers a slice whose files clash with a running one
#   - done fails a slice that edited a file it does not own, and passes one that stayed inside
#   - a file owned by a slice that ran at the same time is not blamed on this slice
#   - a failing check fails the slice; reset lets it run again
#
# Run from the repository root:  bash tools/selftest/slices-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SL="$(cd "$HERE/../.." && pwd)/tools/sdlc-slices.mjs"
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
cd "$T" || exit 1
mkdir -p .sdlc/features/f js tests
rc() { node "$SL" "$@" >/dev/null 2>&1; echo $?; }
out() { node "$SL" "$@" 2>&1; }
put() { printf '%s\n' "$2" > ".sdlc/features/f/$1"; }

put slices.json '{"slices":[
 {"id":"state","owns":["js/state.js"]},
 {"id":"view","owns":["js/view.js"]},
 {"id":"app","owns":["js/app.js","index.html"],"depends":["state","view"]}]}'
check "a valid plan exits 0" "0" "$(rc plan f)"
check "…and shows two waves" "wave 1: state, view|wave 2: app" "$(out plan f | grep '^ *wave' | sed 's/^ *//' | paste -sd'|' -)"

put slices.json '{"slices":[{"id":"a","owns":["js/x.js"]},{"id":"b","owns":["js/x.js"]}]}'
check "two independent slices on one file are refused (3)" "3" "$(rc plan f)"
put slices.json '{"slices":[{"id":"a","owns":["js/**"]},{"id":"b","owns":["js/x.js"],"depends":["a"]}]}'
check "…but the same files are fine when one depends on the other" "0" "$(rc plan f)"
put slices.json '{"slices":[{"id":"a","owns":["a/**"],"depends":["b"]},{"id":"b","owns":["b/**"],"depends":["a"]}]}'
check "a dependency cycle is refused (3)" "3" "$(rc plan f)"
put slices.json '{"slices":[{"id":"a","owns":["a/**"],"depends":["zzz"]}]}'
check "an unknown dependency is refused (3)" "3" "$(rc plan f)"
put slices.json '{"slices":[{"id":"Bad Id","owns":["a/**"]}]}'
check "a bad id is refused (3)" "3" "$(rc plan f)"
put slices.json '{"slices":[{"id":"a","owns":[]}]}'
check "a slice with no files is refused (3)" "3" "$(rc plan f)"

put slices.json '{"slices":[
 {"id":"state","owns":["js/state.js","tests/state.test.js"],"check":"test -f js/state.js"},
 {"id":"view","owns":["js/view.js"]},
 {"id":"app","owns":["js/app.js"],"depends":["state","view"]}]}'
echo "// shared" > js/shared.js
check "ready offers the slices with no dependencies" "state,view" "$(out ready f | paste -sd, -)"
node "$SL" start f state >/dev/null 2>&1
check "a started slice is no longer offered" "view" "$(out ready f | paste -sd, -)"
check "a slice that is not ready cannot be started (3)" "3" "$(rc start f app)"

echo "x" > js/state.js
check "a slice that stayed inside its files passes" "0" "$(rc done f state)"
check "…its status is done" "done" "$(node "$SL" status f --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).slices.find(x=>x.id==="state").status))')"

# view edits a file it does not own
node "$SL" start f view >/dev/null 2>&1
echo "y" > js/view.js
echo "oops" >> js/shared.js
res="$(node "$SL" done f view 2>&1)"; r=$?
check "a slice that edited a file it does not own fails (1)" "1" "$r"
check "…and the report names the file" "1" "$(printf '%s' "$res" | grep -c 'js/shared.js')"
check "…the file it did own is not blamed" "0" "$(printf '%s' "$res" | grep -c 'js/view.js')"

# reset and redo
node "$SL" reset f view >/dev/null 2>&1
node "$SL" start f view >/dev/null 2>&1
echo "z" > js/view.js
check "after a reset the slice can run again, with a fresh baseline" "0" "$(rc done f view)"
check "app is ready once its dependencies are done" "app" "$(out ready f | paste -sd, -)"

# concurrent slices: each one's files are not blamed on the other
put slices.json '{"slices":[{"id":"left","owns":["l/**"]},{"id":"right","owns":["r/**"]}]}'
mkdir -p l r
node "$SL" start f left >/dev/null 2>&1
node "$SL" start f right >/dev/null 2>&1
echo 1 > l/a.js; echo 2 > r/b.js
check "two slices running together do not blame each other" "0" "$(rc done f left)"
check "…the second one passes too" "0" "$(rc done f right)"

# files the feature owns but no slice does (the QA lane) are not blamed on a builder
put slices.json '{"slices":[{"id":"bld","owns":["b/**"]}]}'
put ownership.json '{"owns":["b/**","e2e/**"]}'
mkdir -p b e2e
node "$SL" start f bld >/dev/null 2>&1
echo 1 > b/a.js; echo 2 > e2e/qa.spec.js
check "an unsliced file the feature owns is not blamed on a slice" "0" "$(rc done f bld)"
put slices.json '{"slices":[{"id":"bld2","owns":["b/**"]}]}'
node "$SL" start f bld2 >/dev/null 2>&1
echo 3 > b/a.js; echo 4 > stray.txt
check "…a file nobody owns still is (1)" "1" "$(rc done f bld2)"
rm -f .sdlc/features/f/ownership.json stray.txt

# git-ignored runtime state (a database folder) is not blamed on a slice either
git init -q . 2>/dev/null; printf 'rt/\n' > .gitignore
put slices.json '{"slices":[{"id":"ign","owns":["i/**"]}]}'
mkdir -p i rt
node "$SL" start f ign >/dev/null 2>&1
echo 1 > i/a.js; echo db > rt/data
check "a git-ignored file is not blamed on a slice" "0" "$(rc done f ign)"

# a failing check fails the slice
put slices.json '{"slices":[{"id":"chk","owns":["c/**"],"check":"exit 7"}]}'
node "$SL" start f chk >/dev/null 2>&1
check "a failing check fails the slice (1)" "1" "$(rc done f chk)"
check "…and it can be reset" "0" "$(rc reset f chk)"
check "done on a slice that was never started is refused (3)" "3" "$(rc done f chk)"
check "an unknown feature is refused (3)" "3" "$(rc plan nope)"

# ---- the move to building requires slicing, or a reasoned decision not to
REF="$(cd "$(dirname "$SL")/.." && pwd)/skills/feature-autopilot/references"
VERIFY="$(cd "$(dirname "$SL")" && pwd)/sdlc-verify.mjs"
TRACE="$(cd "$(dirname "$SL")" && pwd)/sdlc-trace.mjs"
gate() { # feature -> exit code of --set-phase building from planned
  node "$VERIFY" --project "$T" --feature "$1" --set-phase planned >/dev/null 2>&1
  node "$VERIFY" --project "$T" --feature "$1" --set-phase building >"$T/gate.out" 2>&1; echo $?
}
newfeat() { rm -rf ".sdlc/features/$1"; mkdir -p ".sdlc/features/$1"; printf 'feature: %s\nchecks:\n  - id: u\n    kind: test\n    cmd: true\n' "$1" > ".sdlc/features/$1/acceptance.yaml"; printf '%s\n' "$2" > ".sdlc/features/$1/plan.md"; }
newfeat g1 'Files: js/state.js, js/rules.js, js/view.js, e2e/g1/a.spec.js'
check "a plan naming 3 source files cannot start building unsliced (3)" "3" "$(gate g1)"
check "…and the refusal says how to proceed" "1" "$(grep -c 'no-slice:' "$T/gate.out")"
cp "$REF/slices-template.json" .sdlc/features/g1/slices.json
check "…with slices.json it can" "0" "$(gate g1)"
newfeat g2 'Files: js/state.js, js/rules.js, js/view.js'
node "$TRACE" --feature g2 --log --from leader --to leader --kind decision --note "no-slice: x" >/dev/null 2>&1
check "a no-slice decision with no real reason is refused" "3" "$(gate g2)"
node "$TRACE" --feature g2 --log --from leader --to leader --kind decision --note "no-slice: one shared file, the parts cannot be built apart" >/dev/null 2>&1
check "…a reasoned one is accepted" "0" "$(gate g2)"
newfeat g3 'Files: js/state.js, js/rules.js'
check "a plan naming only 2 source files needs nothing" "0" "$(gate g3)"
newfeat g4 'Files: js/a.js, e2e/g4/x.spec.js, tests/y.test.js, tests/z.test.js, js/a.test.js'
check "test and e2e files do not count as source files" "0" "$(gate g4)"
newfeat g5 'no files named'
check "a plan that names no files needs nothing" "0" "$(gate g5)"

# ---- the autopilot skill and its templates agree with the tools
REPO="$(cd "$(dirname "$SL")/.." && pwd)"
SKILL="$REPO/skills/feature-autopilot/SKILL.md"
REF="$REPO/skills/feature-autopilot/references"
cd "$T" || exit 1
rm -rf .sdlc; mkdir -p .sdlc/features/f
cp "$REF/slices-template.json" .sdlc/features/f/slices.json
check "the shipped slices template is a valid plan" "0" "$(rc plan f)"
check "…with two waves: the parts, then the wiring" "2" "$(out plan f --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).waves.length))')"
for f in test-contract-template.md brief-builder.md brief-qa-write.md brief-qa-run.md web-app-structure.md slices-template.json; do
  check "the skill points at references/$f, and it exists" "1 1" "$(grep -c "${f%.*}" "$SKILL" | awk '{print ($1>0)}') $([ -s "$REF/$f" ] && echo 1 || echo 0)"
done
for w in "oc-wait.sh" "no-slice:" "sdlc-slices.mjs" "--lane" "qa-evidence" "test-contract.md" "OC_STALL" "--max-failures=1" "15 s"; do
  check "the skill mentions $w" "1" "$(grep -qF -- "$w" "$SKILL" "$REF"/*.md && echo 1 || echo 0)"
done
check "the structure guide has the no-build layout and the refactor rule" "2 1" "$(grep -c 'window.App = window.App' "$REF/web-app-structure.md") $(grep -c 'no behaviour change' "$REF/web-app-structure.md")"
check "the builder brief points to the spec instead of pasting it" "1" "$(grep -c 'Do not paste the spec' "$REF/brief-builder.md")"
check "the builder brief forbids writing the e2e suite" "1" "$(grep -c 'Do not write the end-to-end' "$REF/brief-builder.md")"
check "the QA brief forbids reading product source" "1" "$(grep -c 'Do not open anything under' "$REF/brief-qa-write.md")"
check "the acceptance template carries a qa-evidence check" "1" "$(grep -c 'kind: qa-evidence' "$REPO/skills/feature-lifecycle/references/acceptance-template.yaml")"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
