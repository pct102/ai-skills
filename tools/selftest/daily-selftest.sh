#!/usr/bin/env bash
# Selftest for tools/sdlc-daily.mjs with a fake `gh`, a throwaway git repo and a fake agent (nothing leaves the machine).
#
# Proves: the merge gate refuses big, protected-path, CI-less and non-fix PRs and merges a clean one; the dev stage gives up
# after MAX_FIX_ATTEMPTS, runs the agent in a worktree, then merges its PR; the qa stage spends no agent run until the fix
# is merged and deployed; missing settings are named.
#
# Run from the repository root:  bash tools/selftest/daily-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SD="$(cd "$HERE/../.." && pwd)/tools/sdlc-daily.mjs"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/fx"; : > "$T/global.env"

cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"; fx="$GH_FX"
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"o/r"}' ;;
  "issue list") lbl=""; for ((i=1;i<=$#;i++)); do [ "${!i}" = "--label" ] && j=$((i+1)) && lbl="${!j}"; done; cat "$fx/issues-$lbl.json" ;;
  "issue view") cat "$fx/issueview.json" ;;
  "pr list") st=open; for ((i=1;i<=$#;i++)); do [ "${!i}" = "--state" ] && j=$((i+1)) && st="${!j}"; done; cat "$fx/pr-$st.json" ;;
  "pr view") cat "$fx/prview-$3.json" ;;
  "api repos/o/r/commits/dev/status") echo "${DEPLOY:-success}" ;;
esac
exit 0
GH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" GH_LOG="$T/gh.log" GH_FX="$T/fx" AUTOPILOT_GLOBAL_ENV="$T/global.env" ISSUE_GITHUB_REPO=o/r DAILY_NOTIFY=0 MERGE_WAIT_MIN=0
touch "$GH_LOG"

# a project repo whose origin has a dev branch
git init -q --bare "$T/origin.git"; git init -q "$T/proj"; cd "$T/proj"
git config user.email t@t; git config user.name t
echo x > a; git add a; git commit -qm init; git branch -M dev; git remote add origin "$T/origin.git"; git push -q origin dev
printf 'QA_ENV_URL=https://dev.example.app/vi\nAGENT_CMD="sh %s/agent.sh"\n' "$T" > .sdlc-env.tmp; mkdir -p .sdlc; mv .sdlc-env.tmp .sdlc/autopilot.env
calls() { grep -c -- "$1" "$GH_LOG"; }

pr() { # pr <n> <files-json> <adds> <ci-json> [mergeable] [head]
  printf '{"state":"OPEN","baseRefName":"dev","headRefName":"%s","mergeable":"%s","files":%s,"additions":%s,"deletions":0,"statusCheckRollup":%s}' "${6:-fix/issue-5-x}" "${5:-MERGEABLE}" "$2" "$3" "$4" > "$GH_FX/prview-$1.json"
}
OKCI='[{"name":"ci","conclusion":"SUCCESS","status":"COMPLETED"},{"context":"Vercel","state":"FAILURE"}]'
F1='[{"path":"src/a.tsx"}]'

pr 1 "$F1" 10 "$OKCI";                                         node "$SD" merge 1 >/dev/null 2>&1; check "gate: a clean PR merges (a failing Vercel check is ignored)" "1" "$(calls 'pr merge 1 --repo o/r --squash')"
pr 2 "$F1" 5000 "$OKCI";                                       node "$SD" merge 2 >/dev/null 2>&1; check "gate: a big PR is refused" "0" "$(calls 'pr merge 2')"
pr 3 '[{"path":"package.json"}]' 3 "$OKCI";                    node "$SD" merge 3 >/dev/null 2>&1; check "gate: a protected path is refused" "0" "$(calls 'pr merge 3')"
pr 4 "$F1" 3 '[{"context":"Vercel","state":"SUCCESS"}]';       node "$SD" merge 4 >/dev/null 2>&1; check "gate: no CI check is refused" "0" "$(calls 'pr merge 4')"
pr 5 "$F1" 3 '[{"name":"ci","conclusion":"FAILURE"}]';         node "$SD" merge 5 >/dev/null 2>&1; check "gate: a failing CI check is refused" "0" "$(calls 'pr merge 5')"
pr 6 "$F1" 3 "$OKCI" MERGEABLE feature/x;                      node "$SD" merge 6 >/dev/null 2>&1; check "gate: a non fix/* branch is refused" "0" "$(calls 'pr merge 6')"
pr 7 "$F1" 3 "$OKCI" CONFLICTING;                              node "$SD" merge 7 >/dev/null 2>&1; check "gate: conflicts are refused" "0" "$(calls 'pr merge 7')"
pr 8 "$F1" 3 '[{"name":"ci","status":"IN_PROGRESS"}]';         node "$SD" merge 8 >/dev/null 2>&1; check "gate: pending CI is not merged" "0" "$(calls 'pr merge 8')"

