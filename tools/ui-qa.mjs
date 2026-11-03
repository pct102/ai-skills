#!/usr/bin/env node
// ui-qa — black-box UI check of a running web app from its URL alone (no source code read).
//
//   ui-qa.mjs <url> [--depth 1] [--max-pages 5] [--max-clicks 25] [--out <dir>] [--auth <storageState.json>]
//                   [--issue-min medium|low|high] [--max-issues 8] [--design-polish [--max-design-issues 6]] [--headed] [--allow-remote] [--allow-destructive]
//                   [--ignore <css selectors>] [--ignore-console <regex>]   (defaults skip Next.js dev overlay + React's script-tag dev warning)
//                   [--seed <url|path>]... (extra same-origin pages, tested without crawling on)  [--impeccable] [--impeccable-version 4.8.0]   (opt-in design pass by the third-party `impeccable detect`, via npx)
//   ui-qa.mjs file <out-dir> [--with-images]   file the issues a run wrote (needs ISSUE_TRACKER, see sdlc-issue.mjs)
//     --with-images (GitHub): also upload the worst findings' screenshots with the `gh image` extension and post them as an
//     "evidence" comment. That extension signs in with your BROWSER's GitHub session cookie (unofficial endpoint): opt-in only.
//     A rerun that finds the issue already open comments only the findings that issue does not list yet (silent when none).
//
// Per page: 4 viewports x light/dark -> overflow, small touch targets, broken images, text contrast, dark-mode gaps, screenshots.
// On the desktop + mobile light pass it also scrolls (layout shift), tabs (focus ring), clicks/hovers every safe control
// (blocked, dead, dialog Esc, slow transitions), picks every <select> option, drags [draggable], and live-resizes.
// Every run lists uncaught exceptions, console errors and failing requests, and compares animations with prefers-reduced-motion.
// Safe by default: localhost / private hosts only, every non-GET request is aborted, destructive-looking controls are skipped.
// Writes <out>/report.md, findings.json, screens/*.png, issues.json + issues/*.md. It never files issues by itself.
// Exit: 0 done | 1 high-severity findings, or a tool/setup error | 3 usage error
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { setting } from './lib/setting.mjs'

const argv = process.argv.slice(2)
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] ?? d) }
const has = (k) => argv.includes('--' + k)
const die = (code, msg) => { console.error(`ui-qa: ${msg}`); process.exit(code) }
const HERE = dirname(fileURLToPath(import.meta.url))

