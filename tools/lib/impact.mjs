// Which pages a change can reach: the changed files, then everything that imports them, up to an app/**/page file.
// Read from git (origin/<base>) so the working tree is never touched. ponytail: regex import scan, no tsconfig paths (only "@/" = repo root and relative); ok for a Next.js app, a monorepo would need a real resolver.
import { spawnSync } from 'node:child_process'
import { dirname, join, normalize } from 'node:path'

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || ''
const CODE = /\.(tsx?|jsx?|mjs)$/, EXT = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']

// -> { routes: [pages that render a changed file, nearest first], all: a global style/layout changed, files: [changed code files] }
export function impact(cwd, ref, changed) {
  const tracked = new Set(git(cwd, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean))
  const importers = new Map()
  for (const l of git(cwd, ['grep', '-n', '-E', "(from|import|require)[[:space:]]*[(]?[[:space:]]*['\"]", ref, '--', '*.ts', '*.tsx', '*.js', '*.jsx']).split('\n')) {
    const m = l.match(/^[^:]+:([^:]+):\d+:(.*)$/); if (!m) continue
    const spec = m[2].match(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/)?.[1]; if (!spec || !(spec.startsWith('.') || spec.startsWith('@/'))) continue
    const base = spec.startsWith('@/') ? spec.slice(2) : normalize(join(dirname(m[1]), spec))
    const hit = EXT.map((e) => base + e).find((p) => tracked.has(p)); if (hit) importers.set(hit, [...(importers.get(hit) || []), m[1]])
  }
  const pageOf = (f) => f.match(/(^|\/)app\/(.*)\/?page\.(t|j)sx?$/)
  const routeOf = (f) => { const segs = pageOf(f)[2].split('/').filter(Boolean).filter((s) => !/^\(.*\)$/.test(s)).map((s) => (s === '[locale]' ? 'vi' : s)); return segs.some((s) => s.includes('[')) ? '' : '/' + segs.join('/') }
  const files = changed.filter((f) => CODE.test(f)), all = changed.some((f) => /\.(css|scss)$|tailwind\.config|postcss/.test(f))
  const seen = new Map(files.map((f) => [f, 0])), queue = [...files], routes = []
  for (let f; (f = queue.shift()); ) {
    const d = seen.get(f)
    if (pageOf(f)) { const r = routeOf(f); if (r && !routes.includes(r)) routes.push(r) }
    if (/(^|\/)layout\.(t|j)sx?$/.test(f)) { // a layout reaches every page under its folder
      const dir = dirname(f); for (const p of tracked) if (pageOf(p) && p.startsWith(dir + '/')) { const r = routeOf(p); if (r && !routes.includes(r)) routes.push(r) }
    }
    for (const up of importers.get(f) || []) if (!seen.has(up)) { seen.set(up, d + 1); queue.push(up) }
  }
  return { routes, all, files }
}
