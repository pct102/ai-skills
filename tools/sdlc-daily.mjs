#!/usr/bin/env node
// The daily QA loop for one project. Run from the project root (the project's .sdlc/autopilot.env is read).
//   sdlc-daily.mjs scout          crawl QA_ENV_URL (+ QA_URLS) with ui-qa and file NEW issues (labels ui-qa, auto-fix)
//   sdlc-daily.mjs dev            for each open auto-fix issue, run an agent with pct102-dev-fix, then gate-merge its PR
//   sdlc-daily.mjs qa             for each ready-for-test issue whose fix is merged and deployed, run an agent with pct102-qa-verify --close
//   sdlc-daily.mjs merge <pr>     the merge gate alone
//   sdlc-daily.mjs install        write launchd plists for the three stages (prints the launchctl lines; loads nothing)
// The stages are driven by issue labels, not by the clock, so a late or repeated run is harmless. Only scripts run here;
// tokens are spent only inside the agent each stage launches (AGENT_CMD). Settings: see autopilot.env.example.
// Exit: 0 done | 1 a stage had errors | 3 usage or missing setting
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
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
const say = (s) => { console.log(s); appendFileSync(join(dailyDir, `${day}.md`), `- ${new Date().toTimeString().slice(0, 5)} ${cmd}: ${s}\n`) }
let errors = 0

const ghOut = (a) => { const r = run('gh', a); if (r.status !== 0) throw new Error(`gh ${a.slice(0, 3).join(' ')}: ${(r.stderr || '').trim().slice(0, 200)}`); return r.stdout }
const ghJson = (a) => JSON.parse(ghOut(a) || 'null')
const repo = () => setting('ISSUE_GITHUB_REPO') || ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner
const BASE = setting('PR_BASE') || 'dev'
const PROTECTED = list('PROTECTED_BRANCHES', 'main master')
const issueUrl = (R, n) => `https://github.com/${R}/issues/${n}`
const tag = (R, n, add, remove = '') => run('node', [join(HERE, 'sdlc-issue.mjs'), 'label', '--url', issueUrl(R, n), ...(add ? ['--add', add] : []), ...(remove ? ['--remove', remove] : [])])
const note = (R, n, body) => run('node', [join(HERE, 'sdlc-issue.mjs'), 'comment', '--url', issueUrl(R, n), '--body', body])
const issues = (R, label) => ghJson(['issue', 'list', '--repo', R, '--state', 'open', '--label', label, '--json', 'number,title,labels', '--limit', '100'])
  .map((i) => ({ ...i, labels: i.labels.map((l) => l.name) }))
const prFor = (R, n, state) => ghJson(['pr', 'list', '--repo', R, '--state', state, '--base', BASE, '--json', 'number,headRefName,body,title', '--limit', '100'])
  .find((p) => new RegExp(`^fix/issue-${n}(-|$)`).test(p.headRefName) || new RegExp(`#${n}\\b`).test(`${p.title} ${p.body || ''}`))

const agentCmd = () => setting('AGENT_CMD') || die(3, 'AGENT_CMD is not set (e.g. AGENT_CMD="opencode run"): the command that takes the prompt as its last argument')
function agent(cwd, prompt, logName, label) {
  const cmdline = agentCmd()
  mkdirSync(join(dailyDir, 'logs'), { recursive: true })
  const log = openSync(join(dailyDir, 'logs', `${day}-${logName}.log`), 'a')
  const r = spawnSync('sh', ['-c', `${cmdline} "$SDLC_PROMPT"`], { cwd, env: { ...process.env, SDLC_PROMPT: prompt }, stdio: ['ignore', log, log], timeout: num('AGENT_TIMEOUT_MIN', 30) * 60000 })
  if (r.error || r.status) { errors++; say(`${label}: agent ${r.error?.code === 'ETIMEDOUT' ? 'timed out' : 'exited ' + r.status} (log .sdlc/daily/logs/${day}-${logName}.log)`) }
}

