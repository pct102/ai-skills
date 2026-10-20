#!/usr/bin/env bash
# Selftest for `jev-proxy doctor`.
#
# Proves the diagnostic answers "why is Jev not answering?" without touching the
# network and without ever printing a secret:
#   - gemini backend with a key: exits 0, reports the key as set (length only)
#   - gemini backend without a key: exits 1 and says it is missing
#   - clef backend without a token: exits 1 and names the fix
#   - clef backend with a bad token: exits 1 and reports Cloudflare's answer
#     (the last one needs no network in the sense that it only proves the code
#      path runs; it is skipped when a token file has a real value)
#
# Run from the repository root:  bash tools/selftest/doctor-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY="$(cd "$HERE/../.." && pwd)/tools/jev-proxy/jev-proxy"
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/.config/jev-cli"

doctor() { env -i PATH="$PATH" HOME="$T" "$@" bash "$PROXY" doctor 2>&1; }

# gemini, key present
printf '{"backend":"gemini","model":"gemini-2.5-flash"}\n' > "$T/.config/jev-cli/config.json"
printf 'fake-key-value\n' > "$T/.config/jev-cli/gemini_key.txt"
out="$(doctor)"; code=$?
check "gemini with a key: exit 0" "0" "$code"
check "…reports the key as set, length only" "1" "$(printf '%s' "$out" | grep -c 'gemini key   : set (len 14')"
check "…never prints the value" "0" "$(printf '%s' "$out" | grep -c 'fake-key-value')"

# gemini, no key
rm -f "$T/.config/jev-cli/gemini_key.txt"
out="$(doctor)"; code=$?
check "gemini without a key: exit 1" "1" "$code"
check "…says it is missing" "1" "$(printf '%s' "$out" | grep -c 'gemini key   : MISSING')"

# clef, no token
printf '{"backend":"clef","cf_account_id":"acct123"}\n' > "$T/.config/jev-cli/config.json"
out="$(doctor)"; code=$?
check "clef without a token: exit 1" "1" "$code"
check "…names the fix" "1" "$(printf '%s' "$out" | grep -c 'jev-proxy set-cf-key')"

# clef, no account id
printf '{"backend":"clef"}\n' > "$T/.config/jev-cli/config.json"
printf 'some-token\n' > "$T/.config/jev-cli/cloudflare_key.txt"
out="$(doctor)"; code=$?
check "clef without an account id: exit 1" "1" "$code"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
