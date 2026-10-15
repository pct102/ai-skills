#!/usr/bin/env node
// sdlc-slices — splits one feature into slices that builders can work on at the same time,
// and checks that each builder stayed inside its own files.
//
// A slice is a piece of the feature with its own files (`owns`), the slices it needs first (`depends`),
// a brief for the builder and an optional check command. The leader writes
// .sdlc/features/<f>/slices.json; this tool does the bookkeeping the leader should not do by eye:
//
//   plan    <f>        validate slices.json and print the waves (what can run together)
//   ready   <f>        ids that may start now (dependencies done, no file clash with a running slice)
//   start   <f> <id>   mark running and snapshot the project, so the end can be audited
//   done    <f> <id>   audit the files changed since start, run the slice's check, mark done or failed
//   reset   <f> <id>   put a failed or running slice back to pending, to try again
//   status  <f>        one line per slice (--json for machines)
//
// The audit is the point. Builders cannot see each other, so a slice that edits a file it does not own
// breaks someone else silently. Anything changed outside the slice's own files, and outside the files of
// slices that ran at the same time as it, fails the slice. Files under .sdlc/, .git/, node_modules/ and
// test reports are ignored.
//
// slices.json:
//   { "slices": [ { "id": "state", "title": "Game state",
//                   "owns": ["js/state.js", "tests/state.test.js"],
//                   "depends": [], "brief": "briefs/state.md", "check": "npm test -- state",
//                   "budget_min": 15 } ] }
//
// Exit: 0 ok | 1 nothing ready / slice failed | 3 bad input or bad slices.json
// No dependencies. Node >= 18. Run from the project root.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

class Bad extends Error {}
const HERE = dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------------ globs

function globToRe(glob) {
  const g = glob.replace(/^\.\//, '').replace(/^\/+/, '')
  let s = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { s += '.*'; i++; if (g[i + 1] === '/') i++ } else s += '[^/]*'
    } else if (c === '?') s += '[^/]'
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + s.replace(/\/$/, '') + '(/.*)?$')
}
const matches = (globs, path) => globs.some((g) => globToRe(g).test(path))

// Same idea as sdlc-dispatch: the directory a glob claims. Two globs clash when one claims inside the other.
function staticPrefix(glob) {
  const cleaned = glob.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (cleaned === '') return ''
  const segs = cleaned.split('/')
  const wild = (s) => /[*?[\]{}]/.test(s)
  if (!segs.some(wild)) return segs[segs.length - 1].includes('.') ? cleaned : segs.slice(0, -1).join('/')
  const out = []
  for (const s of segs) { if (wild(s)) break; out.push(s) }
  return out.join('/')
}
const overlap = (a, b) => a === '' || b === '' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
function clash(x, y) {
  for (const g of x.owns) for (const h of y.owns) if (overlap(staticPrefix(g), staticPrefix(h))) return `${g} <-> ${h}`
  return null
}

// ------------------------------------------------------------------ files

const readJson = (f) => {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch (e) { throw new Bad(`${f}: ${e.code === 'ENOENT' ? 'not found' : e.message}`) }
}

function paths(feature) {
  if (!feature || !/^[\w.-]+$/.test(feature)) throw new Bad('a feature name is required')
  const fdir = `.sdlc/features/${feature}`
  if (!existsSync(fdir)) throw new Bad(`${fdir} not found. Run from the project root.`)
  const sdir = `${fdir}/.oc/slices`
  return { feature, fdir, sdir, slices: `${fdir}/slices.json`, state: `${sdir}/state.json` }
}

