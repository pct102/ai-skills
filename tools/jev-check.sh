#!/usr/bin/env bash
# jev-check.sh — one cheap routing judgment from Jev, logged to the feature trace + ledger. Never blocks the run.
#   jev-check.sh <feature> "<question>" "<state>" key=description key=desc ...     (legacy form, still works)
#   jev-check.sh <feature> --command <name> "<state>" [VAR=val ...]                  (versioned form)
# Versioned commands live in tools/jev-proxy/commands/<name>.json so the exact
# wording a leader sends is reviewable, tunable, and reusable as few-shot context.
# Prints `JEV: <key>` (a routing signal, not a fact: look at the evidence if it matters),
# or `JEV UNAVAILABLE: decide yourself` when the proxy is down, slow or answers nothing usable. Always exits 0.
set -u
here=$(cd "$(dirname "$0")" && pwd)
CMD_DIR="$here/jev-proxy/commands"
f=${1:?usage: jev-check.sh <feature> [--command <name>] ...}; shift

cmd_name=""
if [ "${1:-}" = "--command" ]; then
  cmd_name=${2:?usage: jev-check.sh <feature> --command <name> "<state>" [VAR=val ...]}; shift 2
  cmd_file="$CMD_DIR/$cmd_name.json"
  [ -f "$cmd_file" ] || { echo "jev-check: unknown command '$cmd_name' (see $CMD_DIR)" >&2; echo "JEV UNAVAILABLE: decide yourself"; exit 0; }
  s=${1:?usage: jev-check.sh <feature> --command <name> "<state>" [VAR=val ...]}; shift
  # Load question template + options from the versioned command file.
  q=""; opts=()
  while IFS= read -r line; do
    if [ -z "$q" ]; then q=$line; else opts+=("$line"); fi
  done < <(python3 - "$cmd_file" "$@" <<'PY'
import json, sys
cmd = json.load(open(sys.argv[1]))
print(cmd["question"])
for var in sys.argv[2:]:
    if "=" in var:
        k, v = var.split("=", 1)
        # placeholder substitution happens in bash below; just validate names here
        assert k.replace("_", "").isalnum(), f"bad VAR name: {k}"
for k, v in cmd["options"].items():
    print(f"{k}\x1f{v}")
PY
)
  args=()
  # Substitute <VAR> placeholders from VAR=val pairs (e.g. a=p1 b=p2).
  for o in "$@"; do k=${o%%=*}; v=${o#*=}; q=${q//<$k>/$v}; done
  keys=()
  for line in ${opts[@]+"${opts[@]}"}; do k=${line%%$'\x1f'*}; keys+=("$k"); args+=(-o "$k=${line#*$'\x1f'}"); done
else
  [ $# -ge 3 ] || { echo "usage: jev-check.sh <feature> \"<question>\" \"<state>\" key=desc key=desc ..." >&2; exit 3; }
  q=$1 s=$2; shift 2
  args=(); keys=(); for o in "$@"; do args+=(-o "$o"); keys+=("${o%%=*}"); done
fi

endpoint=${JEV_ENDPOINT:-http://127.0.0.1:8765/v1/systemone}
ledger=".sdlc/features/$f/jev-ledger.jsonl"

# Skip-unchanged: an identical (question, state, options) triple was already judged
# for this feature, so reuse it instead of spending another call. Same input would
# get the same low-temperature answer anyway; the ledger is the record.
sig=$(python3 -c 'import hashlib,sys; print(hashlib.sha256("\n".join(sys.argv[1:]).encode()).hexdigest())' \
  "$q" "$s" "$(printf '%s\n' "${args[@]}")")
cached=""
if [ -f "$ledger" ]; then
  cached=$(grep -F "\"hash\": \"$sig\"" "$ledger" 2>/dev/null | tail -1 | python3 -c 'import json,sys; print(json.load(sys.stdin).get("answer",""))' 2>/dev/null || true)
fi

ms_now() { python3 -c 'import time; print(int(time.time()*1000))'; }
if [ -n "$cached" ]; then
  ans=$cached; ms=0; hit=true; cache_note=" (cached)"
else
  t0=$(ms_now)
  ans=$(JEV_ENDPOINT="$endpoint" JEV_PROVIDER=${JEV_PROVIDER:-custom} JEV_API_KEY=${JEV_API_KEY:-local-proxy} \
    timeout 25 jev choice --provider custom --value -q "$q" -s "$s" "${args[@]}" 2>/dev/null | head -1 | tr -d '[:space:]')
  ms=$(( $(ms_now) - t0 )); hit=false; cache_note=""
fi
ok=0; for k in ${keys[@]+"${keys[@]}"}; do [ "$k" = "$ans" ] && ok=1; done
if [ "$ok" = 1 ]; then out="JEV: $ans"; else out="JEV UNAVAILABLE: decide yourself"; fi
# Append the ledger entry (best effort; a missing ledger never fails the run).
mkdir -p "$(dirname "$ledger")" 2>/dev/null || true
python3 - "$ledger" <<PY 2>/dev/null || true
import json, sys, time
entry = {
    "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "command": "$cmd_name" or None,
    "question": $(printf '%s' "$q" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'),
    "hash": "$sig",
    "answer": "$ans" or None,
    "latency_ms": $ms,
    "endpoint": "$endpoint",
    "cached": $([ "$hit" = true ] && echo True || echo False),
}
open(sys.argv[1], "a").write(json.dumps(entry, ensure_ascii=False) + "\n")
PY
node "$here/sdlc-trace.mjs" --feature "$f" --log --from leader --to leader --kind decision --note "jev: $q -> ${ans:-none}$cache_note" >/dev/null 2>&1 || true
echo "$out"
