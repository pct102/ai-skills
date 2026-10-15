#!/usr/bin/env bash
# Selftest for the live-view windows autopilot opens outside macOS (Windows mintty, Linux terminals, tmux).
#
# Proves: AUTOPILOT_NO_WINDOWS / AUTOPILOT_TERMINAL pick the viewer; a window's shell records its pid and runs the
# command; closing kills that process and removes the pid file. A fake `xterm` stands in for a real terminal, so
# nothing is drawn on screen and it runs the same on macOS, Linux and Git Bash.
#
# Run from the repository root:  bash tools/selftest/viewer-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AP="$(cd "$HERE/../.." && pwd)/tools/autopilot.sh"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
trap 'for f in "$T"/p/.sdlc/viewers/*.pid; do [ -f "$f" ] && kill -9 "$(cat "$f")" 2>/dev/null; done; rm -rf "$T" 2>/dev/null' EXIT
mkdir -p "$T/bin" "$T/p"; cd "$T/p"

# fake xterm: `xterm -e bash -c "<inner>"` -> run what follows -e, as a real terminal would
cat > "$T/bin/xterm" <<'X'
#!/usr/bin/env bash
shift
exec "$@"
X
chmod +x "$T/bin/xterm"

# pull just the viewer functions out of autopilot.sh
eval "$(sed -n '/^viewer_kind() {/,/^viewer=\$(viewer_kind)/p' "$AP" | sed '$d')"
eval "$(sed -n '/^open_window_proc() {/,/^# macOS: a Terminal window/p' "$AP" | sed '$d')"
eval "$(sed -n '/^open_window() {/,/^}/p' "$AP")"
eval "$(sed -n '/^close_windows_proc() {/,/^}/p' "$AP")"

AUTOPILOT_NO_WINDOWS=1; check "AUTOPILOT_NO_WINDOWS=1 opens nothing" "" "$(viewer_kind)"; unset AUTOPILOT_NO_WINDOWS
AUTOPILOT_TERMINAL=konsole; check "AUTOPILOT_TERMINAL forces a terminal" "konsole" "$(viewer_kind)"; unset AUTOPILOT_TERMINAL

PATH="$T/bin:$PATH"; export OPENCODE_SERVER_PASSWORD=pw
win_pidfiles=(); viewer=xterm
open_window "sleep 60" "sleep 60" "one"
open_window "sleep 61" "sleep 61" "two"
for _ in $(seq 40); do [ "$(ls .sdlc/viewers 2>/dev/null | wc -l | tr -d ' ')" = 2 ] && [ -s "${win_pidfiles[1]}" ] && break; sleep 0.1; done
check "each window writes its pid file" "2" "$(ls .sdlc/viewers | wc -l | tr -d ' ')"
p1=$(cat "${win_pidfiles[0]}"); p2=$(cat "${win_pidfiles[1]}")
check "both viewer processes are running" "alive alive" "$(kill -0 "$p1" 2>/dev/null && echo alive) $(kill -0 "$p2" 2>/dev/null && echo alive)"
close_windows_proc
check "closing kills them" "dead dead" "$(kill -0 "$p1" 2>/dev/null && echo alive || echo dead) $(kill -0 "$p2" 2>/dev/null && echo alive || echo dead)"
check "…and removes the pid files" "0" "$(ls .sdlc/viewers | wc -l | tr -d ' ')"
viewer=""; open_window "sleep 60" "x" "none"
check "no terminal found: nothing is opened" "0" "$(ls .sdlc/viewers | wc -l | tr -d ' ')"

# the end-of-run block must also fire for windows opened outside macOS (it once looked at the macOS array only)
check "the end-of-run close covers pid-file windows too" "1" "$(grep -c 'win_ids\[@\]} + \${#win_pidfiles\[@\]}' "$AP")"

# open_file: the diagram hub is shown with the platform's own opener (the Windows branch is covered by hand, not here)
eval "$(sed -n '/^open_file() {/,/^}/p' "$AP")"
mkdir -p "$T/ob"; : > "$T/ob/calls"
for tool in open xdg-open; do printf '#!/usr/bin/env bash\necho "%s $*" >> "%s/ob/calls"\n' "$tool" "$T" > "$T/ob/$tool"; done
chmod +x "$T"/ob/*
opened() { : > "$T/ob/calls"; ( PATH="$T/ob:$PATH"; "$@" ); sleep 0.3; cat "$T/ob/calls" | tr '\n' '|'; }
printf '#!/usr/bin/env bash\n[ $# -eq 0 ] && echo Darwin || exec /usr/bin/uname "$@"\n' > "$T/ob/uname"
check "macOS: opens the hub with open" "open hub.html|" "$(opened open_file hub.html)"
printf '#!/usr/bin/env bash\n[ $# -eq 0 ] && echo Linux || exec /usr/bin/uname "$@"\n' > "$T/ob/uname"
check "Linux with a display: opens it with xdg-open" "xdg-open hub.html|" "$(DISPLAY=:0 opened open_file hub.html)"
check "Linux without a display: opens nothing" "" "$(unset DISPLAY WAYLAND_DISPLAY; opened open_file hub.html)"
check "AUTOPILOT_NO_OPEN=1 opens nothing" "" "$(AUTOPILOT_NO_OPEN=1 opened open_file hub.html)"

echo; echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
