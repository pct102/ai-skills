#!/usr/bin/env node
// sdlc-diagrams — turn one feature's recorded state into Archify diagrams.
//
//   sdlc-diagrams.mjs --feature <f> [--only trace,lifecycle] [--no-browser]
//
// Reads  .sdlc/features/<f>/{trace.jsonl,status.json,evidence.json}
// Writes .sdlc/features/<f>/diagrams/
//          trace.sequence.{json,html}   who said what to whom, in time order     (sequence)
//          lifecycle.{json,html}        where the feature is in its phase machine (lifecycle). Only while the
//                                       feature is NOT accepted: an accepted feature always ends in the same place.
//          index.html                   hub linking every *.html in that folder, including any
//                                       architecture / workflow diagram the leader authored
//
// The JSON is generated from recorded facts only; nothing here calls a model. Diagrams the leader
// authors itself (feature architecture, user flow) go in the same folder; see the Diagrams step of
// skills/feature-autopilot/SKILL.md.
//
// Renderer: skills/archify (vendored, MIT). Its browser gate needs Chrome or Chromium; without one
// the HTML is still produced and the run says the browser check was skipped.
// Exit: 0 every requested diagram was produced | 1 a diagram failed a gate | 3 usage or missing input
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stamp, clockOf, range } from './trace-time.mjs'

const a = process.argv.slice(2)
const opt = (k, d = '') => { const i = a.indexOf('--' + k); return i < 0 ? d : (a[i + 1] ?? true) }
const has = (k) => a.includes('--' + k)
const die = (code, msg) => { console.error(msg); process.exit(code) }

