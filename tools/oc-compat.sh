#!/usr/bin/env bash
# oc-compat.sh — sourced by oc-agent.sh and autopilot.sh. opencode 2.x changed its command line:
#   run --attach <url>      -> run --server <url>        (and `run --dir` is gone: run from the directory instead)
#   opencode export <id>    -> opencode session export <id>
#   opencode attach <url>   -> opencode --server <url>
# oc_is_v2 is true when this opencode is the 2.x style. Anything unrecognised (an older opencode, a test double)
# counts as the old style, so the old command lines keep working untouched. OC_V2=1|0 overrides the detection.
oc_is_v2() {
  if [ -z "${OC_V2:-}" ]; then
    local h; h=$(opencode run --help 2>&1 || true)
    if printf '%s' "$h" | grep -q -- '--server' && ! printf '%s' "$h" | grep -q -- '--attach'; then OC_V2=1; else OC_V2=0; fi
  fi
  [ "$OC_V2" = 1 ]
}
oc_attach_flag() { if oc_is_v2; then echo --server; else echo --attach; fi; }
# The command that shows a running server in a terminal.
oc_view_cmd() { if oc_is_v2; then echo "opencode --server $1"; else echo "opencode attach $1"; fi; }
oc_export() { if oc_is_v2; then opencode session export "$1"; else opencode export "$1"; fi; }
