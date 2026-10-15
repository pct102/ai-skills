#!/usr/bin/env node
// sdlc-ship — commit one accepted feature, and nothing else.
//
//   sdlc-ship.mjs --feature <f> [--dry-run] [--push] [--branch <name>] [--message <subject>] [--allow-subdir]
//
// Refuses unless status.json says `accepted`. Stages an explicit list, never `git add -A`:
//   - files matching the feature's ownership.json `owns` globs
//   - the feature's own docs (spec, plan, acceptance, ownership, evidence.md) and .sdlc/{intent,roadmap,stack,decisions}.md
// Never stages generated or private files (traces, raw agent logs, screenshots, generated diagrams, evidence.json,
// status.json, .env, keys, node_modules, test reports). Anything else that changed is listed and
// left alone. A staged file containing a recognisable secret aborts the whole commit.
// Refuses when the project folder is only a subfolder of a bigger git repository (the branch switch and
// commit would happen there); --allow-subdir commits just this folder's files inside that repository.
// Commits on a branch (autopilot/<f> when you are on main/master); never pushes unless --push,
// and never force-pushes or pushes main/master.
//
// Exit: 0 committed or nothing to commit | 1 refused | 3 usage or configuration error
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const a = process.argv.slice(2)
const opt = (k, d = '') => { const i = a.indexOf('--' + k); return i < 0 ? d : (a[i + 1] ?? true) }
const has = (k) => a.includes('--' + k)
const die = (code, msg) => { console.error(msg); process.exit(code) }
const git = (...args) => spawnSync('git', args, { encoding: 'utf8' })
const must = (...args) => { const r = git(...args); if (r.status !== 0) die(1, `git ${args.join(' ')} failed:\n${r.stderr || r.stdout}`); return r.stdout }

const feature = opt('feature')
if (!feature) die(3, '--feature required')
const dry = has('dry-run'), push = has('push')
const root = git('rev-parse', '--show-toplevel')
if (root.status !== 0) die(3, 'not inside a git repository')
const top = root.stdout.trim()
const sub = realpathSync(process.cwd()) !== realpathSync(top)
if (sub && !has('allow-subdir')) {
  die(1, `refused: this project (${process.cwd()}) is a folder inside the git repository ${top}, not a repository of its own.\n` +
    `A branch switch and commit would happen in that repository. Run 'git init' in the project folder, or pass --allow-subdir to commit only this folder's files there.`)
}
const prefix = sub ? git('rev-parse', '--show-prefix').stdout.trim() : ''
const fdir = join('.sdlc', 'features', feature)
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

const status = readJson(join(fdir, 'status.json'))
if (!status) die(3, `no ${fdir}/status.json`)
if (status.phase !== 'accepted') die(1, `refused: phase is '${status.phase}', not 'accepted' (${status.blocked_reason || 'run sdlc-verify first'})`)
// QA is a mandatory, machine-checked gate: accepted work only ships when acceptance.yaml carries a
// qa-evidence check (sdlc-verify has then proved QA ran after the last builder change).
// --no-qa-gate is for features that were not built through autopilot and have no QA lane.
if (!has('no-qa-gate')) {
  let acc = ''
  try { acc = readFileSync(join(fdir, 'acceptance.yaml'), 'utf8') } catch { /* handled below */ }
  if (!/^\s*(-\s*)?kind:\s*qa-evidence\s*$/m.test(acc)) {
    die(1, `refused: ${fdir}/acceptance.yaml has no check of kind qa-evidence, so QA was never required to pass.\n` +
      `Add one (see skills/feature-lifecycle/references/acceptance-template.yaml) and re-run sdlc-verify, or pass --no-qa-gate for a feature that has no QA lane.`)
  }
}
const own = readJson(join(fdir, 'ownership.json'))
if (!own || !Array.isArray(own.owns) || !own.owns.length) die(3, `${fdir}/ownership.json needs a non-empty "owns" list`)

const globToRe = (g) => {
  let s = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') { if (g[i + 1] === '*') { s += '.*'; i++; if (g[i + 1] === '/') i++ } else s += '[^/]*' }
    else if (c === '?') s += '[^/]'
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + s.replace(/\/$/, '') + '(/.*)?$')
}
const owned = own.owns.map(globToRe)
const docs = new Set(['spec.md', 'plan.md', 'acceptance.yaml', 'ownership.json', 'slices.json', 'evidence.md'].map((f) => `${fdir}/${f}`))
for (const f of ['architecture.json', 'workflow.json', 'dataflow.json']) docs.add(`${fdir}/diagrams/${f}`)
for (const f of ['intent.md', 'roadmap.md', 'stack.md', 'decisions.md']) docs.add(`.sdlc/${f}`)

