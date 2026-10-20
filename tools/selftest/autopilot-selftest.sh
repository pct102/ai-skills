# Selftest for the diagrams pass in tools/autopilot.sh.
#
# Proves the extra Claude pass that draws architecture and workflow diagrams runs when it should and
# only then:
#   - it runs after the main run when the feature is accepted and the two diagrams are missing
#   - it does not run for a feature that is not accepted
#   - it does not run when both diagrams already exist
#   - --no-diagrams switches it off
# claude and opencode are replaced by fakes; nothing real is called.
#
# Run from the repository root:  bash tools/selftest/autopilot-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AP="$(cd "$HERE/../.." && pwd)/tools/autopilot.sh"
pass=0
fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi
}

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
export T   # the fake ps below reads it to find the pid the test wants killed
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat > "$T/bin/opencode" <<'FAKE'
#!/bin/sh
# The server (`serve`) just stays up. A `run` call (the visual review) is logged and answers at once.
case "$*" in *--help*) exit 0 ;; esac
case "$1" in
  run) echo "$*" >> "$OCRUNS"; echo '{"type":"text","sessionID":"s","part":{"type":"text","text":"CHECKLIST\nFLAG | B1 | B1-a.png | the sofa overlaps the wall | spec\nVISUAL RESULT: FLAGS 1"}}'; exit "${OC_RUN_RC:-0}" ;;
  export|session) exit 1 ;;
esac
sleep 6
FAKE
cat > "$T/bin/claude" <<'FAKE'
#!/bin/sh
# Records every call. The Nth /feature-autopilot call sets the Nth phase of PHASES (or PHASE), the last one repeating.
# LIMIT_CALLS lists call numbers that answer like a spent usage window: the JSON result autopilot classifies,
# a non-zero exit, and the reset time set to right now so the wait it computes is the short --min-wait floor
# (a real one would be hours, and the test must not sleep that long).
echo "$*" >> "$CALLS"
case "$*" in
  *"--help"*) echo "  --output-format <format>   Output format: text, json"; exit 0 ;;
esac
case "$*" in
  *"/feature-autopilot"*)
    k=$(cat "$CALLS.main" 2>/dev/null || echo 0); k=$((k + 1)); echo $k > "$CALLS.main"
    list="${PHASES:-${PHASE:-accepted}}"
    phase=$(printf %s "$list" | cut -d, -f"$k")
    [ -n "$phase" ] || phase=$(printf %s "$list" | awk -F, '{print $NF}')
    F=.sdlc/features/${FEAT:-make-a-thing}; mkdir -p $F/.oc
    # NO_STATUS models a leader that never starts the feature: no status.json at all. NO_STATUS_CALLS
    # lists call numbers that skip it instead, to model a leader that starts only after autopilot's
    # corrective call — the case that has to recover rather than report.
    skip_status=0
    [ -n "${NO_STATUS:-}" ] && skip_status=1
    case ",${NO_STATUS_CALLS:-}," in *",$k,"*) skip_status=1 ;; esac
    [ -n "${EVIDENCE:-}" ] && { mkdir -p $F/evidence; : > $F/evidence/B1-a.png; }
    [ "$skip_status" = 1 ] || printf '{"feature":"x","phase":"%s","budget":2,"repair_iterations":0}\n' "$phase" > $F/status.json
    if [ -n "${LANES:-}" ] && [ "$k" = 1 ]; then
      # two parallel lane calls, finishing at different times; the slower one is the one that must be waited for
      mkdir -p $F/.oc/lane-core $F/.oc/lane-ui
      ( sleep 1; echo 0 > $F/.oc/lane-core/builder-1.done ) & echo $! > $F/.oc/lane-core/builder.pid
      ( sleep 5; echo 0 > $F/.oc/lane-ui/builder-1.done ) & echo $! > $F/.oc/lane-ui/builder.pid
      echo "1 $(date +%s)" > $F/.oc/lane-core/builder.current; echo "1 $(date +%s)" > $F/.oc/lane-ui/builder.current
    fi
    if [ -n "${PENDING:-}" ] && [ "$k" = 1 ]; then
      # a detached builder call that outlives this Claude, like --async does
      ( sleep 4; echo 0 > $F/.oc/builder-1.done ) &
      echo $! > $F/.oc/builder.pid; echo "1 $(date +%s)" > $F/.oc/builder.current
    fi
    case ",${LIMIT_CALLS:-}," in
      *",$k,"*)
        printf '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"You have hit your session limit \\u00b7 resets %s"}\n' "$(date '+%I:%M%p')"
        exit 1 ;;
    esac
    printf '{"type":"result","is_error":false,"result":"%s"}\n' "${LEADER_SAYS:-ok}" ;;
