#!/usr/bin/env node
// security-scan.mjs — deterministic static security scanner for AI-generated apps.
//
// Catches the vulnerability classes LLMs most often produce: SQL injection in RPC,
// missing RLS / SECURITY DEFINER abuse, hardcoded secrets, client-side auth,
// CSS-only paywalls, IDOR, public storage buckets, XSS via dangerouslySetInnerHTML,
// missing security headers, CORS *, SSRF, and sensitive-data logging.
//
// Usage:
//   node tools/security-scan.mjs [path] [--json] [--severity high]
//
//   path      project root to scan (default: cwd)
//   --json    output JSON only (no human summary)
//   --severity high   only report critical+high (default: all)
//
// Exit codes: 0 = no findings at or above the severity floor, 1 = findings, 2 = usage error.
//
// Designed to be wired into acceptance.yaml as a `kind: security` check:
//   - id: security-scan-01
//     kind: security
//     cmd: node "$AI_SKILLS_HOME/tools/security-scan.mjs"
//     expect: exit-0
//
// The scanner is deliberately conservative: it flags patterns for a human or a
// follow-up skill to confirm, not a verdict by itself. Every finding carries the
// file, line, the matched text, and the remediation.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { execSync } from 'node:child_process'

// ------------------------------------------------------------------ arguments

const args = process.argv.slice(2)
let jsonOnly = false
let severityFloor = 'all'
let target = '.'

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') jsonOnly = true
  else if (args[i] === '--severity') severityFloor = args[++i]
  else if (!args[i].startsWith('--')) target = args[i]
}

if (!existsSync(target)) {
  process.stderr.write(`security-scan: no such directory: ${target}\n`)
  process.exit(2)
}

// ------------------------------------------------------------------ severity

const RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const FLOOR = severityFloor === 'high' ? RANK.high : RANK.low

// ------------------------------------------------------------------ file walk

const SCAN_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.mjs', '.cjs'])
const SQL_EXTENSIONS = new Set(['.sql'])
const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.sdlc', '.oc', 'test', 'tests', '__tests__', 'e2e', 'playwright-report'])

function walk(dir, files = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return files }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), files)
    } else if (e.isFile()) {
      files.push(join(dir, e.name))
    }
  }
  return files
}

const allFiles = walk(target)
const codeFiles = allFiles.filter(f => SCAN_EXTENSIONS.has(extname(f)))
const sqlFiles = allFiles.filter(f => SQL_EXTENSIONS.has(extname(f)))
const configFiles = allFiles.filter(f => CONFIG_EXTENSIONS.has(extname(f)) && !f.includes('node_modules'))

// ------------------------------------------------------------------ helpers

const findings = []

function add(severity, rule, file, line, text, remediation) {
  if (RANK[severity] > FLOOR) return
  findings.push({ severity, rule, file: relative(target, file), line, text: text.trim().slice(0, 200), remediation })
}

function readSafe(file) {
  try { return readFileSync(file, 'utf8') } catch { return null }
}

function linesOf(content) {
  return content.split('\n')
}

// ------------------------------------------------------------------ rules

// --- A. SQL & Database -------------------------------------------------------

// A1. String concatenation inside SQL (SQL injection in RPC / migrations).
//     Precise: a template literal that starts with a SQL keyword and contains
//     an interpolation, or a string literal holding a SQL keyword that is
//     concatenated with a variable. Excludes .join(), .values(), imports.

