// pw-report — read the JSON Playwright's `json` reporter writes, for the qa-evidence gate (sdlc-verify) and the
// evidence page (sdlc-diagrams). Pure functions; nothing here touches git, the trace or a model.
//
// The JSON comes from a shell redirect (`npx playwright test ... --reporter=json,html > evidence/playwright.json`), so it
// can have other stdout in front of it (a global setup that prints, dotenv). parsePlaywright starts at the report's own `{`.

const walk = (suite, file, out) => {
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      const results = t.results || []
      const last = results[results.length - 1] || {}
      const status = t.status === 'skipped' || last.status === 'skipped' ? 'skipped'
        : t.status === 'flaky' ? 'flaky'
        : t.status === 'unexpected' ? 'failed'
        : t.status === 'expected' ? 'passed'
        : last.status === 'passed' ? 'passed' : 'failed'
      const steps = []
      const addSteps = (list, depth) => { for (const s of list || []) { steps.push({ title: s.title, duration: s.duration ?? 0, error: s.error?.message ? String(s.error.message).split('\n')[0] : '', depth }); addSteps(s.steps, depth + 1) } }
      const attachments = []
      for (const r of results) {
        addSteps(r.steps, 0)
        for (const a of r.attachments || []) if (a.path || a.body) attachments.push({ name: a.name, path: a.path || '', contentType: a.contentType || '' })
      }
      out.push({
        title: spec.title || t.title || '',
        file: spec.file || file || '',
        status,
        duration: results.reduce((n, r) => n + (r.duration || 0), 0),
        retries: Math.max(0, results.length - 1),
        errors: results.flatMap((r) => (r.errors || (r.error ? [r.error] : [])).map((e) => String(e.message || e).replace(/\x1b\[[0-9;]*m/g, '').trim())).filter(Boolean),
        steps,
        attachments,
      })
    }
  }
  for (const s of suite.suites || []) walk(s, s.file || file, out)
}

// The id a test title starts with ("B1: valid login ..." -> "B1"), which is also how evidence screenshots are named.
export const behaviourId = (title) => { const m = /^\s*(?:@\w+\s+)?([A-Za-z]+\d+(?:[.-]\d+)*)\b/.exec(String(title)); return m ? m[1] : '' }

export function parsePlaywright(text) {
  const s = String(text ?? '')
  const i = s.indexOf('{\n  "config"') >= 0 ? s.indexOf('{\n  "config"') : s.indexOf('{')
  if (i < 0) return { ok: false, error: 'no JSON in the file (is the cmd redirecting `--reporter=json,html` to it?)' }
  let j
  try { j = JSON.parse(s.slice(i)) } catch (e) { return { ok: false, error: `not valid JSON: ${String(e.message).slice(0, 120)}` } }
  if (!j || !Array.isArray(j.suites)) return { ok: false, error: 'JSON has no "suites": this is not a Playwright json report' }
  const specs = []
  for (const suite of j.suites) walk(suite, suite.file || '', specs)
  const count = (st) => specs.filter((x) => x.status === st).length
  const stats = { passed: count('passed'), failed: count('failed'), flaky: count('flaky'), skipped: count('skipped') }
  stats.executed = stats.passed + stats.failed + stats.flaky
  return { ok: true, stats, specs, errors: (j.errors || []).map((e) => String(e.message || e).split('\n')[0]) }
}

// What the gate does with a report. `fail` makes the check fail; `warn` is shown but never changes the verdict.
// executed == 0 is the hole this closes: Playwright exits 0 when every test is skipped or fixme'd.
export function gateProblems(rep) {
  if (!rep.ok) return { fail: [`Playwright JSON unusable: ${rep.error}`], warn: [] }
  const { stats } = rep
  const fail = [], warn = []
  if (rep.errors.length) fail.push(`Playwright reported errors outside any test: ${rep.errors[0]}`)
  if (stats.executed === 0) fail.push(`no test ran (${stats.skipped} skipped): an all-skipped suite proves nothing`)
  if (stats.failed > 0) fail.push(`${stats.failed} test(s) failed in the JSON report`)
  if (stats.executed > 0 && stats.skipped > 0) warn.push(`${stats.skipped} test(s) skipped`)
  if (stats.flaky > 0) warn.push(`${stats.flaky} flaky test(s) (passed only on a retry)`)
  return { fail, warn }
}
