#!/usr/bin/env node
// sdlc-dispatch — decides which feature lanes may run at the same time.
//
// Reads  <project>/.sdlc/features/*/{status.json,ownership.json,acceptance.yaml}
// Prints which lanes are admitted to run in parallel and why the rest are not.
//
// This is the enforcement for "do not run two agents against the same files".
// Ownership is read from a machine file, never inferred from plan.md prose.
//
// Default is a dry run: it prints the plan and changes nothing. Passing --exec is
// the only way to actually start a lane, and the caller supplies the command,
// because how a lane is started is agent-specific.
//
// Exit codes:
//   0  at least one lane admitted
//   1  no lane admitted (nothing ready, or every ready lane conflicts)
//   3  configuration error (missing or invalid manifest, bad JSON)
//
// No dependencies. Node >= 18.

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DISPATCHABLE = ['planned', 'building', 'validating']
const ACTIVE = ['building', 'validating']
const PRIORITY = { validating: 0, building: 1, planned: 2 }
const DEFAULT_MAX_LANES = 4

class ConfigError extends Error {}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = {
    project: process.cwd(),
    exec: null,
    json: false,
    help: false,
    only: null,
    maxLanes: Number(process.env.SDLC_MAX_LANES || DEFAULT_MAX_LANES),
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
      case '--exec': opts.exec = next(); break
      case '--only': opts.only = next().split(',').map((s) => s.trim()).filter(Boolean); break
      case '--max-lanes': opts.maxLanes = Number(next()); break
      case '--json': opts.json = true; break
      case '-h': case '--help': opts.help = true; break
      default: throw new ConfigError(`unknown argument: ${a}`)
    }
  }
  if (!Number.isInteger(opts.maxLanes) || opts.maxLanes < 1) {
    throw new ConfigError('--max-lanes must be a positive integer')
  }
  if (opts.only && opts.only.length === 0) {
    throw new ConfigError('--only requires at least one feature name')
  }
  return opts
}

const USAGE = `sdlc-dispatch — parallel lane admission

  sdlc-dispatch.mjs [options] [--exec "<command>"]

  --project <dir>   project root holding .sdlc (default: cwd)
  --only <a,b,c>    restrict admission to these features. Use it when resuming,
                    so that a resume never starts work that was never begun.
  --max-lanes <n>   concurrency cap (default 4, or $SDLC_MAX_LANES)
  --exec "<cmd>"    start each admitted lane. Placeholders: {feature} {worktree}.
                    Without it this is a dry run.
  --json            print only the machine plan

Example
  sdlc-dispatch.mjs --exec 'claude -p "run feature-lifecycle for {feature} in {worktree}"'
`

// ------------------------------------------------------------------ reading

function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new ConfigError(`${file}: invalid JSON (${e.message})`)
  }
}

function readOwnership(featureDir, feature) {
  const file = join(featureDir, 'ownership.json')
  if (!existsSync(file)) {
    throw new ConfigError(
      `feature "${feature}" has no ownership.json.\n` +
      `  Parallel lanes are only safe when ownership is declared. Copy ` +
      `${'skills/feature-lifecycle/references/ownership-template.json'} and list the paths this lane edits.`)
  }
  const doc = readJson(file)
  if (!doc || typeof doc !== 'object') throw new ConfigError(`${file}: expected a JSON object`)
  if (!Array.isArray(doc.owns) || doc.owns.length === 0) {
    throw new ConfigError(`${file}: "owns" must be a non-empty array of repo-relative globs`)
  }
  for (const g of doc.owns) {
    if (typeof g !== 'string' || g.trim() === '') {
      throw new ConfigError(`${file}: every entry in "owns" must be a non-empty string`)
    }
    if (g.startsWith('/')) throw new ConfigError(`${file}: "${g}" must be repo-relative, not absolute`)
  }
  if (doc.feature && doc.feature !== feature) {
    throw new ConfigError(`${file}: declares feature "${doc.feature}" but lives in "${feature}"`)
  }
  return {
    owns: doc.owns,
    worktree: doc.worktree || join('.worktrees', feature),
    readOnly: doc.read_only === true,
  }
}

// --------------------------------------------------------- conflict analysis

// The static directory prefix of a glob: every leading segment with no wildcard.
//
// Two shapes have to be distinguished, because conflating them serialises work
// that is actually independent:
//   'tests/snake.test.js' -> 'tests/snake.test.js'  a specific file claims itself
//   'tests/**'           -> 'tests'                a tree claims its directory
//   'src/routes/a.ts'    -> 'src/routes/a.ts'      specific file
//   'src/routes'         -> 'src'                  a bare directory claims its parent
//   '**'  or  '*.ts'     -> ''                     catch-all, claims everything
function staticPrefix(glob) {
  const cleaned = glob.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (cleaned === '') return ''
  const segments = cleaned.split('/')
  const hasWildcard = segments.some((seg) => /[*?[\]{}]/.test(seg))

  if (!hasWildcard) {
    // A literal path. A trailing name with a dot is a file, so it claims itself.
    const last = segments[segments.length - 1]
    if (last.includes('.')) return cleaned
    return segments.slice(0, -1).join('/')
  }

  // Stop at the first wildcard; everything before it is a real directory.
  const static_ = []
  for (const seg of segments) {
    if (/[*?[\]{}]/.test(seg)) break
    static_.push(seg)
  }
  return static_.join('/')
}

function prefixesOverlap(a, b) {
  if (a === '' || b === '') return true
  if (a === b) return true
  return a.startsWith(b + '/') || b.startsWith(a + '/')
}

