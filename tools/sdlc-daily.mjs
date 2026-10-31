#!/usr/bin/env node
// The QA loop for one project, run by hand like autopilot: each stage works through its queue, then stops and writes a report.
// Run from the project root (the project's .sdlc/autopilot.env is read).
//   sdlc-daily.mjs check [--dry-run]   ui-qa over QA_ENV_URL (+ QA_URLS): files NEW issues (labels ui-qa, auto-fix), with screenshots
//   sdlc-daily.mjs fix [--no-verify]  open auto-fix issues, oldest first, ONE AT A TIME: pct102-dev-fix (PR into PR_BASE) -> merge gate (an agent
//                                 resolves conflicts with PR_BASE) -> wait for the dev deploy -> pct102-qa-verify -> next issue
//   sdlc-daily.mjs verify         each ready-for-test issue whose fix is merged and deployed: an agent runs pct102-qa-verify --close
//   sdlc-daily.mjs merge <pr>     the merge gate alone
// Stages follow issue labels, so they can be rerun safely. Only scripts run here; tokens are spent inside the agent (AGENT_CMD) that
// fix and verify launch once per issue. Each run writes .sdlc/daily/<stage>-<date>-<time>.md: what was filed, fixed or verified, with
// links and the image count of every issue. Settings: see autopilot.env.example.
// Exit: 0 done | 1 a stage had errors | 3 usage or missing setting
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setting } from './lib/setting.mjs'

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = process.cwd(), SELF = join(HERE, 'sdlc-daily.mjs')
const [cmd, arg] = process.argv.slice(2)
const die = (code, msg) => { console.error(`sdlc-daily: ${msg}`); process.exit(code) }
const run = (c, a, o = {}) => spawnSync(c, a, { encoding: 'utf8', cwd: ROOT, ...o })
const num = (k, d) => (setting(k) === '' ? d : +setting(k)) // 0 is a real value
const list = (k, d = '') => (setting(k) || d).split(/[\s,]+/).filter(Boolean)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const day = new Date().toLocaleDateString('sv') // yyyy-mm-dd, local
const dailyDir = join(ROOT, '.sdlc', 'daily'); mkdirSync(dailyDir, { recursive: true })
for (const d of ['daily', 'qa-check', 'qa-verify', 'wt']) { // generated output: keep it out of the project's git status
  mkdirSync(join(ROOT, '.sdlc', d), { recursive: true }); writeFileSync(join(ROOT, '.sdlc', d, '.gitignore'), '*\n')
}
const lines = [], cards = []
const stamp = () => new Date().toTimeString().slice(0, 8)
const say = (s) => { console.log(`[${stamp()}] ${s}`); lines.push(`- ${stamp()} ${s}`) }
let errors = 0

