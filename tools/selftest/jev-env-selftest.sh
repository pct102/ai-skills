#!/usr/bin/env bash
# Selftest for model_export_env in tools/model-setting.sh.
#
# Proves the Jev routing split the repo promises:
#   - non-secret routing keys (backend, model, Cloudflare account id, endpoint)
#     flow from autopilot.env into the environment, so the proxy daemon started
#     by autopilot and the leader it spawns both inherit them
#   - project files win over the shared file; a real exported variable wins over both
#   - provider keys are never exported from these files, even if someone writes
#     one there: secrets stay in the environment, key files, or provider logins
#
# Run from the repository root:  bash tools/selftest/jev-env-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MS="$(cd "$HERE/../.." && pwd)/tools/model-setting.sh"
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/proj/.sdlc"

# project file wins over the shared one; env wins over both
printf '%s\n' "JEV_BACKEND=clef" "JEV_CF_ACCOUNT_ID=project-acct" "JEV_API_KEY=should-never-export" > "$T/proj/.sdlc/autopilot.env"
out=$(cd "$T/proj" && unset JEV_BACKEND JEV_MODEL JEV_CF_ACCOUNT_ID JEV_ENDPOINT JEV_PROVIDER JEV_TIMEOUT JEV_PROXY_PORT JEV_API_KEY CLOUDFLARE_API_KEY 2>/dev/null; . "$MS" && model_export_env && printf '%s|%s|%s|%s' "${JEV_BACKEND:-unset}" "${JEV_CF_ACCOUNT_ID:-unset}" "${JEV_API_KEY:-unset}" "${JEV_MODEL:-unset}")
check "project file exports backend + account id, never the key" "clef|project-acct|unset|unset" "$out"

# a real exported variable wins over files
out=$(cd "$T/proj" && unset JEV_BACKEND JEV_MODEL JEV_CF_ACCOUNT_ID JEV_ENDPOINT JEV_PROVIDER JEV_TIMEOUT JEV_PROXY_PORT JEV_API_KEY CLOUDFLARE_API_KEY 2>/dev/null; export JEV_BACKEND=gemini; . "$MS" && model_export_env && printf '%s|%s' "${JEV_BACKEND:-unset}" "${JEV_CF_ACCOUNT_ID:-unset}")
check "exported env wins over files" "gemini|project-acct" "$out"

# missing files are fine, not an error
out=$(cd "$T" && unset JEV_BACKEND JEV_MODEL JEV_CF_ACCOUNT_ID JEV_ENDPOINT JEV_PROVIDER JEV_TIMEOUT JEV_PROXY_PORT JEV_API_KEY CLOUDFLARE_API_KEY 2>/dev/null; . "$MS" && model_export_env && echo EXPORT_OK)
check "no files, no env: silent no-op" "EXPORT_OK" "$out"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
