#!/usr/bin/env node
// The QA loop for one project, run by hand like autopilot: each stage works through its queue, then stops and writes a report.
// Run from the project root (the project's .sdlc/autopilot.env is read).
//   sdlc-daily.mjs check [--dry-run]   ui-qa over QA_ENV_URL (+ QA_URLS): files NEW issues (labels ui-qa, auto-fix), with screenshots
//   sdlc-daily.mjs review [issue] open UNLABELED issues a person filed by hand (no ui-qa label): pct102-qa-review reproduces them, adds steps/expected/pages,
//                                 retitles, labels qa-reviewed + auto-fix (or needs-info), so fix picks them up
//   sdlc-daily.mjs fix [--no-verify]  open auto-fix issues, oldest first, ONE AT A TIME: pct102-dev-fix (PR into PR_BASE) -> merge gate (an agent
//                                 resolves conflicts with PR_BASE) -> wait for the dev deploy -> pct102-qa-verify -> next issue
//   (review, fix, verify take an optional issue number or URL: only that issue, whatever its labels)
//   sdlc-daily.mjs verify [issue] each ready-for-test issue whose fix is merged and deployed: an agent runs pct102-qa-verify --close
//   sdlc-daily.mjs merge <pr>     the merge gate alone
// Stages follow issue labels, so they can be rerun safely. Only scripts run here; tokens are spent inside the agent (AGENT_CMD) that
// fix and verify launch once per issue. Each run writes .sdlc/daily/<stage>-<date>-<time>.md: what was filed, fixed or verified, with
// links and the image count of every issue. Settings: see autopilot.env.example.
// Exit: 0 done | 1 a stage had errors | 3 usage or missing setting
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { setting } from './lib/setting.mjs'
import { impact } from './lib/impact.mjs'

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = process.cwd(), SELF = join(HERE, 'sdlc-daily.mjs')
const [cmd, arg] = process.argv.slice(2)
// Optional issue number or URL after the stage (review 123 | fix https://github.com/o/r/issues/123 | verify 123): only that issue is worked on, whatever its labels. No issue = the whole queue.
const ONLY = process.argv.slice(3).map((a) => (a.match(/^#?(\d+)$/) || a.match(/\/issues\/(\d+)/) || [])[1]).find(Boolean)
const onlyIssue = (R) => { const i = ghJson(['issue', 'view', ONLY, '--repo', R, '--json', 'number,title,labels,state']); return i.state === 'OPEN' ? [{ ...i, labels: i.labels.map((l) => l.name) }] : (say(`#${ONLY} is ${i.state}, nothing to do`), []) }
const die = (code, msg) => { console.error(`sdlc-daily: ${msg}`); process.exit(code) }
const run = (c, a, o = {}) => spawnSync(c, a, { encoding: 'utf8', cwd: ROOT, ...o })
const num = (k, d) => (setting(k) === '' ? d : +setting(k)) // 0 is a real value
const list = (k, d = '') => (setting(k) || d).split(/[\s,]+/).filter(Boolean)
// Profiles = roles tested logged in (a saved login file, ui-qa --auth). QA_PROFILES="admin student1 devadmin"; per profile NAME: QA_PROFILE_<NAME>_AUTH (login file),
// _URL (default QA_LOCAL_URL), _PATHS (pages for that role), _RENEW=0 (a login file made some other way, e.g. a minted test-user session: never renew it from the Google Chrome profile). A local URL runs the project's own server with seeded test users; a remote one is the deployed dev.
const profile = (name) => { const K = `QA_PROFILE_${name.toUpperCase().replace(/\W/g, '_')}_`, a = setting(K + 'AUTH'); return a ? { name, auth: a.startsWith('~') ? join(homedir(), a.slice(1)) : resolve(ROOT, a), base: (setting(K + 'URL') || setting('QA_LOCAL_URL')).replace(/\/+$/, ''), paths: list(K + 'PATHS', '/vi/home'), renew: setting(K + 'RENEW') !== '0' } : null }
const isLocalUrl = (u) => { try { return /^(localhost|127\.|\[?::1\]?$)/.test(new URL(u).hostname) } catch { return false } }
// A deployed profile's login is renewed by itself when the file is missing or older than LOGIN_MAX_AGE_DAYS: the dedicated Chrome profile (made once with ui-qa --login) still holds the sign-in, so no person is needed. Returns '' or why not.
const freshLogin = (pf, force = false) => {
  if (isLocalUrl(pf.base) || !pf.base || !pf.renew) return ''
  const old = force || !existsSync(pf.auth) || Date.now() - statSync(pf.auth).mtimeMs > num('LOGIN_MAX_AGE_DAYS', 2) * 86400000; if (!old) return ''
  const r = run('node', [setting('UI_QA_BIN') || join(HERE, 'ui-qa.mjs'), pf.base + (pf.paths?.[0] || '/'), '--login', pf.auth, '--refresh', '--out', join(ROOT, '.sdlc', 'qa-verify', 'login')], { timeout: 120000 })
  return r.status === 0 ? '' : (r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 200) || 'refresh failed'
}
const reachable = (u) => run('curl', ['-s', '-o', '/dev/null', '-m', '8', u]).status === 0
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const day = new Date().toLocaleDateString('sv') // yyyy-mm-dd, local
const dailyDir = join(ROOT, '.sdlc', 'daily'); mkdirSync(dailyDir, { recursive: true })
for (const d of ['daily', 'qa-check', 'qa-verify', 'qa-review', 'wt', 'features/daily']) { // generated output: keep it out of the project's git status
  mkdirSync(join(ROOT, '.sdlc', d), { recursive: true }); writeFileSync(join(ROOT, '.sdlc', d, '.gitignore'), '*\n')
}
const lines = [], cards = []
const stamp = () => new Date().toTimeString().slice(0, 8)
const say = (s) => { console.log(`[${stamp()}] ${s}`); lines.push(`- ${stamp()} ${s}`) }
let errors = 0

// ---------- progress: a checklist per issue, timed steps, ETA from earlier runs (timing.json), a heartbeat while an agent works
const timingFile = join(dailyDir, 'timing.json')
let timing = {}; try { timing = JSON.parse(readFileSync(timingFile, 'utf8')) } catch {}
const DEFAULT_SEC = { reuse: 5, fix: 900, gate: 180, deploy: 240, rerun: 480, verdict: 300, review: 600 }
const est = (k) => (timing[k]?.length ? timing[k].reduce((a, b) => a + b, 0) / timing[k].length : DEFAULT_SEC[k])
const dur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`)
const STEP_NAME = { reuse: 'Look for an existing PR or branch', fix: 'Fix (agent)', gate: 'Merge gate: CI, conflicts, merge', deploy: 'Wait for the dev deploy', rerun: 'Re-run ui-qa on the affected pages and a sweep', review: 'QA review (agent): reproduce, complete, label', verdict: 'Verdict (agent): compare, comment, label' }
let cl = null // the checklist of the issue being worked on
const begin = (n, keys) => { cl = { n, keys, st: Object.fromEntries(keys.map((k) => [k, { s: 'todo' }])), t0: Date.now() } }
const eta = () => cl.keys.filter((k) => ['todo', 'run'].includes(cl.st[k].s)).reduce((a, k) => a + est(k), 0)
const skip = (why) => ({ skip: why })
async function step(key, fn) {
  const i = cl.keys.indexOf(key) + 1, x = cl.st[key]; x.s = 'run'; x.t0 = Date.now()
  say(`#${cl.n} ▶ ${i}/${cl.keys.length} ${STEP_NAME[key]} · usually ~${dur(est(key))} · issue done in ~${dur(eta())}`)
  let r; try { r = await fn() } catch (e) { say(`#${cl.n} error in "${key}": ${e.message}`); errors++; r = false }
  x.secs = (Date.now() - x.t0) / 1000
  if (r && r.skip !== undefined) { x.s = 'skip'; x.note = r.skip } else {
    x.s = r ? 'ok' : 'fail'
    if (r) { timing[key] = [...(timing[key] || []), Math.round(x.secs)].slice(-10); writeFileSync(timingFile, JSON.stringify(timing)) }
  }
  say(`#${cl.n} ${{ ok: '✔', fail: '✘', skip: '↷' }[x.s]} ${i}/${cl.keys.length} ${STEP_NAME[key]} (${dur(x.secs)})${x.note ? ' · ' + x.note : ''}`)
  return r
}
const ICON = { ok: '✔', fail: '✘', skip: '↷', todo: '☐', run: '…' }
function summary() { // the whole checklist of the issue: terminal, log and report card
  const rows = cl.keys.map((k) => { const x = cl.st[k]; return `${ICON[x.s]} ${STEP_NAME[k]}${x.secs ? ` (${dur(x.secs)})` : ''}${x.note ? ' · ' + x.note : ''}` })
  console.log(`#${cl.n} checklist, ${dur((Date.now() - cl.t0) / 1000)} in total:\n${rows.map((r) => `   ${r}`).join('\n')}`)
  lines.push(`- #${cl.n} checklist (${dur((Date.now() - cl.t0) / 1000)}): ${rows.join(' | ')}`)
  return rows
}

// GitHub answers 502/503/timeouts now and then; one blip must not kill a 20-minute issue run: retry those (not 4xx) after 3, 8 and 20 s.
const ghOut = (a) => { let r; for (const wait of [3000, 8000, 20000, 0]) { r = run('gh', a); if (r.status === 0 || !/HTTP 5\d\d|timed? ?out|timeout|connection|EOF|reset by peer|temporar|unavailable|TLS|no such host/i.test(r.stderr || '')) break; if (wait) sleep(wait) } if (r.status !== 0) throw new Error(`gh ${a.slice(0, 3).join(' ')}: ${(r.stderr || '').trim().slice(0, 200)}`); return r.stdout }
const ghJson = (a) => JSON.parse(ghOut(a) || 'null')
const repo = () => setting('ISSUE_GITHUB_REPO') || ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner
const BASE = setting('PR_BASE') || 'dev'
// A local server tests the code in THIS checkout, so before any local test: be on BASE with its latest commits. Refuses (returns why) if tracked files are modified, never discards work.
const syncLocal = () => {
  if (run('git', ['status', '--porcelain', '--untracked-files=no']).stdout.trim()) return `the checkout has uncommitted changes, so it was not switched to ${BASE} (commit or stash them)`
  const f = run('git', ['fetch', 'origin', BASE]); if (f.status) return `git fetch origin ${BASE} failed`
  const cur = run('git', ['branch', '--show-current']).stdout.trim()
  if (cur !== BASE && run('git', ['switch', BASE]).status) return `could not switch to ${BASE}`
  if (run('git', ['merge', '--ff-only', `origin/${BASE}`]).status) return `${BASE} cannot fast-forward to origin/${BASE} (local commits?)`
  say(`local checkout: on ${BASE} at ${run('git', ['rev-parse', '--short', 'HEAD']).stdout.trim()}${cur !== BASE ? ` (was ${cur})` : ''}`); return ''
}
const PROTECTED = list('PROTECTED_BRANCHES', 'main master')
const issueUrl = (R, n) => `https://github.com/${R}/issues/${n}`
const tag = (R, n, add, remove = '') => run('node', [join(HERE, 'sdlc-issue.mjs'), 'label', '--url', issueUrl(R, n), ...(add ? ['--add', add] : []), ...(remove ? ['--remove', remove] : [])])
const note = (R, n, body) => run('node', [join(HERE, 'sdlc-issue.mjs'), 'comment', '--url', issueUrl(R, n), '--body', body])
const IMG = /!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g
// A report entry for one issue: link, state, labels, how many images are attached across the body and comments (0 = say so), optional full text.
function card(R, n, { full = false, note: extra = '' } = {}) {
  try {
    const i = ghJson(['issue', 'view', String(n), '--repo', R, '--json', 'title,url,state,labels,body,comments'])
    const imgs = [i.body, ...i.comments.map((c) => c.body)].flatMap((t) => [...(t || '').matchAll(IMG)].map((m) => m[1]))
    cards.push([`### #${n} ${i.title}`, `- ${i.url} · ${i.state} · labels: ${i.labels.map((l) => l.name).join(', ') || '-'}`,
      `- images attached: ${imgs.length}${imgs.length ? '' : ' — NONE: the upload failed or was skipped, attach screenshots by hand'}`, ...(extra ? [`- ${extra}`] : []),
      ...(full ? ['', i.body.split('\n').map((l) => `> ${l}`).join('\n')] : []), ''].join('\n'))
    return imgs.length
  } catch (e) { cards.push(`### #${n}\n- could not read the issue: ${e.message}\n`); return 0 }
}
const issues = (R, label) => ghJson(['issue', 'list', '--repo', R, '--state', 'open', '--label', label, '--json', 'number,title,labels', '--limit', '100'])
  .map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }))
