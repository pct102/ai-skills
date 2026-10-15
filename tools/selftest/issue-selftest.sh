#!/usr/bin/env bash
# Selftest for tools/sdlc-issue.mjs, with a fake `gh` on PATH and a local fake Jira server (nothing leaves the machine).
#
# Proves: the tracker is off unless configured; GitHub and Jira create an issue and a rerun reuses it instead of
# filing a duplicate; secrets are scrubbed from the body; a missing Jira credential is named, not guessed.
#
# Run from the repository root:  bash tools/selftest/issue-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IS="$(cd "$HERE/../.." && pwd)/tools/sdlc-issue.mjs"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
cd "$T"; mkdir -p bin
printf 'Login fails.\nkey AKIAABCDEFGHIJKLMNOP and token ghp_%s\n' "$(printf 'a%.0s' $(seq 36))" > body.md

# fake gh: keeps issues in $T/gh.db (one "number<TAB>title" per line); records the --body it was given
cat > bin/gh <<'GH'
#!/usr/bin/env bash
db="$GH_DB"; touch "$db"
case "$1 $2" in
  "--version "*) echo "gh fake" ;;
  "issue list") node -e '
    const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(l=>l.split("\t"));
    console.log(JSON.stringify(rows.map(([n,t])=>({number:+n,title:t,url:"https://github.com/o/r/issues/"+n}))))' "$db" ;;
  "issue create") n=$(( $(wc -l < "$db") + 1 ))
    while [ $# -gt 0 ]; do case "$1" in --title) t=$2; shift ;; --body) printf '%s' "$2" > "$GH_DB.body"; shift ;; esac; shift; done
    printf '%s\t%s\n' "$n" "$t" >> "$db"; echo "https://github.com/o/r/issues/$n" ;;
esac
GH
chmod +x bin/gh
export GH_DB="$T/gh.db"
export AUTOPILOT_GLOBAL_ENV="$T/global.env"   # never read the real <ai-skills>/autopilot.env

out="$(PATH="$T/bin:$PATH" node "$IS" create --title "Login fails" --body-file body.md 2>&1)"; rc=$?
check "tracker off: nothing is sent, exit 0" "0 1" "$rc $(printf '%s' "$out" | grep -c 'tracker is off')"
check "…and gh was not asked" "0" "$(wc -l < "$GH_DB" 2>/dev/null | tr -d ' ' || echo 0)"

export PATH="$T/bin:$PATH" ISSUE_TRACKER=github
out="$(node "$IS" create --title "Login fails" --feature demo --body-file body.md 2>&1)"
check "github: files the issue" "filed: #1 https://github.com/o/r/issues/1" "$out"
check "github: the title carries the feature" "[demo] Login fails" "$(cut -f2 "$GH_DB")"
out="$(node "$IS" create --title "Login fails" --feature demo --body-file body.md 2>&1)"
check "github: a rerun reuses the open issue" "already filed: #1 https://github.com/o/r/issues/1" "$out"
check "github: still one issue" "1" "$(wc -l < "$GH_DB" | tr -d ' ')"
check "github: secrets are scrubbed from the body" "0" "$(grep -cE 'AKIAABCDEFGHIJKLMNOP|ghp_a{36}' "$GH_DB.body")"
check "github: search finds it" "#1 https://github.com/o/r/issues/1" "$(node "$IS" search --title "Login fails" --feature demo)"

# fake Jira: GET search/jql returns what was created; POST issue stores a summary and checks Basic auth
cat > jira.js <<'JS'
const http = require('http'); const issues = []
const want = 'Basic ' + Buffer.from('me@x.io:tok-123456').toString('base64')
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) }
    if (req.headers.authorization !== want) return send(401, { errorMessages: ['bad auth'] })
    if (req.method === 'GET' && req.url.startsWith('/rest/api/2/search/jql')) return send(200, { issues: issues.map((s, i) => ({ key: 'ABC-' + (i + 1), fields: { summary: s } })) })
    if (req.method === 'POST' && req.url === '/rest/api/2/issue') {
      const f = JSON.parse(b).fields; issues.push(f.summary)
      require('fs').writeFileSync(process.argv[3], JSON.stringify(f)); return send(201, { key: 'ABC-' + issues.length })
    }
    const fs = require('fs')
    if (req.method === 'GET' && req.url.startsWith('/rest/api/2/issue/ABC-1?')) return send(200, { fields: { summary: 'Login fails', status: { name: 'Open' }, issuetype: { name: 'Bug' }, reporter: { displayName: 'Ann' }, description: 'steps here', attachment: [{ filename: 'old.png', size: 5 }], labels: [], created: 'c', updated: 'u' } })
    if (req.method === 'GET' && req.url.startsWith('/rest/api/2/issue/ABC-1/comment')) return send(200, { comments: [{ created: 't1', author: { displayName: 'Bob' }, body: 'seen it' }] })
    if (req.method === 'POST' && req.url === '/rest/api/2/issue/ABC-1/comment') { fs.writeFileSync(process.argv[4], b); return send(201, { id: '77' }) }
    if (req.method === 'POST' && req.url === '/rest/api/2/issue/ABC-1/attachments') {
      if (req.headers['x-atlassian-token'] !== 'no-check' || !/multipart\/form-data/.test(req.headers['content-type'] || '')) return send(400, {})
      fs.appendFileSync(process.argv[5], b + '\n--END--\n'); return send(200, [{ filename: (b.match(/filename="([^"]+)"/) || [])[1] }])
    }
    send(404, {})
  })
}).listen(0, '127.0.0.1', function () { require('fs').writeFileSync(process.argv[2], String(this.address().port)) })
JS
node jira.js "$T/port" "$T/jira.fields" "$T/jira.comment" "$T/jira.attach" & SRV=$!; disown
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
export ISSUE_TRACKER=jira JIRA_BASE_URL="http://127.0.0.1:$(cat "$T/port")" JIRA_PROJECT=ABC