const feature = opt('feature')
if (!feature) die(3, '--feature required')
const here = dirname(fileURLToPath(import.meta.url))
const archify = resolve(here, '..', 'skills', 'archify', 'bin', 'archify.mjs')
if (!existsSync(archify)) die(3, `archify renderer not found at ${archify}`)
const fdir = join('.sdlc', 'features', feature)
if (!existsSync(fdir)) die(3, `no ${fdir} in ${process.cwd()}`)
const ddir = join(fdir, 'diagrams')
mkdirSync(ddir, { recursive: true })
const only = String(opt('only', 'trace,lifecycle')).split(',').map((s) => s.trim())

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const readLines = (p) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
const clock = (iso) => clockOf(iso)
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s }
const dur = (ms) => { const s = Math.round(ms / 1000); if (s < 90) return `${s}s`; const m = Math.round(s / 60); return m < 90 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m` }

// ---------------------------------------------------------------- trace -> sequence
function traceDiagram() {
  const events = readLines(join(fdir, 'trace.jsonl'))
  if (!events.length) return null
  const ACTORS = {
    leader: { type: 'backend', label: 'Leader', sub: 'Claude' },
    builder: { type: 'frontend', label: 'Builder', sub: 'opencode' },
    qa: { type: 'messagebus', label: 'QA', sub: 'opencode' },
    verify: { type: 'database', label: 'Verify', sub: 'sdlc-verify' },
  }
  // A trace names one actor per lane (`builder-lightwell`, `qa-e2e`). Drawn as one lifeline each, a run
  // with several lanes cannot fit archify's canvas at all — its validate gate then refuses the whole
  // render, and no HTML is written, which is what left this diagram missing. So the lanes are folded
  // into their role and each message names the lane it belonged to: the diagram answers "who called
  // whom, and when" across the roles, which is what it is for, and the lane is still on the arrow.
  const roleOf = (id) => {
    const dash = id.indexOf('-')
    const role = dash > 0 ? id.slice(0, dash) : ''
    return (role === 'builder' || role === 'qa') && dash + 1 < id.length ? role : id
  }
  const laneOf = (id) => (roleOf(id) === id ? '' : id.slice(id.indexOf('-') + 1))
  const modelOf = {}   // role -> model of the last lane seen working in it
  for (const e of events) {
    const m = /^\[([^\]]+)\]/.exec(e.note || '')
    if (m && e.to && e.kind === 'prompt') modelOf[roleOf(e.to)] = m[1].split('/').pop()
  }
  const CAP = 60
  const dropped = Math.max(0, events.length - CAP)
  const shown = events.slice(dropped)

  const used = new Set(['leader'])
  for (const e of shown) { used.add(roleOf(e.from)); used.add(roleOf(e.to)) }
  const order = ['leader', 'builder', 'qa', 'verify', ...[...used].filter((x) => !ACTORS[x])].filter((x) => used.has(x))
  const participants = order.map((id) => {
    const d = ACTORS[id] || { type: 'external', label: id, sub: 'actor' }
    const model = modelOf[id] ? modelOf[id] : d.sub
    return { id, type: d.type, label: d.label, sublabel: clip(id === 'leader' || id === 'verify' ? d.sub : model, 22) }
  })
  // How wide archify makes each participant box for the canvas it sizes itself (sideMargin 62, the
  // 920px default width, `column_fit: spread`), and therefore how long a message label may be before
  // its gate rejects the diagram: textUnits(label) * 6.8 must stay within the box plus its 6px slack.
  const boxW = Math.max(86, Math.min(190, Math.round((920 - 124) / Math.max(1, order.length)) - 24))
  const labelMax = Math.max(12, Math.floor((boxW + 6) / 6.8))

  const messages = []
  let pending = []
  const Y0 = 190, STEP = 30, GAP = 30
  let y = Y0
  for (const e of shown) {
    const when = stamp(e.ts)
    if (e.from === e.to) { pending.push(`${when} ${clip(e.note, 200)}`); continue }
    const raw = (e.note || '').replace(/^\[[^\]]+\]\s*/, '').replace(/^\([^)]*\)\s*/, '')
    // A prompt is best named by its file (04-qa-round-1.md -> "qa round 1"); a reply by its first words,
    // unless those are only "I'll start by reading…" boilerplate.
    const stem = e.file ? e.file.split('/').pop().replace(/\.[a-z]+$/i, '').replace(/^\d+[-_]?/, '').replace(/[-_]+/g, ' ').trim() : ''
    const boiler = /^(i['’]ll|i will|let me|reading|first,? i)/i.test(raw)
    const gist = clip(e.kind === 'prompt' && stem ? stem : e.kind === 'reply' && boiler ? '' : raw, 30)
    let label, variant
    if (e.kind === 'prompt') { label = `prompt: ${gist}`; variant = 'emphasis' }
    else if (e.kind === 'reply') {
      const head = [e.ms > 0 ? dur(e.ms) : '', e.rc === 124 ? 'timeout' : e.rc >= 128 ? 'killed' : e.rc ? 'rc=' + e.rc : 'ok'].filter(Boolean).join(' ')
      label = gist ? `${head} · ${gist}` : head
      variant = e.rc ? 'security' : 'return'
    } else if (e.kind === 'verify') { label = e.rc === 0 ? 'verify: all checks pass' : e.rc ? `verify: failed (rc=${e.rc})` : 'verify result'; variant = e.rc ? 'security' : 'return' }
    else { label = `${e.kind}: ${gist}`; variant = 'default' }
    // The lane leads, so a folded role still says which lane a call belonged to.
    const lane = laneOf(e.from) || laneOf(e.to)
    if (lane) label = `[${lane}] ${label}`
    const note = [...pending, `${when} ${clip(e.note, 220)}`].join('\n')
    pending = []
    const who = e.from === 'leader' ? roleOf(e.to) : roleOf(e.from)
    if (messages.length && messages[messages.length - 1]._who !== who) y += GAP
    messages.push({ id: `m${messages.length + 1}`, from: roleOf(e.from), to: roleOf(e.to), y, label: clip(label, labelMax), variant, note, _e: e, _who: who })
    y += STEP
  }
  if (!messages.length) return null

  // One band per run of calls with the same counterpart, labelled with its time span.
  const segments = []
  for (const m of messages) {
    const who = m._who
    const last = segments[segments.length - 1]
    if (last && last.who === who) { last.to = m.y + 16; last.end = m._e.ts }
    else segments.push({ who, from: m.y - 28, to: m.y + 16, start: m._e.ts, end: m._e.ts })
  }
  const segs = segments.map((s) => ({ from: s.from, to: s.to, label: clip(`${(ACTORS[s.who] || { label: s.who }).label} · ${clock(s.start)}${s.end !== s.start ? '-' + clock(s.end) : ''}`, 28) }))

  const all = events
  const calls = (r) => all.filter((e) => e.kind === 'prompt' && e.to === r).length
  const failed = all.filter((e) => e.kind === 'reply' && e.rc)
  const verifies = all.filter((e) => e.kind === 'verify')
  const span = dur(new Date(all[all.length - 1].ts) - new Date(all[0].ts))
  const tags = []
  for (const e of all) { const m = /\((verified: [^)]+|MODEL MISMATCH[^)]*|model unverified[^)]*)\)/.exec(e.note || ''); if (m && e.kind === 'reply') tags.push(`${e.from}: ${clip(m[1], 60)}`) }
  const uniqTags = [...new Set(tags)]
  const lastVerify = verifies[verifies.length - 1]
  const cards = [
    { dot: 'cyan', title: 'Run', items: [
      `${range(all[0].ts, all[all.length - 1].ts)} (${span})`,
      `${calls('builder')} builder call(s), ${calls('qa')} QA call(s)`,
      verifies.length ? `verify ran ${verifies.length} time(s); last: ${lastVerify.rc === 0 ? 'all checks pass' : lastVerify.rc ? 'failed rc=' + lastVerify.rc : 'result recorded'}` : 'verify has not run yet',
      ...(dropped ? [`${dropped} earlier event(s) not drawn; see trace.html`] : []),
    ] },
    { dot: failed.length ? 'rose' : 'emerald', title: 'Problems', items: failed.length
      ? failed.slice(0, 4).map((e) => `${stamp(e.ts)} ${e.from} rc=${e.rc}${e.rc === 124 ? ' (timeout, continued)' : e.rc >= 128 ? ' (killed)' : ''}`)
      : ['No failed or killed call'] },
    { dot: uniqTags.some((t) => /MISMATCH|unverified/.test(t)) ? 'amber' : 'violet', title: 'Models', items: uniqTags.length ? uniqTags.slice(0, 4) : ['No model verification recorded'] },
  ]
  return {
    type: 'sequence',
    file: 'trace.sequence',
    json: {
      schema_version: 1,
      diagram_type: 'sequence',
      meta: { title: `Autopilot trace: ${feature}`, output: join(ddir, 'trace.sequence.html').split('\\').join('/'), column_fit: 'spread', quality_profile: 'showcase' },
      participants, segments: segs,
      messages: messages.map(({ _e, _who, ...m }) => m),
      cards,
    },
  }
}

// ---------------------------------------------------------------- status -> lifecycle
function lifecycleDiagram() {
  const st = readJson(join(fdir, 'status.json'))
  if (!st) return null
  if (st.phase === 'accepted') return { skip: 'the feature is accepted, so the status map would only repeat the end of the line' }
  const ev = readJson(join(fdir, 'evidence.json'))
  const now = st.phase
  const tag = (id, base) => (id === now ? 'NOW' : base)
  const states = [
    { id: 'contract', type: 'start', label: 'Contract', sublabel: 'outcome agreed', lane: 'main', col: 0, tag: tag('contract', 'start') },
    { id: 'planned', type: 'neutral', label: 'Planned', sublabel: 'acceptance.yaml written', lane: 'main', col: 1, tag: tag('planned', 'plan') },
    { id: 'building', type: 'active', label: 'Building', sublabel: 'builder implements', lane: 'main', col: 2, tag: tag('building', 'work') },
    { id: 'validating', type: 'decision', label: 'Validating', sublabel: 'sdlc-verify runs checks', lane: 'main', col: 3, tag: tag('validating', 'gate') },
    { id: 'accepted', type: 'success', label: 'Accepted', sublabel: 'every check passed', lane: 'main', col: 4, tag: tag('accepted', 'done') },
    { id: 'blocked', type: 'waiting', label: 'Blocked', sublabel: 'manual gate pending', lane: 'waiting', col: 3, tag: tag('blocked', 'human') },
    { id: 'escalated', type: 'failure', label: 'Escalated', sublabel: 'repair budget spent', lane: 'terminal', col: 3, tag: tag('escalated', 'human') },
  ]
  const budget = st.budget ?? '?'
  const transitions = [
    { from: 'contract', to: 'planned', label: 'contract written' },
    { from: 'planned', to: 'building', label: 'dispatch' },
    { from: 'building', to: 'validating', label: 'verify run' },
    { from: 'validating', to: 'accepted', label: 'all pass', variant: 'emphasis' },
    { from: 'validating', to: 'building', label: 'fix and retry', variant: 'dashed' },
    { from: 'validating', to: 'blocked', label: 'gate', variant: 'security' },
    { from: 'blocked', to: 'validating', label: 'approved' },
    { from: 'validating', to: 'escalated', label: 'budget spent', variant: 'security' },
    { from: 'escalated', to: 'validating', label: 'human reset', variant: 'dashed' },
  ]
  const lr = st.last_run
  const items = [
    `Phase now: ${now}`,
    `Failed validations: ${st.repair_iterations ?? 0} of ${budget}`,
    lr ? `Last run ${stamp(lr.at)}: ${lr.result}, ${lr.passed} passed, ${lr.failed} failed` : 'No validation run yet',
  ]
  const cards = [
    { dot: now === 'accepted' ? 'emerald' : now === 'escalated' ? 'rose' : now === 'blocked' ? 'amber' : 'cyan', title: 'Where it is', items },
    { dot: 'slate', title: 'Who moves it', items: ['Only sdlc-verify grants accepted', 'An agent may declare planned or building', 'Only a person resets a spent budget'] },
  ]
  if (st.blocked_reason) cards[0].items.push(`Reason: ${clip(st.blocked_reason, 90)}`)
  if (ev && Array.isArray(ev.checks)) {
    const bad = ev.checks.filter((c) => !c.ok).map((c) => c.id)
    cards.push({ dot: bad.length ? 'rose' : 'emerald', title: 'Checks', items: bad.length ? [`Failing: ${clip(bad.join(', '), 80)}`] : [`All ${ev.checks.length} check(s) passed`] })
  }
  return {
    type: 'lifecycle',
    file: 'lifecycle',
    json: {
      schema_version: 2,
      diagram_type: 'lifecycle',
      meta: { title: `Feature status: ${feature}`, output: join(ddir, 'lifecycle.html').split('\\').join('/'), quality_profile: 'showcase' },
      lanes: [{ id: 'main', label: 'Delivery' }, { id: 'waiting', label: 'Human gate' }, { id: 'terminal', label: 'Needs a person' }],
      states, transitions, cards,
    },
  }
}

// ---------------------------------------------------------------- render
function findChrome() {
  if (process.env.ARCHIFY_CHROME) return process.env.ARCHIFY_CHROME
  const cands = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ]
  try {
    for (const d of readdirSync('/opt/pw-browsers')) if (d.startsWith('chromium-')) cands.push(`/opt/pw-browsers/${d}/chrome-linux/chrome`)
  } catch { /* no playwright browsers here */ }
  return cands.find((c) => existsSync(c))
}
const chrome = has('no-browser') ? undefined : findChrome()
const env = { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1', ...(chrome ? { ARCHIFY_CHROME: chrome } : {}) }

function render(d) {
  // Regenerating is the normal case: clear what the previous run of this same diagram left behind,
  // because archify refuses to overwrite receipts it did not just create.
  for (const stale of [join(ddir, 'receipts', d.file), join(ddir, `${d.file}.html`), join(ddir, `${d.file}.delivery.json`), join(ddir, `${d.file}.delivery-pending.json`)]) rmSync(stale, { recursive: true, force: true })
  const jsonPath = join(ddir, `${d.file}.json`)
  writeFileSync(jsonPath, JSON.stringify(d.json, null, 2) + '\n')
  const out = d.json.meta.output
  const r = spawnSync(process.execPath, [archify, 'finalize', d.type, jsonPath, out, '--quality', 'showcase', '--out-dir', join(ddir, 'receipts', d.file), '--json'], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  let res = null
  try { res = JSON.parse(r.stdout) } catch { /* fall through */ }
  if (!res) return { ok: false, why: clip(r.stderr || r.stdout || 'archify produced no result', 300) }
  const g = res.gates || {}
  const core = g.validate === 'pass' && g.deliver === 'pass' && g.check === 'pass'
  if (res.ok) return { ok: true, note: 'all gates passed, browser check passed' }
  if (core && g['browser-check'] === 'skipped') return { ok: true, note: 'browser check skipped (no Chrome found; set ARCHIFY_CHROME)' }
  const diag = (res.diagnostics || []).slice(0, 3).map((x) => `${x.code}: ${clip(x.message, 140)}`).join(' | ')
  return { ok: false, why: `${res.failedStage || 'unknown'} gate: ${diag || 'no diagnostics'}` }
}

// Older versions also drew a per-feature copy of the autopilot process map. It was the same for every feature, so it is
// no longer made; remove the copy an earlier run left in this folder.
for (const old of [join(ddir, 'process.json'), join(ddir, 'process.html'), join(ddir, 'process.workflow.html'), join(ddir, 'process.delivery.json'), join(ddir, 'receipts', 'process')]) rmSync(old, { recursive: true, force: true })

const jobs = []
if (only.includes('trace')) jobs.push(['trace', traceDiagram()])
if (only.includes('lifecycle')) jobs.push(['lifecycle', lifecycleDiagram()])
let failed = 0
for (const [name, d] of jobs) {
  if (!d) { console.log(`- ${name}: nothing recorded yet, skipped`); continue }
  if (d.skip) {
    console.log(`- ${name}: skipped, ${d.skip}`)
    // an earlier run, while the feature was not accepted yet, may have left this map behind; it would show a stale phase
    for (const stale of [join(ddir, `${name}.json`), join(ddir, `${name}.html`), join(ddir, `${name}.delivery.json`), join(ddir, 'receipts', name)]) rmSync(stale, { recursive: true, force: true })
    continue
  }
  const r = render(d)
  if (r.ok) console.log(`+ ${name}: ${d.json.meta.output}  (${r.note})`)
  else { failed++; console.log(`! ${name}: ${r.why}`) }
}

// ---------------------------------------------------------------- hub
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
const pages = readdirSync(ddir).filter((f) => f.endsWith('.html') && f !== 'index.html').sort()
const titleOf = (f) => { const m = /<title>([^<]*)<\/title>/.exec(readFileSync(join(ddir, f), 'utf8').slice(0, 4000)); return m ? m[1] : f }
const side = existsSync(join(fdir, 'trace.html')) ? ['<li><a href="../trace.html">Full message log (trace.html)</a><span>every prompt and reply, expandable</span></li>'] : []
const li = pages.map((f) => `<li><a href="${esc(f)}">${esc(titleOf(f))}</a><span>${esc(f)} · ${Math.round(statSync(join(ddir, f)).size / 1024)} KB</span></li>`)
const expected = [['architecture.html', 'How it is built (architecture)'], ['workflow.html', 'What the user does (workflow)']]
const missing = expected.filter(([f]) => !pages.includes(f)).map(([f, t]) => `<li class="miss"><b>${esc(t)}</b><span>not drawn yet. Run: <code>claude -p "/feature-diagrams feature name: ${esc(feature)}" --dangerously-skip-permissions</code></span></li>`)
writeFileSync(join(ddir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagrams: ${esc(feature)}</title>
<style>:root{--bg:#f5f6f8;--fg:#14181f;--mut:#5b6472;--card:#fff;--line:#dde1e8;--acc:#0e7490}@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b96a5;--card:#161b22;--line:#2a313c;--acc:#67e8f9}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}p{color:var(--mut);margin:0 0 20px}
ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;display:flex;flex-direction:column}a{color:var(--acc);font-weight:600;text-decoration:none}a:hover{text-decoration:underline}li span{color:var(--mut);font-size:13px}li.miss{border-style:dashed}li.miss b{color:var(--mut)}code{font-size:12px;word-break:break-all}</style></head>
<body><main><h1>${esc(feature)}</h1><p>Diagrams for this feature: the run (and the status while the feature is not accepted) is drawn from recorded facts; the build and the player flow are drawn from the code by /feature-diagrams.</p><ul>${[...li, ...missing, ...side].join('\n')}</ul></main></body></html>\n`)
console.log(`hub: ${join(ddir, 'index.html')}`)
process.exit(failed ? 1 : 0)