esac
FAKE
# pretend to be macOS on request, and record the Terminal windows autopilot would open.
# FAKE_UNAME answers directly, which is how a case asks for a non-macOS host: deferring to the real
# uname cannot do that, because the real uname on a macOS host says Darwin too. The real one is
# called by absolute path — `command -v -p uname` does not switch to the default search path when it
# is combined with -v, so it found this script again and exec'd it forever.
cat > "$T/bin/uname" <<'FAKE'
#!/bin/sh
if [ -n "${FAKE_UNAME:-}" ]; then echo "$FAKE_UNAME"; exit 0; fi
if [ -n "$FAKE_DARWIN" ] && [ $# -eq 0 ]; then echo Darwin; else exec /usr/bin/uname "$@"; fi
FAKE
cat > "$T/bin/osascript" <<'FAKE'
#!/bin/sh
# records every call and answers the three questions autopilot asks: "open this" (id and tty of the new window),
# "what is the tty of window N" (nothing when that window was closed by hand: FAKE_GONE lists such ids), and
# "is tab N still busy" (FAKE_BUSY lists the ids that keep answering yes, to exercise the wait before a close)
all="$*"
echo "$all" >> "$CALLS.windows"
case "$all" in
  *"do script"*) n=$(( $(cat "$CALLS.wn" 2>/dev/null || echo 0) + 1 )); echo $n > "$CALLS.wn"; echo "$n /dev/ttys99$n" ;;
  *"tty of selected tab of (first window whose id is "*)
    id=$(printf '%s' "$all" | sed -n 's/.*whose id is \([0-9]*\)).*/\1/p')
    case " ${FAKE_GONE:-} " in *" $id "*) ;; *) echo "/dev/ttys99$id" ;; esac ;;
  *"busy of selected tab of (first window whose id is "*)
    id=$(printf '%s' "$all" | sed -n 's/.*whose id is \([0-9]*\)).*/\1/p')
    case " ${FAKE_BUSY:-} " in *" $id "*) echo true ;; *) echo false ;; esac ;;
esac
FAKE
# autopilot asks ps for the pids on a window's tty; the test writes the pid of a process it owns into
# victim.pid, so a real kill really happens and the assertion is about a process, not about a call.
cat > "$T/bin/ps" <<'FAKE'
#!/bin/sh
case "$*" in *"-o pid="*) cat "$T/victim.pid" 2>/dev/null ;; esac
FAKE
# pkill records what it was asked to kill: killing for real is the ps path's job to prove
cat > "$T/bin/pkill" <<'FAKE'
#!/bin/sh
echo "$*" >> "$CALLS.pkill"
exit 0
FAKE
chmod +x "$T/bin/opencode" "$T/bin/claude" "$T/bin/uname" "$T/bin/osascript" "$T/bin/ps" "$T/bin/pkill"

run() { # name, env assignments..., then autopilot args
  local name="$1"; shift
  local d="$T/$name"; mkdir -p "$d"; cd "$d" || exit 1
  CALLS="$d/calls.log"; export CALLS; : > "$CALLS"; OCRUNS="$d/oc-runs.log"; export OCRUNS; : > "$OCRUNS"
  # A jev proxy log pointed at a file that does not exist keeps three windows the default here; a case
  # that wants the fourth passes its own JEV_PROXY_LOG (the last assignment to env wins).
  env PATH="$T/bin:$PATH" JEV_PROXY_LOG="$T/no-such-jev.log" "$@" >"$d/out.log" 2>&1
}
main_calls() { grep -c '/feature-autopilot' "$T/$1/calls.log"; }
diagram_calls() { grep -c '/feature-diagrams' "$T/$1/calls.log"; }
# A logged call can span several lines (the RESUME prompt carries the journal
# brief), so the Nth call is everything from its opening line to the next call.
# (The log holds "$*", not the command name, so lines open with "-p", not "claude".)
nth_call() { awk -v n="$2" '/^-p \/feature-autopilot/ {c++} c==n' "$T/$1/calls.log"; }

