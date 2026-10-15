# Selftest for tools/sdlc-resume.sh.
#
# Proves the daily unattended loop:
#   - a lane interrupted mid-validation is re-verified, not re-planned
#   - a lane whose checks still fail escalates on a later run, not retried forever
#   - a lane interrupted mid-implementation is restarted through the dispatcher,
#     so a restart can never bypass the ownership check
#   - done and escalated lanes are never touched
#   - the default is a dry run
#
# Run from the repository root:  bash tools/selftest/resume-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RESUME="$REPO/tools/sdlc-resume.sh"
PROJECT="$HERE/resume-fixture"

pass=0
fail=0

# r-validating and r-failing are "interrupted mid-validation", r-building is
# "interrupted mid-implementation", the last two are terminal.
phase_for() {
  case "$1" in
    r-validating|r-failing) echo validating ;;
    r-building) echo building ;;
    r-accepted) echo accepted ;;
    r-escalated) echo escalated ;;
    *) echo "$1" ;;
  esac
}

reset_fixture() {
  for f in r-validating r-failing r-building r-accepted r-escalated; do
    rm -f "$PROJECT/.sdlc/features/$f/evidence.json"
    printf '{ "feature": "%s", "phase": "%s", "budget": 1, "repair_iterations": 0, "blocked_reason": null, "approvals": {} }\n' \
      "$f" "$(phase_for "$f")" > "$PROJECT/.sdlc/features/$f/status.json"
  done
}

phase_of() { node -e '
  const fs = require("node:fs")
  try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).phase) }
  catch { process.stdout.write("<missing>") }
' "$PROJECT/.sdlc/features/$1/status.json"; }

check() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    printf '  ok   %-54s %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  FAIL %-54s want=[%s] got=[%s]\n' "$label" "$want" "$got"
    fail=$((fail + 1))
  fi
}

# a stand-in for "start one lane": records which lane it was asked to start
MARKER="$HERE/.resume-marker"
FAKE="$HERE/.fake-lane.sh"
printf '#!/usr/bin/env bash\necho "$1" >> "%s"\nexit 0\n' "$MARKER" > "$FAKE"
chmod +x "$FAKE"
started() { [ -f "$MARKER" ] && tr '\n' ',' < "$MARKER" | sed 's/,$//' || echo ""; }

echo "sdlc-resume selftest"

# 1. dry run changes nothing
reset_fixture; rm -f "$MARKER"
out="$(bash "$RESUME" --project "$PROJECT")"
check "dry run: nothing verified" "validating" "$(phase_of r-validating)"
check "dry run: announces itself" "true" \
  "$(printf '%s' "$out" | grep -q 'dry run' && echo true || echo false)"
check "dry run: flags the restart" "true" \
  "$(printf '%s' "$out" | grep -q 'would hand to sdlc-dispatch' && echo true || echo false)"
check "dry run: started nothing" "" "$(started)"
check "dry run: needs a human" "1" \
  "$(bash "$RESUME" --project "$PROJECT" >/dev/null 2>&1; echo $?)"

# 2. --run re-verifies a lane interrupted mid-validation
reset_fixture; rm -f "$MARKER"
bash "$RESUME" --project "$PROJECT" --run >/dev/null 2>&1
check "resume: green lane accepted" "accepted" "$(phase_of r-validating)"

# 3. a still-failing lane stays in repairing on the first run, then escalates.
#    This is the property that matters unattended: it does not loop forever.
reset_fixture
bash "$RESUME" --project "$PROJECT" --run >/dev/null 2>&1
check "resume: failing lane still repairing" "validating" "$(phase_of r-failing)"
bash "$RESUME" --project "$PROJECT" --run >/dev/null 2>&1
check "resume: failing lane escalates next run" "escalated" "$(phase_of r-failing)"

# 4. terminal lanes are left exactly as they were
check "resume: accepted lane untouched" "accepted" "$(phase_of r-accepted)"
check "resume: escalated lane untouched" "escalated" "$(phase_of r-escalated)"

# 5. a building lane is not verified; it is restarted
check "resume: building lane not verified" "building" "$(phase_of r-building)"

# 6. exit 2 when the loop actually did something and nothing needs a human.
#    r-failing and r-escalated are set aside so the run is clean.
reset_fixture
mv "$PROJECT/.sdlc/features/r-failing" "$HERE/.hold-failing"
mv "$PROJECT/.sdlc/features/r-escalated" "$HERE/.hold-escalated"
bash "$RESUME" --project "$PROJECT" --run --exec "bash $FAKE {feature}" >/dev/null 2>&1
check "resume: clean run exits 2" "2" \
  "$(bash "$RESUME" --project "$PROJECT" --run --exec "bash $FAKE {feature}" >/dev/null 2>&1; echo $?)"
mv "$HERE/.hold-failing" "$PROJECT/.sdlc/features/r-failing"
mv "$HERE/.hold-escalated" "$PROJECT/.sdlc/features/r-escalated"

# 7. two colliding in-flight lanes must not both start: the restart goes through
#    the dispatcher, so the second one is deferred on ownership.
mk_conflict() {
  local dir="$PROJECT/.sdlc/features/$1"
  mkdir -p "$dir"
  cat > "$dir/acceptance.yaml" <<YAML
feature: $1
budget: 1
checks:
  - id: unit-01
    kind: test
    cmd: bash scripts/pass.sh
YAML
  printf '{ "feature": "%s", "phase": "building", "budget": 1, "repair_iterations": 0, "blocked_reason": null, "approvals": {} }\n' \
    "$1" > "$dir/status.json"
  printf '{\n  "feature": "%s",\n  "worktree": ".worktrees/%s",\n  "owns": ["%s/**"]\n}\n' \
    "$1" "$1" "$2" > "$dir/ownership.json"
}

reset_fixture; rm -f "$MARKER"
mk_conflict r-conflict src/r3   # same paths as r-building
bash "$RESUME" --project "$PROJECT" --run --exec "bash $FAKE {feature}" >/dev/null 2>&1
check "resume: only one colliding lane started" "r-building" "$(started)"
rm -rf "$PROJECT/.sdlc/features/r-conflict"

# 8. a disjoint lane is restarted normally
reset_fixture; rm -f "$MARKER"
bash "$RESUME" --project "$PROJECT" --run --exec "bash $FAKE {feature}" >/dev/null 2>&1
check "resume: disjoint lane started" "r-building" "$(started)"

# 9. --run without --exec must not silently do nothing
reset_fixture; rm -f "$MARKER"
bash "$RESUME" --project "$PROJECT" --run >/dev/null 2>&1
check "resume: no --exec starts nothing" "" "$(started)"

# 10. a missing .sdlc is a configuration error, not a silent success
check "no .sdlc is an error" "3" \
  "$(bash "$RESUME" --project "$HERE/nope" >/dev/null 2>&1; echo $?)"

rm -f "$FAKE" "$MARKER"
echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
