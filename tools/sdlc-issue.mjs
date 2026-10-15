#!/usr/bin/env node
// sdlc-issue — look up and file one issue/ticket for a defect QA found, on GitHub or Jira.
//
//   sdlc-issue.mjs status
//   sdlc-issue.mjs search --title "<text>"
//   sdlc-issue.mjs create --title "<text>" --body-file <file> [--feature <f>]
//
// ISSUE_TRACKER = github | jira | (unset = off). Settings come from the environment, .sdlc/autopilot.env or
// <ai-skills>/autopilot.env (see autopilot.env.example). Secrets never go in those files:
//   github  uses the `gh` CLI and its own login (`gh auth login`); optional ISSUE_GITHUB_REPO=owner/name, ISSUE_LABELS
//   jira    JIRA_BASE_URL, JIRA_PROJECT, optional JIRA_ISSUE_TYPE (Bug); JIRA_EMAIL and JIRA_API_TOKEN from the environment
// `create` first looks for an open issue with the same title and reuses it, so a rerun never files a duplicate.
// The body is scrubbed of recognisable secrets before it leaves the machine.
//
// Exit: 0 done, or tracker off (nothing sent) | 1 the tracker refused or is misconfigured | 3 usage error
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setting } from './lib/setting.mjs'

const [cmd, ...a] = process.argv.slice(2)
const opt = (k) => { const i = a.indexOf('--' + k); return i < 0 ? '' : (a[i + 1] ?? '') }
const die = (code, msg) => { console.error(`sdlc-issue: ${msg}`); process.exit(code) }

const SECRETS = /AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[bp]-[A-Za-z0-9-]+|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const scrub = (t) => {
  const own = [process.env.JIRA_API_TOKEN, process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter((v) => v && v.length > 7)
  return own.reduce((s, v) => s.split(v).join('[redacted]'), t.replace(SECRETS, '[redacted]'))
}

const tracker = setting('ISSUE_TRACKER').toLowerCase()
const same = (x, y) => x.trim().toLowerCase() === y.trim().toLowerCase()

const github = {
  need() { if (spawnSync('gh', ['--version']).status !== 0) die(1, 'github: the gh CLI is not on PATH (https://cli.github.com, then `gh auth login`)') },
  repoArgs() { const r = setting('ISSUE_GITHUB_REPO'); return r ? ['--repo', r] : [] },
  search(title) {
    const r = spawnSync('gh', ['issue', 'list', ...this.repoArgs(), '--state', 'open', '--search', `${title} in:title`, '--json', 'number,title,url', '--limit', '30'], { encoding: 'utf8' })
    if (r.status !== 0) die(1, `github search failed: ${r.stderr.trim()}`)
    return JSON.parse(r.stdout || '[]').filter((i) => same(i.title, title)).map((i) => ({ id: `#${i.number}`, url: i.url }))
  },
  create(title, body) {
    const labels = setting('ISSUE_LABELS').split(/[\s,]+/).filter(Boolean).flatMap((l) => ['--label', l])
    const r = spawnSync('gh', ['issue', 'create', ...this.repoArgs(), '--title', title, '--body', body, ...labels], { encoding: 'utf8' })
    if (r.status !== 0) die(1, `github create failed: ${r.stderr.trim()}`)
    const url = r.stdout.trim().split('\n').pop()
    return { id: `#${url.split('/').pop()}`, url }
  },
}

const jira = {
  need() {
    const miss = ['JIRA_BASE_URL', 'JIRA_PROJECT'].filter((k) => !setting(k)).concat(['JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((k) => !process.env[k]))
    if (miss.length) die(1, `jira: missing ${miss.join(', ')} (JIRA_EMAIL and JIRA_API_TOKEN belong in your environment, not in a file)`)
  },
  base: () => setting('JIRA_BASE_URL').replace(/\/+$/, ''),
  async call(method, path, body) {
    const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64')
    const res = await fetch(this.base() + path, {
      method, headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) die(1, `jira ${method} ${path.split('?')[0]} -> ${res.status}: ${text.slice(0, 300)}`)
    return text ? JSON.parse(text) : {}
  },
  async search(title) {
    const q = title.replace(/[\\"]/g, ' ')
    const jql = `project = "${setting('JIRA_PROJECT')}" AND statusCategory != Done AND summary ~ "${q}"`
    const r = await this.call('GET', `/rest/api/2/search/jql?${new URLSearchParams({ jql, fields: 'summary', maxResults: '30' })}`)
    return (r.issues || []).filter((i) => same(i.fields.summary, title)).map((i) => ({ id: i.key, url: `${this.base()}/browse/${i.key}` }))
  },
  async create(title, body) {
    const labels = setting('ISSUE_LABELS').split(/[\s,]+/).filter(Boolean)
    const r = await this.call('POST', '/rest/api/2/issue', { fields: {
      project: { key: setting('JIRA_PROJECT') }, summary: title, description: body,
      issuetype: { name: setting('JIRA_ISSUE_TYPE') || 'Bug' }, ...(labels.length && { labels }),
    } })
    return { id: r.key, url: `${this.base()}/browse/${r.key}` }
  },
}

if (!['status', 'search', 'create'].includes(cmd)) die(3, 'usage: sdlc-issue.mjs status | search --title T | create --title T --body-file F [--feature f]')
if (cmd === 'status') {
  console.log(`tracker: ${tracker || 'off'}`)
  if (tracker === 'jira') console.log(`jira: ${setting('JIRA_BASE_URL') || '(no base url)'} project ${setting('JIRA_PROJECT') || '(none)'}`)
  process.exit(0)
}
if (!tracker || tracker === 'none') { console.log('issue tracker is off (ISSUE_TRACKER unset): nothing sent. Put the defect in your reply instead.'); process.exit(0) }
const be = { github, jira }[tracker]
if (!be) die(1, `ISSUE_TRACKER must be github or jira, not "${tracker}"`)
be.need()

const feature = opt('feature')
const title = (feature ? `[${feature}] ` : '') + opt('title').replace(/\s+/g, ' ').trim().slice(0, 200)
if (!opt('title')) die(3, '--title required')

const found = await be.search(title)
if (cmd === 'search') {
  if (!found.length) console.log('no open issue with that title')
  for (const i of found) console.log(`${i.id} ${i.url}`)
  process.exit(0)
}
if (found.length) { console.log(`already filed: ${found[0].id} ${found[0].url}`); process.exit(0) }
if (!opt('body-file')) die(3, '--body-file required')
let body = scrub(readFileSync(opt('body-file'), 'utf8')).slice(0, 30000)
if (feature) body += `\n\n---\nFiled by autopilot QA for feature \`${feature}\`.`
const made = await be.create(title, body)
console.log(`filed: ${made.id} ${made.url}`)
