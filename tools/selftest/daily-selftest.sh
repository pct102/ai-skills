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
export PATH="$T/bin:$PATH" GH_LOG="$T/gh.log" GH_FX="$T/fx" AUTOPILOT_GLOBAL_ENV="$T/global.env" ISSUE_GITHUB_REPO=o/r DAILY_NOTIFY=0 MERGE_WAIT_MIN=0 DEPLOY_SETTLE_SEC=0 CONFLICT_WAIT_SEC=0 VERIFY_RERUN=0 HEARTBEAT_SEC=1
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
PR9='[{"number":9,"headRefName":"fix/issue-5-x","body":"","title":"fix(#5)"}]'
echo "echo '$PR9' > \"$GH_FX/pr-open.json\"" >> "$T/agent.sh"; echo '[]' > "$GH_FX/pr-open.json"
pr 9 "$F1" 10 "$OKCI"
: > "$GH_LOG"; node "$SD" fix >/dev/null 2>&1
check "dev: an issue out of attempts goes to needs-human" "1" "$(calls 'issue edit 6 .*--add-label needs-human')"
check "dev: the agent ran once, in a worktree, with the issue URL" "1" "$(grep -c 'issue-5|Use the pct102-dev-fix skill on https://github.com/o/r/issues/5' "$T/agent.log")"
check "dev: the ready-for-test fix PR was gate-merged" "1" "$(calls 'pr merge 9 --repo o/r --squash')"
check "dev: the worktree was removed" "0" "$(git worktree list | grep -c 'issue-5')"
# an open fix PR already exists (earlier timeout, or CI fixed since): no agent, straight to the gate
echo '[{"number":5,"title":"t5","labels":[{"name":"auto-fix"},{"name":"fix-attempt-2"}]}]' > "$GH_FX/issues-auto-fix.json"
: > "$T/agent.log"; : > "$GH_LOG"; node "$SD" fix --no-verify >/dev/null 2>&1
check "dev: an existing open PR is reused, no agent run, and gate-merged" "0 1" "$(wc -l < "$T/agent.log" | tr -d ' ') $(calls 'pr merge 9 --repo o/r --squash')"
# default fix = fix, merge, wait for the deploy, then verify that issue before the next one
: > "$T/agent.log"; : > "$GH_LOG"; node "$SD" fix >/dev/null 2>&1
check "dev: after the merge the same issue is verified (qa-verify agent, --env, --close)" "1" "$(grep -c 'pct102-qa-verify skill on https://github.com/o/r/issues/5 --env https://dev.example.app/vi --close' "$T/agent.log")"
: > "$T/agent.log"; DEPLOY=failure node "$SD" fix >/dev/null 2>&1
check "dev: a failed dev deploy stops the loop before verify" "0" "$(wc -l < "$T/agent.log" | tr -d ' ')"
# oldest issue first
echo '[{"number":8,"title":"t8","labels":[{"name":"auto-fix"}]},{"number":7,"title":"t7","labels":[{"name":"auto-fix"}]}]' > "$GH_FX/issues-auto-fix.json"
echo '[]' > "$GH_FX/pr-open.json"; cat > "$T/agent.sh" <<AG
#!/bin/sh
echo "\$(pwd)|\$1" >> "$T/agent.log"
AG
: > "$T/agent.log"; node "$SD" fix --no-verify >/dev/null 2>&1
check "dev: issues are fixed oldest first" "7 8" "$(grep -o 'issues/[0-9]*' "$T/agent.log" | grep -o '[0-9]*' | tr '\n' ' ' | sed 's/ $//')"
# a PR that conflicts with dev: an agent merges dev into its branch, then the gate runs again
git push -q origin dev:fix/issue-10-x
pr 10 "$F1" 5 "$OKCI" CONFLICTING fix/issue-10-x
cat > "$T/agent.sh" <<AG
#!/bin/sh
echo "\$(pwd)|\$1" >> "$T/agent.log"
sed 's/CONFLICTING/MERGEABLE/' "$GH_FX/prview-10.json" > "$GH_FX/p.tmp" && mv "$GH_FX/p.tmp" "$GH_FX/prview-10.json"
AG
: > "$T/agent.log"; : > "$GH_LOG"; CONFLICT_WAIT_SEC=0 node "$SD" merge 10 >/dev/null 2>&1
check "gate: a conflicting PR gets a conflict-resolving agent, then merges" "1 1" "$(grep -c 'conflicts with dev.*git push origin HEAD:fix/issue-10-x' "$T/agent.log") $(calls 'pr merge 10 --repo o/r --squash')"

