# Selftest for tools/claude-stop.mjs — classifying why a headless `claude -p` call ended.
#
# Proves the four things autopilot.sh relies on:
#   - a spent usage window is recognised, and the wait is the time until the reset it states
#   - a run whose own report *talks about* limits is not mistaken for one (precision)
#   - a limit reported as a success is still caught when the call returned too fast to have worked
#   - everything else is done (rc 0) or other (rc != 0), which is the behaviour from before
# --now pins the clock and --file feeds a result object, so every case is exact, not approximate.
#
# Run from the repository root:  bash tools/selftest/claude-stop-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CS="$(cd "$HERE/../.." && pwd)/tools/claude-stop.mjs"
pass=0
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi
}

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT

# 2026-10-07T09:27:00Z is 16:27 in Asia/Saigon, so 8:10pm there is 3 h 43 min away.
NOW=2026-10-07T09:27:00Z

printf '%s' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You'"'"'ve hit your session limit \u00b7 resets 8:10pm (Asia/Saigon)"}' > "$T/limit.json"
# the same words, but the CLI called the result a success: the only evidence is the text
printf '%s' '{"type":"result","subtype":"success","is_error":false,"result":"You'"'"'ve hit your session limit \u00b7 resets 8:10pm (Asia/Saigon)"}' > "$T/soft.json"
printf '%s' '{"type":"result","is_error":false,"result":"saved spec.md; the leader had hit its session limit earlier, resets 8:10pm (Asia/Saigon)"}' > "$T/prose.json"
printf '%s' '{"type":"result","is_error":false,"result":"wrote spec.md and plan.md"}' > "$T/ok.json"
printf '%s' '{"type":"result","is_error":true,"result":"ENOENT: no such file or directory"}' > "$T/err.json"
printf '%s' 'Usage limit reached. Your limit will reset at 3:00am (Asia/Saigon)' > "$T/plain.err"
printf '%s' '{"is_error":true,"result":"You'"'"'ve hit your session limit. Try again later."}' > "$T/none.json"
printf '%s' '{"is_error":true,"result":"You'"'"'ve hit your session limit, resets 8:10pm (Mars/Olympus)"}' > "$T/badtz.json"
printf '%s' '{"is_error":true,"result":"You'"'"'ve hit your session limit \u00b7 resets 3:00am (Asia/Saigon)"}' > "$T/am.json"

kind() { node "$CS" "$@" 2>/dev/null | head -1; }
wait_s() { node "$CS" "$@" 2>/dev/null | sed -n 2p; }
note() { node "$CS" "$@" 2>/dev/null | sed -n 3p; }

# ---- the four kinds, from the exit code and the result object ----
check "a limit the CLI reports as a failure is a limit" "limit" "$(kind --rc 1 --file "$T/limit.json" --now "$NOW")"
check "a normal finished turn is done" "done" "$(kind --rc 0 --elapsed 400 --file "$T/ok.json" --now "$NOW")"
check "a crash without limit text is other" "other" "$(kind --rc 1 --file "$T/err.json" --now "$NOW")"
check "no output at all, rc 0, is done" "done" "$(kind --rc 0 --file /dev/null --now "$NOW")"
check "nothing to read and rc 1 is other" "other" "$(kind --rc 1 --file /dev/null --now "$NOW")"
check "a file that is not there is other" "other" "$(kind --rc 1 --file "$T/missing.json" --now "$NOW")"

# ---- the wait is the time until the stated reset, in the timezone it names ----
check "8:10pm Asia/Saigon at 16:27 there is 3 h 43 min away" "13380" "$(wait_s --rc 1 --file "$T/limit.json" --now "$NOW")"
check "…and the note says which clock it read" "1" "$(note --rc 1 --file "$T/limit.json" --now "$NOW" | grep -c 'resets 20:10 Asia/Saigon (in 223 min)')"
check "with no timezone the machine's clock is used" "13380" "$(wait_s --rc 1 --file "$T/none.json" --now "$NOW" --default-wait 13380)"
check "3:00am the next day is 10 h 33 min away" "37980" "$(wait_s --rc 1 --file "$T/plain.err" --now "$NOW")"
check "3:00am read at 23:00 local is 4 h away" "14400" "$(wait_s --rc 1 --file "$T/am.json" --now 2026-10-07T16:00:00Z)"

# ---- a reset that has already passed means the window is open: retry soon, do not wait a day ----
check "a reset 50 min in the past waits --min-wait, not 24 h" "45" "$(wait_s --rc 1 --file "$T/limit.json" --now 2026-10-07T14:00:00Z --min-wait 45)"
check "…and says so" "1" "$(note --rc 1 --file "$T/limit.json" --now 2026-10-07T14:00:00Z --min-wait 45 | grep -c 'has already passed')"

# ---- when the message states nothing usable, wait a sane default and say why ----
check "no reset time in the message falls back to --default-wait" "1800" "$(wait_s --rc 1 --file "$T/none.json" --now "$NOW")"
check "…and says the message stated none" "1" "$(note --rc 1 --file "$T/none.json" --now "$NOW" | grep -c 'no reset time')"
check "an unknown timezone falls back too" "1800" "$(wait_s --rc 1 --file "$T/badtz.json" --now "$NOW")"
check "…and names the timezone it could not use" "1" "$(note --rc 1 --file "$T/badtz.json" --now "$NOW" | grep -c 'unknown timezone \"Mars/Olympus\"')"
# 20:00 in Asia/Saigon is 13:00Z, so the reset is 10 min away: --min-wait is the floor under it.
check "--min-wait raises a wait that is shorter than it" "900" "$(wait_s --rc 1 --file "$T/limit.json" --now 2026-10-07T13:00:00Z --min-wait 900)"
check "…and a longer wait is left alone" "600" "$(wait_s --rc 1 --file "$T/limit.json" --now 2026-10-07T13:00:00Z --min-wait 60)"

# ---- precision: a successful run that merely mentions limits is not a limit ----
check "a finished run whose report mentions limits is still done" "done" "$(kind --rc 0 --elapsed 400 --file "$T/prose.json" --now "$NOW")"
check "…and no wait is printed for it" "0" "$(wait_s --rc 0 --elapsed 400 --file "$T/prose.json" --now "$NOW")"

# ---- but the same words in a reply that came back in seconds cannot be real work ----
check "a limit reported as a success is a limit when the call took 3 s" "limit" "$(kind --rc 0 --elapsed 3 --file "$T/soft.json" --now "$NOW")"
check "…and the note admits the reply claimed success" "1" "$(note --rc 0 --elapsed 3 --file "$T/soft.json" --now "$NOW" | grep -c 'stated in a successful reply')"
check "--quick 0 turns that safety net off" "done" "$(kind --rc 0 --elapsed 3 --file "$T/soft.json" --now "$NOW" --quick 0)"
check "a slow 'successful' reply is never re-read as a limit" "done" "$(kind --rc 0 --elapsed 300 --file "$T/soft.json" --now "$NOW")"
check "…and an is_error result is a limit at any speed" "limit" "$(kind --rc 0 --elapsed 300 --file "$T/limit.json" --now "$NOW")"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
