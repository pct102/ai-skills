# Selftest for tools/sdlc-ship.mjs.
#
# Proves the commit step cannot take more than the feature owns:
#   - nothing is committed unless status.json says accepted
#   - only owned code, tests and the feature's docs are staged
#   - traces, raw agent logs, screenshots, generated state, .env and node_modules never are
#   - a file the feature does not own is reported and left alone
#   - a secret in a staged file aborts the whole commit
#   - nothing is pushed without --push, and main/master is never pushed
#
# Run from the repository root:  bash tools/selftest/ship-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIP="$(cd "$HERE/../.." && pwd)/tools/sdlc-ship.mjs"
pass=0
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi
}

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT

new_repo() { # name accepted? subdir? -> prints the project path (the repo root unless subdir is given)
  local r="$T/$1"
  mkdir -p "$r" && cd "$r" || exit 1
  git init -q -b main && git config user.email t@t && git config user.name t
  echo base > README.md && git add . && git commit -q -m init
  if [ -n "${3:-}" ]; then echo stray > elsewhere.txt; mkdir -p "$3" && cd "$3" || exit 1; r="$r/$3"; fi
  mkdir -p src/game e2e/game .sdlc/features/game/.oc .sdlc/features/game/evidence node_modules/x
  printf '# Gomoku board\n' > .sdlc/features/game/spec.md
  printf 'feature: game\nchecks:\n  - id: qa-01\n    kind: qa-evidence\n    cmd: true\n' > .sdlc/features/game/acceptance.yaml
  printf '{ "feature": "game", "owns": ["src/game/**", "e2e/game/**"] }\n' > .sdlc/features/game/ownership.json
  printf '{ "phase": "%s", "blocked_reason": null }\n' "${2:-accepted}" > .sdlc/features/game/status.json
  printf '{ "passed": 2, "checks": [ {"id":"unit-01","ok":true}, {"id":"e2e-01","ok":true} ] }\n' > .sdlc/features/game/evidence.json
  echo code > src/game/index.js; echo test > e2e/game/qa.spec.js
  echo raw > .sdlc/features/game/.oc/builder-1.jsonl; echo png > .sdlc/features/game/evidence/01.png
  echo t > .sdlc/features/game/trace.jsonl; echo dep > node_modules/x/i.js
  echo 'KEY=1' > .env; echo other > unrelated.txt
  echo "$r"
}
committed() { git show --name-only --format= HEAD | sort | tr '\n' ' '; }

# 1. not accepted -> refused, nothing committed
R="$(new_repo r1 validating)"; cd "$R"
node "$SHIP" --feature game >/dev/null 2>&1; rc=$?
check "refuses a lane that is not accepted" "1" "$rc"
check "…and commits nothing" "init" "$(git log --format=%s | head -1)"

# 2. accepted -> exactly the owned files and the feature's docs, on a branch
R="$(new_repo r2)"; cd "$R"
out="$(node "$SHIP" --feature game 2>&1)"; rc=$?
check "accepted lane commits" "0" "$rc"
check "branch created from main" "autopilot/game" "$(git rev-parse --abbrev-ref HEAD)"
check "commits only owned code, tests and feature docs" \
  ".sdlc/features/game/acceptance.yaml .sdlc/features/game/ownership.json .sdlc/features/game/spec.md e2e/game/qa.spec.js src/game/index.js " "$(committed)"
check "unowned file left uncommitted" "1" "$(git status --porcelain | grep -c unrelated.txt)"
check "unowned file reported" "1" "$(printf '%s' "$out" | grep -c 'outside this feature')"
check "subject taken from the spec" "feat(game): Gomoku board" "$(git log -1 --format=%s)"
check "body lists the passed checks" "1" "$(git log -1 --format=%b | grep -c 'unit-01, e2e-01')"
check "nothing pushed by default" "0" "$(git remote | wc -l | tr -d ' ')"

# 3. dry run changes nothing
R="$(new_repo r3)"; cd "$R"
node "$SHIP" --feature game --dry-run >/dev/null 2>&1
check "dry run commits nothing" "init" "$(git log --format=%s | head -1)"
check "dry run stays on main" "main" "$(git rev-parse --abbrev-ref HEAD)"