function load(p) {
  const doc = readJson(p.slices)
  if (!doc || !Array.isArray(doc.slices) || !doc.slices.length) throw new Bad(`${p.slices}: "slices" must be a non-empty array`)
  const ids = new Set()
  for (const s of doc.slices) {
    if (!s || typeof s.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(s.id)) throw new Bad(`slice id must be a-z, 0-9, _ and start with a letter: ${JSON.stringify(s && s.id)}`)
    if (ids.has(s.id)) throw new Bad(`duplicate slice id: ${s.id}`)
    ids.add(s.id)
    if (!Array.isArray(s.owns) || !s.owns.length || s.owns.some((g) => typeof g !== 'string' || !g)) throw new Bad(`slice ${s.id}: "owns" must be a non-empty list of globs`)
    s.depends = s.depends ?? []
    if (!Array.isArray(s.depends)) throw new Bad(`slice ${s.id}: "depends" must be a list`)
  }
  for (const s of doc.slices) for (const d of s.depends) {
    if (!ids.has(d)) throw new Bad(`slice ${s.id} depends on unknown slice ${d}`)
    if (d === s.id) throw new Bad(`slice ${s.id} depends on itself`)
  }
  const byId = Object.fromEntries(doc.slices.map((s) => [s.id, s]))
  // cycles, and the transitive closure used to know which slices can run together
  const closure = {}
  const visiting = new Set()
  const walk = (id, chain) => {
    if (closure[id]) return closure[id]
    if (visiting.has(id)) throw new Bad(`dependency cycle: ${[...chain, id].join(' -> ')}`)
    visiting.add(id)
    const set = new Set()
    for (const d of byId[id].depends) { set.add(d); for (const x of walk(d, [...chain, id])) set.add(x) }
    visiting.delete(id)
    return (closure[id] = set)
  }
  for (const s of doc.slices) walk(s.id, [])
  // two slices with no dependency path between them may run together, so their files must not clash
  for (let i = 0; i < doc.slices.length; i++) for (let j = i + 1; j < doc.slices.length; j++) {
    const a = doc.slices[i], b = doc.slices[j]
    if (closure[a.id].has(b.id) || closure[b.id].has(a.id)) continue
    const c = clash(a, b)
    if (c) throw new Bad(`slices ${a.id} and ${b.id} can run at the same time but share files (${c}). Make them disjoint or make one depend on the other.`)
  }
  return { slices: doc.slices, byId, closure }
}

function loadState(p) {
  try { return JSON.parse(readFileSync(p.state, 'utf8')) } catch { return {} }
}
function saveState(p, st) {
  mkdirSync(p.sdir, { recursive: true })
  writeFileSync(p.state, JSON.stringify(st, null, 2) + '\n')
}

// ------------------------------------------------------------------ snapshot

const IGNORE = [/^\.git(\/|$)/, /^\.sdlc(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)(test-results|playwright-report|\.playwright)(\/|$)/, /(^|\/)\.DS_Store$/, /\.log$/]

function snapshot(root = '.') {
  const out = {}
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name
      if (IGNORE.some((re) => re.test(r))) continue
      const full = join(root, r)
      const st = statSync(full)
      if (st.isDirectory()) walk(r)
      else if (st.isFile()) out[r] = createHash('sha1').update(readFileSync(full)).digest('hex')
    }
  }
  walk('')
  return out
}

function changed(before, after) {
  const files = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...files].filter((f) => before[f] !== after[f]).sort()
}

// ------------------------------------------------------------------ trace

function note(feature, text) {
  spawnSync(process.execPath, [join(HERE, 'sdlc-trace.mjs'), '--feature', feature, '--log',
    '--from', 'leader', '--to', 'leader', '--kind', 'note', '--note', text], { stdio: 'ignore' })
}

// ------------------------------------------------------------------ commands

const status = (st, id) => (st[id] && st[id].status) || 'pending'

function waves(L) {
  const level = {}
  const lv = (id) => (level[id] ??= L.byId[id].depends.length ? 1 + Math.max(...L.byId[id].depends.map(lv)) : 0)
  L.slices.forEach((s) => lv(s.id))
  const out = []
  for (const s of L.slices) (out[level[s.id]] ??= []).push(s.id)
  return out
}

function readyIds(L, st) {
  const running = L.slices.filter((s) => status(st, s.id) === 'running')
  return L.slices.filter((s) => {
    if (status(st, s.id) !== 'pending') return false
    if (!s.depends.every((d) => status(st, d) === 'done')) return false
    return !running.some((r) => clash(s, r))
  }).map((s) => s.id)
}

function cmdPlan(p, json) {
  const L = load(p)
  const w = waves(L)
  if (json) return console.log(JSON.stringify({ waves: w }))
  console.log(`${L.slices.length} slices, ${w.length} wave(s). Slices in one wave can run at the same time.`)
  w.forEach((ids, i) => console.log(`  wave ${i + 1}: ${ids.join(', ')}`))
}

function cmdReady(p, json) {
  const L = load(p)
  const ids = readyIds(L, loadState(p))
  if (json) console.log(JSON.stringify({ ready: ids }))
  else ids.forEach((i) => console.log(i))
  return ids.length ? 0 : 1
}

function cmdStart(p, id) {
  const L = load(p)
  if (!L.byId[id]) throw new Bad(`unknown slice: ${id}`)
  const st = loadState(p)
  if (!readyIds(L, st).includes(id)) {
    throw new Bad(`slice ${id} is not ready (status ${status(st, id)}; needs ${L.byId[id].depends.join(', ') || 'nothing'} done and no clash with a running slice)`)
  }
  mkdirSync(p.sdir, { recursive: true })
  writeFileSync(`${p.sdir}/${id}.snap.json`, JSON.stringify(snapshot()))
  st[id] = { status: 'running', started: Date.now() }
  saveState(p, st)
  note(p.feature, `slice ${id} started`)
  console.log(`started ${id}. Builder lane: ${id}. Own files: ${L.byId[id].owns.join(', ')}`)
}