function renderProblems(list) {
  return list.flatMap((q, i) => [`### ${i + 1}. ${q.title} (${q.sev})`, `- **Expected:** ${q.expected}`,
    ...q.rows.map((f) => `- \`${f.path}\` · ${f.ctxs.join(', ')}${f.detail ? ` · ${f.detail}` : ''}${f.shot ? ` · screenshot \`${f.shot}\`` : ''}`), '']).join('\n')
}
if (argv[0] === 'file') {
  const dir = argv[1] || die(3, 'usage: ui-qa.mjs file <out-dir>')
  const list = existsSync(join(dir, 'issues.json')) ? JSON.parse(readFileSync(join(dir, 'issues.json'), 'utf8')) : die(3, `no issues.json in ${dir}`)
  const tracker = setting('ISSUE_TRACKER').toLowerCase()
  if (!tracker) { console.log('ui-qa: ISSUE_TRACKER is off, nothing filed. Set ISSUE_TRACKER=github in ./.sdlc/autopilot.env (see autopilot.env.example).'); process.exit(0) }
  let bad = 0
  const gh = tracker === 'github'
  const sdlc = (args) => spawnSync('node', [join(HERE, 'sdlc-issue.mjs'), ...args], { encoding: 'utf8' })
  if (has('with-images') && !gh) console.log('ui-qa: --with-images works with ISSUE_TRACKER=github only; filing text only.')
  for (const i of list) {
    const r = sdlc(['create', '--title', i.title, '--body-file', join(dir, i.body)])
    const said = r.stdout.trim() || r.stderr.trim(); console.log(said)
    if (r.status) { bad = 1; continue }
    const m = said.match(/(already filed|filed): (#\d+)/); if (!gh || !m) continue
    if (m[1] === 'filed' && (i.priority || i.design)) { const l = sdlc(['label', '--key', m[2], '--add', [i.priority && `priority:${i.priority}`, i.design && 'design-polish'].filter(Boolean).join(',')]); if (l.status) console.log(`  labels not set: ${(l.stderr || l.stdout).trim()}`) }
    const again = m[1] === 'already filed', date = new Date().toISOString().slice(0, 10)
    let shots = has('with-images') ? (i.shots || []).map((x) => join(dir, x)).filter(existsSync) : [], text = `UI QA evidence (${date}).`
    if (again && i.problems) { // an open issue already tracks this area: say only what it does not list yet
      const v = spawnSync('gh', ['issue', 'view', m[2].replace('#', ''), ...(setting('ISSUE_GITHUB_REPO') ? ['--repo', setting('ISSUE_GITHUB_REPO')] : []), '--json', 'body,comments'], { encoding: 'utf8' })
      let seen = ''; try { const j = JSON.parse(v.stdout); seen = [j.body, ...j.comments.map((c) => c.body)].join('\n') } catch {}
      const fresh = i.problems.map((q) => ({ ...q, rows: q.rows.filter((f) => !(seen.includes(q.title) && seen.includes('`' + f.path + '`'))) })).filter((q) => q.rows.length)
      if (!fresh.length) { console.log(`  ${m[2]}: nothing new since the issue was filed`); continue }
      text = `New ui-qa run on ${date}${i.profile ? ` as ${i.profile}` : ''} (${i.origin}): ${fresh.reduce((n, q) => n + q.rows.length, 0)} finding(s) this issue does not list yet.\n\n${renderProblems(fresh)}`
      shots = has('with-images') ? [...new Set(fresh.flatMap((q) => q.rows.map((f) => f.shot)).filter(Boolean))].slice(0, 4).map((x) => join(dir, x)).filter(existsSync) : []
    } else if (again) text = `New ui-qa run on ${date}${i.profile ? ` as ${i.profile}` : ''} (${i.origin}) found this again:\n\n${readFileSync(join(dir, i.body), 'utf8')}`
    else if (!shots.length) continue // a fresh issue needs no comment unless it carries images
    const c = sdlc(['comment', '--key', m[2], '--body', text, ...shots.flatMap((x) => ['--image', x])])
    console.log([c.stdout, c.stderr].map((x) => x.trim()).filter(Boolean).join('\n')); if (c.status) bad = 1
  }
  process.exit(bad)
}

// ---------- setup
const target = argv[0] && !argv[0].startsWith('--') ? argv[0] : die(3, 'usage: ui-qa.mjs <url> [flags]')
let root; try { root = new URL(target) } catch { die(3, `not a URL: ${target}`) }
if (!/^https?:$/.test(root.protocol)) die(3, 'only http(s) URLs')
const localHost = /^(localhost|127\.|\[?::1\]?$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.(local|localhost)$/.test(root.hostname)
if (!localHost && !has('allow-remote') && !has('login')) die(3, `${root.hostname} is not a local/private host. ui-qa clicks everything, so point it at localhost or staging (override: --allow-remote)`)
const safe = !has('allow-destructive')
const DENY = 'delete|remove|destroy|erase|reset|clear|pay|purchase|buy|checkout|order|subscribe|sign.?out|log.?out|unsubscribe|deactivate|cancel|submit|send|publish|xoá|xóa|thanh toán|đăng xuất|mua'

const req = createRequire(join(process.cwd(), 'x.js'))
let chromium
for (const m of ['playwright', '@playwright/test', 'playwright-core']) { try { ({ chromium } = req(m)); break } catch {} }
if (!chromium) die(1, 'playwright not found from this directory. Run in a project that has it, or: npm i --no-save playwright && npx playwright install chromium')

const DEPTH = +flag('depth', 1), MAX_PAGES = +flag('max-pages', 5), MAX_CLICKS = +flag('max-clicks', 25), MAX_ISSUES = +flag('max-issues', 8)
const MIN = flag('issue-min', 'medium')
const IGNORE = flag('ignore', 'nextjs-portal,next-route-announcer') // dev overlays are not the app's UI
const IGNORE_CONSOLE = new RegExp(flag('ignore-console', 'Encountered a script tag while rendering React component'), 'i')
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-')
const out = flag('out', join('ui-qa-report', `${root.hostname}-${stamp}`))
mkdirSync(join(out, 'screens'), { recursive: true }); mkdirSync(join(out, 'issues'), { recursive: true })
writeFileSync(join(out, '.gitignore'), '*\n')

const VIEWPORTS = [{ n: 'mobile', w: 375, h: 667 }, { n: 'tablet', w: 768, h: 1024 }, { n: 'laptop', w: 1024, h: 768 }, { n: 'desktop', w: 1440, h: 900 }]
const SEV = { high: 3, medium: 2, low: 1 }
const LABEL = {
  'page-load': 'Pages that fail to load', 'js-exception': 'Uncaught JavaScript errors', 'console-error': 'Console errors',
  network: 'Failing requests', responsive: 'Responsive layout problems', 'broken-image': 'Broken images', contrast: 'Low text contrast',
  'dark-mode': 'Dark mode problems', 'click-blocked': 'Controls blocked by overlays', 'layout-shift': 'Layout shift while scrolling',
  'touch-target': 'Small touch targets', focus: 'Missing focus indicators', motion: 'Motion and transition issues',
  unresponsive: 'Controls with no visible response', dialog: 'Dialogs that do not close with Esc',
  design: 'Design quality problems (Impeccable)',
}
const stats = { pages: 0, loads: 0, clicks: 0, hovers: 0, selects: 0, drags: 0, tabs: 0, resizes: 0 }

// ---------- findings (deduped by category + title + path; contexts merged)
const found = new Map()
const add = (f) => {
  f = { ...f, title: f.title.replace(/([?&])_rsc=[\w-]+&?/g, '$1').replace(/[?&]$/, '') } // Next.js prefetch tokens change every load
  const k = `${f.cat}|${f.title}|${f.path}`, e = found.get(k)
  if (e) e.ctxs.add(f.ctx); else found.set(k, { ...f, ctxs: new Set([f.ctx]) })
}
const sameOrigin = (u) => { try { return new URL(u).origin === root.origin } catch { return false } }
const short = (u) => { try { const x = new URL(u); return x.pathname + x.search } catch { return u } }
const slug = (p) => p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'

async function open(browser, vp, scheme, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: scheme, storageState: flag('auth', undefined), ...extra })
  const c = { blocked: 0 }
  if (safe) await ctx.route('**/*', (r) => (['GET', 'HEAD', 'OPTIONS'].includes(r.request().method()) ? r.continue() : (c.blocked++, r.abort('blockedbyclient'))))
  await ctx.addInitScript(() => {
    window.__cls = 0
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value }).observe({ type: 'layout-shift', buffered: true }) } catch {}
  })
  const page = await ctx.newPage(); page.setDefaultTimeout(4000)
  const log = []
  page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text()) && !IGNORE_CONSOLE.test(m.text())) log.push(['console', m.text().slice(0, 200)]) })
  page.on('pageerror', (e) => log.push(['pageerror', String(e.message).slice(0, 200)]))
  page.on('response', (r) => { const s = r.status(); if (s >= 500 || (s >= 400 && sameOrigin(r.url()))) log.push(['http', `${s} ${r.request().method()} ${short(r.url())}`]) })
  page.on('requestfailed', (r) => { const t = r.failure()?.errorText || ''; if (!/BLOCKED_BY_CLIENT|ABORTED/i.test(t)) log.push(['netfail', `${t} ${short(r.url())}`]) })
  return Object.assign(c, { ctx, page, log, vp, scheme, name: `${vp.n}-${scheme}` })
}

// drains the events captured since the last call; `where` says what the page was doing
function flush(c, path, where) {
  for (const [k, t] of c.log.splice(0)) {
    if (c.blocked && /failed to fetch|networkerror|load failed/i.test(t)) continue // our own blocked POST, not an app bug
    const [cat, sev] = k === 'pageerror' ? ['js-exception', 'high'] : k === 'console' ? ['console-error', 'medium']
      : k === 'http' ? ['network', t.startsWith('5') ? 'high' : 'medium'] : ['network', 'medium']
    add({ sev, cat, title: t, detail: where, path, ctx: c.name, shot: `screens/${slug(path)}-${c.name}.png` })
  }
}

// ---------- in-page layout check (must be self-contained: it is serialised into the page)
const LAYOUT = ({ touch, ignore }) => {
  const r = { overflow: 0, offenders: [], small: [], broken: [], contrast: [], light: [], bg: '', anims: 0 }
  const de = document.documentElement
  const name = (e) => { const c = [...e.classList].slice(0, 2).join('.'); return e.tagName.toLowerCase() + (e.id ? '#' + e.id : c ? '.' + c : '') }
  const shown = (e) => { const b = e.getBoundingClientRect(), s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
  const cv = document.createElement('canvas'); cv.width = cv.height = 1
  const g = cv.getContext('2d', { willReadFrequently: true }), memo = {}
  const rgba = (c) => memo[c] ||= (g.clearRect(0, 0, 1, 1), g.fillStyle = '#000', g.fillStyle = c, g.fillRect(0, 0, 1, 1), [...g.getImageData(0, 0, 1, 1).data])
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]) }
  const bgOf = (e) => { for (; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none') return null; const b = rgba(s.backgroundColor); if (b[3] > 250) return b; if (b[3] > 0) return null } return [255, 255, 255, 255] }
  const skip = (e) => ignore && e.closest(ignore)
  const clipped = (e) => { for (e = e.parentElement; e && e !== de; e = e.parentElement) if (/auto|scroll|hidden|clip/.test(getComputedStyle(e).overflowX)) return true; return false }

  // what the user sees, not <body>: apps often keep a dark body behind a themed wrapper. '' when no sample has a plain colour.
  const probe = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.85]].map(([x, y]) => { const e = document.elementFromPoint(innerWidth * x, innerHeight * y), b = e && bgOf(e); return b ? b.slice(0, 3).join() : 'x' })
  r.bg = probe.every((v) => v === 'x') ? '' : probe.join('|')
  if (de.scrollWidth > innerWidth + 1) {
    r.overflow = de.scrollWidth
    for (const e of document.body.querySelectorAll('*')) {
      if (r.offenders.length >= 5) break
      const b = e.getBoundingClientRect()
      if (b.width && b.right > innerWidth + 1 && shown(e) && !clipped(e) && !skip(e)) r.offenders.push(`${name(e)} (right edge ${Math.round(b.right)}px)`)
    }
  }
  if (touch) for (const e of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab]')) {
    if (r.small.length >= 5) break
    if (e.disabled || !shown(e) || skip(e)) continue
    const b = e.getBoundingClientRect()
    if ((b.width < 24 || b.height < 24) && getComputedStyle(e).display !== 'inline') r.small.push(`${name(e)} ${Math.round(b.width)}x${Math.round(b.height)}`)
  }
  for (const i of document.images) if (r.broken.length < 5 && i.complete && i.naturalWidth === 0 && i.currentSrc) r.broken.push(i.currentSrc.slice(-80))
  const seen = new Set(); let n = 0
  for (const e of document.body.querySelectorAll('*')) {
    if (++n > 1500 || r.contrast.length >= 10) break
    if (/^(script|style|noscript|svg|path)$/i.test(e.tagName) || e.matches('[disabled],[aria-disabled=true]')) continue
    const t = [...e.childNodes].filter((x) => x.nodeType === 3).map((x) => x.textContent).join('').trim()
    if (!t || !shown(e)) continue
    if (skip(e) || !/[\p{L}\p{N}]/u.test(t)) continue // emoji and symbols carry their own colour
    const s = getComputedStyle(e); if (/material|icon|symbol|awesome/i.test(s.fontFamily)) continue // icon fonts are drawn from letters
    const bg = bgOf(e); if (!bg) continue
    const fg = rgba(s.color), a = fg[3] / 255, f = [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a))
    const L1 = lum(f), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    const px = parseFloat(s.fontSize), need = px >= 24 || (px >= 18.66 && +s.fontWeight >= 700) ? 3 : 4.5
    const k = name(e) + t.slice(0, 30)
    if (ratio < need && !seen.has(k)) { seen.add(k); r.contrast.push({ sel: name(e), text: t.slice(0, 30), ratio: +ratio.toFixed(2), need }) }
  }
  // light surface on a dark parent (white pill/button/badge left in dark mode): dark text on white passes contrast, so only this catches it
  n = 0
  for (const e of document.body.querySelectorAll('button,a,[role=button],[role=tab],span,li,div,input,select')) {
    if (++n > 1500 || r.light.length >= 8) break
    if (!e.textContent.trim() || e.children.length > 3 || !shown(e) || skip(e)) continue
    const own = rgba(getComputedStyle(e).backgroundColor), p = e.parentElement && bgOf(e.parentElement)
    const b = e.getBoundingClientRect()
    if (own[3] > 250 && p && lum(own) > 0.5 && lum(p) < 0.1 && b.width < 600 && b.height < 120) r.light.push(`${name(e)} "${e.textContent.trim().slice(0, 24)}" bg rgb(${own.slice(0, 3)}) on dark rgb(${p.slice(0, 3)})`)
  }
  r.anims = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().duration > 200).length
  return r
}

const lightFail = new Map(), lightBg = new Map()
async function layout(c, path, tag = '') {
  const { page, vp, scheme } = c, ctx = c.name + tag, base = { path, ctx, shot: `screens/${slug(path)}-${c.name}${tag}.png` }
  let r; try { r = await page.evaluate(LAYOUT, { touch: vp.w <= 768, ignore: IGNORE }) } catch (e) { return 0 }
  if (r.overflow) add({ ...base, sev: 'medium', cat: 'responsive', title: `Horizontal scroll at ${vp.n} width (${vp.w}px)`, detail: `page is ${r.overflow}px wide. ${r.offenders.join('; ') || 'no single offender found'}` })
  if (r.small.length) add({ ...base, sev: 'low', cat: 'touch-target', title: 'Touch targets under 24px', detail: r.small.join('; ') })
  if (r.broken.length) add({ ...base, sev: 'medium', cat: 'broken-image', title: 'Images that failed to load', detail: r.broken.join('; ') })
  const key = `${path}|${vp.n}`
  const themed = scheme === 'dark' || tag // a theme-toggle re-check is compared with the untouched light baseline, never stored as it
  if (!themed) { lightFail.set(key, new Set(r.contrast.map((x) => x.sel + x.text))); lightBg.set(key, r.bg) }
  const darkOnly = themed ? r.contrast.filter((x) => !lightFail.get(key)?.has(x.sel + x.text)) : []
  const both = r.contrast.filter((x) => !darkOnly.includes(x))
  const line = (x) => `${x.sel} "${x.text}" ${x.ratio}:1 (needs ${x.need})`
  if (both.length) add({ ...base, sev: both.some((x) => x.ratio < 3) ? 'medium' : 'low', cat: 'contrast', title: 'Text contrast below WCAG AA', detail: both.map(line).join('; ') })
  if (darkOnly.length) add({ ...base, sev: darkOnly.some((x) => x.ratio < 3) ? 'medium' : 'low', cat: 'dark-mode', title: 'Dark mode: text contrast below WCAG AA', detail: darkOnly.map(line).join('; ') })
  if (scheme === 'dark' && r.light.length) add({ ...base, sev: 'medium', cat: 'dark-mode', title: 'Dark mode: light surfaces left on a dark background', detail: r.light.join('; ') })
  if (scheme === 'dark' && !tag && r.bg && lightBg.get(key) === r.bg) add({ ...base, sev: 'low', cat: 'dark-mode', title: 'No dark theme: background is identical under prefers-color-scheme: dark', detail: `sampled backgrounds ${r.bg} are identical in both schemes` })
  return r.anims
}

// ---------- interactions
const CLICKABLE = 'button:not([type=submit]),[role=button],[role=tab],[role=menuitem],[role=switch],[role=checkbox],summary,[aria-haspopup],[aria-expanded],[onclick],input[type=checkbox],input[type=radio],select'
const sig = (page) => page.evaluate(() => [location.href, document.body.innerText.length, document.querySelectorAll('*').length, document.documentElement.className, document.documentElement.dataset.theme, document.body.className,
  [...document.querySelectorAll('[aria-expanded],[aria-checked],[aria-selected],[aria-pressed]')].map((e) => ['expanded', 'checked', 'selected', 'pressed'].map((a) => e.getAttribute('aria-' + a)).join('')).join()].join('|')).catch(() => 'nav')
const slow = (page) => page.evaluate(() => document.getAnimations().filter((a) => { const t = a.effect?.getComputedTiming(); return t && t.duration > 800 && t.iterations < Infinity && a.playState === 'running' })
  .map((a) => `${Math.round(a.effect.getComputedTiming().duration)}ms on ${a.effect.target?.tagName?.toLowerCase()}${a.effect.target?.id ? '#' + a.effect.target.id : ''}`)).catch(() => [])

async function interact(c, path, url) {
  const { page } = c, base = { path, ctx: c.name, shot: `screens/${slug(path)}-${c.name}.png` }
  const reset = async () => { await page.goto(url, { timeout: 15000 }).catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {}); c.log.length = 0 }

  // scroll to the bottom, then read layout shift
  for (let i = 0; i < 30; i++) {
    const end = await page.evaluate(() => { scrollBy(0, innerHeight * 0.9); return Math.ceil(scrollY + innerHeight) >= document.documentElement.scrollHeight - 2 }).catch(() => true)
    await page.waitForTimeout(120); if (end) break
  }
  const cls = await page.evaluate(() => window.__cls || 0).catch(() => 0)
  if (cls > 0.25) add({ ...base, sev: 'medium', cat: 'layout-shift', title: 'Large layout shift while loading and scrolling', detail: `cumulative layout shift ${cls.toFixed(2)} (good is under 0.1)` })
  flush(c, path, 'scrolling'); await page.evaluate(() => scrollTo(0, 0)).catch(() => {})

  // keyboard: every Tab stop should show where the focus is
  const nofocus = new Set()
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab'); stats.tabs++
    const f = await page.evaluate((ign) => {
      const e = document.activeElement; if (!e || e === document.body || (ign && e.closest(ign))) return null
      const s = getComputedStyle(e), c = [...e.classList].slice(0, 2).join('.')
      return { sel: e.tagName.toLowerCase() + (e.id ? '#' + e.id : c ? '.' + c : ''), none: (s.outlineStyle === 'none' || parseFloat(s.outlineWidth) === 0) && s.boxShadow === 'none' }
    }, IGNORE).catch(() => null)
    if (f?.none) nofocus.add(f.sel)
  }
  if (nofocus.size) add({ ...base, sev: 'low', cat: 'focus', title: 'Keyboard focus has no visible indicator', detail: [...nofocus].slice(0, 6).join(', ') })
  await reset()

  // drag: only elements that declare themselves draggable
  const dr = page.locator('[draggable=true]')
  if (await dr.count() >= 2) { await dr.nth(0).dragTo(dr.nth(1)).catch(() => {}); stats.drags++; await page.waitForTimeout(250); flush(c, path, 'dragging'); await reset() }

  // controls
  const cands = await page.evaluate(([sel, deny, safeMode]) => {
    const re = new RegExp(deny, 'i'), res = []
    document.querySelectorAll(sel).forEach((e, i) => {
      const b = e.getBoundingClientRect(), s = getComputedStyle(e)
      if (!b.width || !b.height || s.visibility === 'hidden' || e.disabled || e.closest('[aria-hidden=true]')) return
      const label = (e.innerText || e.getAttribute('aria-label') || e.title || e.value || e.id || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)
      if (safeMode && re.test([label, e.getAttribute('aria-label'), e.title, e.id, e.name].join(' '))) return
      res.push({ i, label, select: e.tagName === 'SELECT' })
    })
    return res
  }, [CLICKABLE, DENY, safe]).catch(() => [])
  let dead = 0
  for (const k of cands.slice(0, MAX_CLICKS)) {
    const el = page.locator(CLICKABLE).nth(k.i), where = `"${k.label}"`
    if (k.select) {
      const opts = await el.locator('option').evaluateAll((o) => o.map((x) => x.value)).catch(() => [])
      for (const v of opts.slice(0, 8)) { await el.selectOption(v).catch(() => {}); stats.selects++; await page.waitForTimeout(150) }
      flush(c, path, `choosing options of select ${where}`); continue
    }
    const before = await sig(page)
    await page.evaluate(() => { window.__uq = new WeakSet(); document.querySelectorAll('*').forEach((e) => { if (/absolute|fixed/.test(getComputedStyle(e).position) && e.getClientRects().length) window.__uq.add(e) }) }).catch(() => {})
    try { await el.hover({ timeout: 1500 }); stats.hovers++ } catch {}
    for (const s of await slow(page)) add({ ...base, sev: 'low', cat: 'motion', title: `Slow transition (${s})`, detail: `on hover over ${where}` })
    try { await el.click({ timeout: 2500 }); stats.clicks++ } catch (e) {
      if (/intercepts pointer events/.test(e.message)) add({ ...base, sev: 'medium', cat: 'click-blocked', title: `Control ${where} is blocked by another element`, detail: e.message.split('\n').find((l) => /intercepts/.test(l))?.trim() || '' })
      continue
    }
    await page.waitForTimeout(60)
    for (const s of await slow(page)) add({ ...base, sev: 'low', cat: 'motion', title: `Slow transition (${s})`, detail: `after clicking ${where}` })
    await page.waitForTimeout(250); const threw = c.log.length > 0; flush(c, path, `clicking ${where}`)
    const after = await sig(page), changed = after !== before
    // a menu or popup the click opened that an ancestor's overflow:hidden cuts off (a fix elsewhere can do this)
    const cut = await page.evaluate(() => {
      const seen = window.__uq || new WeakSet(), out = []
      for (const e of document.querySelectorAll('*')) {
        if (seen.has(e)) continue
        const s = getComputedStyle(e); if (s.position !== 'absolute' || s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) continue
        const r = e.getBoundingClientRect(); if (r.width < 60 || r.height < 30) continue
        let v = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
        for (let a = e.offsetParent; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
          const t = getComputedStyle(a); if (!/hidden|clip/.test(t.overflowX + t.overflowY)) continue
          const b = a.getBoundingClientRect(); v = { left: Math.max(v.left, b.left), top: Math.max(v.top, b.top), right: Math.min(v.right, b.right), bottom: Math.min(v.bottom, b.bottom) }
        }
        if (Math.max(0, v.right - v.left) * Math.max(0, v.bottom - v.top) < 0.6 * r.width * r.height) out.push((e.getAttribute('role') || e.tagName.toLowerCase()) + ' "' + (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30) + '"')
      }
      return out.slice(0, 2)
    }).catch(() => [])
    if (cut.length) { add({ ...base, sev: 'medium', cat: 'click-blocked', title: `Popup opened by ${where} is cut off by an ancestor with overflow hidden`, detail: cut.join('; ') }); await page.screenshot({ path: join(out, `screens/${slug(path)}-${c.name}+popup.png`), animations: 'disabled' }).catch(() => {}) }
    if (!changed && !/checkbox|radio/.test(await el.getAttribute('type').catch(() => '') || '') && !threw && dead++ < 5) add({ ...base, sev: 'low', cat: 'unresponsive', title: `Click on ${where} changed nothing visible`, detail: 'no DOM, aria, theme or URL change after the click (can be fine for analytics-only buttons)' })
    if (changed && /theme|dark|light|mode|giao diện|chế độ/i.test(k.label)) {
      await page.screenshot({ path: join(out, `screens/${slug(path)}-${c.name}+toggle.png`), animations: 'disabled' }).catch(() => {})
      await layout(c, path, '+toggle')
    }
    const dlg = page.locator('[role=dialog]:visible,dialog[open]').first()
    if (await dlg.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape'); await page.waitForTimeout(250)
      if (await dlg.isVisible().catch(() => false)) add({ ...base, sev: 'low', cat: 'dialog', title: `Dialog opened by ${where} does not close with Esc`, detail: '' })
    }
    if (changed) await reset()
  }

  // live resize: JS resize handlers only show up when the same page is resized, not freshly loaded
  if (c.vp.n === 'desktop') for (const v of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[3]]) { // desktop pass runs last, so fresh-load findings exist to dedupe against
    await page.setViewportSize({ width: v.w, height: v.h }).catch(() => {}); stats.resizes++; await page.waitForTimeout(300)
    const w = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1).catch(() => false)
    if (w && !found.has(`responsive|Horizontal scroll at ${v.n} width (${v.w}px)|${path}`)) add({ ...base, sev: 'medium', cat: 'responsive', title: `Horizontal scroll after live resize to ${v.w}px`, detail: 'a fresh load at this width is fine; the page does not re-layout when resized' })
    flush(c, path, `resizing to ${v.w}px`)
  }
}

// ---------- evidence screenshots with the faulty element boxed: red = real defect, yellow = polish, green = fixed (the verify step uses it)
const MARK_COLOR = { red: '#e5484d', yellow: '#f5a524', green: '#16a34a' }
async function markShot(page, items, file) { // items: [{ sel, color: red|yellow|green, label }]; -> number of elements boxed
  const n = await page.evaluate(({ items, C }) => {
    let n = 0, first = null
    const boxes = items.flatMap((it) => { let els = []; try { els = [...document.querySelectorAll(it.sel)].slice(0, 6) } catch {} return els.filter((e) => e.getClientRects().length).map((e) => [e, it]) })
    if (!boxes.length) return 0
    boxes[0][0].scrollIntoView({ block: 'center', inline: 'nearest' })
    for (const [e, it] of boxes) {
      const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue
      const col = C[it.color] || C.red, d = document.createElement('div')
      d.setAttribute('data-uqa-mark', '1'); d.style.cssText = `position:absolute;z-index:2147483647;pointer-events:none;left:${r.left + scrollX - 3}px;top:${r.top + scrollY - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;outline:3px solid ${col};background:${col}22;border-radius:4px`
      const t = document.createElement('span'); t.textContent = it.label; t.style.cssText = `position:absolute;left:0;bottom:100%;margin-bottom:2px;font:700 11px/1.3 system-ui,sans-serif;color:#fff;background:${col};padding:1px 6px;border-radius:3px;white-space:nowrap`
      d.appendChild(t); document.body.appendChild(d); n++
    }
    return n
  }, { items, C: MARK_COLOR }).catch(() => 0)
  if (n) await page.screenshot({ path: file, animations: 'disabled' }).catch(() => {})
  return n
}
// ui-qa.mjs <url> --login <state.json>: opens a normal Chrome with its own profile (kept in ~/.config/ui-qa/chrome-profile, so Google sign-in works and survives),
// you sign in, press Enter here, the session is saved to <state.json> (mode 600; it is a password: never commit it).
if (has('login')) {
  const { spawn } = await import('node:child_process'), { homedir } = await import('node:os'), { chmodSync } = await import('node:fs'), save = flag('login', ''), port = 9223
  const bin = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((x) => existsSync(x)) || die(1, 'Google Chrome not found')
  if (!save) die(3, 'usage: ui-qa.mjs <url> --login <state.json>')
  const ch = spawn(bin, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(homedir(), '.config', 'ui-qa', 'chrome-profile')}`, '--no-first-run', '--no-default-browser-check', ...(has('refresh') ? ['--headless=new'] : []), argv[0]], { stdio: 'ignore', detached: true }); ch.unref()
  if (!has('refresh')) { console.log(`A Chrome window opened on ${argv[0]}. Sign in there, wait until you see the logged-in app, then press Enter here.`); await new Promise((r) => process.stdin.once('data', r)) }
  // --refresh: no person needed. The dedicated Chrome profile still holds the earlier sign-in, so open the app headless, and if it is not sent to a login page, save the session again.
  let b; for (let n = 0; n < (has('refresh') ? 30 : 1) && !b; n++) { b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null); if (!b) await new Promise((r) => setTimeout(r, 1000)) }
  if (!b) die(1, 'cannot reach that Chrome')
  if (has('refresh')) {
    const pg = await b.contexts()[0].newPage(); await pg.goto(argv[0], { timeout: 30000 }).catch(() => {}); await pg.waitForTimeout(3000)
    const out = /\/(login|signin|sign-in)\b|accounts\.google\./.test(pg.url()); await pg.close()
    if (out) { await b.close().catch(() => {}); try { process.kill(-ch.pid) } catch {}; die(2, 'the saved sign-in expired: run this command again without --refresh and sign in once') }
  }
  mkdirSync(dirname(resolve(save)), { recursive: true }); await b.contexts()[0].storageState({ path: resolve(save) }); chmodSync(resolve(save), 0o600)
  await b.close().catch(() => {}); try { process.kill(-ch.pid) } catch { try { process.kill(ch.pid) } catch {} }
  console.log(`saved ${resolve(save)} (mode 600). Do not commit it.`); process.exit(0)
}

// ui-qa.mjs <url> --mark '[{"sel":"…","color":"green","label":"FIXED"}]' --mark-out <png> [--scheme dark] [--auth state.json] [--out <dir>]: one marked screenshot, no crawl
if (has('mark')) {
  const mw = +flag('width', 0), b = await chromium.launch({ headless: true }), c = await open(b, mw ? { n: 'w' + mw, w: mw, h: 900 } : VIEWPORTS[3], flag('scheme', 'light'))
  await c.page.goto(argv[0], { timeout: 20000 }).catch(() => {}); await c.page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {}); await c.page.waitForTimeout(500)
  const n = await markShot(c.page, JSON.parse(flag('mark', '[]')), flag('mark-out', 'marked.png')); await b.close()
  console.log(n ? `marked ${n} element(s): ${flag('mark-out', 'marked.png')}` : 'nothing to mark (selectors not found)'); process.exit(0)
}

// ---------- Impeccable (https://github.com/pbakaus/impeccable, Apache-2.0): 60+ deterministic design rules run on the rendered page by a
// pinned, third-party CLI (npx runs its native binary). Real defects it sees and we do not (text over images, 8px text, skipped headings)
// become medium; style opinions ("AI slop": gradient text, glows...) stay low so they never file an issue by default.
const IMP_VER = flag('impeccable-version', process.env.IMPECCABLE_VERSION || '4.8.0')
const IMP_REAL = new Set(['low-contrast', 'gray-on-color', 'text-occlusion', 'text-overflow', 'clipped-overflow-container', 'broken-image', 'script-error', 'first-viewport-column-overflow', 'content-hidden-at-rest', 'body-text-viewport-edge'])
let impOff = has('impeccable') ? '' : 'off (add --impeccable; about 50 s per page)'
async function impeccable(url, path) {
  if (impOff) return
  const rules = new Map()
  for (const vp of ['1280x800', '390x844']) {
    const r = spawnSync('npx', ['--yes', `impeccable@${IMP_VER}`, 'detect', '--json', '--viewport', vp, url], { encoding: 'utf8', timeout: 120000 })
    let list; try { list = JSON.parse(r.stdout) } catch { impOff = `impeccable@${IMP_VER} did not run (${(r.error?.message || r.stderr || 'no output').trim().split('\n')[0].slice(0, 100)})`; return }
    for (const x of list) { const e = rules.get(x.antipattern) || { x, d: new Set(), vps: new Set(), sels: new Set() }; e.d.add(`${x.snippet} [${x.selector}]`); if (x.selector) e.sels.add(x.selector); e.vps.add(vp); rules.set(x.antipattern, e) }
  }
  let c = null // one desktop page to box the offending elements in each rule's evidence screenshot
  if (rules.size) { c = await open(browser, VIEWPORTS[3], 'light'); await c.page.goto(url, { timeout: 15000 }).catch(() => {}); await c.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {}); await c.page.waitForTimeout(500) }
  for (const [id, { x, d, vps, sels }] of rules) {
    const sev = IMP_REAL.has(id) ? 'medium' : 'low', shot = `screens/${slug(path)}-${id}-marked.png`
    const n = c ? await markShot(c.page, [...sels].map((sel) => ({ sel, color: sev === 'low' ? 'yellow' : 'red', label: x.name })), join(out, shot)) : 0
    if (c) await c.page.evaluate(() => document.querySelectorAll('[data-uqa-mark]').forEach((e) => e.remove())).catch(() => {})
    add({ sev, cat: ['low-contrast', 'gray-on-color'].includes(id) ? 'contrast' : 'design', title: `${x.name} (${id})`, path, ctx: `impeccable-${[...vps].join('+')}`, sels: [...sels],
      detail: `${x.category}/${x.severity}: ${[...d].slice(0, 3).join('; ')}${d.size > 3 ? ` (+${d.size - 3} more)` : ''}`, shot: n ? shot : `screens/${slug(path)}-desktop-light.png` })
  }
  await c?.ctx.close().catch(() => {})
}

// ---------- run
const browser = await chromium.launch({ headless: !has('headed') }).catch((e) => die(1, `cannot start chromium: ${e.message.split('\n')[0]}. Try: npx playwright install chromium`))
const clean = (u) => { const x = new URL(u); x.hash = ''; return x.href }
const queue = [{ url: clean(root.href), d: 0 }], seen = new Set([queue[0].url])
for (const [i, v] of argv.entries()) { // --seed <url|path>: extra pages to test as they are (not crawled further), same origin only
  if (v !== '--seed' || !argv[i + 1]) continue
  try { const u = clean(new URL(argv[i + 1], root.origin).href); if (sameOrigin(u) && !seen.has(u)) { seen.add(u); queue.push({ url: u, d: DEPTH }) } } catch {}
}
while (queue.length && stats.pages < MAX_PAGES) {
  const { url, d } = queue.shift(), path = short(url); stats.pages++
  console.error(`ui-qa: [${stats.pages}/${MAX_PAGES}] ${path}`)
  let anims = 0
  for (const scheme of ['light', 'dark']) for (const vp of VIEWPORTS) {
    const c = await open(browser, vp, scheme); stats.loads++
    try {
      const resp = await c.page.goto(url, { timeout: 15000 }).catch((e) => { add({ sev: 'high', cat: 'page-load', title: 'Page failed to load', detail: e.message.split('\n')[0], path, ctx: c.name, shot: '' }); return null })
      if (!resp) continue
      if (flag('auth', '') && /\/(log.?in|sign.?in)\b/i.test(new URL(c.page.url()).pathname) && !/log.?in|sign.?in/i.test(path)) die(2, `the saved session (${flag('auth')}) was sent to the login page from ${path}: it expired or does not match this server. Log in again.`)
      if (resp.status() >= 400) add({ sev: 'high', cat: 'page-load', title: `Page returns HTTP ${resp.status()}`, detail: '', path, ctx: c.name, shot: '' })
      await c.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
      await c.page.waitForTimeout(500)
      const a = await layout(c, path)
      await c.page.screenshot({ path: join(out, `screens/${slug(path)}-${c.name}.png`), fullPage: true, animations: 'disabled' }).catch(() => {})
      flush(c, path, 'loading the page')
      const light = scheme === 'light'
      if (light && vp.n === 'desktop') {
        anims = a
        if (d < DEPTH) {
          const hrefs = await c.page.evaluate(() => [...document.querySelectorAll('a[href]')].map((x) => x.href)).catch(() => [])
          for (const h of hrefs) { try { const u = new URL(h); if (u.origin === root.origin && !/\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|ico|css|js)$/i.test(u.pathname) && !(safe && /log.?out|sign.?out|delete/i.test(u.pathname)) && !seen.has(clean(h))) { seen.add(clean(h)); queue.push({ url: clean(h), d: d + 1 }) } } catch {} }
        }
      }
      if (light && (vp.n === 'desktop' || vp.n === 'mobile')) await interact(c, path, url)
    } finally { await c.ctx.close() }
  }
  await impeccable(url, path)
  if (anims) { // same page with prefers-reduced-motion: reduce
    const c = await open(browser, VIEWPORTS[3], 'light', { reducedMotion: 'reduce' })
    try {
      await c.page.goto(url, { timeout: 15000 }).catch(() => {}); await c.page.waitForTimeout(800)
      const n = await c.page.evaluate(LAYOUT, { touch: false, ignore: IGNORE }).then((r) => r.anims).catch(() => 0)
      if (n) add({ sev: 'low', cat: 'motion', title: 'Animations keep running with prefers-reduced-motion: reduce', detail: `${n} animation(s) still running (${anims} without the preference)`, path, ctx: 'desktop-light', shot: `screens/${slug(path)}-desktop-light.png` })
    } finally { await c.ctx.close() }
  }
}
await browser.close()

// ---------- report + issue drafts
const all = [...found.values()].map((f) => ({ ...f, ctxs: [...f.ctxs] })).sort((a, b) => SEV[b.sev] - SEV[a.sev] || a.cat.localeCompare(b.cat))
writeFileSync(join(out, 'findings.json'), JSON.stringify({ url: root.href, date: new Date().toISOString(), stats, findings: all }, null, 2))
const count = (s) => all.filter((f) => f.sev === s).length
const row = (f) => `- **${f.sev}** \`${f.cat}\` ${f.title}\n  - page: \`${f.path}\` · contexts: ${f.ctxs.join(', ')}${f.detail ? `\n  - ${f.detail}` : ''}${f.shot ? `\n  - screenshot: \`${f.shot}\`` : ''}`
writeFileSync(join(out, 'report.md'), [
  `# UI QA report — ${root.href}`, '', `Run: ${new Date().toISOString()} · ${safe ? 'safe mode (mutating requests blocked)' : 'DESTRUCTIVE MODE'}`,
  `Coverage: ${Object.entries(stats).map(([k, v]) => `${v} ${k}`).join(', ')}`, '',
  `**${count('high')} high · ${count('medium')} medium · ${count('low')} low**`, '', ...all.map(row), '',
  '## Not covered', ...(impOff && has('impeccable') ? [`Impeccable design pass: ${impOff}.`, ''] : []), 'Business-logic correctness, forms (never filled or submitted), pages behind login (use --auth), canvas/WebGL content, drag on non-`draggable` elements.',
].join('\n'))

