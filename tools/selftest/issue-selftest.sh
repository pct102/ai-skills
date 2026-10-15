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
    send(404, {})
  })
}).listen(0, '127.0.0.1', function () { require('fs').writeFileSync(process.argv[2], String(this.address().port)) })
JS
node jira.js "$T/port" "$T/jira.fields" & SRV=$!; disown
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

echo; echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