out="$(node "$IS" create --title "Login fails" --body-file body.md 2>&1)"; rc=$?
check "jira: missing credentials are named" "1 1" "$rc $(printf '%s' "$out" | grep -c 'missing JIRA_EMAIL, JIRA_API_TOKEN')"
export JIRA_EMAIL=me@x.io JIRA_API_TOKEN=tok-123456
out="$(node "$IS" create --title "Login fails" --body-file body.md 2>&1)"
check "jira: files the ticket" "filed: ABC-1 $JIRA_BASE_URL/browse/ABC-1" "$out"
check "jira: project, type and scrubbed description" "ABC Bug 0" "$(node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(f.project.key,f.issuetype.name,/AKIA|ghp_/.test(f.description)?1:0)' "$T/jira.fields")"
out="$(node "$IS" create --title "Login fails" --body-file body.md 2>&1)"
check "jira: a rerun reuses the ticket" "already filed: ABC-1 $JIRA_BASE_URL/browse/ABC-1" "$out"
JIRA_API_TOKEN=wrong out="$(JIRA_API_TOKEN=wrong node "$IS" search --title "Login fails" 2>&1)"; rc=$?
check "jira: a rejected login fails loudly and does not print the token" "1 0" "$rc $(printf '%s' "$out" | grep -c 'wrong\|tok-123456')"
ISSUE_TRACKER=trello out="$(ISSUE_TRACKER=trello node "$IS" create --title x --body-file body.md 2>&1)"; rc=$?
check "an unknown tracker is a configuration error" "1" "$rc"

