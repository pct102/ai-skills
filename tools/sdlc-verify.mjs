#!/usr/bin/env node
// sdlc-verify — the only component allowed to write a `pass` status or an
// `accepted` phase.
//
// Reads  <project>/.sdlc/features/<feature>/acceptance.yaml
// Writes <project>/.sdlc/features/<feature>/evidence.json   (machine, generated)
// Updates <project>/.sdlc/features/<feature>/status.json   (state machine)
//
// Exit codes are the contract skills cite:
//   0  every check passed                      -> phase accepted
//   1  at least one check failed               -> phase validating | escalated
//   2  automatic checks pass, a human gate is  -> phase blocked
//      still unapproved
//   3  usage or configuration error
//
// No dependencies. Node >= 18.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const VERIFY_VERSION = 1
const DEFAULT_BUDGET = 2
const DEFAULT_TIMEOUT_MS = 600_000
const OUTPUT_MAX_LINES = 40
const OUTPUT_MAX_CHARS = 4_000

const CHECK_KINDS = ['test', 'lint', 'typecheck', 'build', 'security', 'e2e', 'qa-evidence', 'manual']
const PHASES = ['contract', 'planned', 'building', 'validating', 'accepted', 'blocked', 'escalated']

// Legal forward moves. `sdlc-verify` owns validating/accepted/blocked/escalated
// on its own; an agent may only declare the states that describe work it is
// about to do, and only when the transition is legal.
const TRANSITIONS = {
  contract: ['planned', 'building', 'escalated'],
  planned: ['contract', 'building', 'escalated'],
  building: ['planned', 'escalated'],
  validating: ['building', 'escalated'],
  blocked: ['validating', 'building', 'escalated'],
  escalated: ['validating', 'building'],
  accepted: ['building'],
}

const EXIT = { PASS: 0, FAIL: 1, GATE: 2, ERROR: 3 }

class ConfigError extends Error {}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = {
    project: process.cwd(),
    feature: null,
    approve: null,
    by: null,
    resetRepair: false,
    setPhase: null,
    json: false,
    timeout: Number(process.env.SDLC_VERIFY_TIMEOUT || DEFAULT_TIMEOUT_MS),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new ConfigError(`${a} requires a value`)
      return v
    }
    switch (a) {
      case '--project': opts.project = next(); break
      case '--feature': opts.feature = next(); break
      case '--approve': opts.approve = next(); break
      case '--by': opts.by = next(); break
      case '--reset-repair': opts.resetRepair = true; break
      case '--set-phase': opts.setPhase = next(); break
      case '--json': opts.json = true; break
      case '--timeout': opts.timeout = Number(next()); break
      case '-h': case '--help': opts.help = true; break
      default: throw new ConfigError(`unknown argument: ${a}`)
    }
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
    throw new ConfigError('--timeout must be a positive number of milliseconds')
  }
  // These are three distinct intentions. Combining them hides which one the
  // caller actually meant, so refuse rather than guess.
  const modes = [opts.setPhase && '--set-phase', opts.approve && '--approve', opts.resetRepair && '--reset-repair']
    .filter(Boolean)
  if (modes.length > 1) {
    throw new ConfigError(`--set-phase, --approve and --reset-repair are mutually exclusive (got ${modes.join(', ')})`)
  }
  return opts
}

const USAGE = `sdlc-verify — machine-checked acceptance evidence

  sdlc-verify.mjs --feature <name> [options]
  sdlc-verify.mjs --approve <check-id> --by <name>   # satisfy a manual gate

  --project <dir>    project root holding .sdlc (default: cwd)
  --feature <name>   feature directory name
  --set-phase <p>    declare a legal phase: ${'contract planned building'}
  --approve <id>     record a human approval for a \`manual\` check
  --by <who>         approver name, required with --approve
  --reset-repair     reset the repair counter to 0 (a triage decision)
  --timeout <ms>     per-check timeout (default 600000)
  --json             print only the machine summary
`

// ------------------------------------------------------- strict yaml subset

function fail(file, line, msg) {
  throw new ConfigError(`${file}:${line + 1}: ${msg}`)
}

