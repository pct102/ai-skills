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
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
for (const d of ['daily', 'qa-check', 'wt']) { // generated output: keep it out of the project's git status
  mkdirSync(join(ROOT, '.sdlc', d), { recursive: true }); writeFileSync(join(ROOT, '.sdlc', d, '.gitignore'), '*\n')
}
const lines = [], cards = []
const say = (s) => { console.log(s); lines.push(`- ${new Date().toTimeString().slice(0, 5)} ${s}`) }
let errors = 0

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
const freeWt = (wt) => { // drop a stale worktree directory
  run('git', ['worktree', 'remove', '--force', wt]); rmSync(wt, { recursive: true, force: true })
}
const fillWt = (wt) => {
  for (const f of readdirSync(ROOT).filter((x) => /^\.env/.test(x))) copyFileSync(join(ROOT, f), join(wt, f)) // untracked app env files
  if (existsSync(join(ROOT, 'node_modules'))) symlinkSync(join(ROOT, 'node_modules'), join(wt, 'node_modules'))
}
// A PR that conflicts with BASE (something else merged first): one agent run merges BASE into the PR branch and pushes it, then the gate decides again.
function resolveConflicts(R, pr) {
  const head = ghJson(['pr', 'view', String(pr), '--repo', R, '--json', 'headRefName']).headRefName, wt = join(ROOT, '.sdlc', 'wt', `merge-${pr}`)
  run('git', ['fetch', 'origin', BASE, head]); freeWt(wt)
  if (run('git', ['worktree', 'add', '--detach', wt, `origin/${head}`]).status) return say(`PR #${pr}: cannot create a worktree for ${head}`)
  fillWt(wt)
  say(`PR #${pr}: conflicts with ${BASE}, an agent merges ${BASE} into ${head}`)
  agent(wt, `Branch ${head} (PR #${pr}) conflicts with ${BASE}. You are in a checkout of ${head}. Run git merge origin/${BASE}, resolve every conflict keeping the intent of both sides, run npx tsc --noEmit, commit the merge and git push origin HEAD:${head}. Never force-push, never push any other branch, do not merge the PR. If you cannot resolve it safely, git merge --abort and stop. This is an unattended run: never ask questions.`, `merge-${pr}`, `PR #${pr}`)
  run('git', ['worktree', 'remove', '--force', wt])
  sleep(num('CONFLICT_WAIT_SEC', 60) * 1000) // let GitHub recompute mergeable and start CI on the new commit
}
function merge(R, pr, issue) {
  let g = gate(R, pr)
  if (!g.ok && g.reason === 'merge conflicts') { resolveConflicts(R, pr); g = gate(R, pr) }
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
// previous one, so the PRs do not collide. fixOne returns the number of the PR it merged, or 0.
function fixOne(R, i, maxTry) {
  run('git', ['fetch', 'origin', BASE])
  // Work already on GitHub (an earlier run timed out after pushing, or a person fixed the CI): reuse it, don't pay an agent to redo it.
  let pr = prFor(R, i.number, 'open')
  if (!pr) {
    const br = run('git', ['ls-remote', '--heads', 'origin', `fix/issue-${i.number}-*`]).stdout.trim().split('\n')[0]?.split('refs/heads/')[1]
    if (br && !run('gh', ['pr', 'create', '--repo', R, '--base', BASE, '--head', br, '--title', `fix(#${i.number}): ${i.title.replace(/^\[ui-qa\]\s*/, '')}`, '--body', `Fix for #${i.number} (branch pushed by an earlier dev-fix run; PR opened by sdlc-daily).`]).status) pr = prFor(R, i.number, 'open')
  }
  const finish = (ok) => { card(R, i.number, { note: `PR #${pr.number} ${ok ? 'merged into ' + BASE : 'NOT merged (see the log above)'}` }); return ok ? pr.number : 0 }
  if (pr) { say(`#${i.number}: reusing PR #${pr.number}`); tag(R, i.number, 'ready-for-test', 'needs-fix'); return finish(merge(R, pr.number, i.number)) }
  const tries = Math.max(0, ...i.labels.map((l) => +(l.match(/^fix-attempt-(\d+)$/) || [])[1] || 0))
  if (tries >= maxTry) { tag(R, i.number, 'needs-human', 'needs-fix'); note(R, i.number, `Gave up after ${tries} automatic fix attempt(s). A person needs to look at it.`); say(`#${i.number}: ${tries} attempts, handed to a person`); card(R, i.number, { note: `gave up after ${tries} attempts` }); return 0 }
  run('gh', ['label', 'create', `fix-attempt-${tries + 1}`, '--repo', R, '--color', 'ededed']); tag(R, i.number, `fix-attempt-${tries + 1}`)
  const wt = join(ROOT, '.sdlc', 'wt', `issue-${i.number}`); freeWt(wt)
  if (run('git', ['worktree', 'add', '--detach', wt, `origin/${BASE}`]).status) { errors++; say(`#${i.number}: cannot create a worktree from origin/${BASE}`); return 0 }
  fillWt(wt)
  say(`#${i.number}: ${i.title} (attempt ${tries + 1}/${maxTry})`)
  agent(wt, `Use the pct102-dev-fix skill on ${issueUrl(R, i.number)}. This is an unattended run: never ask questions. If you are blocked, comment why on the issue and add the needs-human label. Push the fix branch and open the PR into ${BASE} as the skill says. Do not merge.`, `dev-${i.number}`, `#${i.number}`)
  run('git', ['worktree', 'remove', '--force', wt])
  const now = issues(R, 'auto-fix').find((x) => x.number === i.number); pr = prFor(R, i.number, 'open')
  if (now?.labels.includes('ready-for-test') && pr) return finish(merge(R, pr.number, i.number))
  say(`#${i.number}: ${now?.labels.includes('needs-human') ? 'handed to a person' : `no ready-for-test result (attempt ${tries + 1}); it stays queued`}`); card(R, i.number, { note: 'not fixed in this run' }); return 0
}

// Wait until the commit that holds the merged PR is deployed. Returns the deploy state ('success' or the last non-success state).
function deployed(R, prNumber) {
  const sha = ghJson(['pr', 'view', String(prNumber), '--repo', R, '--json', 'mergeCommit'])?.mergeCommit?.oid || BASE, end = Date.now() + num('DEPLOY_WAIT_MIN', 15) * 60000
  for (;;) {
    const st = ghOut(['api', `repos/${R}/commits/${sha}/status`, '--jq', '.state']).trim()
    if (st === 'success' || /failure|error/.test(st) || Date.now() > end) return st
    sleep(30000)
  }
}

function verifyOne(R, i, env) {
  say(`#${i.number}: verifying on ${env}`)
  agent(ROOT, `Use the pct102-qa-verify skill on ${issueUrl(R, i.number)} --env ${env} --close. This is an unattended run: never ask questions; if the fix is not live or you cannot decide, comment why and leave the issue open.`, `qa-${i.number}`, `#${i.number}`)
  const after = ghJson(['issue', 'view', String(i.number), '--repo', R, '--json', 'state,labels'])
  say(`#${i.number}: now ${after.state}, labels ${after.labels.map((l) => l.name).join(',') || '-'}`); card(R, i.number)
}

function fix() {
  agentCmd()
  const R = repo(), skip = ['ready-for-test', 'needs-human', 'verified'], maxTry = num('MAX_FIX_ATTEMPTS', 2), env = process.argv.includes('--no-verify') ? '' : setting('QA_ENV_URL')
  const todo = issues(R, 'auto-fix').filter((i) => !i.labels.some((l) => skip.includes(l))).sort((a, b) => a.number - b.number).slice(0, num('MAX_DEV_ISSUES', 5))
  if (!todo.length) return say('no open auto-fix issues waiting for a fix')
  if (!env) say('no verify after each fix (--no-verify, or QA_ENV_URL is not set): fixes are merged one after the other, verify them later with the verify stage')
  // ponytail: one issue at a time. dev-fix starts the app for before/after evidence, so parallel fixers would fight over ports; add worktree-per-agent parallelism if the queue grows.
  for (const i of todo) {
    const merged = fixOne(R, i, maxTry)
    if (!merged || !env) continue
    const st = deployed(R, merged)
    if (st !== 'success') { errors++; say(`#${i.number}: ${BASE} deploy is "${st}" after the merge; stopping so no further fix is stacked on it. Fix the deploy, then run fix/verify again.`); card(R, i.number, { note: `stopped: ${BASE} deploy "${st}"` }); return }
    sleep(num('DEPLOY_SETTLE_SEC', 20) * 1000) // the branch alias needs a moment to move to the new deploy
    verifyOne(R, i, env)
  }
}

function verify() {
  agentCmd()
  const env = setting('QA_ENV_URL') || die(3, 'QA_ENV_URL is not set in .sdlc/autopilot.env')
  const R = repo(), todo = issues(R, 'ready-for-test').sort((a, b) => a.number - b.number)
  if (!todo.length) return say('no ready-for-test issues')
  const deploy = ghOut(['api', `repos/${R}/commits/${BASE}/status`, '--jq', '.state']).trim()
  for (const i of todo) {
    // cheap pre-checks before any tokens are spent; qa-verify repeats them on its own
    if (!prFor(R, i.number, 'merged')) { say(`#${i.number}: fix PR not merged into ${BASE} yet, skipped`); card(R, i.number, { note: 'skipped: fix not merged yet' }); continue }
    if (deploy !== 'success') { say(`#${i.number}: ${BASE} deploy is "${deploy}", skipped`); card(R, i.number, { note: 'skipped: dev not deployed yet' }); continue }
    verifyOne(R, i, env)
  }
}

if (!['check', 'fix', 'verify', 'merge'].includes(cmd)) die(3, 'usage: sdlc-daily.mjs check | fix | verify | merge <pr>')
if (cmd === 'merge') { if (!/^\d+$/.test(arg || '')) die(3, 'merge <pr number>'); process.exit(merge(repo(), +arg, 0) ? 0 : 1) }

// one run of the loop per project at a time (a long stage must not overlap the next trigger)
const lock = join(dailyDir, 'lock'), alive = (p) => { try { process.kill(p, 0); return true } catch { return false } }
if (existsSync(lock) && alive(+readFileSync(lock, 'utf8'))) die(0, `another stage is running (pid ${readFileSync(lock, 'utf8')}), skipped`)
writeFileSync(lock, String(process.pid))
try { ({ check, fix, verify })[cmd]() } catch (e) { errors++; say(`stopped: ${e.message}`) } finally { rmSync(lock, { force: true }) }
const report = join(dailyDir, `${cmd}-${day}-${new Date().toTimeString().slice(0, 5).replace(':', '')}.md`)
writeFileSync(report, [`# ${basename(ROOT)} · ${cmd} · ${day}`, '', errors ? `**${errors} error(s) in this run.**` : 'No errors in this run.', '', '## Log', ...lines, '', '## Issues', ...(cards.length ? cards : ['(none)']), ''].join('\n'))
console.log(`report: ${report}`)
if (process.platform === 'darwin' && setting('DAILY_NOTIFY') !== '0') run('osascript', ['-e', `display notification "${cmd}: ${errors ? errors + ' error(s), see .sdlc/daily' : 'done'}" with title "${basename(ROOT)} daily"`])
process.exit(errors ? 1 : 0)
