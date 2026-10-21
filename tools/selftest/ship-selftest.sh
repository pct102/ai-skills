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

# 5b. PROTECTED_BRANCHES: a project can protect more than main
R="$(new_repo r7)"; cd "$R"; git switch -q -c dev
PROTECTED_BRANCHES="main dev" node "$SHIP" --feature game >/dev/null 2>&1
check "a protected dev branch gets a feature branch" "autopilot/game" "$(git rev-parse --abbrev-ref HEAD)"
R="$(new_repo r7b)"; cd "$R"; git switch -q -c dev
node "$SHIP" --feature game >/dev/null 2>&1
check "an unlisted branch is committed on directly" "dev" "$(git rev-parse --abbrev-ref HEAD)"

# 5c. the branch the run started on is recorded (run-branch, written by autopilot.sh); a branch
# switched to mid-run is refused, because the feature's branch name is not the leader's to choose
R="$(new_repo r13)"; cd "$R"
printf 'main\n' > .sdlc/features/game/run-branch
git switch -q -c claude/invented
node "$SHIP" --feature game >/dev/null 2>&1; rc=$?
check "refuses a branch switched to mid-run" "1" "$rc"
check "…and commits nothing" "init" "$(git log --format=%s | head -1)"
check "…and says which branch to go back to" "1" "$(node "$SHIP" --feature game 2>&1 | grep -c 'git switch main')"
node "$SHIP" --feature game --branch claude/invented >/dev/null 2>&1
check "--branch overrides the recorded start branch" "claude/invented" "$(git rev-parse --abbrev-ref HEAD)"
R="$(new_repo r13b)"; cd "$R"; git switch -q -c dev
printf 'dev\n' > .sdlc/features/game/run-branch
node "$SHIP" --feature game >/dev/null 2>&1
check "the recorded start branch itself is committed on" "dev" "$(git rev-parse --abbrev-ref HEAD)"
R="$(new_repo r13c)"; cd "$R"
printf 'main\n' > .sdlc/features/game/run-branch
node "$SHIP" --feature game >/dev/null 2>&1
check "a recorded start on main still gets autopilot/<feature>" "autopilot/game" "$(git rev-parse --abbrev-ref HEAD)"
check "…and run-branch itself is never committed" "0" "$(git show --name-only --format= HEAD | grep -c run-branch)"

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

# COMMIT_SDLC=no keeps the whole .sdlc/ folder out of git (docs and tests included), on disk for reading only
R="$(new_repo r_sdlc)"; cd "$R"
out="$(COMMIT_SDLC=no node "$SHIP" --feature game 2>&1)"; rc=$?
check "COMMIT_SDLC=no: still commits the code" "0" "$rc"
check "…only owned files outside .sdlc" "e2e/game/qa.spec.js src/game/index.js " "$(committed)"
check "…nothing under .sdlc is in the commit" "0" "$(git show --name-only --format= HEAD | grep -c '^\.sdlc/')"
check "…git no longer sees .sdlc at all" "0" "$(git status --porcelain --untracked-files=all | grep -c '\.sdlc')"
check "…the ignore lives in .git/info/exclude, not in a tracked file" "1 0" "$(grep -c '^\.sdlc/$' .git/info/exclude) $(git ls-files .gitignore | wc -l | tr -d ' ')"
check "…and the .sdlc files are still on disk" "yes" "$(test -f .sdlc/features/game/spec.md && echo yes)"
COMMIT_SDLC=no node "$SHIP" --ignore-sdlc >/dev/null 2>&1
check "--ignore-sdlc twice does not repeat the line" "1" "$(grep -c '^\.sdlc/$' .git/info/exclude)"

# values that mean no, and the default
for v in false off 0; do
  R="$(new_repo "r_sdlc_$v")"; cd "$R"; COMMIT_SDLC=$v node "$SHIP" --feature game >/dev/null 2>&1
  check "COMMIT_SDLC=$v also keeps .sdlc out" "0" "$(git show --name-only --format= HEAD | grep -c '^\.sdlc/')"
done
R="$(new_repo r_sdlc_default)"; cd "$R"; node "$SHIP" --ignore-sdlc >/dev/null 2>&1
check "unset: --ignore-sdlc does nothing" "0" "$(grep -c 'sdlc' .git/info/exclude 2>/dev/null)"
node "$SHIP" --feature game >/dev/null 2>&1
check "unset: .sdlc docs are committed as before" "1" "$(git show --name-only --format= HEAD | grep -c '^\.sdlc/features/game/spec\.md$')"

# a project whose .sdlc files were committed earlier: later changes to them are still not committed
R="$(new_repo r_sdlc_tracked)"; cd "$R"
git add -f .sdlc/features/game/spec.md && git commit -q -m "track spec"; echo "# changed" >> .sdlc/features/game/spec.md
COMMIT_SDLC=no node "$SHIP" --feature game >/dev/null 2>&1
check "COMMIT_SDLC=no: an already tracked .sdlc file is not committed again" "0" "$(git show --name-only --format= HEAD | grep -c '^\.sdlc/')"

# an owned test file hidden by .gitignore must stop the ship, not vanish from it
R="$(new_repo r_ignored)"; cd "$R"
printf '/e2e/*\n' > .gitignore; git add .gitignore && git commit -q -m ignore
out="$(node "$SHIP" --feature game 2>&1)"; rc=$?
check "owned file ignored by git: refused" "1" "$rc"
check "…names the hidden file" "1" "$(printf '%s' "$out" | grep -c '! e2e/game')"
check "…and commits nothing" "ignore" "$(git log --format=%s | head -1)"
git checkout -q -f main 2>/dev/null; printf '/e2e/\n' > .gitignore; git add .gitignore && git commit -q -m ignore2
node "$SHIP" --feature game >/dev/null 2>&1
check "…also when the whole parent folder is ignored" "1" "$?"
node "$SHIP" --feature game --allow-ignored >/dev/null 2>&1
check "--allow-ignored overrides" "0" "$?"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