function scalar(raw, file, line) {
  const v = raw.trim()
  if (v === '') throw new ConfigError(`${file}:${line + 1}: missing value`)
  if (v === '|' || v === '>' || v.startsWith('|') || v.startsWith('>')) {
    fail(file, line, 'block scalars are not supported; keep values on one line')
  }
  if (v === '[]') return []
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
    return v.slice(1, -1)
  }
  if (/^[\[{]/.test(v)) fail(file, line, 'flow collections are not supported')
  return v
}

function assign(obj, text, file, line) {
  const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(text)
  if (!m) fail(file, line, `unsupported syntax: ${text}`)
  const key = m[1]
  if (key in obj) fail(file, line, `duplicate key: ${key}`)
  if (m[2].trim() === '') fail(file, line, `key "${key}" has no value (nested maps are not supported)`)
  obj[key] = scalar(m[2], file, line)
}

function parseAcceptance(src, file) {
  const out = { feature: null, budget: null, checks: [] }
  const lines = src.split(/\r?\n/)
  const seenTop = new Set()
  let section = null
  let item = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.includes('\t')) fail(file, i, 'tabs are not allowed, use spaces')
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()

    if (indent === 0) {
      const m = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(body)
      if (!m) fail(file, i, `unsupported top-level syntax: ${body}`)
      section = m[1]
      const rest = m[2].trim()
      if (section === 'checks') {
        if (rest !== '') fail(file, i, 'checks must be a list of "- id: ..." items')
        item = null
      } else {
        if (rest === '') fail(file, i, `${section} requires an inline value`)
        if (seenTop.has(section)) fail(file, i, `duplicate key: ${section}`)
        seenTop.add(section)
        out[section] = scalar(rest, file, i)
      }
      continue
    }

    if (indent === 2 && body.startsWith('- ')) {
      if (section !== 'checks') fail(file, i, 'lists are only allowed under "checks"')
      item = {}
      out.checks.push(item)
      assign(item, body.slice(2).trim(), file, i)
      continue
    }

    if (indent === 4) {
      if (!item) fail(file, i, 'property without a preceding "- " item')
      assign(item, body, file, i)
      continue
    }

    fail(file, i, `unsupported indentation (${indent} spaces); expected 0, 2, or 4`)
  }
  return out
}

