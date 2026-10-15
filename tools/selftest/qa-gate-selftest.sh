# Selftest for the mandatory QA gate: the `qa-evidence` check kind in sdlc-verify and its guard in sdlc-ship.
#
# Proves the gate cannot be satisfied by skipping QA:
#   - the command passing is not enough: without a QA reply in the trace the check fails
#   - a QA call that ended badly (rc != 0) fails it
#   - a builder reply AFTER the last QA reply fails it (stale QA)
#   - a good QA reply after the last builder reply passes it (also for lane actors qa-x / builder-x)
#   - a failing command fails it even when QA ran
#   - sdlc-ship refuses a feature whose acceptance.yaml has no qa-evidence check, unless --no-qa-gate
#
# Run from the repository root:  bash tools/selftest/qa-gate-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VERIFY="$REPO/tools/sdlc-verify.mjs"
TRACE="$REPO/tools/sdlc-trace.mjs"
SHIP="$REPO/tools/sdlc-ship.mjs"
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
cd "$T" || exit 1

fresh() { # name cmd
  rm -rf .sdlc; mkdir -p ".sdlc/features/$1"
  printf 'feature: %s\nbudget: 5\nchecks:\n  - id: qa-01\n    kind: qa-evidence\n    cmd: %s\n' "$1" "$2" > ".sdlc/features/$1/acceptance.yaml"
}
reply() { node "$TRACE" --feature "$1" --log --from "$2" --to leader --kind reply --rc "$3" --note x >/dev/null 2>&1; }
verify() { node "$VERIFY" --project "$T" --feature "$1" >"$T/out" 2>&1; echo $?; }

fresh f true
check "command passes but QA never ran: fails (1)" "1" "$(verify f)"
check "…and says why" "1" "$(grep -c 'QA evidence missing' "$T/out")"

reply f qa 1
check "a QA call that ended with rc 1: fails" "1" "$(verify f)"

reply f qa 0
check "a good QA reply: passes (0)" "0" "$(verify f)"

reply f builder 0
check "a builder reply after QA makes the QA stale: fails" "1" "$(verify f)"
reply f qa 0
check "QA run again after the builder: passes" "0" "$(verify f)"

fresh g true
reply g builder-state 0; reply g qa-e2e 0
check "lane actors count (builder-x, qa-x)" "0" "$(verify g)"

fresh h false
reply h qa 0
check "QA ran but the command fails: fails" "1" "$(verify h)"

# ---- sdlc-ship guard
mkrepo() { # name acceptance-text
  rm -rf "$T/r"; mkdir -p "$T/r" && cd "$T/r" || exit 1
  git init -q -b main && git config user.email t@t && git config user.name t
  echo base > README.md && git add . && git commit -q -m init
  mkdir -p src "$(printf '.sdlc/features/%s' "$1")"
  printf '# Thing\n' > ".sdlc/features/$1/spec.md"
  printf '%b' "$2" > ".sdlc/features/$1/acceptance.yaml"
  printf '{ "owns": ["src/**"] }\n' > ".sdlc/features/$1/ownership.json"
  printf '{ "phase": "accepted" }\n' > ".sdlc/features/$1/status.json"
  echo code > src/a.js
}
mkrepo t 'feature: t\nchecks:\n  - id: unit-01\n    kind: test\n    cmd: true\n'
node "$SHIP" --feature t >"$T/ship" 2>&1; rc=$?
check "ship refuses an accepted feature with no qa-evidence check (1)" "1" "$rc"
check "…and names the missing kind" "1" "$(grep -c 'qa-evidence' "$T/ship")"
check "…and commits nothing" "init" "$(git log --format=%s | head -1)"
node "$SHIP" --feature t --no-qa-gate >/dev/null 2>&1; rc=$?
check "--no-qa-gate lets a QA-less feature ship" "0" "$rc"
mkrepo t 'feature: t\nchecks:\n  - id: qa-01\n    kind: qa-evidence\n    cmd: true\n'
node "$SHIP" --feature t >/dev/null 2>&1; rc=$?
check "a feature with the check ships" "0" "$rc"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
