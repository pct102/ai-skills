# Selftest for tools/sdlc-dispatch.mjs.
#
# Proves the conflict rule that makes parallel lanes safe:
#   - disjoint directories run together
#   - overlapping and nested directories are deferred, with a stated reason
#   - a catch-all glob conflicts with everything
#   - a read-only lane never conflicts
#   - a lane with no ownership manifest is a hard configuration error
#   - terminal phases are never dispatched again
#
# Run from the repository root:  bash tools/selftest/dispatch-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DISPATCH="$REPO/tools/sdlc-dispatch.mjs"
PROJECT="$HERE/dispatch-fixture"

pass=0
fail=0

# `plan_with` echoes the JSON plan, or <error> when the dispatcher refused, so a
# failure reads as a diff instead of a stack trace. Extra flags are forwarded.
plan_with() {
  local out
  out="$(node "$DISPATCH" --project "$PROJECT" --json "$@" 2>"$HERE/.derr")"
  if [ -z "$out" ]; then echo "<error>"; else echo "$out"; fi
}
plan() { plan_with "$@"; }
plan_exit() { node "$DISPATCH" --project "$PROJECT" --json "$@" >/dev/null 2>&1; echo $?; }

# which features the dispatcher admitted
admitted() { admit_list "$@"; }
admit_list() { plan_with "$@" | node -e '
  let s = ""
  process.stdin.on("data", (d) => (s += d))
  process.stdin.on("end", () => {
    if (!s.trim()) return process.stdout.write("<error>")
    process.stdout.write(JSON.parse(s).admitted.map((a) => a.feature).join(","))
  })'; }

reason_for() { defer_reason "$1"; }
defer_reason() { plan_with "${@:2}" | node -e '
  let s = ""
  process.stdin.on("data", (d) => (s += d))
  process.stdin.on("end", () => {
    if (!s.trim()) return process.stdout.write("<error>")
    const p = JSON.parse(s)
    const d = p.deferred.find((x) => x.feature === process.argv[1])
    process.stdout.write(d ? String(d.reason).split(":")[0] : "")
  })' "$1"; }

idle() { plan_with | node -e '
  let s = ""
  process.stdin.on("data", (d) => (s += d))
  process.stdin.on("end", () => {
    if (!s.trim()) return process.stdout.write("<error>")
    process.stdout.write(JSON.parse(s).idle.map((x) => x.feature).join(","))
  })'; }

check() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    printf '  ok   %-52s %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL %-52s want=[%s] got=[%s]\n' "$label" "$want" "$got"
    sed 's/^/       | /' "$HERE/.derr"
    fail=$((fail + 1))
  fi
}

echo "sdlc-dispatch selftest"

# 1. disjoint lanes run together; overlapping ones are deferred.
#    Four is the default cap, so the first four by priority-then-name are admitted.
check "disjoint lanes admitted together" "lane-a,lane-b,lane-e,lane-t1" "$(admitted)"
check "overlapping lane deferred" "file_conflict" "$(reason_for lane-c)"
check "nested lane deferred" "file_conflict" "$(reason_for lane-d)"
check "catch-all glob deferred" "file_conflict" "$(reason_for lane-f)"
check "read-only lane never deferred" "" "$(reason_for lane-e)"

# 2. terminal and pre-contract phases are never dispatched
check "non-dispatchable phases idle" "lane-g,lane-h,lane-i" "$(idle)"

# 3. something runnable was found
check "exit 0 when a lane is admitted" "0" "$(plan_exit)"

# 4. dry run must not change any state
before="$(admitted)"
check "dry run is stable" "$before" "$(admitted)"

# 5. a dispatchable lane without an ownership manifest is a config error
mkdir -p "$PROJECT/.sdlc/features/lane-j"
cat > "$PROJECT/.sdlc/features/lane-j/acceptance.yaml" <<'YAML'
feature: lane-j
checks:
  - id: unit-01
    kind: test
    cmd: bash scripts/pass.sh
YAML
cat > "$PROJECT/.sdlc/features/lane-j/status.json" <<'JSON'
{ "feature": "lane-j", "phase": "planned", "budget": 2, "repair_iterations": 0, "approvals": {} }
JSON
# `plan` first so .derr is fresh, then the exit code: plan_exit throws stderr away.
plan >/dev/null
check "missing manifest is an error" "3" "$(plan_exit)"
check "error names the missing file" "true" \
  "$(grep -q 'ownership.json' "$HERE/.derr" && echo true || echo false)"

# 6. a lane with no contract is skipped, not an error
cat > "$PROJECT/.sdlc/features/lane-j/status.json" <<'JSON'
{ "feature": "lane-j", "phase": "contract", "budget": 2, "repair_iterations": 0, "approvals": {} }
JSON
check "uncontracted lane skipped" "true" \
  "$(reason_for lane-a >/dev/null; [ "$(plan_exit)" = "0" ] && echo true || echo false)"

# 7. the concurrency cap defers the surplus without dropping the cap reason
check "cap keeps only the highest priority lane" "lane-a" "$(admit_list --max-lanes 1)"
check "cap reports lane_cap for the surplus" "lane_cap" "$(defer_reason lane-b --max-lanes 1 | cut -d: -f1)"
check "cap still admits at least one lane" "0" "$(plan_exit --max-lanes 1)"

# 8. --only must not switch off conflict detection against in-flight lanes
check "only: colliding lane stays deferred" "file_conflict" "$(defer_reason lane-c --only lane-c | cut -d: -f1)"
check "only: unknown feature is an error" "3" "$(plan_exit --only nope)"
check "only: empty list is an error" "3" "$(plan_exit --only ,)"
check "only: bad cap is an error" "3" "$(plan_exit --max-lanes 0)"

# 9. regression: two lanes owning different files in the same directory are
#    independent. Reducing both to "tests" used to serialise every test file.
check "sibling files run together" "lane-t1,lane-t2" \
  "$(admit_list --max-lanes 20 | tr ',' '\n' | grep -E '^lane-t[0-9]+$' | paste -sd, -)"
check "a lane owning the tree still conflicts" "file_conflict" \
  "$(defer_reason lane-ttree --max-lanes 20 | cut -d: -f1)"

rm -rf "$PROJECT/.sdlc/features/lane-j" "$HERE/.derr"
echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