const prFor = (R, n, state) => ghJson(['pr', 'list', '--repo', R, '--state', state, '--base', BASE, '--json', 'number,headRefName,body,title', '--limit', '100'])
  .find((p) => new RegExp(`^fix/issue-${n}(-|$)`).test(p.headRefName) || new RegExp(`#${n}\\b`).test(`${p.title} ${p.body || ''}`))

const agentCmd = () => setting('AGENT_CMD') || die(3, 'AGENT_CMD is not set (e.g. AGENT_CMD="opencode run"): the command that takes the prompt as its last argument')
// What an opencode agent is doing right now, read from its event log (lane = its own folder, see oc-daily-agent.sh).
function activity(lane) {
  const d = join(dailyDir, 'oc', '.oc', `lane-${lane}`); let model = '', last = '', n = 0
  try { model = readFileSync(join(d, 'builder.model'), 'utf8').trim() } catch {}
  try {
    const f = readdirSync(d).filter((x) => /^builder-\d+\.jsonl$/.test(x)).sort().pop()
    if (f) for (const l of readFileSync(join(d, f), 'utf8').split('\n')) {
      if (!l.includes('"tool_use"')) continue
      try { const p = JSON.parse(l).part, i = p.state?.input || {}; n++; last = `${p.tool} ${String(i.command || i.filePath || i.name || '').replace(/\s+/g, ' ').slice(0, 70)}` } catch {}
    }
  } catch {}
  return { model, last, n }
}
// Runs the agent command (prompt as its last argument) in its own process group, so a timeout takes its children down too. Prints a heartbeat.
// Impeccable design rules run on every ui-qa pass (medium+ become issues, low stays in the report); QA_IMPECCABLE=0 turns them off.
const imp = () => (setting('QA_IMPECCABLE') === '0' ? [] : ['--impeccable'])
// the low design rules become issues too (one per rule, label design-polish); QA_DESIGN_POLISH=0 keeps them in the report only
const polish = () => (imp().length && setting('QA_DESIGN_POLISH') !== '0' ? ['--design-polish'] : [])

// A lane keeps the agent's session, so a lane reused by a later run makes the agent answer "already done" from its old context: every run gets its own.
const RUN = Date.now().toString(36)
function agent(cwd, prompt, logName, label, { lane = '', min = num('AGENT_TIMEOUT_MIN', 30), what = 'agent' } = {}) {
  const cmdline = agentCmd(), chain = (setting('BUILDER_MODEL') || '').replace(/\s+/g, '').split(',').filter(Boolean)
  mkdirSync(join(dailyDir, 'logs'), { recursive: true })
  const logFile = join(dailyDir, 'logs', `${day}-${logName}.log`), log = openSync(logFile, 'a'), t0 = Date.now()
  say(`${label}   ${what} started · max ${min}m · models: ${chain.length ? chain.join(' → ') + ' (next one when a model hits its limit)' : "opencode's own default"}`)
  return new Promise((resolve) => {
    lane = lane && `${lane}_${RUN}`
    const child = spawn('sh', ['-c', `${cmdline} "$SDLC_PROMPT"`], { cwd, env: { ...process.env, SDLC_PROMPT: prompt, OC_LANE: lane }, stdio: ['ignore', log, log], detached: true })
    let timedOut = false
    const group = (sig) => { try { process.kill(-child.pid, sig) } catch {} }
    const to = setTimeout(() => { timedOut = true; group('SIGTERM'); setTimeout(() => group('SIGKILL'), 5000) }, min * 60000)
    const hb = setInterval(() => { const a = activity(lane); console.log(`[${stamp()}] ${label}   ⏳ ${what} ${dur((Date.now() - t0) / 1000)} of max ${min}m · model ${a.model || chain[0] || '?'} · ${a.n} tool calls${a.last ? ' · now: ' + a.last : ''}`) }, num('HEARTBEAT_SEC', 60) * 1000)
    const end = (code) => {
      clearTimeout(to); clearInterval(hb); closeSync(log)
      const a = activity(lane), ok = !timedOut && !code
      if (!ok) { errors++; say(`${label}: ${what} ${timedOut ? 'timed out after ' + min + 'm' : 'exited ' + code} (log ${logFile.replace(ROOT + '/', '')})`) }
      resolve({ ok, timedOut, model: a.model || chain[0] || '', calls: a.n })
    }
    child.on('close', end); child.on('error', (e) => { say(`${label}: cannot start the agent: ${e.message}`); end(1) })
  })
}