run a PHASE=accepted bash "$AP" "Make a thing"
check "accepted + diagrams missing: the diagrams pass runs" "1" "$(diagram_calls a)"
check "…and it is told the feature name" "1" "$(grep '/feature-diagrams' $T/a/calls.log | grep -c 'feature name: make-a-thing')"
check "the start prompt forbids creating or switching branches" "1" "$(grep '/feature-autopilot' $T/a/calls.log | grep -c 'no git checkout -b, git switch, git branch')"
check "…and names the branch ship will create" "1" "$(grep '/feature-autopilot' $T/a/calls.log | grep -c 'autopilot/make-a-thing (exactly the feature')"
check "…and the run records its starting branch" "1" "$([ -f $T/a/.sdlc/features/make-a-thing/run-branch ] && echo 1 || echo 0)"

run b PHASE=escalated bash "$AP" "Make a thing"
check "not accepted: no diagrams pass" "0" "$(diagram_calls b)"
check "…and it says why, with the phase and the command to run later" "1 1" "$(grep -c "diagrams pass skipped: the feature's phase is 'escalated'" $T/b/out.log) $(grep -c 'claude -p "/feature-diagrams feature name: make-a-thing"' $T/b/out.log)"

run c PHASE=accepted bash "$AP" --no-diagrams "Make a thing"
check "--no-diagrams: no diagrams pass" "0" "$(diagram_calls c)"
check "…and it says it was switched off" "1" "$(grep -c 'diagrams pass skipped (--no-diagrams)' $T/c/out.log)"
check "a diagrams pass that draws nothing is reported" "1" "$(grep -c 'the diagrams pass ended but architecture.html and/or workflow.html are still missing' $T/a/out.log)"

mkdir -p "$T/d/.sdlc/features/make-a-thing/diagrams"
touch "$T/d/.sdlc/features/make-a-thing/diagrams/architecture.html" "$T/d/.sdlc/features/make-a-thing/diagrams/workflow.html"
run d PHASE=accepted bash "$AP" "Make a thing"
check "both diagrams already exist: no diagrams pass" "0" "$(diagram_calls d)"
check "…and nothing is said about skipping the diagrams pass" "0" "$(grep -c 'diagrams pass skipped' $T/d/out.log)"

# the feature name is cut at a word boundary, never in the middle of a word
run e PHASE=accepted bash "$AP" "alpha beta gamma delta epsilon zeta eta theta iota kappa"
name="$(grep -o 'feature name: [a-z0-9-]*' "$T/e/calls.log" | head -1 | sed 's/feature name: //')"
check "a long request gives a name ending on a whole word" "alpha-beta-gamma-delta-epsilon-zeta-eta" "$name"
run f PHASE=accepted bash "$AP" "Update the existing match-pairs/index.html; do not touch the hub"
name="$(grep -o 'feature name: [a-z0-9-]*' "$T/f/calls.log" | head -1 | sed 's/feature name: //')"
check "the real request that was cut as ...-index-ht now ends on ...-index-html" "update-the-existing-match-pairs-index-html" "$name"
run g PHASE=accepted bash "$AP" "Make a thing"
check "a short request is kept whole" "make-a-thing" "$(grep -o 'feature name: [a-z0-9-]*' "$T/g/calls.log" | head -1 | sed 's/feature name: //')"

# Claude stopped early: a fresh Claude resumes from disk, a bounded number of times
run h PHASES=building,accepted bash "$AP" --no-diagrams "Make a thing"
check "stopped in building, then accepted: resumed once (2 main calls)" "2" "$(main_calls h)"
check "…and the second call is a RESUME that does not repeat the request" "1" "$(nth_call h 2 | grep -c 'RESUME')"
check "…and the RESUME carries the git rule too" "1" "$(nth_call h 2 | grep -c 'no git checkout -b')"
run i PHASES=building AUTOPILOT_RESUMES=2 bash "$AP" --no-diagrams "Make a thing"
check "never finishing: 1 run + 2 resumes, then it stops" "3" "$(main_calls i)"
check "…and says how to continue by hand" "1" "$(grep -c 'autopilot --resume make-a-thing' $T/i/out.log)"
run j PHASES=escalated bash "$AP" --no-diagrams "Make a thing"
check "escalated is an ending: no resume" "1" "$(main_calls j)"
run k PHASES=blocked bash "$AP" --no-diagrams "Make a thing"
check "blocked is an ending: no resume" "1" "$(main_calls k)"