// ---------- merge gate: deterministic, no LLM. Returns {ok, reason}; reason 'pending' means try again later.
function gate(R, pr) {
  const wait = Date.now() + num('MERGE_WAIT_MIN', 10) * 60000
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
    sleep(30000)
  }
}
function merge(R, pr, issue) {
  const g = gate(R, pr)
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
function scout() {
  const env = setting('QA_ENV_URL') || die(3, 'QA_ENV_URL is not set in .sdlc/autopilot.env')
  const origin = new URL(env).origin, cap = num('MAX_NEW_ISSUES', 8), out = join(ROOT, '.sdlc', 'qa-scout', day)
  const jobs = [[env, '--depth', '2', '--max-pages', String(num('QA_SCOUT_MAX_PAGES', 25))],
    ...list('QA_URLS').map((u) => [new URL(u, origin).href, '--depth', '0', '--max-pages', '1'])]
  const R = repo(); for (const l of ['ui-qa', 'auto-fix']) run('gh', ['label', 'create', l, '--repo', R, '--color', 'c5def5']) // exists -> non-zero, fine
  let filed = 0
  jobs.forEach(([url, ...flags], i) => {
    if (filed >= cap) return
    const dir = join(out, String(i)), r = run('node', [join(HERE, 'ui-qa.mjs'), url, '--allow-remote', '--max-issues', String(cap), '--out', dir, ...flags])
    if (r.status > 1 || r.error) { errors++; return say(`ui-qa failed on ${url}: ${(r.stderr || '').trim().split('\n').pop()}`) }
    const f = run('node', [join(HERE, 'ui-qa.mjs'), 'file', dir, '--new-only'], { env: { ...process.env, ISSUE_TRACKER: 'github', ISSUE_GITHUB_REPO: R, ISSUE_LABELS: 'ui-qa,auto-fix' } })
    for (const l of f.stdout.split('\n').filter((x) => /^filed:/.test(x))) { filed++; say(`new issue ${l}`) }
  })
  say(`scout done: ${jobs.length} run(s), ${filed} new issue(s)`)
}

function dev() {
  agentCmd()
  const R = repo(), skip = ['ready-for-test', 'needs-human', 'verified'], maxTry = num('MAX_FIX_ATTEMPTS', 2)
  const todo = issues(R, 'auto-fix').filter((i) => !i.labels.some((l) => skip.includes(l))).slice(0, num('MAX_DEV_ISSUES', 5))
  if (!todo.length) return say('no open auto-fix issues waiting for a fix')
  run('git', ['fetch', 'origin', BASE])
  // ponytail: one issue at a time. dev-fix starts the app for before/after evidence, so parallel fixers would fight over ports; add worktree-per-agent parallelism if the queue grows.
  for (const i of todo) {
    const tries = Math.max(0, ...i.labels.map((l) => +(l.match(/^fix-attempt-(\d+)$/) || [])[1] || 0))
    if (tries >= maxTry) { tag(R, i.number, 'needs-human', 'needs-fix'); note(R, i.number, `Gave up after ${tries} automatic fix attempt(s). A person needs to look at it.`); say(`#${i.number}: ${tries} attempts, handed to a person`); continue }
    run('gh', ['label', 'create', `fix-attempt-${tries + 1}`, '--repo', R, '--color', 'ededed']); tag(R, i.number, `fix-attempt-${tries + 1}`)
    const wt = join(ROOT, '.sdlc', 'wt', `issue-${i.number}`)
    run('git', ['worktree', 'remove', '--force', wt]); rmSync(wt, { recursive: true, force: true })
    if (run('git', ['worktree', 'add', '--detach', wt, `origin/${BASE}`]).status) { errors++; say(`#${i.number}: cannot create a worktree from origin/${BASE}`); continue }
    for (const f of readdirSync(ROOT).filter((x) => /^\.env/.test(x))) copyFileSync(join(ROOT, f), join(wt, f)) // untracked app env files
    if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(wt, 'node_modules'))
    say(`#${i.number}: ${i.title} (attempt ${tries + 1}/${maxTry})`)
    agent(wt, `Use the pct102-dev-fix skill on ${issueUrl(R, i.number)}. This is an unattended run: never ask questions. If you are blocked, comment why on the issue and add the needs-human label. Push the fix branch and open the PR into ${BASE} as the skill says. Do not merge.`, `dev-${i.number}`, `#${i.number}`)
    run('git', ['worktree', 'remove', '--force', wt])
    const now = issues(R, 'auto-fix').find((x) => x.number === i.number), pr = prFor(R, i.number, 'open')
    if (now?.labels.includes('ready-for-test') && pr) merge(R, pr.number, i.number)
    else if (!now?.labels.includes('needs-human')) say(`#${i.number}: no ready-for-test result (attempt ${tries + 1}); it stays queued`)
  }
}