// ---------- merge gate: deterministic, no LLM. Returns {ok, reason}; reason 'pending' means try again later.
function gate(R, pr) {
  const wait = Date.now() + num('MERGE_WAIT_MIN', 10) * 60000; let lastSig = ''
  for (;;) {
    const p = ghJson(['pr', 'view', String(pr), '--repo', R, '--json', 'state,baseRefName,headRefName,mergeable,files,additions,deletions,statusCheckRollup'])
    if (p.state !== 'OPEN') return { ok: false, reason: `PR is ${p.state}` }
    if (p.baseRefName !== BASE || PROTECTED.includes(p.baseRefName)) return { ok: false, reason: `base ${p.baseRefName} is not the auto-merge branch ${BASE}` }
    if (!/^fix\//.test(p.headRefName)) return { ok: false, reason: `head ${p.headRefName} is not a fix/* branch` }
    if (p.mergeable === 'CONFLICTING') return { ok: false, reason: 'merge conflicts' }
    if (p.files.length > num('MERGE_MAX_FILES', 8) || p.additions + p.deletions > num('MERGE_MAX_LINES', 300)) return { ok: false, reason: `too big for auto-merge (${p.files.length} files, ${p.additions + p.deletions} lines)` }
    const block = new RegExp(setting('MERGE_BLOCK_PATHS') || '(^|/)(\\.github/|\\.env|vercel\\.json|package(-lock)?\\.json|migrations?/|supabase/|middleware\\.)', 'i')
    const hit = p.files.find((f) => block.test(f.path)); if (hit) return { ok: false, reason: `touches a protected path: ${hit.path}` }
    // Vercel is ignored: ignored builds and preview errors say nothing about the code. The real gate is CI.
    const ci = p.statusCheckRollup.filter((c) => !/vercel/i.test(c.name || c.context || ''))
    const st = (c) => c.conclusion || c.state || c.status || ''
    const bad = ci.find((c) => /FAIL|ERROR|CANCEL|TIMED_OUT|ACTION_REQUIRED/i.test(st(c))); if (bad) return { ok: false, reason: `check ${bad.name || bad.context} failed` }
    const pending = ci.some((c) => !/SUCCESS|NEUTRAL|SKIPPED/i.test(st(c)))
    if (!ci.length && setting('MERGE_REQUIRE_CI') !== '0') return { ok: false, reason: 'no CI check on the PR (add the CI workflow, or MERGE_REQUIRE_CI=0)' }
    if (!pending && p.mergeable !== 'UNKNOWN') return { ok: true }
    if (Date.now() > wait) return { ok: false, reason: 'pending' }
    const sig = ci.map((c) => `${c.name || c.context}=${st(c) || 'pending'}`).join(' ') || 'no checks yet'
    if (sig !== lastSig) { say(`PR #${pr}: waiting for ${p.mergeable === 'UNKNOWN' ? 'GitHub to compute mergeability' : 'checks'}: ${sig}`); lastSig = sig }
    sleep(30000)
  }
}
const freeWt = (wt) => { // drop a stale worktree directory
  run('git', ['worktree', 'remove', '--force', wt]); rmSync(wt, { recursive: true, force: true })
}
const fillWt = (wt) => {
  for (const f of readdirSync(ROOT).filter((x) => /^\.env/.test(x))) copyFileSync(join(ROOT, f), join(wt, f)) // untracked app env files
  if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(wt, 'node_modules'))
}
// A PR that conflicts with BASE (something else merged first): one agent run merges BASE into the PR branch and pushes it, then the gate decides again.
async function resolveConflicts(R, pr) {
  const head = ghJson(['pr', 'view', String(pr), '--repo', R, '--json', 'headRefName']).headRefName, wt = join(ROOT, '.sdlc', 'wt', `merge-${pr}`)
  run('git', ['fetch', 'origin', BASE, head]); freeWt(wt)
  if (run('git', ['worktree', 'add', '--detach', wt, `origin/${head}`]).status) return say(`PR #${pr}: cannot create a worktree for ${head}`)
  fillWt(wt)
  say(`PR #${pr}: conflicts with ${BASE}, an agent merges ${BASE} into ${head}`)
  await agent(wt, `Branch ${head} (PR #${pr}) conflicts with ${BASE}. You are in a checkout of ${head}. Run git merge origin/${BASE}, resolve every conflict keeping the intent of both sides, run npx tsc --noEmit, commit the merge and git push origin HEAD:${head}. Never force-push, never push any other branch, do not merge the PR. If you cannot resolve it safely, git merge --abort and stop. This is an unattended run: never ask questions.`, `merge-${pr}`, `PR #${pr}`, { lane: `pr${pr}cf`, what: 'conflict agent' })
  run('git', ['worktree', 'remove', '--force', wt])
  sleep(num('CONFLICT_WAIT_SEC', 60) * 1000) // let GitHub recompute mergeable and start CI on the new commit
}
async function merge(R, pr, issue) {
  let g = gate(R, pr)
  if (!g.ok && g.reason === 'merge conflicts') { await resolveConflicts(R, pr); g = gate(R, pr) }
  if (!g.ok) {
    say(`PR #${pr}: not merged: ${g.reason}`)
    if (g.reason !== 'pending' && issue) { tag(R, issue, 'needs-human', 'ready-for-test'); note(R, issue, `Auto-merge of PR #${pr} was refused: ${g.reason}. A person needs to look at it.`) }
    return false
  }
  const r = run('gh', ['pr', 'merge', String(pr), '--repo', R, '--squash'])
  if (r.status) { errors++; say(`PR #${pr}: merge failed: ${r.stderr.trim().slice(0, 160)}`); return false }
  say(`PR #${pr}: merged into ${BASE}`); return true
}