# A spent usage window is not a failed resume. It is waited out, it does not spend a resume, and the
# run carries on afterwards — the whole point, because three retries of a locked account used to end
# the run. AUTOPILOT_LIMIT_MIN_WAIT=1 keeps the wait at a second; the fake states a reset time of
# "right now", which is the one case that resolves to that floor.
run w LIMIT_CALLS=1 PHASES=building,accepted AUTOPILOT_LIMIT_MIN_WAIT=1 bash "$AP" --no-diagrams "Make a thing"
check "a spent window is waited out and the run continues" "2" "$(main_calls w)"
check "…the leader is asked for its JSON result so the reason can be read" "2" "$(grep -c -- '--output-format json' $T/w/calls.log)"
check "…it says it is waiting instead of retrying" "1" "$(grep -c 'waiting instead of retrying' $T/w/out.log)"
check "…it announces the reopen time" "1" "$(grep -c 'waiting for the leader.s usage window to reopen' $T/w/out.log)"
check "…and the wait does not spend a resume: the next one is still the first" "1" "$(grep -c 'resuming (1 of' $T/w/out.log)"
check "…the classification is in the trace" "1" "$(grep -c 'leader call 1 ended limit' $T/w/.sdlc/features/make-a-thing/trace.jsonl)"

# ...whereas an ordinary stop still spends a resume, exactly as before.
run w2 PHASES=building,accepted bash "$AP" --no-diagrams "Make a thing"
check "an ordinary stop is still a resume, not a limit" "0" "$(grep -c 'waiting instead of retrying' $T/w2/out.log)"

# The waiting is bounded three ways, so a locked-out run reports instead of hiding for hours. The fake
# keeps the feature in 'building': a phase of 'accepted' would end the loop before the limit is read.
run x LIMIT_CALLS=1 PHASES=building AUTOPILOT_LIMIT_WAIT=0 bash "$AP" --no-diagrams "Make a thing"
check "AUTOPILOT_LIMIT_WAIT=0 stops instead of waiting" "1" "$(grep -c 'AUTOPILOT_LIMIT_WAIT=0' $T/x/out.log)"
check "…after the one call, with no resume" "1" "$(main_calls x)"
run y LIMIT_CALLS=1 PHASES=building AUTOPILOT_LIMIT_MAX_WAIT=0 bash "$AP" --no-diagrams "Make a thing"
check "a window beyond AUTOPILOT_LIMIT_MAX_WAIT is reported, not slept on" "1" "$(grep -c 'further than AUTOPILOT_LIMIT_MAX_WAIT' $T/y/out.log)"
run z LIMIT_CALLS=1,2,3,4,5 PHASES=building AUTOPILOT_LIMIT_MIN_WAIT=1 AUTOPILOT_LIMIT_WAITS=2 bash "$AP" --no-diagrams "Make a thing"
check "the number of waits in one run is bounded" "1" "$(grep -c 'was spent 2 time(s) in this run' $T/z/out.log)"
check "…after the two waits it was allowed" "3" "$(main_calls z)"

# --resume <feature>: no request, straight to a resume
mkdir -p "$T/l/.sdlc/features/old-feature"
echo '{"feature":"old-feature","phase":"building","budget":2,"repair_iterations":0}' > "$T/l/.sdlc/features/old-feature/status.json"
run l FEAT=old-feature PHASES=accepted bash "$AP" --no-diagrams --resume old-feature
check "--resume starts a RESUME call for that feature" "1" "$(grep '/feature-autopilot' $T/l/calls.log | grep -c 'feature name: old-feature. RESUME')"
check "…and makes exactly one call" "1" "$(main_calls l)"
run m bash "$AP" --resume nope
check "--resume of an unknown feature is refused" "1" "$(grep -c 'no .sdlc/features/nope' $T/m/out.log)"

