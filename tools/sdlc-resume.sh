#!/usr/bin/env bash
# sdlc-resume — the daily loop for unattended delivery.
#
# Looks at every feature lane in .sdlc/ and does the one thing that lane needs:
#
#   validating  -> re-run its acceptance contract (deterministic, no agent needed)
#   building    -> hand it to sdlc-dispatch so it restarts inside its own worktree
#   planned     -> reported only. A resume must not start work that was never begun;
#                  use sdlc-dispatch directly for that.
#   escalated   -> reported only. It waits for a human, and it stays that way.
#   blocked     -> reported only. A human gate is outstanding.
#   accepted    -> reported only.
#
# This is the Cấp 3 loop: clear goals, so the work restarts on a schedule and only
# exceptions reach a human. It is not a trigger system; nothing watches for events
# and nothing starts itself because a PR opened.
#
# Default is a dry run that changes no state. Pass --run to actually act.
#
# Exit codes:
#   0  the loop completed with nothing needing a human
#   1  at least one lane is escalated, blocked, or failed again
#   2  a lane was resumed
#   3  configuration error
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="$HERE/sdlc-verify.mjs"
DISPATCH="$HERE/sdlc-dispatch.mjs"

PROJECT="$(pwd)"
EXEC_CMD=""
DO_RUN=0
JSON=0
MAX_LANES="${SDLC_MAX_LANES:-4}"

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 || exit 3 ;;
    --run) DO_RUN=1; shift ;;
    --exec) EXEC_CMD="${2:-}"; shift 2 || exit 3 ;;
    --max-lanes) MAX_LANES="${2:-}"; shift 2 || exit 3 ;;
    --json) JSON=1; shift ;;
    -h|--help) usage; exit 3 ;;
    *) echo "sdlc-resume: unknown argument: $1" >&2; exit 3 ;;
  esac
done

[ -d "$PROJECT/.sdlc/features" ] || {
  echo "sdlc-resume: no .sdlc/features at $PROJECT" >&2
  exit 3
}

# Emit one TSV row per lane: feature, phase, repair, blocked_reason
lanes() {
  node -e '
    const fs = require("node:fs")
    const path = require("node:path")
    const root = path.join(process.argv[1], ".sdlc", "features")
    for (const feature of fs.readdirSync(root).sort()) {
      const file = path.join(root, feature, "status.json")
      if (!fs.existsSync(file)) continue
      let s = {}
      try { s = JSON.parse(fs.readFileSync(file, "utf8")) } catch {}
      const phase = s.phase || "unknown"
      const reason = String(s.blocked_reason || "").replace(/[\t\n]/g, " ")
      console.log([feature, phase, s.repair_iterations ?? 0, reason].join("\t"))
    }
  ' "$PROJECT"
}

if [ "$JSON" -eq 1 ]; then
  lanes
  exit 0
fi

echo "sdlc-resume $PROJECT"
[ "$DO_RUN" -eq 0 ] && echo "  (dry run — pass --run to act)"

needs_human=0
resumed=0
restart=()

while IFS="$(printf '\t')" read -r feature phase repair reason; do
  [ -n "$feature" ] || continue

  case "$phase" in
    validating)
      echo "  VERIFY  $feature (repair $repair)"
      if [ "$DO_RUN" -eq 1 ]; then
        node "$VERIFY" --project "$PROJECT" --feature "$feature"
        rc=$?
        case $rc in
          0) echo "          -> accepted" ;;
          2) echo "          -> blocked, human gate outstanding"; needs_human=1 ;;
          *) echo "          -> still failing (exit $rc)"; needs_human=1 ;;
        esac
        [ $rc -eq 0 ] && resumed=$((resumed + 1))
      fi
      ;;
    building)
      echo "  RESTART $feature (repair $repair)"
      restart+=("$feature")
      [ "$DO_RUN" -eq 1 ] && resumed=$((resumed + 1))
      ;;
    planned|contract)
      echo "  WAIT    $feature ($phase, never started — use sdlc-dispatch)"
      ;;
    escalated)
      echo "  HUMAN   $feature  $reason"
      needs_human=1
      ;;
    blocked)
      echo "  HUMAN   $feature  $reason"
      needs_human=1
      ;;
    accepted)
      echo "  DONE    $feature"
      ;;
    *)
      echo "  HUMAN   $feature  unknown phase '$phase'"
      needs_human=1
      ;;
  esac
done < <(lanes)

# Restart the interrupted lanes through the dispatcher, so a resume cannot bypass
# the ownership check. --only keeps it to lanes that were already in flight.
#
# Note the ordering: a lane that was mid-validation is re-verified first, so if it
# passes it becomes `accepted` and releases its ownership hold before dispatch
# runs. That is intended — a finished lane no longer blocks a neighbour — but it
# means ownership is held for the duration of a lane, not forever.
if [ ${#restart[@]} -gt 0 ]; then
  only="$(IFS=,; echo "${restart[*]}")"
  if [ "$DO_RUN" -eq 0 ]; then
    echo "  would hand to sdlc-dispatch: $only"
  elif [ -z "$EXEC_CMD" ]; then
    echo "  no --exec given, cannot restart: $only"
    needs_human=1
  else
    node "$DISPATCH" --project "$PROJECT" --only "$only" --max-lanes "$MAX_LANES" --exec "$EXEC_CMD"
    [ $? -eq 0 ] || needs_human=1
  fi
fi

[ $needs_human -eq 1 ] && exit 1
[ $resumed -gt 0 ] && exit 2
exit 0
