#!/usr/bin/env bash
# Selftest for the Cloudflare Clef backend in tools/jev-proxy/jev_proxy.py.
#
# Proves, without touching the network:
#   - the request body keeps the jev CLI's state + typed-questions shape and only
#     adds the `instructions` field Clef decides from, with the short model name
#   - a non-Cloudflare model name falls back to clef-flash, never to Gemini
#   - the response parser accepts the Workers AI envelope, a bare answers
#     object, and a JSON string — and garbage in any other shape
#   - credentials are per-backend: env/file discovery never cross-contaminates
#     a Gemini key into a Cloudflare header
#
# Run from the repository root:  bash tools/selftest/clef-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY="$(cd "$HERE/../.." && pwd)/tools/jev-proxy/jev_proxy.py"
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT

# Each probe prints its verdict on stdout; stderr stays clean unless Python
# itself breaks, which fails loudly instead of passing silently.

check "request keeps state + typed questions, adds instructions" "1" "$(
python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
body = jp.clef_request_body(
    "s",
    {"answer": {"type": "choice",
                "instructions": "Can they run in parallel?",
                "criteria": {"parallel": "no shared state"}}},
    "@cf/cloudflare/clef-flash")
want = {"model": "clef-flash", "state": "s", "questions": {
    "answer": {"type": "choice",
               "instructions": "Can they run in parallel?",
               "criteria": {"parallel": "no shared state"}}}}
print(1 if body == want else 0)
PYEOF
)"

check "missing instructions falls back to the question key" "q" "$(
python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
body = jp.clef_request_body("s", {"q": {"type": "choice", "criteria": {"parallel": "x"}}}, "@cf/cloudflare/clef-flash")
print(body["questions"]["q"]["instructions"])
PYEOF
)"

check "non-CF model name falls back to clef-flash" "@cf/cloudflare/clef-flash" "$(
python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(jp.effective_model({"backend": "clef", "model": "gemini-2.5-flash"}))
PYEOF
)"

check "explicit CF model is kept" "@cf/cloudflare/clef" "$(
python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(jp.effective_model({"backend": "clef", "model": "@cf/cloudflare/clef"}))
PYEOF
)"

check "Workers AI envelope parses" "{'a': 1}" "$(
python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(jp.clef_parse_answers({"result": {"answers": {"a": 1}}}))
PYEOF
)"

check "bare answers object parses" "{'a': 1}" "$(
python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(jp.clef_parse_answers({"answers": {"a": 1}}))
PYEOF
)"

check "string answers still parse" "{'a': 1}" "$(
python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(jp.clef_parse_answers({"result": {"answers": '{"a": 1}'}}))
PYEOF
)"

check "garbage shapes give {}" "1" "$(
python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(1 if jp.clef_parse_answers({}) == {} and jp.clef_parse_answers("nope") == {} else 0)
PYEOF
)"

# Credential wiring, hermetic under a fake HOME: exactly one token env name works,
# and neither autopilot.env-style JEV_CF_API_KEY nor config.json can smuggle one in.
T2="$(mktemp -d)"; trap 'rm -rf "$T" "$T2"' EXIT
check "CLOUDFLARE_API_TOKEN env is picked up" "tok" "$(
env -i PATH="$PATH" HOME="$T2" JEV_BACKEND=clef CLOUDFLARE_API_TOKEN=tok python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(jp.load_config()["cf_api_key"])
PYEOF
)"
check "legacy JEV_CF_API_KEY env is ignored" "" "$(
env -i PATH="$PATH" HOME="$T2" JEV_BACKEND=clef JEV_CF_API_KEY=xyz python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(jp.load_config().get("cf_api_key", ""))
PYEOF
)"
mkdir -p "$T2/.config/jev-cli"
printf '{"backend": "clef", "cf_api_key": "should-not-load", "cf_account_id": "abc"}' > "$T2/.config/jev-cli/config.json"
check "config.json cannot smuggle a token in" "" "$(
env -i PATH="$PATH" HOME="$T2" JEV_BACKEND=clef python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(jp.load_config().get("cf_api_key", ""))
PYEOF
)"
check "...but the account id still loads from it" "abc" "$(
env -i PATH="$PATH" HOME="$T2" JEV_BACKEND=clef python3 - "$PROXY" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("jp", sys.argv[1])
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
print(jp.load_config().get("cf_account_id", ""))
PYEOF
)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