# A leader that ends without ever writing status.json: the run never started. Autopilot must say that
# plainly and show the leader's own reason, instead of only "nothing to resume" — the measured failure,
# where the leader decided the work was small, fixed and committed it itself, and the only diagnosis sat
# unread in .sdlc/claude/leader-1.json. AUTOPILOT_START_RETRIES=0 reads the report path directly; the
# recovery path is the s2 case below.
run s NO_STATUS=1 AUTOPILOT_START_RETRIES=0 \
  LEADER_SAYS='Most of this was already in the repo, so I did not run the builder/QA agents.' \
  bash "$AP" --no-diagrams "Make a thing"
check "no status.json: it says the feature was never started" "1" "$(grep -c 'ended without starting feature' $T/s/out.log)"
check "…and it does not claim there is something to resume" "0" "$(grep -c 'autopilot: resuming (' $T/s/out.log)"
check "…it shows the leader's own reason" "1" "$(grep -c 'did not run the builder/QA agents' $T/s/out.log)"
check "…and points at the file holding the full message" "1" "$(grep -c 'full message: .sdlc/claude/leader-1.json' $T/s/out.log)"
check "…after exactly one leader call" "1" "$(main_calls s)"

# …but a leader that never started is not simply given up on: autopilot tells it what is missing and asks
# it to start. Here the first call leaves no status.json and the corrective call produces one, so the run
# carries on instead of ending — the whole point, because reporting a started-nothing run twice in a row
# is what left the user with no spec, no acceptance contract and no evidence.
run s2 NO_STATUS_CALLS=1 PHASES=accepted bash "$AP" --no-diagrams "Make a thing"
check "a leader that starts only on the corrective call is recovered" "2" "$(main_calls s2)"
check "…the corrective call names the missing status.json" "1" "$(grep -c 'CORRECTION: the previous call ended without writing' $T/s2/calls.log)"
check "…it forbids doing the work and committing" "1" "$(grep -c 'You are the leader: do not write product code and do not run git commit' $T/s2/calls.log)"
check "…and it carries the git rule too" "1" "$(grep 'CORRECTION' $T/s2/calls.log | grep -c 'no git checkout -b')"
check "…it names the phase command that must run first" "1" "$(grep -c 'set-phase building' $T/s2/calls.log)"
check "…it repeats the request so the leader can write the spec" "1" "$(grep 'CORRECTION' $T/s2/calls.log | grep -c 'Make a thing')"
check "…and the run does not report a failure" "0" "$(grep -c 'ended without starting feature' $T/s2/out.log)"
check "…it says it is asking again" "1" "$(grep -c 'Asking the leader to start the procedure' $T/s2/out.log)"

# The corrective calls are bounded, so a leader that never starts cannot loop for ever.
run s3 NO_STATUS=1 AUTOPILOT_START_RETRIES=2 bash "$AP" --no-diagrams "Make a thing"
check "a leader that never starts is asked twice, then reported" "3" "$(main_calls s3)"
check "…and the report counts the corrective calls it made" "1" "$(grep -c 'after 2 corrective call(s)' $T/s3/out.log)"
check "…showing the newest leader message, not the first" "1" "$(grep -c 'full message: .sdlc/claude/leader-3.json' $T/s3/out.log)"

# a builder call that outlives Claude is waited for, not killed with the server
run n PENDING=1 PHASES=accepted bash "$AP" --no-diagrams "Make a thing"
check "waits for a call still running when Claude stops" "1" "$(grep -c 'still running; waiting' $T/n/out.log)"
check "…and its result exists when autopilot returns" "1" "$([ -f $T/n/.sdlc/features/make-a-thing/.oc/builder-1.done ] && echo 1 || echo 0)"

# parallel lanes are waited for too, all of them
run o LANES=1 PHASES=accepted bash "$AP" --no-diagrams "Make a thing"
check "waits for lane calls still running when Claude stops" "1" "$(grep -c 'still running; waiting' $T/o/out.log)"
check "…names the lanes it waits for" "1" "$(grep -c 'builder-core\|builder-ui' $T/o/out.log)"
check "…and the slowest lane finished before autopilot returned" "1" "$([ -f $T/o/.sdlc/features/make-a-thing/.oc/lane-ui/builder-1.done ] && echo 1 || echo 0)"