// One issue per AREA (what a fixer changes together), not per detector category: separate issues for one root cause get fixed by accident.
const AREA = { 'js-exception': 'runtime', 'console-error': 'runtime', network: 'runtime', 'page-load': 'runtime', contrast: 'theme', 'dark-mode': 'theme',
  responsive: 'layout', 'touch-target': 'layout', 'broken-image': 'layout', 'layout-shift': 'layout', 'click-blocked': 'interaction', unresponsive: 'interaction',
  dialog: 'interaction', focus: 'interaction', motion: 'interaction', design: 'design' }
const AREA_LABEL = { runtime: 'Runtime errors', theme: 'Color, contrast and dark mode problems', layout: 'Layout and responsive problems', interaction: 'Interaction and motion problems', design: 'Design quality problems' }
const EXPECT = { 'js-exception': 'No uncaught exceptions while loading or using the page.', 'console-error': 'No errors in the browser console.', network: 'No failing requests (4xx/5xx).',
  'page-load': 'The page loads with HTTP 200.', contrast: 'Text contrast of at least 4.5:1 (3:1 for large text) in light and dark themes.',
  'dark-mode': 'In dark mode every surface, text and control follows the theme: no light surfaces and no low-contrast text left behind.',
  responsive: 'No horizontal scroll at 375, 768, 1024 and 1440 px.', 'touch-target': 'Touch targets of at least 24x24 px (44 recommended).', 'broken-image': 'Every image loads.',
  'layout-shift': 'Content does not jump while loading or scrolling.', 'click-blocked': 'Every control can be clicked, not covered by another element.',
  unresponsive: 'Clicking a control gives visible feedback or navigates.', dialog: 'Dialogs close with Esc.', focus: 'Every tab stop shows a visible focus indicator.',
  motion: 'Transitions stay under 800 ms and animations respect prefers-reduced-motion.', design: 'Basic typography and layout quality rules hold.' }