// ---------- progress: a checklist per issue, timed steps, ETA from earlier runs (timing.json), a heartbeat while an agent works
const timingFile = join(dailyDir, 'timing.json')
let timing = {}; try { timing = JSON.parse(readFileSync(timingFile, 'utf8')) } catch {}
const DEFAULT_SEC = { reuse: 5, fix: 900, gate: 180, deploy: 240, rerun: 480, verdict: 300 }
const est = (k) => (timing[k]?.length ? timing[k].reduce((a, b) => a + b, 0) / timing[k].length : DEFAULT_SEC[k])
const dur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`)
const STEP_NAME = { reuse: 'Look for an existing PR or branch', fix: 'Fix (agent)', gate: 'Merge gate: CI, conflicts, merge', deploy: 'Wait for the dev deploy', rerun: 'Re-run ui-qa on the affected pages and a sweep', verdict: 'Verdict (agent): compare, comment, label' }
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

const ghOut = (a) => { const r = run('gh', a); if (r.status !== 0) throw new Error(`gh ${a.slice(0, 3).join(' ')}: ${(r.stderr || '').trim().slice(0, 200)}`); return r.stdout }
const ghJson = (a) => JSON.parse(ghOut(a) || 'null')
const repo = () => setting('ISSUE_GITHUB_REPO') || ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner
const BASE = setting('PR_BASE') || 'dev'
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
// A lane keeps the agent's session, so a lane reused by a later run makes the agent answer "already done" from its old context: every run gets its own.
const RUN = Date.now().toString(36)
function agent(cwd, prompt, logName, label, { lane = '', min = num('AGENT_TIMEOUT_MIN', 30), what = 'agent' } = {}) {
  const cmdline = agentCmd(), chain = (setting('BUILDER_MODEL') || '').replace(/\s+/g, '').split(',').filter(Boolean)
  mkdirSync(join(dailyDir, 'logs'), { recursive: true })
  const logFile = join(dailyDir, 'logs', `${day}-${logName}.log`), log = openSync(logFile, 'a'), t0 = Date.now()
  say(`${label}   ${what} started · max ${min}m · models: ${chain.length ? chain.join(' → ') + ' (next one when a model hits its limit)' : "opencode's own default"}`)
  return new Promise((resolve) => {
    lane = lane && `${lane}-${RUN}`
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
  const jobs = [[env, '--depth', '2', '--max-pages', String(num('QA_SCOUT_MAX_PAGES', 25) + seeds.length / 2), ...seeds]] // one run: one set of issues, no same-title drafts
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
const pagesOf = (body) => [...((body || '').match(/Affected pages?:?\**\s*(.+)/i)?.[1] || '').matchAll(/`(\/[^`\s]*)`/g)].map((m) => m[1])
const verdictOf = (R, n) => { const a = ghJson(['issue', 'view', String(n), '--repo', R, '--json', 'state,labels']), l = a.labels.map((x) => x.name); return { state: a.state, labels: l, done: a.state === 'CLOSED' || l.includes('verified') || l.includes('needs-fix') } }

// The ui-qa runs of the verification are done HERE, not by the agent: one crawl takes minutes and an agent's shell gives up after two.
// A few pages at a time (VERIFY_PARALLEL), at most VERIFY_MAX_PAGES of the issue's pages (the rest is said to be not covered).
async function rerunQa(R, i, env) {
  const dir = join(ROOT, '.sdlc', 'qa-verify', `issue-${i.number}`), origin = new URL(env).origin
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  const all = pagesOf(ghJson(['issue', 'view', String(i.number), '--repo', R, '--json', 'body']).body), cap = num('VERIFY_MAX_PAGES', 8), pages = (all.length ? all : [new URL(env).pathname]).slice(0, cap)
  const jobs = pages.map((pg) => [`run-${pg.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home'}`, [origin + pg, '--max-pages', '1', '--depth', '0']])
  if (num('VERIFY_SWEEP', 1)) jobs.push(['sweep', [new URL(env).href, '--max-pages', '5', '--depth', '1']])
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
  cl.st.rerun.note = `${jobs.length - bad}/${jobs.length} runs${all.length > cap ? `, ${all.length - cap} pages not covered` : ''}`
  return bad < jobs.length ? dir : false
}

