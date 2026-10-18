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

# ---- the Playwright JSON report is part of the gate when the cmd names evidence/playwright.json ---------------------
# gen.mjs stands in for `npx playwright test ... > evidence/playwright.json`: no browser needed to test the gate's logic.
cd "$T" || exit 1   # the ship cases above leave the shell inside a scratch repo
cat > "$T/gen.mjs" <<'GEN'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
const [mode, out] = process.argv.slice(2)
const t = (title, status, extra = {}) => ({ title, file: 'a.spec.ts', tests: [{ status, results: [{ status: status === 'expected' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed', duration: 5, attachments: [], steps: [], ...extra }] }] })
const specs = { pass: [t('B1: ok', 'expected'), t('B2: ok', 'expected')], fail: [t('B1: ok', 'expected'), t('B2: broken', 'unexpected', { errors: [{ message: 'expected 1 got 2' }] })],
  allskip: [t('B1: s', 'skipped'), t('B2: s', 'skipped')], flaky: [t('B1: ok', 'expected'), t('B2: sometimes', 'flaky')], noise: [t('B1: ok', 'expected')],
  oneskip: [t('B1: ok', 'expected'), t('B2: s', 'skipped')] }[mode]
if (mode === 'none') process.exit(0)
mkdirSync(dirname(out), { recursive: true })
if (mode === 'garbage') { writeFileSync(out, 'this is not json'); process.exit(0) }
writeFileSync(out, (mode === 'noise' ? 'global setup says hi\n' : '') + JSON.stringify({ config: {}, suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs }], errors: [] }, null, 2))
if (mode === 'fail') process.exit(1)
GEN
pwcase() { # mode -> verify exit code; the cmd names the JSON path like the real one does
  fresh pw "node $T/gen.mjs $1 .sdlc/features/pw/evidence/playwright.json"
  mkdir -p .sdlc/features/pw/evidence && : > .sdlc/features/pw/evidence/B1-start.png
  reply pw builder 0; reply pw qa 0
  verify pw
}
check "JSON all passed: the gate passes (0)" "0" "$(pwcase pass)"
check "JSON with a failed test: fails (1)" "1" "$(pwcase fail)"
check "…and says what failed" "1" "$(grep -c 'failed in the JSON' "$T/out")"
check "…and the failing run's screenshots are kept as evidence/round-1" "1" "$([ -f .sdlc/features/pw/evidence/round-1/B1-start.png ] && echo 1 || echo 0)"
check "every test skipped (Playwright itself exits 0): fails (1)" "1" "$(pwcase allskip)"
check "…and says nothing ran" "1" "$(grep -c 'no test ran' "$T/out")"
check "JSON file never written: fails (1), not a silent pass" "1" "$(pwcase none)"
check "…and says it was not written" "1" "$(grep -c 'was not written' "$T/out")"
check "JSON that is not JSON: fails (1)" "1" "$(pwcase garbage)"
check "stdout noise in front of the JSON is tolerated (0)" "0" "$(pwcase noise)"
check "a flaky test only warns: passes (0)" "0" "$(pwcase flaky)"
check "…and the warning is recorded in evidence.json" "1" "$(grep -c 'WARN 1 flaky' .sdlc/features/pw/evidence.json)"
check "one skipped test among executed ones only warns (0)" "0" "$(pwcase oneskip)"
fresh old true; reply old builder 0; reply old qa 0
check "a cmd that does not name playwright.json is judged as before (0)" "0" "$(verify old)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