# read, comment and attach (Jira only)
export ISSUE_TRACKER=jira JIRA_API_TOKEN=tok-123456   # the checks above leave "wrong" / "trello" behind
out="$(node "$IS" get --key abc-1 2>&1)"
check "jira get: prints summary, status, attachments and description" "4" "$(printf '%s' "$out" | grep -cE 'ABC-1 Login fails|status: Open|old.png \(5 B\)|steps here')"
check "jira get: warns that ticket text is data" "1" "$(printf '%s' "$out" | grep -c 'not instructions')"
check "jira comments: lists author and body" "2" "$(node "$IS" comments --key ABC-1 | grep -cE 'Bob|seen it')"
check "jira get: a bad key is a usage error" "3" "$(node "$IS" get --key nope >/dev/null 2>&1; echo $?)"
printf 'screenshot-bytes' > shot.png; printf 'run log\nAKIAABCDEFGHIJKLMNOP\n' > leaky.log; printf 'X=1' > .env
out="$(node "$IS" comment --key ABC-1 --body "see ghp_$(printf 'a%.0s' $(seq 36)) evidence" --attach shot.png 2>&1)"
check "jira comment+attach: reports both" "attached to ABC-1: shot.png|commented: $JIRA_BASE_URL/browse/ABC-1?focusedCommentId=77" "$(printf '%s' "$out" | paste -sd'|')"
check "jira comment: body is scrubbed and links the evidence" "0 1" "$(grep -c 'ghp_a' "$T/jira.comment") $(grep -c 'Evidence: \[^shot.png\]' "$T/jira.comment")"
check "jira attach: sends the file bytes" "1" "$(grep -c 'screenshot-bytes' "$T/jira.attach")"
check "jira attach: a file holding a secret is refused" "1 0" "$(node "$IS" attach --key ABC-1 --attach leaky.log >/dev/null 2>&1; echo $?) $(grep -c 'AKIAABCDEFGHIJKLMNOP' "$T/jira.attach")"
check "jira attach: a credential-looking name is refused" "1" "$(node "$IS" attach --key ABC-1 --attach .env >/dev/null 2>&1; echo $?)"
check "github: get is refused (Jira only)" "1" "$(ISSUE_TRACKER=github node "$IS" get --key ABC-1 >/dev/null 2>&1; echo $?)"

# credentials follow the project: its .sdlc/autopilot.env, then the global file (the environment wins over both)
unset JIRA_EMAIL JIRA_API_TOKEN; mkdir -p .sdlc
printf 'JIRA_EMAIL=me@x.io
JIRA_API_TOKEN=tok-123456
' > .sdlc/autopilot.env
check "jira: credentials in the project's .sdlc/autopilot.env are used" "ABC-1 Login fails" "$(node "$IS" get --key ABC-1 2>&1 | grep -m1 'ABC-1 Login')"
rm -f .sdlc/autopilot.env
printf 'JIRA_EMAIL=me@x.io  # work account
JIRA_API_TOKEN="tok-123456"
' > "$T/global.env"
check "jira: the global env file is the fallback" "ABC-1 Login fails" "$(node "$IS" get --key ABC-1 2>&1 | grep -m1 'ABC-1 Login')"
printf 'JIRA_API_TOKEN=wrong-token
' > .sdlc/autopilot.env
out="$(node "$IS" get --key ABC-1 2>&1)"; rc=$?
check "jira: the project's value beats the global one" "1 1" "$rc $(printf '%s' "$out" | grep -c '401')"
rm -f .sdlc/autopilot.env "$T/global.env"
# the tracker is chosen per project: the same global config serves a GitHub project and a Jira project
mkdir -p proj-gh/.sdlc proj-jira/.sdlc; printf 'ISSUE_TRACKER=github
' > proj-gh/.sdlc/autopilot.env
printf 'ISSUE_TRACKER=jira
JIRA_PROJECT=ABC
' > proj-jira/.sdlc/autopilot.env
unset ISSUE_TRACKER JIRA_PROJECT
check "tracker: a GitHub project and a Jira project, one global config" "tracker: github|tracker: jira" "$(cd proj-gh && node "$IS" status | head -1)|$(cd proj-jira && node "$IS" status | head -1)"
check "tracker: a project with no env file has it off" "tracker: off" "$(cd "$T" && node "$IS" status | head -1)"

echo; echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