const DENY = [
  [/(^|\/)\.env(\.(?!example$|sample$|template$).+)?$/, 'environment file'],
  [/\.(pem|key|p12|pfx|keystore)$|(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/, 'key material'],
  [/(^|\/)node_modules\//, 'dependencies'],
  [/^\.sdlc\/.*\/(\.oc\/|evidence\/)/, 'raw agent log or screenshot (regenerable)'],
  [/^\.sdlc\/.*\/(trace\.(jsonl|md|html)|evidence\.json|status\.json)$/, 'generated state'],
  [/^\.sdlc\/.*\/diagrams\/(?!(architecture|workflow|dataflow)\.json$)/, 'generated diagram (regenerable)'],
  [/^\.sdlc\/opencode-server\.log$/, 'server log'],
  [/(^|\/)(test-results|playwright-report|\.playwright)\//, 'test report'],
  [/\.log$|(^|\/)\.DS_Store$|(^|\/)\.worktrees\//, 'log or local junk'],
]
const SECRETS = [/AKIA[0-9A-Z]{16}/, /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, /gh[pousr]_[A-Za-z0-9]{36,}/,
  /sk-[A-Za-z0-9_-]{32,}/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /AIza[0-9A-Za-z_-]{35}/]

// Everything that changed: modified, staged, and untracked (one file per entry).
const entries = must('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0').filter(Boolean)
const changed = []
let elsewhere = 0
for (let i = 0; i < entries.length; i++) {
  const [x] = entries[i]
  const path = entries[i].slice(3)
  if (x === 'R' || x === 'C') i++          // rename/copy: the next entry is the old path
  if (prefix && !path.startsWith(prefix)) { elsewhere++; continue }   // status paths are relative to the repository root
  changed.push(prefix ? path.slice(prefix.length) : path)
}

const stage = [], skip = []
for (const p of changed) {
  const deny = DENY.find(([re]) => re.test(p))
  if (deny) { skip.push([p, deny[1]]); continue }
  if (!(docs.has(p) || owned.some((re) => re.test(p)))) { skip.push([p, 'outside this feature\'s ownership']); continue }
  if (existsSync(p) && statSync(p).size > 5_000_000) { skip.push([p, 'larger than 5 MB']); continue }
  stage.push(p)
}

for (const p of stage) {
  if (!existsSync(p)) continue
  const buf = readFileSync(p)
  if (buf.includes(0)) continue
  const text = buf.toString('utf8')
  const hit = SECRETS.find((re) => re.test(text))
  if (hit) die(1, `refused: ${p} looks like it contains a secret (${hit}). Nothing was committed.`)
}

console.log(`feature ${feature}: ${stage.length} file(s) to commit, ${skip.length} left alone`)
for (const p of stage) console.log(`  + ${p}`)
for (const [p, why] of skip) console.log(`  - ${p}   (${why})`)
const outside = skip.filter(([, w]) => w.startsWith('outside')).length
if (elsewhere) console.log(`note: ${elsewhere} changed file(s) elsewhere in ${top} were ignored.`)
if (outside) console.log(`warning: ${outside} changed file(s) are not owned by this feature and were not committed.`)
if (!stage.length) { console.log('nothing to commit'); process.exit(0) }
if (dry) { console.log('dry run: nothing changed'); process.exit(0) }

const current = must('rev-parse', '--abbrev-ref', 'HEAD').trim()
const isDefault = ['main', 'master', 'HEAD'].includes(current)
const branch = opt('branch') || (isDefault ? `autopilot/${feature}` : current)
if (branch !== current) must('switch', '-c', branch)

const ev = readJson(join(fdir, 'evidence.json'))
const ids = ev ? ev.checks.filter((c) => c.ok).map((c) => c.id) : []
let subject = opt('message')
if (!subject) {
  const spec = existsSync(join(fdir, 'spec.md')) ? readFileSync(join(fdir, 'spec.md'), 'utf8') : ''
  subject = (spec.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || feature)
  subject = `feat(${feature}): ${subject.replace(/^(spec|feature)\s*[:\-–]\s*/i, '')}`.slice(0, 72)
}
const body = `Accepted by sdlc-verify: ${ev ? ev.passed : '?'} check(s) passed${ids.length ? ' (' + ids.join(', ') + ')' : ''}.\nFeature artifacts: ${fdir}/`
must('add', '--', ...stage)
must('commit', '-m', subject, '-m', body, '--', ...stage)
console.log(`committed on ${branch}: ${must('rev-parse', '--short', 'HEAD').trim()}  ${subject}`)

if (push) {
  if (['main', 'master'].includes(branch)) die(1, 'refused to push main/master')
  const r = git('push', '-u', 'origin', branch)
  process.stdout.write(r.stdout + r.stderr)
  if (r.status !== 0) die(1, 'push failed; the commit is still local')
  console.log(`pushed ${branch}. Open a pull request from it when ready.`)
} else {
  console.log(`not pushed. To push: git push -u origin ${branch}`)
}