// ---------- stages
function check() {
  const env = setting('QA_ENV_URL') || die(3, 'QA_ENV_URL is not set in .sdlc/autopilot.env')
  const origin = new URL(env).origin, cap = num('MAX_NEW_ISSUES', 15), out = join(ROOT, '.sdlc', 'qa-check', day)
  const seeds = list('QA_URLS').flatMap((u) => ['--seed', new URL(u, origin).href])
  const jobs = [[env, '--depth', '2', '--max-pages', String(num('QA_SCOUT_MAX_PAGES', 25) + seeds.length / 2), ...seeds, ...imp(), ...polish()]] // one run: one set of issues, no same-title drafts
  for (const name of list('QA_PROFILES')) { // roles tested logged in; each one that cannot run says why instead of silently testing the login page
    const pf = profile(name)
    if (!pf?.base) { say(`profile ${name}: QA_PROFILE_${name.toUpperCase()}_AUTH or a URL is missing, skipped`); continue }
    const lg = freshLogin(pf); if (lg && !existsSync(pf.auth)) say(`profile ${name}: could not renew the login: ${lg}`)
    if (!existsSync(pf.auth)) { say(`profile ${name}: no saved login at ${pf.auth}, skipped (create it, see autopilot.env.example)`); continue }
    if (!reachable(pf.base)) { say(`profile ${name}: ${pf.base} is not running, skipped (start the app, for example npm run dev)`); continue }
    const bad = isLocalUrl(pf.base) && syncLocal(); if (bad) { say(`profile ${name}: ${bad}, skipped`); continue }
    const [first, ...rest] = pf.paths
    jobs.push([pf.base + first, '--depth', String(num('QA_PROFILE_DEPTH', 2)), '--max-pages', String(Math.max(pf.paths.length, num('QA_PROFILE_MAX_PAGES', 15))), '--expand-seeds', ...rest.flatMap((x) => ['--seed', pf.base + x]), '--auth', pf.auth, '--profile', name, ...imp(), ...polish()])
  }
  const R = repo(); for (const l of ['ui-qa', 'auto-fix']) run('gh', ['label', 'create', l, '--repo', R, '--color', 'c5def5']) // exists -> non-zero, fine
  let filed = 0; const newIssues = []
  jobs.forEach(([url, ...flags], i) => {
    if (filed >= cap) return
    const dir = join(out, String(i))
    say(`crawling ${url} (up to ${flags[flags.indexOf('--max-pages') + 1]} pages, 8 views each; several minutes). Progress below.`)
    const r = run('node', [join(HERE, 'ui-qa.mjs'), url, '--allow-remote', '--max-issues', String(cap), '--out', dir, ...flags], { stdio: ['ignore', 'pipe', 'inherit'] }) // inherit: show ui-qa's page-by-page progress
    if (r.status > 1 || r.error) { errors++; return say(`ui-qa failed on ${url}: ${r.error?.message || `exit ${r.status}`}`) }
    if (process.argv.includes('--dry-run')) { // show what would be filed, file nothing
      for (const d of JSON.parse(readFileSync(join(dir, 'issues.json'), 'utf8'))) { say(`draft: ${d.title} (${d.findings} problem(s), ${d.shots.length} screenshot(s))`); cards.push(`### DRAFT ${d.title}\n\n${readFileSync(join(dir, d.body), 'utf8').split('\n').map((l) => `> ${l}`).join('\n')}\n`) }
      return
    }
    const f = run('node', [join(HERE, 'ui-qa.mjs'), 'file', dir, '--with-images'], { env: { ...process.env, ISSUE_TRACKER: 'github', ISSUE_GITHUB_REPO: R, ISSUE_LABELS: 'ui-qa,auto-fix' } })
    say('filing issues...')
    const out2 = `${f.stdout}\n${f.stderr}`
    for (const m of out2.matchAll(/^filed: #(\d+)/gm)) { filed++; say(`new issue #${m[1]}`); newIssues.push(m[1]) }
    for (const m of out2.matchAll(/^already filed: #(\d+)/gm)) say(`#${m[1]} already open: new findings (if any) added as a comment`)
    for (const m of out2.matchAll(/^ +#(\d+): nothing new/gm)) say(`#${m[1]}: nothing new`)
  })
  for (const n of newIssues) card(R, n, { full: true })
  say(`check done: ${jobs.length} run(s), ${filed} new issue(s)`)
}

// One issue at a time, oldest first: fix -> merge -> wait for the deploy -> verify -> next. Every fix starts from a dev that already holds the
// previous one, so the PRs do not collide. Each issue runs as a checklist of timed steps (see step()).
const pagesOf = (body) => { const a = [...((body || '').match(/Affected pages?:?\**\s*(.+)/i)?.[1] || '').matchAll(/`(\/[^`\s]*)`/g)].map((m) => m[1]); if (a.length) return a; try { return [...new Set([...(body || '').matchAll(/URL:\s*(https?:\/\/[^\s<>]+)/g)].map((m) => new URL(m[1].replace(/[).,]+$/, '')).pathname))] } catch { return [] } }  // pages from "Affected pages", else from the "URL:" lines of an Impeccable paste
// A feature/enhancement is proven by running the new behaviour, not by a page crawl. Label enhancement/feature, or a "Xong khi"/"Done when" section.
const lblOf = (i) => (i?.labels || []).map((x) => x?.name ?? x)
const isFeature = (labels, body) => labels.some((l) => /^(enhancement|feature)$/i.test(l)) || /^#{1,4}\s*(Xong khi|Done when)\b/im.test(body || '')
const profileOf = (R, n) => { const a = ghJson(['issue', 'view', String(n), '--repo', R, '--json', 'body,labels']), body = a.body || '', m = body.match(/QA profile:\*{0,2}\s*([\w-]+)/), feat = isFeature((a.labels || []).map((x) => x.name), body), name = m ? m[1] : feat ? setting('QA_FEATURE_PROFILE') : '' // no "QA profile:" line: a feature goes to QA_FEATURE_PROFILE (a local test role), a bug to the dev env
  const pf = name ? profile(name) : null; if (name && !pf) say(`#${n} the issue names QA profile "${name}" but it is not defined (QA_PROFILE_${name.toUpperCase().replace(/\W/g, '_')}_AUTH): verifying WITHOUT a login`); return pf }
const verdictOf = (R, n) => { const a = ghJson(['issue', 'view', String(n), '--repo', R, '--json', 'state,labels']), l = a.labels.map((x) => x.name); return { state: a.state, labels: l, done: a.state === 'CLOSED' || l.includes('verified') || l.includes('needs-fix') } }

// The ui-qa runs of the verification are done HERE, not by the agent: one crawl takes minutes and an agent's shell gives up after two.
// A few pages at a time (VERIFY_PARALLEL), at most VERIFY_MAX_PAGES of the issue's pages (the rest is said to be not covered).
async function rerunQa(R, i, env) {
  const pf = profileOf(R, i.number); if (pf) freshLogin(pf)
  const au = pf ? ['--auth', pf.auth] : [], dir = join(ROOT, '.sdlc', 'qa-verify', `issue-${i.number}`), origin = new URL(pf ? pf.base : env).origin
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  const all = pagesOf(ghJson(['issue', 'view', String(i.number), '--repo', R, '--json', 'body']).body), cap = num('VERIFY_MAX_PAGES', 8), pages = (all.length ? all : [new URL(env).pathname]).slice(0, cap)
  const jobs = pages.map((pg) => [`run-${pg.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home'}`, [origin + pg, '--max-pages', '1', '--depth', '0', ...imp(), ...au]])
  // Impact: pages the fix's changed files reach but the issue does not list. A fix can break what it did not mean to touch (a clipped avatar menu), so these are tested too.
  const mp = prFor(R, i.number, 'merged'), ch = mp ? (ghJson(['pr', 'view', String(mp.number), '--repo', R, '--json', 'files'])?.files || []).map((f) => f.path) : []
  const im = ch.length ? impact(ROOT, `origin/${BASE}`, ch) : { routes: [], all: false, files: [] }
  const extra = im.routes.filter((r) => !pages.includes(r)).sort((a, b) => /admin/.test(a) - /admin/.test(b)).slice(0, num('VERIFY_IMPACT_PAGES', 4))
  for (const pg of extra) jobs.push([`impact-${pg.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home'}`, [origin + pg, '--max-pages', '1', '--depth', '0', ...imp(), ...au]])
  cl.impact = { files: im.files, all: im.all, routes: im.routes, tested: extra }
  if (im.files.length) { say(`#${i.number}   impact: PR #${mp.number} changed ${im.files.length} file(s) reaching ${im.routes.length} page(s)${im.all ? ' (global styles changed: every page)' : ''}; also testing ${extra.length}: ${extra.join(' ') || 'none'}`); note(R, i.number, `Impact scope of PR #${mp.number}: changed ${im.files.map((f) => '`' + f + '`').join(', ')}. These files reach ${im.routes.length} page(s)${im.all ? ' and global styles (every page)' : ''}: ${im.routes.slice(0, 12).map((r) => '`' + r + '`').join(', ')}${im.routes.length > 12 ? ', ...' : ''}. QA re-tests: ${[...pages, ...extra].map((r) => '`' + r + '`').join(', ')}.`) }
  if (num('VERIFY_SWEEP', 1)) jobs.push(['sweep', [pf ? origin + pf.paths[0] : new URL(env).href, '--max-pages', String(num('VERIFY_SWEEP_PAGES', 8)), '--depth', String(num('VERIFY_SWEEP_DEPTH', 2)), ...imp(), ...au]])
  if (all.length > cap) say(`#${i.number}   the issue lists ${all.length} pages, re-running the first ${cap} (VERIFY_MAX_PAGES); the rest is not covered`)
  let bad = 0, done = 0, next = 0
  const one = ([name, args]) => new Promise((resolve) => {
    const t = Date.now(), c = spawn('node', [setting('UI_QA_BIN') || join(HERE, 'ui-qa.mjs'), ...args, '--allow-remote', '--out', join(dir, name)], { stdio: 'ignore', detached: true })
    const to = setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL') } catch {} }, num('RERUN_TIMEOUT_MIN', 10) * 60000)
    c.on('close', (code) => { clearTimeout(to); done++; if (code > 1 || code === null) bad++; say(`#${i.number}   ui-qa ${done}/${jobs.length} ${code > 1 || code === null ? 'FAILED' : 'done'}: ${args[0]} (${dur((Date.now() - t) / 1000)})`); resolve() })
    c.on('error', () => { bad++; done++; resolve() })
  })
  say(`#${i.number}   ui-qa: ${jobs.length} runs, ${Math.min(num('VERIFY_PARALLEL', 3), jobs.length)} at a time`)
  await Promise.all(Array.from({ length: Math.min(num('VERIFY_PARALLEL', 3), jobs.length) }, async () => { while (next < jobs.length) await one(jobs[next++]) }))
  // A page that shows the framework's error page ("This page couldn't load") is often a session that expired on the server, not a defect of the fix: renew the login (whatever the file's age) and run those pages once more. If they still show it, the verdict must not count them (cl.sessionErr).
  const errPage = (d) => { try { const f = JSON.parse(readFileSync(join(dir, d, 'findings.json'), 'utf8')); return (Array.isArray(f) ? f : f.findings || []).some((x) => /couldn.t load|application error|something went wrong/i.test(x.detail || '')) } catch { return false } }
  cl.sessionErr = []
  const bad0 = pf ? jobs.filter(([n]) => /^(run|impact)-/.test(n) && errPage(n)) : []
  if (bad0.length) {
    const lg = freshLogin(pf, true); say(`#${i.number}   ${bad0.length} page(s) show an error page; ${lg ? `login renew failed (${lg})` : 'login renewed'}, running them again`)
    if (!lg) for (const j of bad0) await one(j)
    cl.sessionErr = bad0.filter(([n]) => errPage(n)).map(([, a]) => new URL(a[0]).pathname)
    if (cl.sessionErr.length) say(`#${i.number}   still an error page after renewing the login: ${cl.sessionErr.join(' ')}; not judged`)
  }
  // Evidence the eye can read at once: on each issue page, the elements the issue named are boxed red/yellow where the rule still fires, green where it no longer does.
  // Problems come as "### 1. title" (ui-qa) or "#### 1. title" (qareview); selectors as [sel] (ui-qa) or a `Selector:`-less backtick CSS in the bullet (qareview). Widths come from the issue's "640, 768, 820px viewport" line.
  const ibody = ghJson(['issue', 'view', String(i.number), '--repo', R, '--json', 'body']).body || ''
  const probs = ibody.split(/^#{3,4} \d+\. /m).slice(1).map((t) => { const head = t.split('\n')[0]; return { title: head.replace(/\s*\((high|medium|low)\)\s*$/, ''), low: /\(low\)\s*$/.test(head), sels: [...new Set([...t.matchAll(/`([^`\n]*(?:[.#\[>:]|^header|^button)[^`\n]*)`/g)].map((m) => m[1].trim()).filter((x) => /^[a-z*.#\[][^\s]*(\s|$)/i.test(x) && !/\.(tsx?|jsx?|css|mjs)\b|\//.test(x) && !/^\d/.test(x)).concat([...t.matchAll(/\[([^\[\]\n]+)\]/g)].map((m) => m[1]).filter((x) => !/=/.test(x))))] } }).filter((q) => q.sels.length)
  const wl = (ibody.match(/(\d{3,4}(?:\s*,\s*\d{3,4})*)\s*px\s*viewport/i)?.[1] || '').split(/\s*,\s*/).map(Number).filter((w) => w >= 320 && w <= 1920).slice(0, 3)
  // Impeccable paste (hand-filed or qareview): "URL: <page>" then "- **Rule name** at `selector`: ..." with no numbered headings. Per page, one problem per rule name; findings of the rerun are titled "Rule name (id)".
  const impParts = ibody.split(/URL:\s*(https?:\/\/[^\s<>]+)/), impBy = new Map()
  for (let k = 1; k < impParts.length; k += 2) { const u = new URL(impParts[k].replace(/[).,]+$/, '')).pathname, cur = impBy.get(u) || new Map(); for (const m of impParts[k + 1].matchAll(/\*\*([^*\n]+)\*\* at `([^`\n]+)`/g)) cur.set(m[1], [...(cur.get(m[1]) || []), m[2]]); impBy.set(u, cur) }
  const probsOf = (pg) => probs.length ? probs : [...(impBy.get(pg) || [])].map(([title, sels]) => ({ title, low: false, imp: true, sels: [...new Set(sels)] }))
  for (const pg of pages) {
    const probs = probsOf(pg); if (!probs.length) continue
    const slugp = pg.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home'
    const fj = join(dir, `run-${slugp}`, 'findings.json'); let now = []; try { now = JSON.parse(readFileSync(fj, 'utf8')); now = Array.isArray(now) ? now : now.findings || [] } catch { continue }
    // green only when the finding is really gone: match by title when the issue was filed by ui-qa; a renamed (qareview) title falls back to the selector alone, so a mismatch never paints a live defect green
    const items = probs.flatMap((q) => { const same = (f) => f.title === q.title || (q.imp && f.title.startsWith(q.title + ' (')), known = now.some(same); return [...new Set(q.sels)].map((sel) => { const still = now.some((f) => ((!known && !q.imp) || same(f)) && (f.sels || []).includes(sel)); return { sel, color: still ? (q.low ? 'yellow' : 'red') : 'green', label: `${still ? 'STILL WRONG' : 'FIXED'}: ${q.title}` } }) })
    for (const w of wl.length ? wl : [0]) run('node', [setting('UI_QA_BIN') || join(HERE, 'ui-qa.mjs'), origin + pg, '--allow-remote', ...au, '--out', join(dir, 'mark-tmp'), '--mark', JSON.stringify(items), ...(w ? ['--width', String(w)] : []), '--mark-out', join(dir, `marked-${slugp}${w ? `-${w}` : ''}.png`)])
  }
  rmSync(join(dir, 'mark-tmp'), { recursive: true, force: true })
  // States behind interaction (feedback after an answer, a result page): ui-qa cannot reach them, so the project's QA_PLAY_CMD plays the flow, only for an issue that matches QA_PLAY_WHEN. {url} {auth} are filled in; --out <dir>/play[-n] is appended. QA_PLAY_VARIANTS="--scheme light|--scheme dark" runs it once per variant.
  const playCmd = setting('QA_PLAY_CMD'), when = setting('QA_PLAY_WHEN')
  if (playCmd && when && pf && existsSync(pf.auth) && new RegExp(when, 'i').test(ibody + ' ' + pages.join(' '))) {
    const playMarks = JSON.stringify(probs.flatMap((q) => [...new Set(q.sels)].map((sel) => ({ sel, label: q.title, text: ibody.split(q.title)[1]?.split(/^#{3,4} \d+\. /m)[0]?.match(/"([^"\n]{1,40})"/)?.[1] || '' }))))
    const vs = (setting('QA_PLAY_VARIANTS') || '').split('|').map((x) => x.trim()), t = Date.now(); let okN = 0
    for (const [n, v] of (vs.length ? vs : ['']).entries()) {
      const out = join(dir, vs.length > 1 ? `play-${n + 1}` : 'play'), r = run('sh', ['-c', `${playCmd.replaceAll('{url}', pf.base).replaceAll('{auth}', pf.auth).replaceAll('{subject}', /vietnamese|tiếng việt/i.test(ibody + ' ' + pages.join(' ')) ? 'vietnamese' : 'math')} ${v} --out '${out}' --mark '${playMarks.replaceAll("'", "'\\''")}'`], { timeout: num('PLAY_TIMEOUT_MIN', 8) * 60000 })
      if (r.status === 0) okN++; else say(`#${i.number}   play ${v || 'run'} exit ${r.status}: ${((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`)
    }
    cl.play = okN; say(`#${i.number}   play: ${okN}/${vs.length || 1} runs of QA_PLAY_CMD as "${pf.name}" (${dur((Date.now() - t) / 1000)})`)
  }
  // A feature/enhancement: the project's QA_FEATURE_CMD plays the NEW behaviour itself (the agent's shell is too short, and a weak model skips the script). {url} {auth} {out}; it must write PNGs of the feature into {out} (<issue dir>/feature/).
  // QA_FEATURE_WHEN (a regex on the issue body, unset = every feature issue) picks which features it applies to. The agent is told to attach THESE screenshots and nothing from the home page.
  const featCmd = setting('QA_FEATURE_CMD'), featWhen = setting('QA_FEATURE_WHEN')
  if (featCmd && pf && existsSync(pf.auth) && isFeature(lblOf(i), ibody) && (!featWhen || new RegExp(featWhen, 'i').test(ibody))) {
    const out = join(dir, 'feature'), t = Date.now(); mkdirSync(out, { recursive: true })
    const r = run('sh', ['-c', featCmd.replaceAll('{url}', pf.base).replaceAll('{auth}', pf.auth).replaceAll('{out}', `'${out}'`)], { timeout: num('FEATURE_TIMEOUT_MIN', 12) * 60000, env: { ...process.env, QA_OUT: out } })
    cl.feature = r.status === 0
    say(`#${i.number}   feature run (QA_FEATURE_CMD) as "${pf.name}": ${r.status === 0 ? 'ok' : `exit ${r.status}: ${((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`} (${dur((Date.now() - t) / 1000)})`)
  }
  cl.st.rerun.note = `${jobs.length - bad}/${jobs.length} runs${all.length > cap ? `, ${all.length - cap} pages not covered` : ''}`
  return bad < jobs.length ? dir : false
}

// rerun + verdict. A verdict is a `verified` or `needs-fix` label (or a closed issue). No verdict after the first agent: one shorter second try on the same results.
async function verifyIssue(R, i, env) {
  let dir = ''
  if (num('VERIFY_RERUN', 1)) { dir = await step('rerun', async () => rerunQa(R, i, env) || false); if (!dir) { const hard = cl.st.rerun.s === 'fail'; cl.st.verdict = { s: 'skip', note: hard ? 'the ui-qa re-run did not finish (error above); the issue stays ready-for-test, run qaverify again' : 'no ui-qa results to judge' }; if (hard) say(`#${i.number}: the re-run failed, not a verdict on the fix. It stays ready-for-test: run qaverify again.`); return false } } else cl.st.rerun = { s: 'skip', note: 'VERIFY_RERUN=0' }
  const url = issueUrl(R, i.number), rel = dir.replace(ROOT + '/', '')
  const pf = profileOf(R, i.number), local = pf && isLocalUrl(pf.base)
  const feat = isFeature(lblOf(i), ghJson(['issue', 'view', String(i.number), '--repo', R, '--json', 'body']).body || '')
  const base = `Use the pct102-qa-verify skill on ${url} --env ${pf ? pf.base : env}${local ? '' : ' --close'}. This is an unattended run: never ask questions; if the fix is not live or you cannot decide, comment why and leave the issue open.${pf ? ` The ui-qa runs were logged in as the "${pf.name}" test role.` : ''}${local ? ' This environment is the project\'s own local server, not a Vercel deploy: the script already proved the merged commit is in it, so skip the deploy check; do NOT close the issue (the script closes it after a verified label).' : ''}`
  const perfNote = (i.labels || []).includes('performance') ? ` This issue is about speed: do not judge it by findings alone. Run the measurement from its Acceptance criteria yourself (ui-qa --perf, same command, same login) and compare the median with the criteria: PASS only when the number is met; the comment shows the baseline, the new numbers and the target.` : ''
  const pre = dir ? ` The ui-qa runs are already done by the script, in ${rel}/ (run-*/ for the issue's pages, sweep/ for the sweep; each has report.md, findings.json, screens/). marked-*.png in the same folder (the -<width> suffix is the viewport width where the issue shows) are screenshots with the issue's elements boxed (red/yellow = rule still fires there, green = fixed): attach those first as evidence (--image) and say which boxes are green and which are not. If there is no marked-*.png, attach screenshots from run-*/screens at the issue's viewport; NEVER draw boxes or labels yourself, and never use a red box on a fixed state. Read the results and do NOT run ui-qa yourself (a crawl takes longer than your shell allows). Never create or edit a file under AI_SKILLS_HOME.${cl.impact?.tested?.length ? ` IMPACT CHECK: the fix PR also changed ${cl.impact.files.join(', ')}, which reach other pages. impact-*/ holds ui-qa runs of ${cl.impact.tested.join(', ')}. Any finding there that is new and plausibly caused by the PR (for example a menu or popup cut off, a control blocked, layout broken) is a REGRESSION: the verdict is needs-fix even if the issue's own problems are gone, and the comment names it.` : ''}` : ''
  const sessNote = cl.sessionErr?.length ? ` ERROR PAGES: ${cl.sessionErr.join(', ')} still showed the framework error page ("This page couldn't load") after the script renewed the login and re-ran them. That is the environment (expired session or a server error), not evidence about the fix: do NOT count findings from those pages as a failure and do not choose needs-fix because of them; list them as not covered with that reason and decide the verdict from the other pages.` : ''
  const hasPlay = existsSync(join(dir || ROOT, 'play')) || existsSync(join(dir || ROOT, 'play-1'))
  const playNoteBug = existsSync(join(dir || ROOT, 'play')) || existsSync(join(dir || ROOT, 'play-1')) ? ` The script also played the flow as the "${pf?.name}" test role (QA_PLAY_CMD): ${rel}/play*/ holds report.json (answers, result page, audit findings, cleanup) and PNGs of each answered question (the wrong answer shows the red feedback bar) and result.png. marked-*.png there box the issue's elements green (FIXED, nothing fires on them) or red (STILL WRONG): attach those first. These ARE the evidence for the states behind interaction, and they outrank anything written in earlier comments on the issue (a list of findings from an earlier verify run is history, not the current state; never copy it into your verdict): read report.json, judge the feedback bar and result page from the PNGs, and attach them (--image), play-2 is dark mode when present. When every play audit is empty and the result page was reached, the interaction problems of the issue are FIXED: verified, and close it. A play run with \"STUCK\" or ERROR is not a pass for those states: say not covered.` : ''
  const featNote = ' If this issue is a feature or enhancement (it has "Done when"/acceptance criteria, or the label enhancement/feature), follow step 3b of the skill: ui-qa runs only prove nothing broke. Build the checklist from the body, every comment and the description edits, and prove each line yourself on the env with a Playwright script as the test role. A clean sweep is never PASS for a feature; a line you could not exercise means NOT VERIFIED (no label, issue stays open, say what is missing), a line that deviates from the issue means needs-fix. This outranks the "compare Problems with the results" shortcut.'
  const playNote = feat ? (hasPlay ? ` The script also ran a generic regression play as the "${pf?.name}" test role (${rel}/play*/): it proves the app still works, NOT the feature.` : '') : playNoteBug
  // For a feature the evidence is the feature itself. A weak model given a crawl and a result page attached the home page and called it done; and needs-fix on a naming detail started the fix agent on a wrong PR.
  const featEvidence = feat ? ` FEATURE ISSUE (this outranks every evidence and verdict rule above): ${rel}/feature/ ${cl.feature ? 'holds the script\'s own run of the NEW behaviour (QA_FEATURE_CMD): PNGs of the feature and its log. Attach those screenshots as the evidence (--image), feature screenshots first, and say which checklist line each one proves.' : 'has no run of the feature (the project has no feature script for this issue, or it failed): write and run the Playwright script yourself (skill step 3b) into ' + rel + '/feature/ and screenshot the new behaviour.'} NEVER attach the home page, landing page, sweep, result page or any screenshot the feature does not touch as evidence for a feature; with no screenshot of the feature itself the verdict is NOT VERIFIED (no label; say what is missing). needs-fix starts an automatic fix agent, so it is ONLY for broken behaviour: a checklist line you ran and that fails (wrong or missing behaviour). If the behaviour works but an implementation detail differs from the issue text (where files live, a name, an internal structure), that is NOT a failure: set the label needs-human (not needs-fix, not verified) and say in the comment what differs and that the owner decides.` : ''
  const retry = `Your earlier attempt on ${url} ended without a verdict. The ui-qa results are in ${rel}/. Do only this, quickly: compare the issue's Problems with those results, comment the verdict with screenshots from them, set the label verified or needs-fix, and close the issue only if verified and the fix is live (--close rules of the pct102-qa-verify skill). Do not run ui-qa. Never create or edit a file under AI_SKILLS_HOME. Unattended: never ask questions.`
  return step('verdict', async () => {
    for (const [k, prompt] of [[1, base + pre + playNote + sessNote + perfNote + featNote + featEvidence], [2, retry + playNote + sessNote + perfNote + featNote + featEvidence]]) {
      const before = verdictOf(R, i.number)
      const r = await agent(ROOT, prompt, `qa-${i.number}`, `#${i.number}`, { lane: `i${i.number}vd${k}`, min: num('VERIFY_TIMEOUT_MIN', 15), what: k === 1 ? 'verify agent' : 'verify agent (second try)' })
      const v = verdictOf(R, i.number), humanNow = v.labels.includes('needs-human') && !before.labels.includes('needs-human') // a feature whose behaviour works but differs in a detail: the agent hands it to the owner, which is a verdict (no fix agent)
      if (humanNow) v.done = true
      cl.st.verdict.note = `model ${r.model || '?'}${v.done ? ', ' + (v.state === 'CLOSED' ? 'closed' : v.labels.includes('verified') ? 'verified' : humanNow && !v.labels.includes('needs-fix') ? 'needs-human' : 'needs-fix') : ''}`
      if (local && v.labels.includes('verified') && v.state !== 'CLOSED') run('gh', ['issue', 'close', String(i.number), '--repo', R, '--reason', 'completed'])
      if (v.done) { card(R, i.number); return true }
    }
    tag(R, i.number, 'needs-human'); note(R, i.number, `Automatic verification did not reach a verdict. The ui-qa results are in ${rel}/ on the machine that ran the loop. A person needs to look at it.`)
    return false
  })
}

// Wait until the commit that holds the merged PR is deployed. Returns the deploy state ('success' or the last non-success state).
async function deployed(R, prNumber) {
  const sha = ghJson(['pr', 'view', String(prNumber), '--repo', R, '--json', 'mergeCommit'])?.mergeCommit?.oid || BASE, end = Date.now() + num('DEPLOY_WAIT_MIN', 15) * 60000; let last = ''
  for (;;) {
    const st = ghOut(['api', `repos/${R}/commits/${sha}/status`, '--jq', '.state']).trim()
    if (st !== last) { say(`#${cl.n}   ${BASE} deploy: ${st || 'unknown'}`); last = st }
    if (st === 'success' || /failure|error/.test(st) || Date.now() > end) return st
    await new Promise((r) => setTimeout(r, 30000))
  }
}

// Stop what an agent left running inside its worktree (a `next dev` server keeps burning CPU for hours), then free the CPU/RAM it held.
function killIn(dir) {
  const out = run('lsof', ['-a', '-d', 'cwd', '-Fpn']).stdout || '', pids = []; let pid
  for (const l of out.split('\n')) { if (l[0] === 'p') pid = +l.slice(1); else if (l[0] === 'n' && l.slice(1).startsWith(dir) && pid !== process.pid) pids.push(pid) }
  for (const p of pids) try { process.kill(p, 'SIGTERM') } catch {}
  if (pids.length) say(`stopped ${pids.length} leftover process(es) from ${dir}`)
}

// One auto-fix issue end to end. Returns 'stop' when the loop must not go on (the dev deploy broke), else nothing.
async function fixOne(R, i, maxTry, env) {
  begin(i.number, env ? ['reuse', 'fix', 'gate', 'deploy', 'rerun', 'verdict'] : ['reuse', 'fix', 'gate'])
  say(`#${i.number} ${i.title}`)
  run('git', ['fetch', 'origin', BASE])
  let pr = null, merged = false, already = false, handed = '', outcome = ''
  const finish = () => { const rows = summary(); card(R, i.number, { note: outcome }); cards[cards.length - 1] += `\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n` }
  // Work already on GitHub (an earlier run timed out after pushing, or a person fixed the CI): reuse it, don't pay an agent to redo it.
  await step('reuse', async () => {
    pr = i.labels.includes('needs-fix') ? null : prFor(R, i.number, 'open') // needs-fix = QA rejected the work already on GitHub: a new agent must read the verdict, never re-merge the old branch
    if (!pr && !i.labels.includes('needs-fix')) {
      const br = run('git', ['ls-remote', '--heads', 'origin', `fix/issue-${i.number}-*`]).stdout.trim().split('\n')[0]?.split('refs/heads/')[1]
      // A branch whose PR is already merged and that has no newer commit holds nothing new: a PR from it would merge the old fix again.
      const stale = br && (ghJson(['pr', 'list', '--repo', R, '--head', br, '--state', 'merged', '--json', 'mergedAt']) || []).some((m) => m.mergedAt >= run('git', ['log', '-1', '--format=%cI', `origin/${br}`]).stdout.trim())
      if (br && !stale && !run('gh', ['pr', 'create', '--repo', R, '--base', BASE, '--head', br, '--title', `fix(#${i.number}): ${i.title.replace(/^\[ui-qa\]\s*/, '')}`, '--body', `Fix for #${i.number} (branch pushed by an earlier dev-fix run; PR opened by sdlc-daily).`]).status) pr = prFor(R, i.number, 'open')
    }
    cl.st.reuse.note = pr ? `PR #${pr.number}` : 'none, a new fix is needed'
    return true
  })
  if (pr) { tag(R, i.number, 'ready-for-test', 'needs-fix'); await step('fix', async () => skip('PR already there')) }
  else {
    const tries = Math.max(0, ...i.labels.map((l) => +(l.match(/^fix-attempt-(\d+)$/) || [])[1] || 0))
    if (tries >= maxTry) {
      tag(R, i.number, 'needs-human', 'needs-fix'); note(R, i.number, `Gave up after ${tries} automatic fix attempt(s). A person needs to look at it.`)
      say(`#${i.number}: ${tries} attempts, handed to a person`); outcome = `gave up after ${tries} attempts`
      for (const k of cl.keys.slice(1)) cl.st[k] = { s: 'skip', note: 'out of attempts' }
      return finish()
    }
    run('gh', ['label', 'create', `fix-attempt-${tries + 1}`, '--repo', R, '--color', 'ededed']); tag(R, i.number, `fix-attempt-${tries + 1}`)
    const wt = join(ROOT, '.sdlc', 'wt', `issue-${i.number}`); freeWt(wt)
    const ready = await step('fix', async () => {
      if (run('git', ['worktree', 'add', '--detach', wt, `origin/${BASE}`]).status) { say(`#${i.number}: cannot create a worktree from origin/${BASE}`); return false }
      fillWt(wt)
      const r = await agent(wt, `Use the pct102-dev-fix skill on ${issueUrl(R, i.number)}. This is an unattended run: never ask questions. If you are blocked, comment why on the issue and add the needs-human label. Push the fix branch and open the PR into ${BASE} as the skill says. Do not merge.${(() => { const pf = profileOf(R, i.number); return pf ? ` The problem was found logged in as the test role "${pf.name}" on ${pf.base}: run ui-qa for its pages with --auth ${pf.auth} (never print or copy that file). Start the app from your worktree on a free port; the saved login works on any localhost port. The issue was found on a local server that may have run older code than ${BASE}: first re-check with ui-qa on your worktree (it is ${BASE}); if every listed problem is already gone, comment \"already fixed on ${BASE}\" with the evidence, add ready-for-test, open no PR, and stop. Do not spend more than 20 minutes: if you cannot find the cause by then, comment what you tried and add needs-human.` : '' })()}${i.labels.some((l) => ['performance', 'enhancement'].includes(l)) ? ` This is an improvement, not a bug: the issue has Baseline, Acceptance criteria and a Plan from the QA review. Follow the plan. Before changing code run the issue's measurement (for speed: ui-qa --perf as the Acceptance criteria say, with the login rules above) and again after; put both sets of numbers in your comment. Add ready-for-test only if the acceptance criteria are met; if they cannot be met by code in this repo (for example hosting or database region), comment what you measured and why, and add needs-human.` : ''}${i.labels.includes('needs-fix') ? ` An earlier fix for this issue was merged and QA rejected it: read the latest 'Verdict: FAIL' comment and every comment after it, fix exactly what they say (the old change stays in dev; add to it), and push a NEW branch named fix/issue-${i.number}-v${tries + 1}-<slug>, never the old branch.` : ''}`, `dev-${i.number}`, `#${i.number}`, { lane: `i${i.number}fx${tries + 1}`, what: `fix agent (attempt ${tries + 1}/${maxTry})` })
      killIn(wt); run('git', ['worktree', 'remove', '--force', wt])
      const now = issues(R, 'auto-fix').find((x) => x.number === i.number); pr = prFor(R, i.number, 'open')
      const L = now?.labels || []; already = L.includes('ready-for-test') && !pr // the agent found nothing left to fix on BASE: no PR, the next step is to verify, not to merge
      if (L.includes('needs-human')) { const c = ghJson(['issue', 'view', String(i.number), '--repo', R, '--json', 'comments'])?.comments?.at(-1)?.body || ''; handed = c.replace(/[#*`]/g, '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 300) || 'no reason given' }
      cl.st.fix.note = `model ${r.model || '?'}, ${pr && L.includes('ready-for-test') ? 'PR #' + pr.number : already ? 'already fixed on ' + BASE + ', no code change' : handed ? 'blocked: ' + handed : 'no result (timeout or no label), stays queued'}`
      return L.includes('ready-for-test') && (!!pr || already)
    })
    if (!ready) { outcome = handed ? `NEEDS A DECISION: ${handed}` : 'not fixed in this run (agent gave no result), stays queued'; if (handed) say(`#${i.number}: the agent is blocked and needs a person or a design decision: ${handed}`); for (const k of cl.keys.slice(2)) cl.st[k] = { s: 'skip', note: 'no fix' }; return finish() }
  }
  if (already) { merged = true; cl.st.gate = { s: 'skip', note: `already fixed on ${BASE}, no PR to merge` } }
  else await step('gate', async () => { merged = await merge(R, pr.number, i.number); cl.st.gate.note = merged ? `PR #${pr.number} merged into ${BASE}` : 'not merged, see the log'; return merged })
  outcome = already ? `already fixed on ${BASE}, sent to verify` : `PR #${pr.number} ${merged ? 'merged into ' + BASE : 'NOT merged (see the log above)'}`
  if (!merged || !env) { for (const k of cl.keys.slice(3)) cl.st[k] = { s: 'skip', note: merged ? 'no verify (--no-verify)' : 'not merged' }; return finish() }
  const pf = profileOf(R, i.number), loc = pf && isLocalUrl(pf.base) // a local-role issue is verified on the local server: pull the merged BASE into this checkout instead of waiting for a deploy
  if (loc) {
    const ok = await step('deploy', async () => { const b = syncLocal() || (!reachable(pf.base) ? `${pf.base} is not running` : ''); cl.st.deploy.note = b || `local checkout updated to ${BASE}`; return !b })
    if (!ok) { outcome += '; not verified here (local checkout or server not ready), qaverify will do it'; for (const k of ['rerun', 'verdict']) cl.st[k] = { s: 'skip', note: 'local not ready' }; return finish() }
  } else {
  const st = await step('deploy', async () => { const d = await deployed(R, pr?.number); cl.st.deploy.note = d; return d === 'success' })
  if (!st) { errors++; say(`#${i.number}: ${BASE} deploy did not succeed; stopping so no further fix is stacked on it. Fix the deploy, then run fix/verify again.`); outcome += `; stopped: ${BASE} deploy not successful`; for (const k of ['rerun', 'verdict']) cl.st[k] = { s: 'skip', note: 'deploy failed' }; finish(); return 'stop' }
  }
  sleep(num('DEPLOY_SETTLE_SEC', 20) * 1000) // the alias / the local dev server needs a moment to move to the new code
  await verifyIssue(R, i, env)
  finish()
}

// Smallest blast radius first (priority:low, then medium, then high; no label counts as medium), oldest first inside a level. DEVFIX_ORDER=oldest ignores priority.
const rank = (i) => (setting('DEVFIX_ORDER') === 'oldest' ? 0 : i.labels.includes('priority:low') ? 0 : i.labels.includes('priority:high') ? 2 : 1)

async function fix() {
  agentCmd()
  const R = repo(), skipL = ['ready-for-test', 'needs-human', 'verified'], maxTry = num('MAX_FIX_ATTEMPTS', 2), env = process.argv.includes('--no-verify') ? '' : setting('QA_ENV_URL')
  const todo = ONLY ? onlyIssue(R) : issues(R, 'auto-fix').filter((i) => !i.labels.some((l) => skipL.includes(l))).sort((a, b) => rank(a) - rank(b) || a.number - b.number).slice(0, num('MAX_DEV_ISSUES', 5))
  if (!todo.length) return say('no open auto-fix issues waiting for a fix')
  const keys = env ? ['reuse', 'fix', 'gate', 'deploy', 'rerun', 'verdict'] : ['reuse', 'fix', 'gate'], per = keys.reduce((a, k) => a + est(k), 0)
  say(`queue: ${todo.map((i) => '#' + i.number).join(' → ')} · ${setting('DEVFIX_ORDER') === 'oldest' ? 'oldest first' : 'lowest priority first (smallest impact), then oldest'}, one at a time${env ? ', each verified before the next' : ' (no verify: --no-verify, or QA_ENV_URL is not set)'} · about ${dur(per * todo.length)} if every issue needs a fix`)
  // ponytail: one issue at a time. dev-fix starts the app for before/after evidence, so parallel fixers would fight over ports; add worktree-per-agent parallelism if the queue grows.
  for (const [k, i] of todo.entries()) {
    say(`── issue ${k + 1}/${todo.length} ── ${todo.length - k} left, about ${dur(per * (todo.length - k))}`)
    if (await fixOne(R, i, maxTry, env) === 'stop') break
  }
}

// Boxed evidence for a hand-filed issue, made by the script and not left to the agent: every `selector` an Impeccable paste names ("**Low contrast text** at `td > span`") is boxed red on its page
// (page-level findings have no element to box). The login is the profile of that origin whose pages cover the path (devadmin for /vi/admin). Returns the folder, or '' when nothing was boxed.
function markReport(R, i) {
  const body = ghJson(['issue', 'view', String(i.number), '--repo', R, '--json', 'body']).body || '', byUrl = new Map(), parts = body.split(/URL:\s*(https?:\/\/[^\s<>]+)/)
  for (let k = 1; k < parts.length; k += 2) { const u = parts[k].replace(/[).,]+$/, ''), cur = byUrl.get(u) || new Map(); for (const m of parts[k + 1].matchAll(/\*\*([^*\n]+)\*\* at `([^`\n]+)`/g)) cur.set(m[2], m[1]); byUrl.set(u, cur) }
  const dir = join(ROOT, '.sdlc', 'qa-review', `issue-${i.number}`); let made = 0
  for (const [u, sels] of byUrl) {
    if (!sels.size) continue
    const url = new URL(u), pfs = list('QA_PROFILES').map(profile).filter((p) => p?.base && new URL(p.base).origin === url.origin && existsSync(p.auth))
    const pf = pfs.find((p) => p.paths.some((x) => url.pathname === x || url.pathname.startsWith(x + '/'))) || pfs[0]
    const png = join(dir, `marked-${(url.pathname.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home')}.png`); mkdirSync(dir, { recursive: true })
    const items = [...sels].map(([sel, label]) => ({ sel, color: 'red', label }))
    const r = run('node', [setting('UI_QA_BIN') || join(HERE, 'ui-qa.mjs'), u, '--allow-remote', ...(pf ? ['--auth', pf.auth, '--profile', pf.name] : []), '--out', join(dir, 'mark-tmp'), '--mark', JSON.stringify(items), '--mark-out', png], { timeout: 120000 })
    if (existsSync(png)) made++; else say(`#${i.number}   no box drawn on ${u}: ${((r.stdout || '') + (r.stderr || '')).trim().split('\n').pop().slice(0, 160)}`)
  }
  rmSync(join(dir, 'mark-tmp'), { recursive: true, force: true })
  if (made) say(`#${i.number}   boxed the listed elements on ${made} page(s) in ${dir.replace(ROOT + '/', '')}/`)
  return made ? dir : ''
}
// Issues a person filed by hand (no ui-qa label): reproduce, complete (steps, expected, pages), retitle, label qa-reviewed + auto-fix so fix picks them up.
async function review() {
  agentCmd()
  // Only issues with NO label at all are reviewed: anything labeled (enhancement, feature, ui-qa, qa-reviewed, needs-*, ...) is somebody's own to define. Naming an issue (review 123) overrides that.
  const R = repo(), cap = num('MAX_REVIEW_ISSUES', 5)
  const todo = ONLY ? onlyIssue(R) : ghJson(['issue', 'list', '--repo', R, '--state', 'open', '--json', 'number,title,labels', '--limit', '100']).filter((i) => !i.labels.length).map((i) => ({ ...i, labels: [] })).sort((a, b) => a.number - b.number).slice(0, cap)
  if (!todo.length) return say('no hand-filed issues waiting for a QA review')
  for (const name of list('QA_PROFILES')) { const pf = profile(name); if (pf?.base && !isLocalUrl(pf.base)) { const lg = freshLogin(pf); if (lg) say(`profile ${name}: could not renew the login: ${lg}`) } }
  say(`review queue: ${todo.map((i) => '#' + i.number).join(' → ')} · about ${dur(est('review') * todo.length)}`)
  for (const i of todo) {
    begin(i.number, ['review']); say(`#${i.number} ${i.title}`)
    const mk = markReport(R, i)
    await step('review', async () => {
      const r = await agent(ROOT, `Use the pct102-qa-review skill on ${issueUrl(R, i.number)}. This is an unattended run: never ask questions.${mk ? ` The script already boxed the elements the issue names, in red, on each page: ${mk.replace(ROOT + '/', '')}/marked-*.png. Attach those first (--image), up to 4 per comment (several comments if there are more pages), and say for each page which listed elements it shows; do not redo the boxing.` : ''} If you cannot decide or test it, comment why and add the needs-info label (or needs-human for a decision).`, `review-${i.number}`, `#${i.number}`, { lane: `i${i.number}rv`, min: num('REVIEW_TIMEOUT_MIN', 20), what: 'review agent' })
      const L = (issues(R, 'qa-reviewed').concat(issues(R, 'needs-info'), issues(R, 'needs-human')).find((x) => x.number === i.number) || {}).labels || []
      cl.st.review.note = `model ${r.model || '?'}, ${L.includes('qa-reviewed') ? 'reproduced and completed, handed to devfix' : L.includes('needs-info') ? 'needs more info (see its comment)' : L.includes('needs-human') ? 'needs a decision (see its comment)' : 'no result'}`
      if (!L.length) { tag(R, i.number, 'needs-human'); note(R, i.number, 'The automatic QA review did not reach a result. A person needs to look at it.'); return false }
      return true
    })
    const rows = summary(); card(R, i.number); cards[cards.length - 1] += `\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n`
  }
}

async function verify() {
  agentCmd()
  const env = setting('QA_ENV_URL') || die(3, 'QA_ENV_URL is not set in .sdlc/autopilot.env')
  const R = repo(), todo = ONLY ? onlyIssue(R) : issues(R, 'ready-for-test').sort((a, b) => a.number - b.number)
  if (!todo.length) return say('no ready-for-test issues')
  const deploy = ghOut(['api', `repos/${R}/commits/${BASE}/status`, '--jq', '.state']).trim()
  say(`verify queue: ${todo.map((i) => '#' + i.number).join(' → ')} · about ${dur((est('rerun') + est('verdict')) * todo.length)}`)
  for (const i of todo) {
    // cheap pre-checks before any tokens are spent; qa-verify repeats them on its own
    const mp = prFor(R, i.number, 'merged') // no PR at all (not even an open one) = the fix agent found it already fixed on BASE: verify against BASE as it is
    if (!mp && prFor(R, i.number, 'open')) { say(`#${i.number}: fix PR not merged into ${BASE} yet, skipped`); card(R, i.number, { note: 'skipped: fix not merged yet' }); continue }
    const pf = profileOf(R, i.number)
    if (pf && isLocalUrl(pf.base)) { // a local server: the merged commit must be in this checkout (git pull; the dev server reloads) and the server must answer
      const bad = syncLocal(); if (bad) { say(`#${i.number}: ${bad}, skipped`); card(R, i.number, { note: `skipped: ${bad}` }); continue }
      const sha = mp && ghJson(['pr', 'view', String(mp.number), '--repo', R, '--json', 'mergeCommit'])?.mergeCommit?.oid; run('git', ['fetch', 'origin', BASE])
      const why = mp && (!sha || run('git', ['merge-base', '--is-ancestor', sha, 'HEAD']).status) ? `this checkout does not have the fix yet: git pull origin ${BASE}` : !reachable(pf.base) ? `${pf.base} is not running` : ''
      if (why) { say(`#${i.number}: ${why}, skipped`); card(R, i.number, { note: `skipped: ${why}` }); continue }
    } else if (deploy !== 'success') { say(`#${i.number}: ${BASE} deploy is "${deploy}", skipped`); card(R, i.number, { note: 'skipped: dev not deployed yet' }); continue }
    begin(i.number, ['rerun', 'verdict']); say(`#${i.number} ${i.title}`)
    await verifyIssue(R, i, env)
    const rows = summary(); card(R, i.number); cards[cards.length - 1] += `\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n`
  }
}

if (!['check', 'fix', 'verify', 'review', 'merge'].includes(cmd)) die(3, 'usage: sdlc-daily.mjs check | review [issue] | fix [issue] | verify [issue] | merge <pr>')
if (cmd === 'merge') { if (!/^\d+$/.test(arg || '')) die(3, 'merge <pr number>'); process.exit((await merge(repo(), +arg, 0)) ? 0 : 1) }

// one run of the loop per project at a time (a long stage must not overlap the next trigger)
const lock = join(dailyDir, 'lock'), alive = (p) => { try { process.kill(p, 0); return true } catch { return false } }
if (existsSync(lock) && alive(+readFileSync(lock, 'utf8'))) die(0, `another stage is running (pid ${readFileSync(lock, 'utf8')}), skipped`)
writeFileSync(lock, String(process.pid))
try { await ({ check, fix, verify, review })[cmd]() } catch (e) { errors++; say(`stopped: ${e.message}`) } finally { rmSync(lock, { force: true }) }
const report = join(dailyDir, `${cmd}-${day}-${new Date().toTimeString().slice(0, 5).replace(':', '')}.md`)
writeFileSync(report, [`# ${basename(ROOT)} · ${cmd} · ${day}`, '', errors ? `**${errors} error(s) in this run.**` : 'No errors in this run.', '', '## Log', ...lines, '', '## Issues', ...(cards.length ? cards : ['(none)']), ''].join('\n'))
console.log(`report: ${report}`)
if (process.platform === 'darwin' && setting('DAILY_NOTIFY') !== '0') run('osascript', ['-e', `display notification "${cmd}: ${errors ? errors + ' error(s), see .sdlc/daily' : 'done'}" with title "${basename(ROOT)} daily"`])
process.exit(errors ? 1 : 0)
