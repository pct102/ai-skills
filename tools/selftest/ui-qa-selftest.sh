#!/usr/bin/env bash
# Selftest for tools/ui-qa.mjs.
#
# Proves: `file --with-images` uploads via `gh image` and comments, falls back to local paths, and never comments on a fresh issue without the flag; remote hosts and bad usage are refused before a browser starts; `file` sends nothing while the tracker is off;
# on a local fixture with known bugs the run reports overflow, low contrast and a console error, and (safe mode) never
# lets a POST reach the server, and a menu cut off by overflow:hidden is caught. The browser part is skipped unless Playwright resolves from $UI_QA_PW_DIR (default: cwd).
#
# Run from the repository root:  bash tools/selftest/ui-qa-selftest.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UQ="$(cd "$HERE/../.." && pwd)/tools/ui-qa.mjs"
PW_DIR="${UI_QA_PW_DIR:-$PWD}"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; pass=$((pass + 1)); else echo "FAIL $1 (expected '$2', got '$3')"; fail=$((fail + 1)); fi; }

T="$(mktemp -d)"
case "$T" in /tmp/*|/var/*|/private/*) ;; *) echo "unexpected temp dir $T"; exit 1 ;; esac
SRV=
trap '[ -n "$SRV" ] && kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
export AUTOPILOT_GLOBAL_ENV="$T/none.env"

node "$UQ" https://example.com >/dev/null 2>&1; check "remote host refused" 3 $?
node "$UQ" >/dev/null 2>&1; check "no url refused" 3 $?
mkdir -p "$T/off"; echo '[]' > "$T/off/issues.json"
check "file is a no-op while the tracker is off" "yes" "$(cd "$T" && node "$UQ" file "$T/off" | grep -q 'nothing filed' && echo yes)"

# `file --with-images` against a fake gh (+ fake `gh image`): nothing leaves the machine
mkdir -p "$T/bin" "$T/rep/issues" "$T/rep/screens"
printf 'png' > "$T/rep/screens/home-mobile-light.png"
printf -- '- **medium** `responsive` Horizontal scroll\n  - key ghp_%s\n' "$(printf 'a%.0s' $(seq 36))" > "$T/rep/issues/01-responsive.md"
echo '[{"title":"[ui-qa] Responsive layout problems on h:1","body":"issues/01-responsive.md","findings":1,"shots":["screens/home-mobile-light.png","screens/gone.png"]}]' > "$T/rep/issues.json"
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
case "$1 $2" in
  "--version "*) echo gh ;;
  "issue list") if [ -s "$GH_DB" ]; then echo '[{"number":1,"title":"[ui-qa] Responsive layout problems on h:1","url":"https://github.com/o/r/issues/1"}]'; else echo '[]'; fi ;;
  "issue view") echo '{"body":"b","comments":[{"body":"### 1. Horizontal scroll (medium)\n- `/a` · mobile-light"}]}' ;;
  "issue create") echo x > "$GH_DB"; echo "https://github.com/o/r/issues/1" ;;
  "issue comment") while [ $# -gt 0 ]; do [ "$1" = --body ] && printf '%s\n----\n' "$2" >> "$GH_DB.comments"; shift; done; echo "https://github.com/o/r/issues/1#c" ;;
  "image "*|"image") shift; [ "$GH_IMAGE_FAIL" = 1 ] && { echo "no session" >&2; exit 1; }; for f in "$@"; do case "$f" in --repo|o/r) ;; *) echo "![$(basename "$f")](https://github.com/user-attachments/assets/0ff6ee29-4729-4ae9-bbb1-22489701889e)" ;; esac; done ;;
esac
GH
chmod +x "$T/bin/gh"
export GH_DB="$T/gh.db"
fileit() { (cd "$T" && PATH="$T/bin:$PATH" ISSUE_TRACKER=github node "$UQ" file "$T/rep" "$@" 2>&1); }
fileit >/dev/null; check "file: no flag, fresh issue -> no comment" "no" "$([ -e "$GH_DB.comments" ] && echo yes || echo no)"
rm -f "$GH_DB" "$GH_DB.comments"
fileit --with-images >/dev/null
check "with-images: evidence comment has the uploaded image" "1" "$(grep -c 'user-attachments/assets/0ff6ee29.*' "$GH_DB.comments")"
check "with-images: only screenshots that exist are uploaded" "0" "$(grep -c 'gone.png' "$GH_DB.comments")"
rm -f "$GH_DB.comments"
fileit --with-images >/dev/null
check "rerun on an open issue comments the new findings + image" "2" "$(grep -cE 'found this again|user-attachments' "$GH_DB.comments")"
check "comment text is scrubbed of secrets" "0" "$(grep -c 'ghp_a' "$GH_DB.comments")"
rm -f "$GH_DB.comments"
out="$(GH_IMAGE_FAIL=1 fileit --with-images)"
check "upload failure: says so, still comments with local paths" "1 1" "$(printf '%s' "$out" | grep -c 'image upload failed') $(grep -c 'local files, not uploaded' "$GH_DB.comments")"

# open issue + rerun: only findings the issue does not list yet are commented
mkdir -p "$T/rep2/issues"; echo body > "$T/rep2/issues/01.md"; echo x > "$GH_DB"; rm -f "$GH_DB.comments"
P='{"cat":"responsive","title":"Horizontal scroll","sev":"medium","expected":"No scroll.","rows":[{"path":"/a","ctxs":["mobile-light"],"detail":"","shot":""},{"path":"/b","ctxs":["tablet-dark"],"detail":"d","shot":""}]}'
echo "[{\"title\":\"[ui-qa] Responsive layout problems on h:1\",\"body\":\"issues/01.md\",\"findings\":1,\"shots\":[],\"problems\":[$P]}]" > "$T/rep2/issues.json"
(cd "$T" && PATH="$T/bin:$PATH" ISSUE_TRACKER=github node "$UQ" file "$T/rep2" >/dev/null 2>&1)
check "rerun: comments only the finding the issue lacks" "1 0" "$(grep -c '`/b`' "$GH_DB.comments") $(grep -c '`/a`' "$GH_DB.comments")"
rm -f "$GH_DB.comments"; echo "[{\"title\":\"[ui-qa] Responsive layout problems on h:1\",\"body\":\"issues/01.md\",\"findings\":1,\"shots\":[],\"problems\":[$(echo "$P" | sed 's|,{"path":"/b"[^}]*}||')]}]" > "$T/rep2/issues.json"
(cd "$T" && PATH="$T/bin:$PATH" ISSUE_TRACKER=github node "$UQ" file "$T/rep2" >/dev/null 2>&1)
check "rerun: nothing new -> no comment" "no" "$([ -e "$GH_DB.comments" ] && echo yes || echo no)"

if ! (cd "$PW_DIR" && node -e "try{require('playwright')}catch{require('@playwright/test')}" 2>/dev/null); then
  echo "skip browser run (no Playwright in $PW_DIR; set UI_QA_PW_DIR)"; echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]; exit
fi

cat > "$T/srv.mjs" <<'JS'
import http from 'node:http'; import { appendFileSync } from 'node:fs'
const page = `<!doctype html><title>fx</title><style>body{background:#0f172a;margin:0}.app{background:#fff;min-height:100vh}@media(prefers-color-scheme:dark){.app{background:#111;color:#eee}}.w{width:900px}.f{color:#ccc}@media(prefers-color-scheme:dark){.f{color:#ddd}}button{outline:none}.x .app{background:#111;color:#eee}</style>
<div class=app><p class=f>faint text</p><div class=w>wide</div><span style="color:#fff">\u{1F34E}</span>
<button onclick="document.documentElement.classList.toggle('x')">Toggle dark theme</button><button onclick="fetch('/post',{method:'POST'})">Save</button><div style="position:relative;overflow:hidden;width:120px;height:34px"><button onclick="this.nextElementSibling.hidden=false">Open menu</button><div hidden style="position:absolute;top:100%;left:0;width:200px;height:120px;background:#fff;color:#000">menu items here</div></div><nextjs-portal><button style="outline:none">dev</button></nextjs-portal>
<script>console.error('fx error');console.error('Encountered a script tag while rendering React component')</script></div>`
http.createServer((q, s) => { if (q.method === 'POST') appendFileSync(process.argv[2], 'post\n'); s.setHeader('content-type', 'text/html'); s.end(page) })
  .listen(0, '127.0.0.1', function () { console.log(this.address().port) })
JS
node "$T/srv.mjs" "$T/posts" > "$T/port" & SRV=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
(cd "$PW_DIR" && node "$UQ" "http://127.0.0.1:$(cat "$T/port")/" --max-pages 1 --profile fx --out "$T/out" >/dev/null 2>&1); check "run exits 0 or 1 (never a tool error)" 1 $(( $? <= 1 ? 1 : 0 ))
cats="$(node -e "console.log([...new Set(require('$T/out/findings.json').findings.map(f=>f.cat))].sort().join())" 2>/dev/null)"
for c in responsive contrast console-error; do case ",$cats," in *",$c,"*) check "reports $c" ok ok ;; *) check "reports $c" ok "missing ($cats)" ;; esac; done
f="$(cat "$T/out/findings.json")"
check "a theme toggle does not overwrite the light baseline (no false 'no dark theme')" "0" "$(printf '%s' "$f" | grep -c 'No dark theme')"
check "emoji is not reported as low contrast" "0" "$(printf '%s' "$f" | grep -c 🍎)"
check "a popup cut off by overflow:hidden is reported" "1" "$(printf '%s' "$f" | grep -c 'cut off by an ancestor')"
check "dev overlay is ignored (focus, console noise)" "0" "$(printf '%s' "$f" | grep -cE 'nextjs-portal|script tag')"
check "no POST reached the server" "0" "$(cat "$T/posts" 2>/dev/null | wc -l | tr -d ' ')"
check "drafts carry a priority and no 'Expected: undefined'" "yes" "$(grep -q '"priority": "' "$T/out/issues.json" && ! grep -rq 'Expected:\*\* undefined' "$T/out/issues" && echo yes)"
(cd "$PW_DIR" && node "$UQ" "http://127.0.0.1:$(cat "$T/port")/" --out "$T/mk" --mark '[{"sel":"p.f","color":"green","label":"FIXED"},{"sel":".w","color":"red","label":"STILL"}]' --mark-out "$T/marked.png" >/dev/null 2>&1)
check "--mark boxes elements in a screenshot (red/yellow still wrong, green fixed)" "yes" "$([ -s "$T/marked.png" ] && echo yes)"
check "--profile is in the body, not the title (one issue across roles and servers)" "yes" "$(! grep -q '"title": "[^"]*(fx)' "$T/out/issues.json" && grep -rq 'QA profile:\*\* fx' "$T/out/issues" && echo yes)"
check "issue drafts written" "yes" "$([ -s "$T/out/issues.json" ] && echo yes)"

echo "passed=$pass failed=$fail"; [ "$fail" = 0 ]