# the live windows on macOS: agents, trace and the leader
opened() { grep -c 'do script' "$T/$1/calls.log.windows" 2>/dev/null || true; }
closed() { grep -c 'close (every window whose id is' "$T/$1/calls.log.windows" 2>/dev/null || true; }
run p FAKE_DARWIN=1 PHASE=accepted bash "$AP" --no-diagrams "Make a thing"
check "macOS: three windows are opened" "3" "$(opened p)"
check "…one is the leader view, pointed at this project and started now" "1" "$(grep -c "claude-follow.mjs' --cwd '$T/p' --since [0-9]" $T/p/calls.log.windows)"
check "…one is the opencode view and one the trace" "1 1" "$(grep -c 'opencode attach' $T/p/calls.log.windows) $(grep -c 'sdlc-trace.mjs' $T/p/calls.log.windows)"
check "the feature ended accepted: all three windows are closed" "3" "$(closed p)"
check "…each by the id it was given" "1 1 1" "$(grep -c 'close (every window whose id is 1)' $T/p/calls.log.windows) $(grep -c 'close (every window whose id is 2)' $T/p/calls.log.windows) $(grep -c 'close (every window whose id is 3)' $T/p/calls.log.windows)"
run q FAKE_DARWIN=1 AUTOPILOT_NO_CLAUDE_WINDOW=1 PHASE=accepted bash "$AP" --no-diagrams "Make a thing"
check "AUTOPILOT_NO_CLAUDE_WINDOW=1 leaves the leader view out" "2 0 2" "$(opened q) $(grep -c 'claude-follow' $T/q/calls.log.windows) $(closed q)"
run r FAKE_UNAME=Linux PHASE=accepted bash "$AP" --no-diagrams "Make a thing"
check "not macOS: no windows" "0" "$([ -f $T/r/calls.log.windows ] && echo 1 || echo 0)"
run t FAKE_DARWIN=1 PHASE=escalated bash "$AP" --no-diagrams "Make a thing"
check "the feature did not end accepted: the windows stay open" "3 0" "$(opened t) $(closed t)"
check "…and autopilot says so" "1" "$(grep -c "not accepted, so the trace windows stay open" $T/t/out.log)"
run u FAKE_DARWIN=1 AUTOPILOT_KEEP_WINDOWS=1 PHASE=accepted bash "$AP" --no-diagrams "Make a thing"
check "AUTOPILOT_KEEP_WINDOWS=1 keeps them open even when accepted" "3 0" "$(opened u) $(closed u)"
run v FAKE_DARWIN=1 FAKE_GONE=2 PHASE=accepted bash "$AP" --no-diagrams "Make a thing"
check "a window you closed yourself is skipped, the others are closed" "2 0" "$(closed v) $(grep -c 'close (every window whose id is 2)' $T/v/calls.log.windows)"

# A window is only closed once Terminal says its tab is idle. Closing while a process is still in the
# window is what raised the "do you want to terminate running processes?" dialog on every window at the
# end of a run, so autopilot asks first — and this proves the question is asked before the close, not
# after it, and that a tab which never settles is still closed instead of hanging the run.
busy_asks() { grep -c 'busy of selected tab' "$T/$1/calls.log.windows" 2>/dev/null || true; }
run w3 FAKE_DARWIN=1 PHASE=accepted bash "$AP" --no-diagrams "Make a thing"
check "each close asks Terminal whether the tab is still busy" "3" "$(busy_asks w3)"
check "…and asks before it closes" "1" "$(awk '/busy of selected tab/{if(!b)b=NR} /close \(every window whose id is/{if(!c)c=NR} END{print (b && c && b < c) ? 1 : 0}' $T/w3/calls.log.windows)"
check "…so a tab that is already idle is closed, all three" "3" "$(closed w3)"
run w4 FAKE_DARWIN=1 FAKE_BUSY="1 2 3" AUTOPILOT_CLOSE_WAIT=2 PHASE=accepted bash "$AP" --no-diagrams "Make a thing"
check "a tab that never reports idle is asked again, then closed anyway" "6 3" "$(busy_asks w4) $(closed w4)"