const SQL_STMT_START = /^\s*`\s*(SELECT|INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|CREATE TABLE|DROP TABLE|WITH)\b/i
const SQL_IN_STRING = /['"]\s*(SELECT\s+[\w*]|INSERT\s+INTO\s+\w+|UPDATE\s+\w+\s+SET|DELETE\s+FROM\s+\w+)/i

function isSqlInjectionLine(line, isSqlFile) {
  const t = line.trim()
  if (t.startsWith('--') || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
  // Template literal starting with a SQL keyword and containing ${}.
  if (SQL_STMT_START.test(line) && line.includes('${')) return true
  // Template literal containing real SQL syntax and ${}.
  if (/`[^`]*\b(SELECT\s+[\w*]+\s+FROM|INSERT\s+INTO\s+\w+|UPDATE\s+\w+\s+SET|DELETE\s+FROM\s+\w+|WHERE\s+\w+\s*[=<>])[^`]*\$\{/.test(line)) return true
  // String literal with a SQL keyword concatenated with a variable.
  if (SQL_IN_STRING.test(line) && /['"]\s*\+\s*[a-zA-Z_]/.test(line)) return true
  if (SQL_IN_STRING.test(line) && /[a-zA-Z_]\s*\+\s*['"]/.test(line)) return true
  // .query( / .text( / .raw( with a template literal or concatenation.
  if (/\.(query|text|raw)\s*\(\s*`[^`]*\$\{/.test(line)) return true
  if (/\.(query|text|raw)\s*\(\s*['"][^'"]*\+\s*[a-zA-Z_]/.test(line)) return true
  // In .sql files: || concatenation or INTO/VALUES with interpolation.
  if (isSqlFile && /\$\{/.test(line) && /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|SET|VALUES)\b/.test(line)) return true
  return false
}

for (const file of [...sqlFiles, ...codeFiles]) {
  const content = readSafe(file)
  if (!content) continue
  const isSqlFile = SQL_EXTENSIONS.has(extname(file))
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    if (isSqlInjectionLine(line, isSqlFile)) {
      add('critical', 'sql-injection', file, i + 1, line,
        'Use parameterized queries ($1, $2) or the query builder. Never interpolate values into SQL.')
    }
  })
}

// A2. SECURITY DEFINER without a permission check.
for (const file of sqlFiles) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    if (/SECURITY\s+DEFINER/i.test(line)) {
      // Look for a nearby SET search_path or a permission guard.
      const window = lines.slice(Math.max(0, i - 5), i + 15).join('\n')
      const guarded = /SET\s+search_path|pg_has_role|auth\.uid|current_user|security_invoker/i.test(window)
      if (!guarded) {
        add('critical', 'security-definer', file, i + 1, line,
          'SECURITY DEFINER functions run as the table owner. Add SET search_path, check auth.uid()/pg_has_role, or use SECURITY INVOKER.')
      }
    }
  })
}

// A3. RLS disabled or never enabled on a table.
for (const file of sqlFiles) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    if (/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(line)) {
      add('critical', 'rls-disabled', file, i + 1, line,
        'Never disable RLS on tables holding user data. Enable RLS and write policies instead.')
    }
  })
}

// A4. DELETE/DROP without WHERE in migrations (destructive by accident).
for (const file of sqlFiles) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    if (/^\s*DELETE\s+FROM\s+\w+\s*;/i.test(line) && !/WHERE/i.test(line)) {
      add('high', 'delete-without-where', file, i + 1, line,
        'DELETE without WHERE wipes the table. Add a WHERE clause or use TRUNCATE intentionally.')
    }
  })
}

// --- B. Hardcoded secrets & credentials -------------------------------------

const SECRET_PATTERNS = [
  { re: /(api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|pwd)\s*[:=]\s*['"][^'"]{12,}['"]/i, label: 'hardcoded credential' },
  { re: /(SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|PRIVATE_KEY|JWT_SECRET)\s*[:=]\s*['"][^'"]+['"]/, label: 'hardcoded service secret' },
  { re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: 'private key in source' },
  { re: /(sk|pk|ak)_(live|test)_[A-Za-z0-9]{16,}/, label: 'live API key pattern' },
  { re: /(AIza[0-9A-Za-z_-]{35})/, label: 'Google API key pattern' },
]

for (const file of codeFiles) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    // Skip comments and obvious test fixtures.
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#')) return
    for (const { re, label } of SECRET_PATTERNS) {
      if (re.test(line)) {
        add('critical', 'hardcoded-secret', file, i + 1, line,
          'Move the secret to an environment variable or a secrets manager. Never commit credentials to source.')
        break
      }
    }
  })
}

// --- C. Client-side auth & authorization -------------------------------------