function validateContract(doc, file) {
  if (typeof doc.feature !== 'string' || doc.feature.trim() === '') {
    throw new ConfigError(`${file}: "feature" is required`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(doc.feature)) {
    throw new ConfigError(`${file}: "feature" must be kebab-case`)
  }
  if (doc.budget !== null) {
    if (!/^\d+$/.test(String(doc.budget))) {
      throw new ConfigError(`${file}: "budget" must be a non-negative integer`)
    }
    doc.budget = Number(doc.budget)
  }
  if (!Array.isArray(doc.checks) || doc.checks.length === 0) {
    throw new ConfigError(`${file}: "checks" must list at least one check`)
  }

  const seen = new Set()
  for (const c of doc.checks) {
    if (!c.id || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
      throw new ConfigError(`${file}: every check needs a kebab-case "id"`)
    }
    if (seen.has(c.id)) throw new ConfigError(`${file}: duplicate check id "${c.id}"`)
    seen.add(c.id)
    if (!CHECK_KINDS.includes(c.kind)) {
      throw new ConfigError(`${file}: check "${c.id}" has unknown kind "${c.kind}"; allowed: ${CHECK_KINDS.join(', ')}`)
    }
    if (c.kind === 'manual') {
      if (!c.desc) throw new ConfigError(`${file}: manual check "${c.id}" needs a "desc" for the approver`)
    } else {
      if (!c.cmd) throw new ConfigError(`${file}: check "${c.id}" needs a "cmd"`)
    }
    if (c.expect !== undefined && !/^exit-\d+$/.test(c.expect)) {
      throw new ConfigError(`${file}: check "${c.id}" has invalid "expect" (use exit-0 or exit-<n>)`)
    }
  }
  return doc
}

// A feature whose plan names several source files is a candidate for parallel slices. Measured on real runs, one
// builder given such a feature needs 45+ minutes in several calls and hits the 30 minute call limit. So the
// move to `building` needs either slices.json (checked by sdlc-slices plan) or an explicit, reasoned
// `no-slice: <why>` decision in the trace. The leader may still choose one builder; it may not do so silently.
const SLICE_THRESHOLD = 3
function planSourceFiles(featureDir) {
  let plan = ''
  try { plan = readFileSync(join(featureDir, 'plan.md'), 'utf8') } catch { return [] }
  const found = plan.match(/[\w][\w./-]*\.(?:jsx?|tsx?|mjs|css|scss|py|go|rs|rb|php|java|vue|svelte|html)\b/g) || []
  const src = found.filter((f) => !/(^|\/)(e2e|tests?|__tests__|spec)\//.test(f) && !/\.(test|spec)\./.test(f))
  return [...new Set(src)]
}
function slicingProblem(featureDir) {
  const files = planSourceFiles(featureDir)
  if (files.length < SLICE_THRESHOLD) return null
  if (existsSync(join(featureDir, 'slices.json'))) return null
  try {
    for (const l of readFileSync(join(featureDir, 'trace.jsonl'), 'utf8').split('\n')) {
      let e
      try { e = JSON.parse(l) } catch { continue }
      if (e.kind === 'decision' && typeof e.note === 'string' && /^no-slice:\s*\S.{9,}/.test(e.note)) return null
    }
  } catch { /* no trace yet */ }
  return `plan.md names ${files.length} source files (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}). ` +
    `Split the work: write slices.json and run sdlc-slices.mjs plan, or log why one builder is enough: ` +
    `sdlc-trace.mjs --feature <f> --log --from leader --to leader --kind decision --note "no-slice: <reason, 10+ chars>"`
}

// Reads trace.jsonl in order. QA counts when its latest reply succeeded (rc 0) and nothing from a builder
// replied after it. Order in the file is the order of events, so no clock comparison is needed.
function qaEvidenceProblem(featureDir) {
  let lines = []
  try { lines = readFileSync(join(featureDir, 'trace.jsonl'), 'utf8').split('\n') } catch { return 'no trace.jsonl, QA never ran' }
  let lastQa = -1, lastQaRc = null, lastBuilder = -1
  lines.forEach((l, i) => {
    let e
    try { e = JSON.parse(l) } catch { return }
    if (e.kind !== 'reply' || typeof e.from !== 'string') return
    if (e.from === 'qa' || e.from.startsWith('qa-')) { lastQa = i; lastQaRc = e.rc ?? 0 }
    else if (e.from === 'builder' || e.from.startsWith('builder-')) lastBuilder = i
  })
  if (lastQa < 0) return 'QA never replied (no qa reply in trace.jsonl)'
  if (lastQaRc !== 0) return `QA's latest call ended with rc ${lastQaRc}`
  if (lastBuilder > lastQa) return 'a builder changed things after the last QA run; run QA again'
  return null
}

function readContract(featureDir) {
  const file = join(featureDir, 'acceptance.yaml')
  if (!existsSync(file)) {
    throw new ConfigError(`missing acceptance contract: ${file}`)
  }
  return validateContract(parseAcceptance(readFileSync(file, 'utf8'), file), file)
}

// ------------------------------------------------------------- state machine

function defaultStatus(feature, budget) {
  return {
    feature,
    phase: 'contract',
    budget,
    repair_iterations: 0,
    blocked_reason: null,
    approvals: {},
    last_run: null,
  }
}

function readStatus(featureDir, feature, budget) {
  const file = join(featureDir, 'status.json')
  if (!existsSync(file)) return defaultStatus(feature, budget)
  let doc
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new ConfigError(`${file}: invalid JSON (${e.message})`)
  }
  const base = defaultStatus(feature, budget)
  const merged = { ...base, ...doc }
  if (!PHASES.includes(merged.phase)) {
    throw new ConfigError(`${file}: unknown phase "${merged.phase}"; allowed: ${PHASES.join(', ')}`)
  }
  if (!Number.isInteger(merged.repair_iterations) || merged.repair_iterations < 0) {
    throw new ConfigError(`${file}: repair_iterations must be a non-negative integer`)
  }
  if (!Number.isInteger(merged.budget) || merged.budget < 0) {
    throw new ConfigError(`${file}: budget must be a non-negative integer`)
  }
  if (typeof merged.approvals !== 'object' || merged.approvals === null || Array.isArray(merged.approvals)) {
    throw new ConfigError(`${file}: approvals must be an object`)
  }
  return merged
}

function writeJson(file, doc) {
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
}

// -------------------------------------------------------------------- runner

function runCheck(cmd, cwd, timeoutMs) {
  const started = Date.now()
  const res = spawnSync(cmd, {
    shell: true,
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, SDLC: '1', CI: process.env.CI || '1' },
  })
  const duration = Date.now() - started
  const code = res.error
    ? (res.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn-failed')
    : res.status
  const raw = `${res.stdout || ''}${res.stderr || ''}`
  const lines = raw.split('\n')
  const clipped = lines.slice(0, OUTPUT_MAX_LINES).join('\n').slice(0, OUTPUT_MAX_CHARS)
  return { exit_code: code, duration_ms: duration, output: clipped, truncated: lines.length > OUTPUT_MAX_LINES }
}

function expectedCode(expect) {
  const m = /^exit-(\d+)$/.exec(expect || 'exit-0')
  return Number(m[1])
}

function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    process.stdout.write(USAGE)
    return EXIT.ERROR
  }

  const project = resolve(opts.project)
  const sdlcDir = join(project, '.sdlc')
  if (!existsSync(sdlcDir)) throw new ConfigError(`no .sdlc directory at ${project}`)

  // Default to the feature that owns the current directory when possible.
  let feature = opts.feature
  if (!feature) {
    const featuresDir = join(sdlcDir, 'features')
    if (existsSync(featuresDir)) {
      const hit = readdirSync(featuresDir).find((name) =>
        resolve(featuresDir, name) === resolve(process.cwd()) ||
        resolve(featuresDir, name) === resolve(process.cwd(), '..'))
      if (hit) feature = hit
    }
  }
  if (!feature) throw new ConfigError('--feature is required when cwd is not a feature directory')

  const featureDir = join(sdlcDir, 'features', feature)
  if (!existsSync(featureDir)) throw new ConfigError(`no such feature: ${feature}`)

  const contract = readContract(featureDir)
  if (contract.feature !== feature) {
    throw new ConfigError(
      `contract declares feature "${contract.feature}" but lives in "${feature}"`)
  }

  const status = readStatus(featureDir, feature, contract.budget ?? DEFAULT_BUDGET)
  if (opts.resetRepair) {
    status.repair_iterations = 0
    if (status.phase === 'escalated') {
      status.phase = 'validating'
      status.blocked_reason = null
    }
  }

  // ---- declare the work phase, subject to the transition table
  if (opts.setPhase) {
    if (!PHASES.includes(opts.setPhase)) {
      throw new ConfigError(`unknown phase "${opts.setPhase}"; allowed: ${PHASES.join(', ')}`)
    }
    const allowed = TRANSITIONS[status.phase] || []
    if (status.phase !== opts.setPhase && !allowed.includes(opts.setPhase)) {
      throw new ConfigError(
        `illegal transition ${status.phase} -> ${opts.setPhase}; allowed from here: ${allowed.join(', ') || 'none'}`)
    }
    if (opts.setPhase === 'building' && status.phase !== 'building') {
      const why = slicingProblem(featureDir)
      if (why) throw new ConfigError(`refused: ${why}`)
    }
    const from = status.phase
    status.phase = opts.setPhase
    if (['planned', 'building', 'contract'].includes(opts.setPhase)) {
      status.blocked_reason = null
    }
    writeJson(join(featureDir, 'status.json'), status)
    if (!opts.json) process.stdout.write(`${feature}: phase ${from} -> ${status.phase}\n`)
    return EXIT.PASS
  }

  // ---- record a human gate approval, then verify the whole contract
  //
  // Recording an approval deliberately does NOT short-circuit to `accepted`.
  // A gate is one input to the contract, not a substitute for it: the
  // remaining checks still have to be re-run so evidence.json never mixes a
  // fresh gate with stale check results.
  if (opts.approve) {
    const target = contract.checks.find((c) => c.id === opts.approve)
    if (!target) throw new ConfigError(`no check "${opts.approve}" in ${feature}`)
    if (target.kind !== 'manual') {
      throw new ConfigError(`check "${opts.approve}" is ${target.kind}, not a manual gate; approvals only apply to manual checks`)
    }
    if (!opts.by) throw new ConfigError('--approve requires --by <name>')
    status.approvals[opts.approve] = { by: opts.by, at: new Date().toISOString() }
    if (!opts.json) {
      process.stdout.write(`recorded approval ${feature}#${opts.approve} by ${opts.by}, re-verifying\n`)
    }
  }

  // ---- run every check
  const results = []
  for (const check of contract.checks) {
    if (check.kind === 'manual') {
      const approval = status.approvals[check.id]
      results.push({
        id: check.id,
        kind: check.kind,
        desc: check.desc,
        expect: 'approved',
        cmd: null,
        exit_code: approval ? 0 : null,
        ok: Boolean(approval),
        gate_pending: !approval,
        approved_by: approval ? approval.by : null,
        duration_ms: 0,
        output: approval ? `approved by ${approval.by} at ${approval.at}` : `pending human gate: ${check.desc}`,
      })
      continue
    }
    const want = expectedCode(check.expect)
    const run = runCheck(check.cmd, project, opts.timeout)
    let ok = run.exit_code === want
    let note = null
    if (check.kind === 'qa-evidence') {
      // The command must pass AND QA must really have run after the last builder change. Without the second
      // half, QA could be skipped, or its pass could predate the last edit, and the gate would still be green.
      const why = qaEvidenceProblem(featureDir)
      if (why) { ok = false; note = `QA evidence missing: ${why}`; run.output = `QA evidence missing: ${why}\n${run.output || ''}` }
    }
    results.push({
      id: check.id,
      kind: check.kind,
      desc: check.desc ?? null,
      expect: check.expect || 'exit-0',
      cmd: check.cmd,
      exit_code: run.exit_code,
      ok,
      gate_pending: false,
      duration_ms: run.duration_ms,
      output: run.output,
      note,
      truncated: run.truncated,
    })
  }

  const failed = results.filter((r) => !r.ok)
  const pendingGates = results.filter((r) => r.gate_pending)
  const hardFailures = failed.filter((r) => !r.gate_pending)

  let result
  if (hardFailures.length > 0) result = 'fail'
  else if (pendingGates.length > 0) result = 'gate_pending'
  else result = 'pass'

  // ---- advance the state machine
  const before = status.phase
  if (result === 'pass') {
    status.repair_iterations = 0
    status.phase = 'accepted'
    status.blocked_reason = null
  } else if (result === 'gate_pending') {
    status.phase = 'blocked'
    status.blocked_reason = `human_gate_pending: ${pendingGates.map((g) => g.id).join(', ')}`
  } else {
    status.repair_iterations += 1
    if (status.repair_iterations > status.budget) {
      status.phase = 'escalated'
      status.blocked_reason =
        `repair_budget_exhausted: ${status.repair_iterations} failed runs exceed budget ${status.budget} ` +
        `(${hardFailures.map((f) => `${f.id}=${f.exit_code}`).join(', ')})`
    } else {
      status.phase = 'validating'
      status.blocked_reason =
        `failing_checks: ${hardFailures.map((f) => `${f.id}=${f.exit_code}`).join(', ')} ` +
        `(iteration ${status.repair_iterations}/${status.budget})`
    }
  }

  const evidence = {
    sdlc_verify_version: VERIFY_VERSION,
    feature,
    ran_at: new Date().toISOString(),
    result,
    phase: status.phase,
    previous_phase: before,
    repair_iterations: status.repair_iterations,
    budget: status.budget,
    passed: results.filter((r) => r.ok).length,
    failed: hardFailures.length,
    gates_pending: pendingGates.length,
    checks: results,
  }

  status.last_run = {
    at: evidence.ran_at,
    result,
    passed: evidence.passed,
    failed: evidence.failed,
    gates_pending: evidence.gates_pending,
  }

  writeJson(join(featureDir, 'evidence.json'), evidence)
  writeJson(join(featureDir, 'status.json'), status)

  if (opts.json) {
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n')
  } else {
    const mark = (r) => (r.ok ? 'PASS' : r.gate_pending ? 'GATE' : 'FAIL')
    for (const r of results) {
      const code = r.gate_pending ? 'pending' : r.exit_code
      process.stdout.write(`  ${mark(r)}  ${r.id} (${r.kind}) exit=${code} ${r.duration_ms}ms${r.note ? ` | ${r.note}` : ''}\n`)
    }
    process.stdout.write(
      `${feature}: result=${result} phase=${status.phase} ` +
      `repair=${status.repair_iterations}/${status.budget}\n`)
    if (status.blocked_reason) process.stdout.write(`  reason: ${status.blocked_reason}\n`)
  }

  const code = result === 'pass' ? EXIT.PASS : result === 'gate_pending' ? EXIT.GATE : EXIT.FAIL

  // Leave one line in the feature's conversation trace, so a verification is on record even when
  // nobody remembers to log it. Best effort: a trace write must never change the verdict.
  try {
    appendFileSync(join(featureDir, 'trace.jsonl'), JSON.stringify({
      ts: evidence.ran_at, from: 'verify', to: 'leader', kind: 'verify', rc: code,
      note: `${result}: ${evidence.passed} passed, ${evidence.failed} failed` +
        (status.blocked_reason ? ` (${status.blocked_reason})` : ''),
      file: join(featureDir, 'evidence.json'),
    }) + '\n')
  } catch { /* ignore */ }

  return code
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`sdlc-verify: ${e.message}\n`)
    process.exitCode = EXIT.ERROR
  } else {
    process.stderr.write(`sdlc-verify: internal error: ${e.stack}\n`)
    process.exitCode = EXIT.ERROR
  }
}

export { parseAcceptance, validateContract, defaultStatus, PHASES, CHECK_KINDS }