# What the windows were running is stopped before they are closed. This used `pkill -t <tty>`, which
# matches nothing for a Terminal window on macOS — measured, with a process running on it — so nothing
# was ever killed and every close raised the "terminate running processes?" dialog. The ps path is
# proved with a process the test owns, so the assertion is about a process that really died.
sleep 120 & VICTIM=$!
echo "$VICTIM" > "$T/victim.pid"
run w5 FAKE_DARWIN=1 PHASE=accepted bash "$AP" --no-diagrams "Make a thing"
check "what a window was running is killed, so the tab can go idle" "dead" "$(kill -0 "$VICTIM" 2>/dev/null && echo alive || echo dead)"
check "…and the command line is kept as a second net" "1" "$(grep -c 'opencode attach http://127.0.0.1' $T/w5/calls.log.pkill)"
wait "$VICTIM" 2>/dev/null || true

# The fourth view is the local jev proxy's log — the service the agents' jev tool talks to, which used to
# be invisible during a run. It is opened only when that log exists, and closes with the others.
echo 'x' > "$T/jev.log"
run w6 FAKE_DARWIN=1 PHASE=accepted JEV_PROXY_LOG="$T/jev.log" bash "$AP" --no-diagrams "Make a thing"
check "a jev proxy log to watch: four windows are opened" "4" "$(opened w6)"
check "…the fourth tails that log" "1" "$(grep -c 'tail -n 40 -f' $T/w6/calls.log.windows)"
check "…and it is closed with the rest" "4" "$(closed w6)"
run w7 FAKE_DARWIN=1 PHASE=accepted JEV_PROXY_LOG="$T/jev.log" AUTOPILOT_NO_JEV_WINDOW=1 bash "$AP" --no-diagrams "Make a thing"
check "AUTOPILOT_NO_JEV_WINDOW=1 leaves it out" "3 0" "$(opened w7) $(grep -c 'tail -n 40' $T/w7/calls.log.windows)"

# ---- the visual review pass: opt-in, accepted features with screenshots only -------------------------------------------
V=.sdlc/features/make-a-thing
run v1 PHASE=accepted EVIDENCE=1 VISUAL_QA=1 bash "$AP" --no-diagrams "Make a thing"
check "VISUAL_QA=1, accepted, screenshots: one visual call is made" "1" "$(grep -c '^run ' "$T/v1/oc-runs.log")"
check "…with a model that accepts images (the visual chain, not the builder's)" "1" "$(grep -c -- '-m opencode-go/glm-5.3-flash' "$T/v1/oc-runs.log" | awk '{print ($1>0)?1:0}')"
check "…its review is kept in visual-review.md" "1" "$(grep -c '^FLAG' "$T/v1/$V/visual-review.md")"
check "…and the evidence page shows the flag" "1" "$(grep -c 'overlaps the wall' "$T/v1/$V/diagrams/evidence.html" | awk '{print ($1>0)?1:0}')"
run v2 PHASE=accepted EVIDENCE=1 bash "$AP" --no-diagrams "Make a thing"
check "VISUAL_QA unset: no visual call and no review file" "0 0" "$(grep -c '^run ' "$T/v2/oc-runs.log") $([ -e "$T/v2/$V/visual-review.md" ] && echo 1 || echo 0)"
run v3 PHASE=escalated EVIDENCE=1 VISUAL_QA=1 bash "$AP" --no-diagrams "Make a thing"
check "VISUAL_QA=1 but the feature is not accepted: skipped" "0" "$(grep -c '^run ' "$T/v3/oc-runs.log")"
run v4 PHASE=accepted VISUAL_QA=1 bash "$AP" --no-diagrams "Make a thing"
check "VISUAL_QA=1 but there are no screenshots: skipped" "0" "$(grep -c '^run ' "$T/v4/oc-runs.log")"
run v5 PHASE=accepted EVIDENCE=1 VISUAL_QA=1 OC_RUN_RC=1 bash "$AP" --no-diagrams "Make a thing"
check "a visual call that fails leaves no review, the run still ends normally" "0 0" "$([ -e "$T/v5/$V/visual-review.md" ] && echo 1 || echo 0) $(grep -c 'ended without starting' "$T/v5/out.log")"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