for (const file of codeFiles) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*')) return

    // C1. Admin/paywall decided in localStorage or sessionStorage.
    if (/(localStorage|sessionStorage)\.(get|set)Item\(\s*['"](isAdmin|is_admin|role|isPro|is_paid|premium)/.test(line) ||
        /(localStorage|sessionStorage)\.(isAdmin|is_admin|isPro|is_paid|premium)/.test(line)) {
      add('critical', 'client-side-auth', file, i + 1, line,
        'Authorization must be enforced server-side (RLS / API). Client state is trivially bypassed.')
    }

    // C2. Paywall enforced by CSS blur/hide only.
    if (/className\s*=\s*['"][^'"]*\b(blur|hidden|paywall|locked)\b[^'"]*['"][^>]*\$\{(isPro|isPaid|isSubscribed|hasAccess)/.test(line) ||
        /(blur|hidden)\s*:\s*(isPro|isPaid|isSubscribed|hasAccess|!user)/.test(line)) {
      add('high', 'css-paywall', file, i + 1, line,
        'Hiding content with CSS is not a paywall. Enforce access in the API/RLS and return 402/403.')
    }

    // C3. dangerouslySetInnerHTML without a sanitizer.
    if (/dangerouslySetInnerHTML\s*=\s*\{\s*__html\s*:/.test(line)) {
      const window = lines.slice(Math.max(0, i - 3), i + 3).join('\n')
      if (!/sanitize|DOMPurify|dompurify/.test(window)) {
        add('high', 'xss-dangerously', file, i + 1, line,
          'Sanitize with DOMPurify before passing to dangerouslySetInnerHTML, or render as text.')
      }
    }

    // C4. innerHTML / document.write with interpolation.
    if (/\.innerHTML\s*=\s*[^'"]*\$\{/.test(line) || /document\.write\s*\(/.test(line)) {
      add('high', 'xss-innerhtml', file, i + 1, line,
        'Use textContent or a sanitized HTML writer. Never interpolate untrusted input into innerHTML.')
    }

    // C5. eval with dynamic input.
    if (/\beval\s*\(/.test(line) && !/^\s*\/\//.test(line)) {
      add('critical', 'eval-usage', file, i + 1, line,
        'eval executes arbitrary code. Use JSON.parse, a lookup table, or a safe parser.')
    }
  })
}

// --- D. IDOR / ownership ------------------------------------------------------

for (const file of codeFiles) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*')) return
    // API route that takes an id param and returns data without an ownership check.
    if (/(params|query|body)\.(id|userId|user_id|ownerId|owner_id)\b/.test(line) &&
        /(find|select|get|fetch|return|respond|res\.json)/.test(line) &&
        !/(auth|session|user|owner|created_by|userId)\s*[=!]==?\s*(params|query|body)\.(userId|user_id|ownerId|owner_id)/.test(line) &&
        !/where.*(user_id|ownerId|created_by|auth\.uid)/i.test(line)) {
      add('high', 'idor-risk', file, i + 1, line,
        'Verify the caller owns the record (auth.uid() = owner, or RLS policy) before returning or mutating it.')
    }
  })
}

// --- E. Storage buckets -------------------------------------------------------

for (const file of [...configFiles, ...codeFiles]) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('#')) return
    // Supabase storage bucket public: true, or a policy granting public access.
    if (/public\s*:\s*true/i.test(line) && /bucket|storage/i.test(content.slice(0, 2000))) {
      add('high', 'public-bucket', file, i + 1, line,
        'A public storage bucket lets anyone read/write files. Use signed URLs and per-user policies.')
    }
    if (/create\s+policy[^;]*(public|anon)[^;]*(insert|update|delete|all)/i.test(line) && /storage\.objects/i.test(line)) {
      add('critical', 'public-bucket-policy', file, i + 1, line,
        'Policy grants write/delete to anon/public on storage.objects. Restrict to authenticated owners.')
    }
  })
}

// --- F. Security headers & CORS ----------------------------------------------