# verify re-runs ui-qa itself (a fake one here) on the pages the issue names, then hands the results folder to the agent
cat > "$T/fake-uiqa.mjs" <<'UQ'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
const a = process.argv.slice(2), out = a[a.indexOf('--out') + 1]
mkdirSync(out, { recursive: true }); writeFileSync(`${out}/findings.json`, '{"findings":[]}'); appendFileSync(process.env.UQ_LOG, `${a[0]}\n`)
UQ
echo '{"labels":[{"name":"ready-for-test"}],"state":"OPEN","body":"**Affected pages:** `/vi/a`, `/vi/b`"}' > "$GH_FX/issueview.json"
echo '[{"number":5,"title":"t5","labels":[{"name":"ready-for-test"}]}]' > "$GH_FX/issues-ready-for-test.json"
echo '[{"number":9,"headRefName":"fix/issue-5-x","body":"","title":"fix(#5)"}]' > "$GH_FX/pr-merged.json"
: > "$T/agent.log"; : > "$T/uq.log"
UQ_LOG="$T/uq.log" UI_QA_BIN="$T/fake-uiqa.mjs" VERIFY_RERUN=1 node "$SD" verify >/dev/null 2>&1
check "verify: ui-qa ran on each page of the issue plus a sweep, by the script" "3" "$(wc -l < "$T/uq.log" | tr -d ' ')"
check "verify: the agent is told where the results are and not to run ui-qa" "1" "$(grep -c 'qa-verify/issue-5/.*do NOT run ui-qa' "$T/agent.log")"
echo '{"labels":[{"name":"ready-for-test"}],"state":"OPEN"}' > "$GH_FX/issueview.json"

# qa stage: nothing runs until the fix PR is merged and dev is deployed
echo '[{"number":5,"title":"t5","labels":[{"name":"ready-for-test"}]}]' > "$GH_FX/issues-ready-for-test.json"
echo '[]' > "$GH_FX/pr-merged.json"; echo '[{"number":9,"headRefName":"fix/issue-5-x","body":"","title":"fix(#5)"}]' > "$GH_FX/pr-open.json"; : > "$T/agent.log"
node "$SD" verify >/dev/null 2>&1;                                  check "qa: fix not merged -> no agent run" "0" "$(wc -l < "$T/agent.log" | tr -d ' ')"
echo '[{"number":9,"headRefName":"fix/issue-5-x","body":"","title":"fix(#5)"}]' > "$GH_FX/pr-merged.json"
echo '[]' > "$GH_FX/pr-open.json"
DEPLOY=pending node "$SD" verify >/dev/null 2>&1;                   check "qa: dev not deployed -> no agent run" "0" "$(wc -l < "$T/agent.log" | tr -d ' ')"
echo '[]' > "$GH_FX/pr-merged.json"; : > "$T/agent.log"
node "$SD" verify >/dev/null 2>&1;                                  check "qa: no PR at all (agent found it already fixed on dev) -> verified against dev" "1" "$(grep -c 'pct102-qa-verify skill on https://github.com/o/r/issues/5 --env https://dev.example.app/vi --close' "$T/agent.log")"
echo '[{"number":9,"headRefName":"fix/issue-5-x","body":"","title":"fix(#5)"}]' > "$GH_FX/pr-merged.json"; : > "$T/agent.log"
node "$SD" verify >/dev/null 2>&1;                                  check "qa: merged and deployed -> one agent run with --env and --close" "1" "$(grep -c 'pct102-qa-verify skill on https://github.com/o/r/issues/5 --env https://dev.example.app/vi --close' "$T/agent.log")"

check "fix wrote a report file naming the issue" "yes" "$(cat .sdlc/daily/fix-*.md 2>/dev/null | grep -q "#7" && echo yes)"

# review stage: only the hand-filed issue (no ui-qa / auto-fix label) gets the QA review agent
echo '[{"number":7,"title":"contrast bug","labels":[{"name":"bug"}]},{"number":8,"title":"[ui-qa] x","labels":[{"name":"ui-qa"}]},{"number":9,"title":"done","labels":[{"name":"qa-reviewed"}]}]' > "$GH_FX/issues-.json"
echo '[{"number":7,"title":"contrast bug","labels":[{"name":"qa-reviewed"},{"name":"auto-fix"}]}]' > "$GH_FX/issues-qa-reviewed.json"; echo '[]' > "$GH_FX/issues-needs-info.json"; echo '[]' > "$GH_FX/issues-needs-human.json"
cat > "$T/agent.sh" <<AG
#!/bin/sh
echo "\$1" >> "$T/agent.log"
AG
: > "$T/agent.log"; node "$SD" review >/dev/null 2>&1
check "review: one agent, for the hand-filed issue only" "1" "$(grep -c 'pct102-qa-review skill on https://github.com/o/r/issues/7' "$T/agent.log")"
check "review: ui-qa and already reviewed issues are left alone" "1" "$(wc -l < "$T/agent.log" | tr -d ' ')"

# settings
rm .sdlc/autopilot.env
check "check: missing QA_ENV_URL is a usage error" "3" "$(node "$SD" check >/dev/null 2>&1; echo $?)"
check "fix: missing AGENT_CMD is a usage error" "3" "$(node "$SD" fix >/dev/null 2>&1; echo $?)"
check "unknown stage is a usage error" "3" "$(node "$SD" nope >/dev/null 2>&1; echo $?)"

echo; echo "passed=$pass failed=$fail"; [ "$fail" -eq 0 ]
