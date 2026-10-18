// evidence-page — one HTML page per feature that answers "what did the tests see, and where is it wrong?"
// Called by sdlc-diagrams.mjs, which writes the result to <feature>/diagrams/evidence.html so the hub lists it.
//
// Reads (all optional; returns null when there is nothing to show):
//   evidence/playwright.json      Playwright's json report  -> one row per test, failures first, with its steps and errors
//   evidence/*.png, round-N/      screenshots; <id>-<step>.png belongs to the test whose title starts with <id>
//                                 round-N/ holds the same names from an earlier FAILED run, shown as "before"
//   visual-review.md              the visual reviewer's `FLAG | <id> | <image> | <what looks wrong> | <spec line>` lines
// Images are linked, not embedded, so the page stays small; it is meant to be opened from the feature folder.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { behaviourId, parsePlaywright } from './pw-report.mjs'

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
const IMG = /\.(png|jpe?g|webp|gif)$/i
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`)
const ORDER = { failed: 0, flaky: 1, skipped: 2, passed: 3 }

export function parseVisualReview(text) {
  const flags = []
  for (const l of String(text).split('\n')) {
    const m = /^\s*FLAG\s*\|(.*)$/.exec(l)
    if (!m) continue
    const [id = '', image = '', what = '', spec = ''] = m[1].split('|').map((x) => x.trim())
    flags.push({ id, image, what, spec })
  }
  const verdict = (/VISUAL RESULT:\s*(.+)/i.exec(text) || [])[1] || ''
  return { flags, verdict: verdict.trim() }
}

export function renderEvidencePage({ feature, fdir, outDir }) {
  const evDir = join(fdir, 'evidence')
  const rel = (p) => relative(outDir, resolve(p)).split('\\').join('/')
  const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
  const pwText = read(join(evDir, 'playwright.json'))
  const visText = read(join(fdir, 'visual-review.md'))
  if (pwText == null && visText == null) return null

  const rep = pwText == null ? null : parsePlaywright(pwText)
  const latest = existsSync(evDir) ? readdirSync(evDir).filter((f) => IMG.test(f)).sort() : []
  const rounds = existsSync(evDir) ? readdirSync(evDir).filter((f) => /^round-\d+$/.test(f)).sort((a, b) => a.slice(6) - b.slice(6)) : []
  const before = (name) => rounds.filter((r) => existsSync(join(evDir, r, name)))
  const fig = (src, cap, cls = '') => `<figure class="${cls}"><a href="${esc(src)}" target="_blank"><img loading="lazy" src="${esc(src)}" alt="${esc(cap)}"></a><figcaption>${esc(cap)}</figcaption></figure>`

  // ---- visual reviewer's flags
  let visual = ''
  if (visText != null) {
    const v = parseVisualReview(visText)
    const cards = v.flags.map((f) => {
      const img = f.image && IMG.test(f.image) ? (f.image.includes('/') ? f.image : join(evDir, f.image)) : ''
      return `<div class="flag"><b>${esc(f.id || '?')}</b> ${esc(f.what)}${f.spec ? `<small>spec: ${esc(f.spec)}</small>` : ''}${img && existsSync(img) ? fig(rel(img), f.image) : f.image ? `<small>${esc(f.image)}</small>` : ''}</div>`
    })
    visual = `<section><h2>Visual review ${v.flags.length ? `<span class="pill warn">${v.flags.length} to look at</span>` : '<span class="pill ok">nothing flagged</span>'}</h2>
