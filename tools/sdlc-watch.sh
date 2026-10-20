#!/usr/bin/env bash
# sdlc-watch — the whole run in one pane: a journal snapshot, then the live trace.
#
# autopilot opens four terminal windows (opencode, trace, leader, jev proxy log).
# When you just want to watch one feature, this is the one command: the snapshot
# tells you where it stands, the trace shows everything that happens next.
#
#   tools/sdlc-watch.sh <feature> [--once]   # --once prints the snapshot and exits
set -u
f=${1:?usage: sdlc-watch.sh <feature> [--once]}
here=$(cd "$(dirname "$0")" && pwd)
node "$here/sdlc-resume-context.mjs" --feature "$f" || exit 3
[ "${2:-}" = "--once" ] && exit 0
echo "--- following trace (Ctrl-C to stop; re-run for a fresh snapshot) ---"
exec node "$here/sdlc-trace.mjs" --feature "$f" --follow
