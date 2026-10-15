#!/usr/bin/env node
// claude-follow — shows what the leader (headless `claude -p`) is doing, live, in a terminal window.
//
//   node claude-follow.mjs --cwd <project dir> [--since <epoch seconds>] [--once] [--base <claude config dir>]
//
// `claude -p` prints nothing until it ends, but Claude Code records every turn in
//   <config dir>/projects/<project dir with every non-alphanumeric character replaced by "-">/<session>.jsonl
// This tool tails those files and prints, per event: the time, what Claude said (💬), each tool it called (🔧),
// a short line of each result (↳ / ✗), and running totals (Σ: turns, tokens written, context size), so you can
// also watch what the leader costs. A resumed autopilot run starts a new session file; it is picked up on its own.
//
//   --since   only files modified at or after this time (autopilot passes its start time)
//   --once    print what is there and exit (used by the selftest); default is to keep following
//   --base    Claude config dir; default $CLAUDE_CONFIG_DIR or ~/.claude
//
// No dependencies. Node >= 18.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const a = process.argv.slice(2)
const opt = (k, d = '') => { const i = a.indexOf('--' + k); return i < 0 ? d : (a[i + 1] ?? d) }
const once = a.includes('--once')
const cwd = path.resolve(opt('cwd', process.cwd()))
const since = Number(opt('since', '0')) * 1000
const base = opt('base') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const dir = path.join(base, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))

const one = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const k = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n))
const hms = (ts) => { const d = new Date(ts); return isNaN(d) ? '        ' : d.toTimeString().slice(0, 8) }

const turns = new Map() // message id -> last usage seen
let lastId = null
function totals() {
  let out = 0, ctx = 0
  for (const u of turns.values()) {
    out += u.output_tokens || 0
    ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
  }
  return `Σ turns=${turns.size} written=${k(out)} context=${k(ctx)}`
}

function toolLine(c) {
  const i = c.input || {}
  if (c.name === 'Bash') return `Bash: ${one(i.command, 220)}`
  if (/^(Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name)) return `${c.name} ${i.file_path || i.notebook_path || ''}`
  if (c.name === 'Grep' || c.name === 'Glob') return `${c.name} ${one(i.pattern, 100)}`
  return `${c.name} ${one(JSON.stringify(i), 140)}`
}
function resultText(c) {
  const t = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : c.content
  return one(t, 160)
}

function show(line) {
  let e
  try { e = JSON.parse(line) } catch { return }
  const t = hms(e.timestamp)
  const content = e.message && e.message.content
  if (e.type === 'assistant' && Array.isArray(content)) {
    const id = e.message.id || e.uuid
    if (id !== lastId) {
      if (lastId !== null) console.log(`        ${totals()}`)
      lastId = id
    }
    if (e.message.usage) turns.set(id, e.message.usage)
    for (const c of content) {
      if (c.type === 'text' && c.text.trim()) console.log(`${t} 💬 ${one(c.text, 600)}`)
      else if (c.type === 'tool_use') console.log(`${t} 🔧 ${toolLine(c)}`)
    }
  } else if (e.type === 'user') {
    if (typeof content === 'string') console.log(`${t} 👤 ${one(content, 200)}`)
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'tool_result') console.log(`         ${c.is_error ? '✗' : '↳'} ${resultText(c)}`)
        else if (c.type === 'text' && c.text.trim()) console.log(`${t} 👤 ${one(c.text, 200)}`)
      }
    }
  }
}

const offsets = new Map() // file -> bytes already read
const partial = new Map() // file -> incomplete last line
function pump() {
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')) } catch { return }
  const files = names
    .map((n) => ({ n, f: path.join(dir, n), m: fs.statSync(path.join(dir, n)).mtimeMs }))
    .filter((x) => x.m >= since)
    .sort((x, y) => x.m - y.m)
  for (const { n, f } of files) {
    if (!offsets.has(f)) { offsets.set(f, 0); console.log(`── Claude session ${n.replace(/\.jsonl$/, '')} ──`) }
    const size = fs.statSync(f).size
    const from = offsets.get(f)
    if (size <= from) continue
    const fd = fs.openSync(f, 'r')
    const buf = Buffer.alloc(size - from)
    fs.readSync(fd, buf, 0, buf.length, from)
    fs.closeSync(fd)
    offsets.set(f, size)
    const text = (partial.get(f) || '') + buf.toString('utf8')
    const lines = text.split('\n')
    partial.set(f, lines.pop())
    for (const l of lines) if (l.trim()) show(l)
  }
}

pump()
if (once) {
  if (turns.size) console.log(`        ${totals()}`)
  else console.log(`(no Claude session found in ${dir})`)
  process.exit(0)
}
console.log(`following ${dir} (Ctrl+C to stop)`)
setInterval(pump, 1000)