# 4. a secret in an owned file aborts everything
R="$(new_repo r4)"; cd "$R"
echo 'const k = "AKIAABCDEFGHIJKLMNOP"' > src/game/config.js
node "$SHIP" --feature game >/dev/null 2>&1; rc=$?
check "secret aborts the commit" "1" "$rc"
check "…and nothing was committed" "init" "$(git log --format=%s | head -1)"

# 5. --push goes to the feature branch only; main is never pushed
R="$(new_repo r5)"; cd "$R"
git init -q --bare "$T/origin.git" && git remote add origin "$T/origin.git"
node "$SHIP" --feature game --push >/dev/null 2>&1; rc=$?
check "--push succeeds on the feature branch" "0" "$rc"
check "remote has the feature branch" "1" "$(git ls-remote --heads origin autopilot/game | wc -l | tr -d ' ')"
R="$(new_repo r6)"; cd "$R"; git remote add origin "$T/origin.git"
node "$SHIP" --feature game --branch main --push >/dev/null 2>&1; rc=$?
check "refuses to push main" "1" "$rc"
check "remote still has no main" "0" "$(git ls-remote --heads origin main | wc -l | tr -d ' ')"

# 6. an over-broad ownership still cannot pull in generated or private files
R="$(new_repo r8)"; cd "$R"
printf '{ "feature": "game", "owns": ["**"] }\n' > .sdlc/features/game/ownership.json
node "$SHIP" --feature game >/dev/null 2>&1
bad="$(git show --name-only --format= HEAD | grep -cE '\.oc/|evidence/|trace\.|status\.json|evidence\.json|node_modules|\.env$')"
check "owns ['**'] still excludes logs, screenshots, state, deps and .env" "0" "$bad"
check "…but keeps the real code" "1" "$(git show --name-only --format= HEAD | grep -c '^src/game/index.js$')"

# 7. generated diagrams stay out, the leader-authored source stays in
R="$(new_repo r10)"; cd "$R"
printf '{ "feature": "game", "owns": ["src/game/**"] }\n' > .sdlc/features/game/ownership.json
mkdir -p .sdlc/features/game/diagrams/receipts/x
echo h > .sdlc/features/game/diagrams/trace.sequence.html; echo j > .sdlc/features/game/diagrams/trace.sequence.json
echo r > .sdlc/features/game/diagrams/receipts/x/a.json; echo i > .sdlc/features/game/diagrams/index.html
echo '{}' > .sdlc/features/game/diagrams/architecture.json; echo h > .sdlc/features/game/diagrams/architecture.html
node "$SHIP" --feature game >/dev/null 2>&1
check "diagram source is committed" "1" "$(git show --name-only --format= HEAD | grep -c 'diagrams/architecture.json$')"
check "rendered and generated diagram files are not" "0" "$(git show --name-only --format= HEAD | grep -c 'diagrams/.*\.html$\|trace.sequence.json\|receipts')"

# 8. a project that is only a folder inside a bigger repository
R="$(new_repo r12 accepted proj)"; cd "$R"
node "$SHIP" --feature game >/dev/null 2>&1; rc=$?
check "refuses a project that is a subfolder of a repository" "1" "$rc"
check "…and does not switch branch there" "main" "$(git rev-parse --abbrev-ref HEAD)"
check "…and commits nothing" "init" "$(git log --format=%s | head -1)"
node "$SHIP" --feature game --allow-subdir >/dev/null 2>&1; rc=$?
check "--allow-subdir commits" "0" "$rc"
check "…only this folder's files" "1" "$(git show --name-only --format= HEAD | grep -c '^proj/src/game/index.js$')"
check "…never a changed file elsewhere in the repository" "0" "$(git show --name-only --format= HEAD | grep -c 'elsewhere.txt')"

# 9. configuration errors
R="$(new_repo r11)"; cd "$R"; rm .sdlc/features/game/ownership.json
node "$SHIP" --feature game >/dev/null 2>&1; rc=$?
check "missing ownership.json is a configuration error" "3" "$rc"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
