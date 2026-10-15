#!/usr/bin/env bash
# Selftest for tools/sdlc-verify.mjs.
#
# Proves the three outcomes that matter:
#   exit 0  -> all checks passed                    -> phase accepted
#   exit 1  -> a check failed                      -> phase validating | escalated
#   exit 2  -> automatic checks pass, gate pending  -> phase blocked
#   exit 3  -> a deliberately broken contract is rejected
#
# Run from the repository root:  bash tools/selftest/selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
VERIFY="$REPO/tools/sdlc-verify.mjs"
PROJECT="$HERE"

pass=0
fail=0

run() { node "$VERIFY" --project "$PROJECT" "$@" >"$HERE/.out" 2>&1; echo $?; }

expect() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    printf '  ok   %-46s exit=%s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL %-46s want=%s got=%s\n' "$label" "$want" "$got"
    sed 's/^/       | /' "$HERE/.out"
    fail=$((fail + 1))
  fi
}

field_of() { node -e '
  const fs = require("node:fs")
  const f = process.argv[1]
  const k = process.argv[2]
  let doc = {}
  try { doc = JSON.parse(fs.readFileSync(f, "utf8")) } catch {}
  process.stdout.write(String(doc[k] ?? ""))
' "$PROJECT/.sdlc/features/$1/status.json" "$2"; }

phase_of() { field_of "$1" phase; }
reason_of() { field_of "$1" blocked_reason; }
repair_of() { field_of "$1" repair_iterations; }

# read a nested field, e.g. run_field demo-ok last_run result
run_field() { node -e '
  const fs = require("node:fs")
  let cur = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  for (const k of process.argv.slice(2)) {
    if (cur === null || cur === undefined) break
    cur = cur[k]
  }
  process.stdout.write(String(cur ?? ""))
' "$PROJECT/.sdlc/features/$1/status.json" "${@:2}"; }

echo "sdlc-verify selftest"

# 0. start from a clean slate. The tools persist state on purpose, so the
#    selftest must clear it or it only passes on a fresh checkout.
#    Only the verify fixtures are cleared; the dispatch fixtures keep their
#    committed status.json because that phase is their test input.
for f in demo-ok demo-bad demo-gate demo-phase; do
  rm -f "$PROJECT/.sdlc/features/$f/status.json" "$PROJECT/.sdlc/features/$f/evidence.json" "$PROJECT/.sdlc/features/$f/trace.jsonl"
done

# 1. happy path -> accepted
expect "demo-ok: all checks pass" 0 "$(run --feature demo-ok)"
expect "demo-ok: phase is accepted" "accepted" "$(phase_of demo-ok)"

# 1b. every validation leaves one line in the feature's trace, whoever ran it
trace_rc() { node -e '
  const fs = require("node:fs")
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  const v = lines.filter((e) => e.from === "verify" && e.kind === "verify")
  process.stdout.write(v.length ? String(v[v.length - 1].rc) + "/" + v.length : "none")
' "$PROJECT/.sdlc/features/$1/trace.jsonl" 2>/dev/null || printf 'none'; }
expect "demo-ok: the pass is on the trace (rc/count)" "0/1" "$(trace_rc demo-ok)"

# 2. a failing check -> non-zero, and the phase never says accepted
expect "demo-bad: failing check" 1 "$(run --feature demo-bad)"
expect "demo-bad: phase is validating" "validating" "$(phase_of demo-bad)"
expect "demo-bad: repair counted" "1" "$(repair_of demo-bad)"
expect "demo-bad: the failure is on the trace (rc/count)" "1/1" "$(trace_rc demo-bad)"

# 3. budget exhaustion -> escalated, unattended.
#    budget: 2 means two failed validations are tolerated; the third escalates.
expect "demo-bad: second failure tolerated" 1 "$(run --feature demo-bad)"
expect "demo-bad: still validating at budget" "validating" "$(phase_of demo-bad)"
expect "demo-bad: repair at budget" "2" "$(repair_of demo-bad)"

expect "demo-bad: third failure" 1 "$(run --feature demo-bad)"
expect "demo-bad: budget exhausted" "escalated" "$(phase_of demo-bad)"
expect "demo-bad: reason recorded" "repair_budget_exhausted" "$(reason_of demo-bad | cut -d: -f1)"

# an escalated lane must not silently recover on its own
expect "demo-bad: still fails while escalated" 1 "$(run --feature demo-bad)"
expect "demo-bad: phase unchanged" "escalated" "$(phase_of demo-bad)"
expect "demo-bad: keeps counting" "4" "$(repair_of demo-bad)"

# only an explicit triage decision clears it
expect "demo-bad: reset-repair" 1 "$(run --feature demo-bad --reset-repair)"
expect "demo-bad: back to validating" "validating" "$(phase_of demo-bad)"
expect "demo-bad: counter restarted" "1" "$(repair_of demo-bad)"

# 4. a human gate blocks acceptance until approved
expect "demo-gate: gate pending" 2 "$(run --feature demo-gate)"
expect "demo-gate: phase is blocked" "blocked" "$(phase_of demo-gate)"
expect "demo-gate: reason names the gate" "human_gate_pending" "$(reason_of demo-gate | cut -d: -f1)"

expect "demo-gate: approval needs --by" 3 "$(run --feature demo-gate --approve release-01)"
expect "demo-gate: non-manual check refused" 3 "$(run --feature demo-gate --approve unit-01 --by selftest)"
expect "demo-gate: unknown check refused" 3 "$(run --feature demo-gate --approve nope --by selftest)"

expect "demo-gate: approved" 0 "$(run --feature demo-gate --approve release-01 --by selftest)"
expect "demo-gate: phase is accepted" "accepted" "$(phase_of demo-gate)"

# 5. a green feature can pass without any approval state
expect "demo-ok: still accepted" 0 "$(run --feature demo-ok)"

# 5b. the phase machine only allows legal transitions
expect "demo-phase: unknown phase refused" 3 "$(run --feature demo-phase --set-phase coding)"
expect "demo-phase: contract -> building" 0 "$(run --feature demo-phase --set-phase building)"
expect "demo-phase: phase recorded" "building" "$(phase_of demo-phase)"
expect "demo-phase: building -> planned" 0 "$(run --feature demo-phase --set-phase planned)"
expect "demo-phase: illegal planned -> accepted" 3 "$(run --feature demo-phase --set-phase accepted)"
expect "demo-phase: phase unchanged after refusal" "planned" "$(phase_of demo-phase)"
expect "demo-phase: modes are exclusive" 3 "$(run --feature demo-phase --set-phase building --reset-repair)"

# 5c. last_run is populated by a real run, not left as a dead field
run --feature demo-ok >/dev/null
expect "demo-ok: last_run has a result" "pass" "$(run_field demo-ok last_run result)"
expect "demo-ok: last_run has a timestamp" "true" \
  "$([ -n "$(run_field demo-ok last_run at)" ] && echo true || echo false)"

# 6. malformed contracts are rejected, not guessed at
for bad in no-feature no-checks bad-kind bad-indent dup-id bad-expect; do
  expect "contract rejected: $bad" 3 "$(run --feature "broken-$bad")"
done

# 7. missing pieces are errors, not passes
expect "unknown feature is an error" 3 "$(run --feature does-not-exist)"

rm -f "$HERE/.out"
echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
