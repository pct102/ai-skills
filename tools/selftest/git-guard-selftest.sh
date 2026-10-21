#!/usr/bin/env bash
# Selftest for tools/hooks/leader-git-guard.sh: destructive git is blocked (exit 2), everything the leader
# really runs (sdlc-ship, commits in text, status, diff, reading) passes (exit 0).
#
# Run from the repository root:  bash tools/selftest/git-guard-selftest.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$(cd "$HERE/.." && pwd)/hooks/leader-git-guard.sh"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }
run() { jq -n --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}' | bash "$GUARD" >/dev/null 2>&1; echo $?; }

for c in 'git push' 'git push origin main' 'git push --force' 'git -C /x push' 'cd a && git push -f' 'echo hi; git reset --hard HEAD~1' \
         'git reset --hard' 'git clean -fd' 'git clean -f' 'git branch -D x' 'git checkout .' 'git restore .' 'ls | git push'; do
  check "blocks: $c" "2" "$(run "$c")"
done
for c in 'node "$AI_SKILLS_HOME/tools/sdlc-ship.mjs" --feature f --push' 'git status' 'git diff --stat' 'git log --oneline -3' \
         'git commit -m "docs: explain git push in the readme"' 'git checkout -- src/a.ts' 'git branch --show-current' \
         'git reset HEAD file' 'git clean -n' 'echo "do not git push"' 'grep -rn "git push" tools/' 'npm test'; do
  check "allows: $c" "0" "$(run "$c")"
done
check "allows a call with no command (not a Bash call)" "0" "$(printf '{"tool_name":"Read","tool_input":{"file_path":"x"}}' | bash "$GUARD" >/dev/null 2>&1; echo $?)"
check "allows garbage input" "0" "$(printf 'not json' | bash "$GUARD" >/dev/null 2>&1; echo $?)"
echo; echo "passed=$pass failed=$fail"; [ "$fail" -eq 0 ]
