#!/usr/bin/env bash
# jev-check.sh — one cheap routing judgment from Jev, logged to the feature trace. Never blocks the run.
#   jev-check.sh <feature> "<question>" "<state: the evidence, text or @file>" key=description key=description ...
# Prints `JEV: <key>` (a routing signal, not a fact: look at the evidence if it matters), or
# `JEV UNAVAILABLE: decide yourself` when the proxy is down, slow or answers nothing usable. Always exits 0.
set -u
[ $# -ge 4 ] || { echo "usage: jev-check.sh <feature> <question> <state> key=desc key=desc ..." >&2; exit 3; }
f=$1 q=$2 s=$3; shift 3
here=$(cd "$(dirname "$0")" && pwd)
args=(); for o in "$@"; do args+=(-o "$o"); done
ans=$(JEV_ENDPOINT=${JEV_ENDPOINT:-http://127.0.0.1:8765/v1/systemone} JEV_PROVIDER=${JEV_PROVIDER:-custom} JEV_API_KEY=${JEV_API_KEY:-local-proxy} \
  timeout 25 jev choice --provider custom --value -q "$q" -s "$s" "${args[@]}" 2>/dev/null | head -1 | tr -d '[:space:]')
ok=0; for o in "$@"; do [ "${o%%=*}" = "$ans" ] && ok=1; done
if [ "$ok" = 1 ]; then out="JEV: $ans"; else out="JEV UNAVAILABLE: decide yourself"; fi
node "$here/sdlc-trace.mjs" --feature "$f" --log --from leader --to leader --kind decision --note "jev: $q -> ${ans:-none}" >/dev/null 2>&1 || true
echo "$out"
