#!/usr/bin/env bash
# Run every sdlc-* selftest. This is the gate that keeps the machine layer
# honest: it proves a feature cannot be accepted by accident, cannot spin
# forever, and cannot collide with a parallel lane.
#
#   bash tools/selftest/run-all.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITES="selftest dispatch-selftest resume-selftest ship-selftest diagrams-selftest autopilot-selftest claude-stop-selftest oc-agent-selftest slices-selftest qa-gate-selftest oc-wait-selftest claude-follow-selftest"

total_pass=0
total_fail=0
failed_suites=""

for suite in $SUITES; do
  echo "───────────────────────────────────────────────────────────────"
  # Run once. The output is both displayed and parsed, so a suite cannot pass
  # the tally while behaving differently on a second run.
  output="$(bash "$HERE/$suite.sh" 2>&1)"
  rc=$?
  printf '%s\n' "$output"

  line="$(printf '%s\n' "$output" | grep -E '^passed=[0-9]+ failed=[0-9]+$' | tail -1)"
  p="$(printf '%s' "$line" | sed -n 's/^passed=\([0-9]*\).*/\1/p')"
  f="$(printf '%s' "$line" | sed -n 's/.*failed=\([0-9]*\)$/\1/p')"
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${f:-0}))

  if [ $rc -ne 0 ] || [ "${f:-1}" != "0" ]; then
    failed_suites="$failed_suites $suite"
  fi
done

echo "───────────────────────────────────────────────────────────────"
echo "TOTAL passed=$total_pass failed=$total_fail"
if [ -n "$failed_suites" ]; then
  echo "failing suites:$failed_suites"
  exit 1
fi
echo "all suites green"