function qa() {
  agentCmd()
  const env = setting('QA_ENV_URL') || die(3, 'QA_ENV_URL is not set in .sdlc/autopilot.env')
  const R = repo(), todo = issues(R, 'ready-for-test')
  if (!todo.length) return say('no ready-for-test issues')
  const deploy = ghOut(['api', `repos/${R}/commits/${BASE}/status`, '--jq', '.state']).trim()
  for (const i of todo) {
    // cheap pre-checks before any tokens are spent; qa-verify repeats them on its own
    if (!prFor(R, i.number, 'merged')) { say(`#${i.number}: fix PR not merged into ${BASE} yet, skipped`); continue }
    if (deploy !== 'success') { say(`#${i.number}: ${BASE} deploy is "${deploy}", skipped`); continue }
    say(`#${i.number}: ${i.title}`)
    agent(ROOT, `Use the pct102-qa-verify skill on ${issueUrl(R, i.number)} --env ${env} --close. This is an unattended run: never ask questions; if the fix is not live or you cannot decide, comment why and leave the issue open.`, `qa-${i.number}`, `#${i.number}`)
    const after = ghJson(['issue', 'view', String(i.number), '--repo', R, '--json', 'state,labels'])
    say(`#${i.number}: now ${after.state}, labels ${after.labels.map((l) => l.name).join(',') || '-'}`)
  }
}

function install() {
  const dir = join(homedir(), 'Library', 'LaunchAgents'), name = basename(ROOT).replace(/[^\w-]/g, '')
  mkdirSync(dir, { recursive: true })
  for (const [stage, key, d] of [['scout', 'SCOUT_AT', '05:00'], ['dev', 'DEV_AT', '09:00'], ['qa', 'QA_AT', '15:00']]) {
    const [h, m] = (setting(key) || d).split(':').map(Number), label = `com.pct102.sdlc-daily.${name}.${stage}`, f = join(dir, `${label}.plist`)
    writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${process.execPath}</string><string>${SELF}</string><string>${stage}</string></array>
<key>WorkingDirectory</key><string>${ROOT}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string><key>HOME</key><string>${homedir()}</string></dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m || 0}</integer></dict>
<key>StandardOutPath</key><string>${join(dailyDir, `launchd-${stage}.log`)}</string>
<key>StandardErrorPath</key><string>${join(dailyDir, `launchd-${stage}.log`)}</string>
</dict></plist>
`)
    console.log(`wrote ${f}\n  load:   launchctl bootstrap gui/$(id -u) ${f}\n  remove: launchctl bootout gui/$(id -u) ${f}`)
  }
}

if (!['scout', 'dev', 'qa', 'merge', 'install'].includes(cmd)) die(3, 'usage: sdlc-daily.mjs scout | dev | qa | merge <pr> | install')
if (cmd === 'install') { install(); process.exit(0) }
if (cmd === 'merge') { if (!/^\d+$/.test(arg || '')) die(3, 'merge <pr number>'); process.exit(merge(repo(), +arg, 0) ? 0 : 1) }

// one run of the loop per project at a time (a long stage must not overlap the next trigger)
const lock = join(dailyDir, 'lock'), alive = (p) => { try { process.kill(p, 0); return true } catch { return false } }
if (existsSync(lock) && alive(+readFileSync(lock, 'utf8'))) die(0, `another stage is running (pid ${readFileSync(lock, 'utf8')}), skipped`)
writeFileSync(lock, String(process.pid))
try { ({ scout, dev, qa })[cmd]() } catch (e) { errors++; say(`stopped: ${e.message}`) } finally { rmSync(lock, { force: true }) }
if (process.platform === 'darwin' && setting('DAILY_NOTIFY') !== '0') run('osascript', ['-e', `display notification "${cmd}: ${errors ? errors + ' error(s), see .sdlc/daily' : 'done'}" with title "${basename(ROOT)} daily"`])
process.exit(errors ? 1 : 0)