function cmdDone(p, id) {
  const L = load(p)
  const s = L.byId[id]
  if (!s) throw new Bad(`unknown slice: ${id}`)
  const st = loadState(p)
  if (status(st, id) !== 'running') throw new Bad(`slice ${id} is ${status(st, id)}, not running`)
  const snapFile = `${p.sdir}/${id}.snap.json`
  const before = existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, 'utf8')) : null
  if (!before) throw new Bad(`no snapshot for ${id}; use start first`)
  const now = Date.now()
  const mine = st[id]
  // slices that ran at any point while this one ran may legitimately have written their own files
  const allowed = [...s.owns]
  for (const o of L.slices) {
    if (o.id === id) continue
    const t = st[o.id]
    if (!t || !t.started) continue
    if (t.started <= now && (t.finished ?? now) >= mine.started) allowed.push(...o.owns)
  }
  const outside = changed(before, snapshot()).filter((f) => !matches(allowed, f))
  const reasons = []
  if (outside.length) reasons.push(`changed files outside the slice: ${outside.join(', ')}`)
  let checkOut = ''
  if (s.check) {
    const r = spawnSync(s.check, { shell: true, encoding: 'utf8', timeout: (s.check_timeout_s || 600) * 1000 })
    checkOut = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-15).join('\n')
    if (r.status !== 0) reasons.push(`check failed (exit ${r.status ?? 'timeout'}): ${s.check}`)
  }
  st[id] = { ...mine, status: reasons.length ? 'failed' : 'done', finished: now, reasons }
  saveState(p, st)
  const mins = ((now - mine.started) / 60000).toFixed(1)
  note(p.feature, `slice ${id} ${reasons.length ? 'FAILED' : 'done'} in ${mins} min`)
  if (reasons.length) {
    console.log(`slice ${id} FAILED after ${mins} min`)
    reasons.forEach((r) => console.log(`  - ${r}`))
    if (checkOut) console.log(`  check output (tail):\n${checkOut.replace(/^/gm, '    ')}`)
    return 1
  }
  console.log(`slice ${id} done in ${mins} min`)
  return 0
}

function cmdReset(p, id) {
  const L = load(p)
  if (!L.byId[id]) throw new Bad(`unknown slice: ${id}`)
  const st = loadState(p)
  if (status(st, id) === 'done') throw new Bad(`slice ${id} is done; reset only applies to failed or running slices`)
  delete st[id]
  saveState(p, st)
  console.log(`slice ${id} is pending again`)
}

function cmdStatus(p, json) {
  const L = load(p)
  const st = loadState(p)
  const rows = L.slices.map((s) => {
    const t = st[s.id] || {}
    const end = t.finished ?? Date.now()
    const min = t.started ? (end - t.started) / 60000 : 0
    const over = t.status === 'running' && s.budget_min && min > s.budget_min
    return { id: s.id, title: s.title || '', status: status(st, s.id), minutes: Number(min.toFixed(1)), budget_min: s.budget_min || null, over_budget: !!over, depends: s.depends, reasons: t.reasons || [] }
  })
  if (json) return console.log(JSON.stringify({ slices: rows }))
  for (const r of rows) {
    const extra = r.over_budget ? `  OVER BUDGET (${r.budget_min} min)` : r.reasons.length ? `  ${r.reasons[0]}` : ''
    console.log(`${r.id.padEnd(14)} ${r.status.padEnd(8)} ${r.minutes ? r.minutes + ' min' : ''}${extra}`)
  }
}

// ------------------------------------------------------------------ main

const USAGE = `sdlc-slices.mjs <plan|ready|start|done|reset|status> <feature> [slice-id] [--json]`

try {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const [cmd, feature, id] = args.filter((a) => a !== '--json')
  if (!cmd || cmd === '-h' || cmd === '--help') { console.log(USAGE); process.exit(cmd ? 0 : 3) }
  const p = paths(feature)
  const need = () => { if (!id) throw new Bad(`${cmd} needs a slice id`); return id }
  let rc = 0
  switch (cmd) {
    case 'plan': cmdPlan(p, json); break
    case 'ready': rc = cmdReady(p, json); break
    case 'start': cmdStart(p, need()); break
    case 'done': rc = cmdDone(p, need()); break
    case 'reset': cmdReset(p, need()); break
    case 'status': cmdStatus(p, json); break
    default: throw new Bad(`unknown command: ${cmd}\n${USAGE}`)
  }
  process.exit(rc)
} catch (e) {
  if (e instanceof Bad) { console.error(`sdlc-slices: ${e.message}`); process.exit(3) }
  throw e
}