# dev stage: issue 6 is out of attempts, issue 5 gets a worktree + agent, whose run (agent.sh) makes it ready-for-test
cat > "$T/agent.sh" <<AG
#!/bin/sh
echo "\$(pwd)|\$1" >> "$T/agent.log"
echo '[{"number":5,"title":"t5","labels":[{"name":"auto-fix"},{"name":"fix-attempt-1"},{"name":"ready-for-test"}]},{"number":6,"title":"t6","labels":[{"name":"auto-fix"},{"name":"fix-attempt-2"},{"name":"needs-human"}]}]' > "$GH_FX/issues-auto-fix.json"
AG
echo '[{"number":6,"title":"t6","labels":[{"name":"auto-fix"},{"name":"fix-attempt-2"}]},{"number":5,"title":"t5","labels":[{"name":"auto-fix"}]}]' > "$GH_FX/issues-auto-fix.json"
echo '{"labels":[{"name":"ready-for-test"}],"state":"OPEN"}' > "$GH_FX/issueview.json"
echo '[{"number":9,"headRefName":"fix/issue-5-x","body":"","title":"fix(#5)"}]' > "$GH_FX/pr-open.json"
pr 9 "$F1" 10 "$OKCI"
: > "$GH_LOG"; node "$SD" fix >/dev/null 2>&1
check "dev: an issue out of attempts goes to needs-human" "1" "$(calls 'issue edit 6 .*--add-label needs-human')"
check "dev: the agent ran once, in a worktree, with the issue URL" "1" "$(grep -c 'issue-5|Use the pct102-dev-fix skill on https://github.com/o/r/issues/5' "$T/agent.log")"
check "dev: the ready-for-test fix PR was gate-merged" "1" "$(calls 'pr merge 9 --repo o/r --squash')"
check "dev: the worktree was removed" "0" "$(git worktree list | grep -c 'issue-5')"

# qa stage: nothing runs until the fix PR is merged and dev is deployed
echo '[{"number":5,"title":"t5","labels":[{"name":"ready-for-test"}]}]' > "$GH_FX/issues-ready-for-test.json"
echo '[]' > "$GH_FX/pr-merged.json"; : > "$T/agent.log"
node "$SD" verify >/dev/null 2>&1;                                  check "qa: fix not merged -> no agent run" "0" "$(wc -l < "$T/agent.log" | tr -d ' ')"
echo '[{"number":9,"headRefName":"fix/issue-5-x","body":"","title":"fix(#5)"}]' > "$GH_FX/pr-merged.json"
DEPLOY=pending node "$SD" verify >/dev/null 2>&1;                   check "qa: dev not deployed -> no agent run" "0" "$(wc -l < "$T/agent.log" | tr -d ' ')"
node "$SD" verify >/dev/null 2>&1;                                  check "qa: merged and deployed -> one agent run with --env and --close" "1" "$(grep -c 'pct102-qa-verify skill on https://github.com/o/r/issues/5 --env https://dev.example.app/vi --close' "$T/agent.log")"

check "fix wrote a report file naming the issue" "1" "$(ls .sdlc/daily/fix-*.md 2>/dev/null | head -1 | xargs grep -c '#5' | awk '{print ($1>0)}')"

# settings
rm .sdlc/autopilot.env
check "check: missing QA_ENV_URL is a usage error" "3" "$(node "$SD" check >/dev/null 2>&1; echo $?)"
check "fix: missing AGENT_CMD is a usage error" "3" "$(node "$SD" fix >/dev/null 2>&1; echo $?)"
check "unknown stage is a usage error" "3" "$(node "$SD" nope >/dev/null 2>&1; echo $?)"

echo; echo "passed=$pass failed=$fail"; [ "$fail" -eq 0 ]
