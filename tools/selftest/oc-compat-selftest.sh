#!/usr/bin/env bash
# Selftest for tools/oc-compat.sh: opencode 1.x and 2.x take different command lines, and a fake `opencode` that
# prints either help text proves which one is chosen. An unrecognised opencode must count as the old style.
#
# Run from the repository root:  bash tools/selftest/oc-compat-selftest.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPAT="$(cd "$HERE/../.." && pwd)/tools/oc-compat.sh"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"; trap 'rm -rf "$T" 2>/dev/null' EXIT
mkdir -p "$T/v1" "$T/v2" "$T/odd"
# the fakes echo the arguments they get, so the chosen subcommand is visible
cat > "$T/v1/opencode" <<'X'
#!/usr/bin/env bash
[ "$1 $2" = "run --help" ] && { printf 'FLAGS\n  --attach string  Attach to a server\n  --dir string  Directory\n'; exit 0; }
echo "v1 $*"
X
cat > "$T/v2/opencode" <<'X'
#!/usr/bin/env bash
[ "$1 $2" = "run --help" ] && { printf 'FLAGS\n  --standalone  private server\n  --server string  Connect to a server URL\n'; exit 0; }
echo "v2 $*"
X
printf '#!/usr/bin/env bash\necho odd "$@"\n' > "$T/odd/opencode"
chmod +x "$T"/*/opencode

probe() { ( PATH="$T/$1:$PATH"; unset OC_V2; . "$COMPAT"; echo "$(oc_attach_flag) | $(oc_view_cmd http://u) | $(oc_export ses_1)" ); }
check "1.x: --attach, opencode attach, opencode export" "--attach | opencode attach http://u | v1 export ses_1" "$(probe v1)"
check "2.x: --server, opencode --server, session export" "--server | opencode --server http://u | v2 session export ses_1" "$(probe v2)"
check "an unrecognised opencode is treated as 1.x" "--attach | opencode attach http://u | odd export ses_1" "$(probe odd)"
check "OC_V2=1 forces the 2.x style" "--server" "$( ( PATH="$T/v1:$PATH"; OC_V2=1; . "$COMPAT"; oc_attach_flag ) )"
check "OC_V2=0 forces the 1.x style" "--attach" "$( ( PATH="$T/v2:$PATH"; OC_V2=0; . "$COMPAT"; oc_attach_flag ) )"

echo; echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
