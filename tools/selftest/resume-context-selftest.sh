#!/usr/bin/env bash
# Selftest for tools/sdlc-resume-context.mjs.
#
# Proves the resume brief is derived from the journal, not guessed from prose:
#   - a missing feature is an error (exit 3), never an invented brief
#   - phase, repair count, blocked reason and last run come from status.json
#   - the slice table merges the plan (slices.json) with the machine state
#     (.oc/slices/state.json), including dependencies
#   - lanes still in flight are reported (alive pid vs dead pid)
#   - trace events are capped and truncated; prior jev answers are listed so
#     the same question is not asked again
#   - --json is valid and carries the same fields, including the next step
#
# Run from the repository root:  bash tools/selftest/resume-context-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTX="$(cd "$HERE/../.." && pwd)/tools/sdlc-resume-context.mjs"
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
cd "$T" || exit 1

out() { node "$CTX" "$@" 2>&1; }
rc() { node "$CTX" "$@" >/dev/null 2>&1; echo $?; }

check "missing feature exits 3" "3" "$(rc --feature no-such-feature)"
check "…and says which one" "no .sdlc/features/no-such-feature" "$(out --feature no-such-feature)"

mkdir -p .sdlc/features/f/.oc/lane-core .sdlc/features/f/.oc/slices
cat > .sdlc/features/f/status.json <<'JSON'
{"feature":"f","phase":"building","budget":2,"repair_iterations":1,"blocked_reason":"","approvals":{},"last_run":{"at":"2026-10-20T06:00:00.000Z","result":"fail","passed":4,"failed":1,"gates_pending":0}}
JSON
cat > .sdlc/features/f/slices.json <<'JSON'
{"slices":[{"id":"p1","owns":["a.ts"],"depends":[]},{"id":"p2","owns":["b.ts"],"depends":["p1"]},{"id":"p3","owns":["c.ts"],"depends":["p1"]}]}
JSON
cat > .sdlc/features/f/.oc/slices/state.json <<'JSON'
{"p1":{"status":"done"},"p2":{"status":"running"},"p3":{"status":"pending"}}
JSON
echo "$$" > .sdlc/features/f/.oc/lane-core/builder.pid
echo "1 1700000000" > .sdlc/features/f/.oc/lane-core/builder.current
echo 99999999 > .sdlc/features/f/.oc/ghost.pid
echo "1 1700000000" > .sdlc/features/f/.oc/ghost.current
printf '%s\n' \
  '{"ts":"2026-10-20T06:00:00Z","from":"leader","to":"leader","kind":"decision","note":"jev: Can p1 and p2 run in parallel? -> sequential"}' \
  '{"ts":"2026-10-20T06:01:00Z","from":"builder","to":"leader","kind":"reply","note":"p1 done, a very long note that should be truncated in the brief output because leaders pay per token and prose is expensive to re-read over and over again and again"}' \
  > .sdlc/features/f/trace.jsonl
printf '%s\n' \
  '{"ts":"2026-10-20T06:00:00+0700","command":"slice-order","question":"Can p1 and p2 run in parallel?","hash":"x","answer":"sequential","latency_ms":3000,"endpoint":"x","cached":false}' \
  > .sdlc/features/f/jev-ledger.jsonl

check "exit 0 on a real feature" "0" "$(rc --feature f)"
check "phase and repair from status.json" "phase: building (repair 1/2)" "$(out --feature f | grep '^phase:')"
check "slice states merged with the plan" "p1 done|p2 running (depends: p1)|p3 pending (depends: p1)" "$(out --feature f | grep '^  p[123] ' | sed 's/^ *//' | paste -sd'|' -)"
check "alive lane reported, dead pid marked unread" "1" "$(out --feature f | grep -c 'builder (core): pid .* alive')"
check "…and the dead one too" "1" "$(out --feature f | grep -c 'ghost: pid 99999999 dead, result unread')"
check "prior jev answers listed" "1" "$(out --feature f | grep -cE '^  Can p1')"
check "events capped by --max-events" "1" "$(out --feature f --max-events 1 | grep -c '\[reply\]')"
check "long notes truncated" "0" "$(out --feature f --max-events 1 | grep -c 'again and again' || true)"
check "next names the running slice" "1" "$(out --feature f | grep -c 'next: slices running (p2)')"
check "--json is valid" "building" "$(out --feature f --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["phase"])')"
check "…with the same next step" "True" "$(out --feature f --json | python3 -c 'import json,sys; print("p2" in json.load(sys.stdin)["next"])')"

# A running slice past its budget_min is stalled, not just slow: the brief says
# so and tells the leader to read the lane before resetting it.
mkdir -p .sdlc/features/f2/.oc/slices
cat > .sdlc/features/f2/status.json <<'JSON'
{"feature":"f2","phase":"building","budget":2,"repair_iterations":0,"blocked_reason":"","approvals":{},"last_run":null}
JSON
cat > .sdlc/features/f2/slices.json <<'JSON'
{"slices":[{"id":"p9","owns":["z.js"],"budget_min":30}]}
JSON
python3 - .sdlc/features/f2/.oc/slices/state.json <<'PY'
import json, sys, time
json.dump({"p9": {"status": "running", "started": int(time.time() * 1000) - 3600000}}, open(sys.argv[1], "w"))
PY
check "an over-budget running slice is flagged, not hidden" "1" "$(out --feature f2 | grep -c 'p9 running OVER BUDGET (60m > 30m)')"
check "…and next says read-then-reset, not start-more-work" "1" "$(out --feature f2 | grep -c 'possibly stalled (p9')"
check "…and --json carries over_budget" "True" "$(out --feature f2 --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["slices"][0]["over_budget"])')"

echo "passed=$pass failed=$fail"