// rerun + verdict. A verdict is a `verified` or `needs-fix` label (or a closed issue). No verdict after the first agent: one shorter second try on the same results.
async function verifyIssue(R, i, env) {
  let dir = ''
  if (num('VERIFY_RERUN', 1)) { dir = await step('rerun', async () => rerunQa(R, i, env) || false); if (!dir) { cl.st.verdict = { s: 'skip', note: 'no ui-qa results to judge' }; return false } } else cl.st.rerun = { s: 'skip', note: 'VERIFY_RERUN=0' }
  const url = issueUrl(R, i.number), rel = dir.replace(ROOT + '/', '')
  const base = `Use the pct102-qa-verify skill on ${url} --env ${env} --close. This is an unattended run: never ask questions; if the fix is not live or you cannot decide, comment why and leave the issue open.`
  const pre = dir ? ` The ui-qa runs are already done by the script, in ${rel}/ (run-*/ for the issue's pages, sweep/ for the sweep; each has report.md, findings.json, screens/). Read them and do NOT run ui-qa yourself (a crawl takes longer than your shell allows). Never create or edit a file under AI_SKILLS_HOME.` : ''
  const retry = `Your earlier attempt on ${url} ended without a verdict. The ui-qa results are in ${rel}/. Do only this, quickly: compare the issue's Problems with those results, comment the verdict with screenshots from them, set the label verified or needs-fix, and close the issue only if verified and the fix is live (--close rules of the pct102-qa-verify skill). Do not run ui-qa. Never create or edit a file under AI_SKILLS_HOME. Unattended: never ask questions.`
  return step('verdict', async () => {
    for (const [k, prompt] of [[1, base + pre], [2, retry]]) {
      const r = await agent(ROOT, prompt, `qa-${i.number}`, `#${i.number}`, { lane: `i${i.number}vd${k}`, min: num('VERIFY_TIMEOUT_MIN', 15), what: k === 1 ? 'verify agent' : 'verify agent (second try)' })
      const v = verdictOf(R, i.number)
      cl.st.verdict.note = `model ${r.model || '?'}${v.done ? ', ' + (v.state === 'CLOSED' ? 'closed' : v.labels.includes('verified') ? 'verified' : 'needs-fix') : ''}`
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
  let pr = null, merged = false, outcome = ''
  const finish = () => { const rows = summary(); card(R, i.number, { note: outcome }); cards[cards.length - 1] += `\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n` }
  // Work already on GitHub (an earlier run timed out after pushing, or a person fixed the CI): reuse it, don't pay an agent to redo it.
  await step('reuse', async () => {
    pr = prFor(R, i.number, 'open')
    if (!pr) {
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
      const r = await agent(wt, `Use the pct102-dev-fix skill on ${issueUrl(R, i.number)}. This is an unattended run: never ask questions. If you are blocked, comment why on the issue and add the needs-human label. Push the fix branch and open the PR into ${BASE} as the skill says. Do not merge.`, `dev-${i.number}`, `#${i.number}`, { lane: `i${i.number}fx${tries + 1}`, what: `fix agent (attempt ${tries + 1}/${maxTry})` })
      killIn(wt); run('git', ['worktree', 'remove', '--force', wt])
      const now = issues(R, 'auto-fix').find((x) => x.number === i.number); pr = prFor(R, i.number, 'open')
      cl.st.fix.note = `model ${r.model || '?'}, ${now?.labels.includes('ready-for-test') && pr ? 'PR #' + pr.number : now?.labels.includes('needs-human') ? 'handed to a person' : 'no ready-for-test result, stays queued'}`
      return !!(now?.labels.includes('ready-for-test') && pr)
    })
    if (!ready) { outcome = 'not fixed in this run'; for (const k of cl.keys.slice(2)) cl.st[k] = { s: 'skip', note: 'no fix' }; return finish() }
  }
  await step('gate', async () => { merged = await merge(R, pr.number, i.number); cl.st.gate.note = merged ? `PR #${pr.number} merged into ${BASE}` : 'not merged, see the log'; return merged })
  outcome = `PR #${pr.number} ${merged ? 'merged into ' + BASE : 'NOT merged (see the log above)'}`
  if (!merged || !env) { for (const k of cl.keys.slice(3)) cl.st[k] = { s: 'skip', note: merged ? 'no verify (--no-verify)' : 'not merged' }; return finish() }
  const st = await step('deploy', async () => { const d = await deployed(R, pr.number); cl.st.deploy.note = d; return d === 'success' })
  if (!st) { errors++; say(`#${i.number}: ${BASE} deploy did not succeed; stopping so no further fix is stacked on it. Fix the deploy, then run fix/verify again.`); outcome += `; stopped: ${BASE} deploy not successful`; for (const k of ['rerun', 'verdict']) cl.st[k] = { s: 'skip', note: 'deploy failed' }; finish(); return 'stop' }
  sleep(num('DEPLOY_SETTLE_SEC', 20) * 1000) // the branch alias needs a moment to move to the new deploy
  await verifyIssue(R, i, env)
  finish()
}

async function fix() {
  agentCmd()
  const R = repo(), skipL = ['ready-for-test', 'needs-human', 'verified'], maxTry = num('MAX_FIX_ATTEMPTS', 2), env = process.argv.includes('--no-verify') ? '' : setting('QA_ENV_URL')
  const todo = issues(R, 'auto-fix').filter((i) => !i.labels.some((l) => skipL.includes(l))).sort((a, b) => a.number - b.number).slice(0, num('MAX_DEV_ISSUES', 5))
  if (!todo.length) return say('no open auto-fix issues waiting for a fix')
  const keys = env ? ['reuse', 'fix', 'gate', 'deploy', 'rerun', 'verdict'] : ['reuse', 'fix', 'gate'], per = keys.reduce((a, k) => a + est(k), 0)
  say(`queue: ${todo.map((i) => '#' + i.number).join(' → ')} · oldest first, one at a time${env ? ', each verified before the next' : ' (no verify: --no-verify, or QA_ENV_URL is not set)'} · about ${dur(per * todo.length)} if every issue needs a fix`)
  // ponytail: one issue at a time. dev-fix starts the app for before/after evidence, so parallel fixers would fight over ports; add worktree-per-agent parallelism if the queue grows.
  for (const [k, i] of todo.entries()) {
    say(`── issue ${k + 1}/${todo.length} ── ${todo.length - k} left, about ${dur(per * (todo.length - k))}`)
    if (await fixOne(R, i, maxTry, env) === 'stop') break
  }
}

async function verify() {
  agentCmd()
  const env = setting('QA_ENV_URL') || die(3, 'QA_ENV_URL is not set in .sdlc/autopilot.env')
  const R = repo(), todo = issues(R, 'ready-for-test').sort((a, b) => a.number - b.number)
  if (!todo.length) return say('no ready-for-test issues')
  const deploy = ghOut(['api', `repos/${R}/commits/${BASE}/status`, '--jq', '.state']).trim()
  say(`verify queue: ${todo.map((i) => '#' + i.number).join(' → ')} · about ${dur((est('rerun') + est('verdict')) * todo.length)}`)
  for (const i of todo) {
    // cheap pre-checks before any tokens are spent; qa-verify repeats them on its own
    if (!prFor(R, i.number, 'merged')) { say(`#${i.number}: fix PR not merged into ${BASE} yet, skipped`); card(R, i.number, { note: 'skipped: fix not merged yet' }); continue }
    if (deploy !== 'success') { say(`#${i.number}: ${BASE} deploy is "${deploy}", skipped`); card(R, i.number, { note: 'skipped: dev not deployed yet' }); continue }
    begin(i.number, ['rerun', 'verdict']); say(`#${i.number} ${i.title}`)
    await verifyIssue(R, i, env)
    const rows = summary(); card(R, i.number); cards[cards.length - 1] += `\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n`
  }
}

if (!['check', 'fix', 'verify', 'merge'].includes(cmd)) die(3, 'usage: sdlc-daily.mjs check | fix | verify | merge <pr>')
if (cmd === 'merge') { if (!/^\d+$/.test(arg || '')) die(3, 'merge <pr number>'); process.exit((await merge(repo(), +arg, 0)) ? 0 : 1) }

// one run of the loop per project at a time (a long stage must not overlap the next trigger)
const lock = join(dailyDir, 'lock'), alive = (p) => { try { process.kill(p, 0); return true } catch { return false } }
if (existsSync(lock) && alive(+readFileSync(lock, 'utf8'))) die(0, `another stage is running (pid ${readFileSync(lock, 'utf8')}), skipped`)
writeFileSync(lock, String(process.pid))
try { await ({ check, fix, verify })[cmd]() } catch (e) { errors++; say(`stopped: ${e.message}`) } finally { rmSync(lock, { force: true }) }
const report = join(dailyDir, `${cmd}-${day}-${new Date().toTimeString().slice(0, 5).replace(':', '')}.md`)
writeFileSync(report, [`# ${basename(ROOT)} · ${cmd} · ${day}`, '', errors ? `**${errors} error(s) in this run.**` : 'No errors in this run.', '', '## Log', ...lines, '', '## Issues', ...(cards.length ? cards : ['(none)']), ''].join('\n'))
console.log(`report: ${report}`)
if (process.platform === 'darwin' && setting('DAILY_NOTIFY') !== '0') run('osascript', ['-e', `display notification "${cmd}: ${errors ? errors + ' error(s), see .sdlc/daily' : 'done'}" with title "${basename(ROOT)} daily"`])
process.exit(errors ? 1 : 0)