const bySev = Object.keys(SEV).filter((s) => SEV[s] >= SEV[MIN])
// --design-polish: the low Impeccable design rules become issues too, one per rule (a fixer changes one rule's pages together), labelled design-polish, capped
const polish = has('design-polish') && has('impeccable'), isPolish = (f) => polish && f.cat === 'design' && SEV[f.sev] < SEV[MIN]
const areas = [...new Set(all.filter((f) => bySev.includes(f.sev) && !isPolish(f)).map((f) => AREA[f.cat] || 'runtime'))]
  .sort((x, y) => Math.max(...all.filter((f) => (AREA[f.cat] || 'runtime') === y && !isPolish(f)).map((f) => SEV[f.sev])) - Math.max(...all.filter((f) => (AREA[f.cat] || 'runtime') === x && !isPolish(f)).map((f) => SEV[f.sev]))).slice(0, MAX_ISSUES)
// Priority = how much a fix can touch: high = a crash or 6+ pages, medium = 2+ pages, low = one page. A person can still relabel.
const PROFILE = flag('profile', '') // the role a --auth run is logged in as. Not in the title: the same problem seen by another role or on another server is one issue (a rerun adds only what is new)
const priorityOf = (fs, polish) => polish ? 'low' : fs.some((f) => f.sev === 'high') || new Set(fs.map((f) => f.path)).size >= 6 ? 'high' : new Set(fs.map((f) => f.path)).size >= 2 ? 'medium' : 'low'
const mkDraft = (area, fs, body, title, design) => {
  
  const probs = new Map() // cat|title -> one problem listing every page it appears on
  for (const f of fs) { const k = `${f.cat}|${f.title}`, e = probs.get(k) || { cat: f.cat, title: f.title, sev: f.sev, expected: EXPECT[f.cat] || '', rows: [] }; e.rows.push(f); probs.set(k, e) }
  const list = [...probs.values()].sort((x, y) => SEV[y.sev] - SEV[x.sev])
  const pages = [...new Set(fs.map((f) => f.path))], prio = priorityOf(fs, design)
  writeFileSync(join(out, body), [
    '## Summary', `A black-box UI check (\`ui-qa\`, no source read) of ${root.href} on ${new Date().toISOString().slice(0, 10)} found ${list.length} problem(s) in one area: **${AREA_LABEL[area]}**. They are filed together because they are usually fixed together: fix the shared cause once (a global style, a theme token, a shared component) and check every item below before marking it ready.`, '',
    `**Affected pages:** ${pages.map((x) => `\`${x}\``).join(', ')}`, ...(PROFILE ? [`**QA profile:** ${PROFILE} (logged in as this role; ${root.origin})`] : []), `**Priority:** ${prio} · impact: ${pages.length} page(s), ${list.length} problem(s)${design ? ' · design polish (a taste call: follow the project design system)' : ''}`, '', '## Problems', '',
    renderProblems(list),
    '## How to reproduce', `\`node tools/ui-qa.mjs ${root.href}\`. Open the page at the listed viewport and theme (the context names are viewport-theme, for example mobile-dark).`, '',
    '## Notes for the fixer', '- Search for siblings: the same cause often shows on other pages, themes or components than the ones listed.', '- Do not close this issue yourself: a separate QA pass verifies the fix on the deployed environment.', '',
    '_Screenshot paths are relative to the ui-qa report folder on the reporter\'s machine; with --with-images they are attached in a comment._',
  ].join('\n'))
  const shots = [...new Set(fs.filter((f) => f.shot && existsSync(join(out, f.shot))).map((f) => f.shot))].slice(0, 4) // already worst-first
  return { title, profile: PROFILE, origin: root.origin, priority: prio, design: !!design, body, findings: list.length, shots, problems: list.map(({ cat, title, sev, expected, rows }) => ({ cat, title, sev, expected, rows: rows.map((f) => ({ path: f.path, ctxs: [...f.ctxs], detail: f.detail, shot: f.shot })) })) }
}
const drafts = areas.map((area, n) => mkDraft(area, all.filter((f) => (AREA[f.cat] || 'runtime') === area && bySev.includes(f.sev) && !isPolish(f)), `issues/${String(n + 1).padStart(2, '0')}-${area}.md`, `[ui-qa] ${AREA_LABEL[area]}`, false))
if (polish) { // one issue per design rule, the widest first
  const rules = new Map(); for (const f of all.filter(isPolish)) rules.set(f.title, [...(rules.get(f.title) || []), f])
  ;[...rules].sort((x, y) => new Set(y[1].map((f) => f.path)).size - new Set(x[1].map((f) => f.path)).size).slice(0, +flag('max-design-issues', 6))
    .forEach(([title, fs], n) => drafts.push(mkDraft('design', fs, `issues/d${String(n + 1).padStart(2, '0')}-design.md`, `[ui-qa] Design: ${title}`, true)))
}
writeFileSync(join(out, 'issues.json'), JSON.stringify(drafts, null, 2))

console.log(`ui-qa: ${count('high')} high, ${count('medium')} medium, ${count('low')} low · ${stats.pages} pages, ${stats.clicks} clicks`)
console.log(`report: ${join(out, 'report.md')}`)
console.log(drafts.length ? `${drafts.length} issue draft(s) in ${join(out, 'issues')} (nothing filed). To file: node tools/ui-qa.mjs file ${out}` : `no findings at ${MIN} or above, no issue drafts`)
process.exit(count('high') ? 1 : 0)