<p class="mut">A second reviewer looked at the screenshots against the spec. These are suspicions, not verdicts: they never change the acceptance result.${v.verdict ? ` Reviewer's line: <code>${esc(v.verdict)}</code>` : ''}</p>
${cards.join('\n') || ''}<details><summary>Full review text</summary><pre>${esc(visText)}</pre></details></section>`
  }

  // ---- tests
  let body = ''
  let summary = ''
  if (rep && !rep.ok) body = `<section><h2>Tests</h2><p class="bad">Cannot read evidence/playwright.json: ${esc(rep.error)}</p></section>`
  else if (rep) {
    const { stats } = rep
    summary = `<div class="chips"><span class="pill ok">${stats.passed} passed</span><span class="pill ${stats.failed ? 'bad' : 'mut'}">${stats.failed} failed</span><span class="pill ${stats.flaky ? 'warn' : 'mut'}">${stats.flaky} flaky</span><span class="pill ${stats.skipped ? 'warn' : 'mut'}">${stats.skipped} skipped</span></div>`
    const rows = [...rep.specs].sort((x, y) => ORDER[x.status] - ORDER[y.status]).map((t) => {
      const id = behaviourId(t.title)
      const shots = new Map()
      for (const a of t.attachments) if (a.path && IMG.test(a.path) && existsSync(a.path)) shots.set(basename(a.path), a.path)
      if (id) for (const f of latest) if (f.toLowerCase().startsWith(id.toLowerCase() + '-')) shots.set(f, join(evDir, f))
      const figs = [...shots].map(([name, path]) => {
        const b = before(name).map((r) => fig(rel(join(evDir, r, name)), `before (${r})`, 'before'))
        return `<div class="pair">${b.join('')}${fig(rel(path), name)}</div>`
      })
      const steps = t.steps.length ? `<ol class="steps">${t.steps.map((s) => `<li style="margin-left:${s.depth * 14}px" class="${s.error ? 'bad' : ''}">${esc(s.title)} <small>${ms(s.duration)}</small>${s.error ? `<small class="bad"> ${esc(s.error)}</small>` : ''}</li>`).join('')}</ol>` : ''
      const errs = t.errors.length ? `<pre class="err">${esc(t.errors.slice(0, 2).join('\n---\n').slice(0, 1800))}</pre>` : ''
      const open = t.status === 'passed' ? '' : ' open'
      return `<details class="t ${t.status}"${open}><summary><span class="pill ${t.status === 'passed' ? 'ok' : t.status === 'failed' ? 'bad' : 'warn'}">${t.status}</span> ${id ? `<b>${esc(id)}</b> ` : ''}${esc(id ? t.title.replace(/^\s*(@\w+\s+)?[A-Za-z]+\d+(?:[.-]\d+)*[:\s-]*/, '') : t.title)} <small>${ms(t.duration)}${t.retries ? ` · ${t.retries} retr${t.retries > 1 ? 'ies' : 'y'}` : ''}</small></summary>${errs}${steps}${figs.length ? `<div class="gallery">${figs.join('')}</div>` : '<p class="mut">no screenshot for this test</p>'}</details>`
    })
    const pwHtml = join(fdir, '..', '..', '..', 'playwright-report', 'index.html')
    body = `<section><h2>Tests</h2>${summary}${rows.join('\n')}${existsSync(pwHtml) ? `<p class="mut">Traces and the full step timeline: <a href="${esc(rel(pwHtml))}">Playwright report</a></p>` : ''}</section>`
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test evidence: ${esc(feature)}</title>
<style>:root{--bg:#f5f6f8;--fg:#14181f;--mut:#5b6472;--card:#fff;--line:#dde1e8;--acc:#0e7490;--ok:#15803d;--bad:#b91c1c;--warn:#b45309}@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b96a5;--card:#161b22;--line:#2a313c;--acc:#67e8f9;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1000px;margin:0 auto;padding:28px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 10px}.mut,small{color:var(--mut)}small{font-size:12px}a{color:var(--acc)}
.pill{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid currentColor}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.chips{display:flex;gap:8px;margin:0 0 12px}
details.t,.flag{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0}details.failed{border-color:var(--bad)}details.flaky,.flag{border-color:var(--warn)}summary{cursor:pointer}
pre{overflow:auto;background:var(--bg);border-radius:6px;padding:8px;font-size:12px;white-space:pre-wrap}.steps{margin:8px 0;padding-left:22px;font-size:13px}.gallery{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}
.pair{display:flex;gap:6px;align-items:flex-start}figure{margin:0}figure img{max-width:230px;max-height:170px;border:1px solid var(--line);border-radius:6px;display:block}figure.before img{opacity:.75;border-color:var(--bad)}figcaption{font-size:11px;color:var(--mut)}.flag small{display:block}</style></head>
<body><main><h1>Test evidence</h1><p class="mut">${esc(feature)}. Failures first; open a row to see its steps, errors and screenshots. A red-bordered picture is the same screenshot from an earlier failed run.</p>${visual}${body}</main></body></html>\n`
}