function firstConflict(own, other) {
  for (const g of own.owns) {
    const pg = staticPrefix(g)
    for (const h of other.owns) {
      if (prefixesOverlap(pg, staticPrefix(h))) return `${g} <-> ${h}`
    }
  }
  return null
}

// ------------------------------------------------------------------- admission

function collectLanes(project) {
  const featuresDir = join(project, '.sdlc', 'features')
  if (!existsSync(featuresDir)) throw new ConfigError(`no .sdlc/features at ${project}`)

  const lanes = []
  for (const feature of readdirSync(featuresDir).sort()) {
    const dir = join(featuresDir, feature)
    if (!existsSync(join(dir, 'acceptance.yaml'))) continue // not a contracted lane yet

    const status = readJson(join(dir, 'status.json')) || { phase: 'contract', feature }
    const phase = status.phase || 'contract'
    const lane = { feature, phase, reason: null, ownership: null }

    if (DISPATCHABLE.includes(phase)) {
      // A dispatchable lane must declare ownership, even if it is the only one.
      lane.ownership = readOwnership(dir, feature)
    }
    lanes.push(lane)
  }
  return lanes
}

function admit(lanes, opts) {
  let candidates = lanes.filter((l) => DISPATCHABLE.includes(l.phase))

  if (opts.only) {
    const wanted = new Set(opts.only)
    const unknown = [...wanted].filter((f) => !lanes.some((l) => l.feature === f))
    if (unknown.length > 0) {
      throw new ConfigError(`--only names unknown feature(s): ${unknown.join(', ')}`)
    }
    candidates = candidates.filter((l) => wanted.has(l.feature))
  }

  candidates = candidates.sort(
    (a, b) => (PRIORITY[a.phase] - PRIORITY[b.phase]) || a.feature.localeCompare(b.feature))

  // Lanes that are already in flight still block, even when --only narrows the
  // set we are allowed to start. Otherwise a resume would happily start a lane
  // that collides with work another agent is doing right now.
  const blockers = []
  if (opts.only) {
    for (const lane of lanes) {
      if (opts.only.includes(lane.feature)) continue
      if (!ACTIVE.includes(lane.phase)) continue
      blockers.push(lane)
    }
  }

  const admitted = []
  for (const lane of candidates) {
    // The cap is applied after conflict detection so a conflicting lane never
    // consumes a slot that a safe lane could have used.
    if (admitted.length >= opts.maxLanes) {
      lane.reason = `lane_cap: max-lanes ${opts.maxLanes} reached, higher priority lanes already admitted`
      continue
    }
    if (lane.ownership.readOnly) {
      lane.reason = 'read-only, no conflict possible'
      admitted.push(lane)
      continue
    }
    const clash = blockers.find((other) => other.ownership && !other.ownership.readOnly &&
      firstConflict(lane.ownership, other.ownership))
    if (clash) {
      // Machine token first, same convention as status.json blocked_reason,
      // so a reader can branch on the prefix without parsing prose.
      const globs = firstConflict(lane.ownership, clash.ownership)
      lane.reason = `file_conflict:${clash.feature}: ${globs}`
      continue
    }
    admitted.push(lane)
    blockers.push(lane)
  }
  return { admitted, deferred: candidates.filter((l) => !admitted.includes(l)) }
}

function main(argv) {
  const opts = parseArgs(argv)
  if (opts.help) {
    process.stdout.write(USAGE)
    return 3
  }

  const project = resolve(opts.project)
  const lanes = collectLanes(project)
  const { admitted, deferred } = admit(lanes, opts)
  const plan = {
    generated_at: new Date().toISOString(),
    project,
    max_lanes: opts.maxLanes,
    admitted: admitted.map((l) => ({
      feature: l.feature,
      phase: l.phase,
      worktree: l.ownership.worktree,
      owns: l.ownership.owns,
      note: l.reason,
    })),
    deferred: deferred.map((l) => ({ feature: l.feature, phase: l.phase, reason: l.reason })),
    idle: lanes
      .filter((l) => !DISPATCHABLE.includes(l.phase))
      .map((l) => ({ feature: l.feature, phase: l.phase })),
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
  } else {
    process.stdout.write(`sdlc-dispatch ${project}\n`)
    if (plan.admitted.length === 0) {
      process.stdout.write('  no lane admitted\n')
    }    for (const l of plan.admitted) {
      process.stdout.write(`  RUN   ${l.feature} (${l.phase}) worktree=${l.worktree}\n`)
      for (const g of l.owns) process.stdout.write(`         owns ${g}\n`)
      if (l.note) process.stdout.write(`         note ${l.note}\n`)
    }
    for (const l of plan.deferred) {
      process.stdout.write(`  WAIT  ${l.feature} (${l.phase}) ${l.reason}\n`)
    }
    for (const l of plan.idle) {
      process.stdout.write(`  IDLE  ${l.feature} (${l.phase})\n`)
    }
  }

  if (opts.exec) {
    for (const l of plan.admitted) {
      const cmd = opts.exec
        .replaceAll('{feature}', l.feature)
        .replaceAll('{worktree}', l.worktree)
      process.stdout.write(`  spawn ${l.feature}: ${cmd}\n`)
      const res = spawnSync(cmd, { shell: true, cwd: project, stdio: 'inherit' })
      if (res.status !== 0) {
        process.stderr.write(`  lane ${l.feature} exited ${res.status}\n`)
        if (res.status !== 0) return 1
      }
    }
  }

  return plan.admitted.length > 0 ? 0 : 1
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`sdlc-dispatch: ${e.message}\n`)
    process.exitCode = 3
  } else {
    process.stderr.write(`sdlc-dispatch: internal error: ${e.stack}\n`)
    process.exitCode = 3
  }
}
