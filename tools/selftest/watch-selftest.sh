#!/usr/bin/env bash
# Selftest for tools/sdlc-watch.sh: one pane for the whole run.
#
# Proves the watch snapshot comes from the journal (phase, slices, jev answers)
# and degrades honestly when there is nothing to show yet, instead of hanging a
# terminal on an empty follow.
#
# Run from the repository root:  bash tools/selftest/watch-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCH="$(cd "$HERE/../.." && pwd)/tools/sdlc-watch.sh"
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
cd "$T" || exit 1

mkdir -p .sdlc/features/f
cat > .sdlc/features/f/status.json <<'JSON'
{"feature":"f","phase":"validating","budget":1,"repair_iterations":0,"blocked_reason":"","approvals":{},"last_run":null}
JSON
printf '%s\n' '{"ts":"2026-10-20T06:00:00Z","from":"qa","to":"leader","kind":"reply","note":"suite green"}' > .sdlc/features/f/trace.jsonl
printf '%s\n' '{"ts":"2026-10-20T06:00:00+0700","command":"defect-triage","question":"Is it product, test or env?","hash":"x","answer":"env","latency_ms":100,"endpoint":"x","cached":false}' > .sdlc/features/f/jev-ledger.jsonl

out="$(bash "$WATCH" f --once)"
check "the snapshot names the phase" "1" "$(printf '%s' "$out" | grep -c '^phase: validating')"
check "…and carries the trace through" "1" "$(printf '%s' "$out" | grep -c 'suite green')"
check "…and the prior jev answer" "1" "$(printf '%s' "$out" | grep -c 'Is it product, test or env? -> env')"
check "a missing feature is an error, not an empty watch" "3" "$(bash "$WATCH" no-such-feature --once >/dev/null 2>&1; echo $?)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