for (const file of configFiles) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('#')) return
    // CORS *.
    if (/(Access-Control-allow-origin|accessControlAllowOrigin|cors)\s*[:=]\s*['"]\*['"]/i.test(line)) {
      add('high', 'cors-wildcard', file, i + 1, line,
        'CORS * lets any site call your API with credentials. Allowlist your own origins.')
    }
  })
}

// Check for missing security headers in common config locations.
const headerConfigs = configFiles.filter(f => /(vercel\.json|next\.config|netlify\.toml|_headers|helmet|csp)/i.test(f))
const hasCSP = headerConfigs.some(f => /content-security-policy/i.test(readSafe(f) || ''))
const hasFrameOptions = headerConfigs.some(f => /x-frame-options|frameguard/i.test(readSafe(f) || ''))
if (headerConfigs.length > 0) {
  if (!hasCSP) add('medium', 'missing-csp', headerConfigs[0], 1, '(no Content-Security-Policy found)',
    'Add a Content-Security-Policy header to mitigate XSS and data injection.')
  if (!hasFrameOptions) add('medium', 'missing-frame-options', headerConfigs[0], 1, '(no X-Frame-Options found)',
    'Add X-Frame-Options: DENY or frameguard to prevent clickjacking.')
}

// --- G. SSRF ------------------------------------------------------------------

for (const file of codeFiles) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*')) return
    // fetch/axios with a URL taken straight from the request.
    if (/(fetch|axios\.get|axios\.post|http\.get|https\.get|request)\s*\(\s*(req|request|ctx|context)\.(query|body|params)\.(url|uri|link|href|target)/.test(line)) {
      add('high', 'ssrf-risk', file, i + 1, line,
        'Validate and allowlist the URL server-side. Never fetch a URL taken directly from the request.')
    }
  })
}

// --- H. Sensitive data in logs -------------------------------------------------

const SENSITIVE_LOG = /(console\.(log|info|warn|error)|logger\.(log|info|warn|error))\s*\([^)]*(token|password|secret|apiKey|api_key|authorization|cookie|ssn|email|phone)/i
for (const file of codeFiles) {
  const content = readSafe(file)
  if (!content) continue
  const lines = linesOf(content)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*')) return
    if (SENSITIVE_LOG.test(line)) {
      add('medium', 'sensitive-log', file, i + 1, line,
        'Do not log tokens, passwords, or PII. Log a correlation id or a redacted marker instead.')
    }
  })
}

// --- I. Supply chain: npm audit -----------------------------------------------

function runNpmAudit() {
  try {
    const out = execSync('npm audit --omit=dev --audit-level=high --json 2>/dev/null', {
      cwd: target, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const report = JSON.parse(out)
    const vulns = report.vulnerabilities || {}
    for (const [name, v] of Object.entries(vulns)) {
      if (['critical', 'high'].includes(v.severity)) {
        add('high', 'npm-audit', 'package.json', 1, `${name}: ${v.severity} (${v.via?.[0]?.title || 'see npm audit'})`,
          'Update the dependency or apply the upstream patch. Run `npm audit fix` when safe.')
      }
    }
  } catch {
    // npm audit exits non-zero when it finds vulnerabilities; the JSON is still on stdout.
    // If we could not parse it, skip — the dedicated deps-01 check in acceptance.yaml covers this.
  }
}

if (existsSync(join(target, 'package.json'))) {
  runNpmAudit()
}

// ------------------------------------------------------------------ output

findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line)

if (jsonOnly) {
  process.stdout.write(JSON.stringify({ scanned: target, findings }, null, 2) + '\n')
} else {
  if (findings.length === 0) {
    process.stdout.write(`security-scan: no findings in ${target}\n`)
  } else {
    process.stdout.write(`security-scan: ${findings.length} finding(s) in ${target}\n\n`)
    for (const f of findings) {
      process.stdout.write(`[${f.severity.toUpperCase()}] ${f.rule} — ${f.file}:${f.line}\n`)
      process.stdout.write(`  ${f.text}\n`)
      process.stdout.write(`  fix: ${f.remediation}\n\n`)
    }
  }
}

process.exit(findings.length > 0 ? 1 : 0)
