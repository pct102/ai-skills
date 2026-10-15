---
name: security-audit
description: Audits an AI-generated or human-written app for the vulnerability classes LLMs most often produce: SQL injection in RPC, missing RLS, SECURITY DEFINER abuse, hardcoded secrets, client-side auth, CSS-only paywalls, IDOR, public storage buckets, XSS via dangerouslySetInnerHTML, missing security headers, CORS *, SSRF, and sensitive-data logging. Use before shipping any feature that touches auth, database, storage, or payments; also use as the remediation guide when security-scan.mjs reports findings.
---

# Security Audit

## Purpose

AI coding assistants optimise for "it works", not "it is safe". The result is apps that
function correctly while being wide open: the database readable by anyone, admin decided
in `localStorage`, paywalls enforced by CSS. This skill is the checklist that catches
those defects before they ship, and the remediation guide when the scanner finds them.

Run `tools/security-scan.mjs` first — it catches the mechanical patterns. This skill
covers what a scanner cannot decide: whether a policy is correct, whether an ownership
check is real, whether a dependency is legitimate.

## When to use

- A feature touches **auth, database, storage, files, payments, or user-generated content**.
- `security-scan.mjs` reports findings and you need to triage or fix them.
- A code review or QA pass needs a security lens.
- Before any production deploy of an AI-generated app.

Do not use for: dependency-only CVEs (use `npm audit`), infrastructure hardening, or
penetration testing of running systems.

## Procedure

### 1. Scan

```bash
node ${AI_SKILLS_HOME}/tools/security-scan.mjs . --severity high
```

Exit `0` = clean. Exit `1` = findings. Every finding carries `severity`, `rule`,
`file:line`, the matched text, and a remediation. Triage each finding:

- **Confirmed** — the pattern is real and exploitable. Fix it.
- **False positive** — the pattern matched but the context is safe (e.g. a test fixture,
  a local variable named `password` that is never sent). Note it and move on.
- **Needs human** — the scanner cannot tell (e.g. "is this URL allowlisted?"). Decide
  from the code or ask the user.

### 2. Review the checklist

The scanner catches syntax. These checks need reading. Go through every section that
applies to the feature.

#### A. SQL & Database

- [ ] **No string-built SQL.** Every query uses parameters (`$1`, `$2`) or the query
      builder. No template literals or `+` concatenation holding SQL keywords.
- [ ] **RLS enabled on every table** that holds user data. `ALTER TABLE ... ENABLE ROW
      LEVEL SECURITY` is present, and policies exist for `SELECT`, `INSERT`, `UPDATE`,
      `DELETE`.
- [ ] **No `SECURITY DEFINER` without a guard.** If a function must be `SECURITY DEFINER`,
      it sets `SET search_path = ''` and checks `auth.uid()` or `pg_has_role()` before
      touching data.
- [ ] **No `DELETE`/`UPDATE` without `WHERE`** in migrations.
- [ ] **No `SELECT *` in production code** — it leaks columns added later.

#### B. Auth & Authorization

- [ ] **Authorization is server-side.** No `localStorage.isAdmin`, no `sessionStorage.role`,
      no client-side feature flags that gate real functionality.
- [ ] **Paywalls are enforced in the API/RLS**, not by hiding content with CSS. A user
      who bypasses the UI must still get `402`/`403` from the server.
- [ ] **Every API route that takes an `id` verifies ownership.** `auth.uid() = owner` or
      an RLS policy — not "the frontend sent the right user_id".
- [ ] **Sessions/tokens expire** and are validated server-side. No "forever" tokens.

#### C. Secrets & Credentials

- [ ] **No secrets in source.** No API keys, passwords, private keys, or service-role
      keys in client code, commits, or logs. Use env vars or a secrets manager.
- [ ] **The anon key is the only key in client code.** The service-role key never ships
      to the browser.
- [ ] **No `.env` committed.** `.env` is in `.gitignore`.

#### D. XSS & Injection

- [ ] **No `dangerouslySetInnerHTML` without sanitization.** Use DOMPurify or render as
      text.
- [ ] **No `innerHTML` / `document.write` with interpolation.**
- [ ] **No `eval()`** or `new Function()` with dynamic input.
- [ ] **User-generated content (bio, comment, name) is rendered as text or sanitized
      HTML**, never as raw markup.

#### E. Storage & Files

- [ ] **Storage buckets are not public.** No `public: true` on buckets holding user
      files. Use signed URLs and per-user policies.
- [ ] **Uploads validate type and size** server-side, not just by extension in the UI.
- [ ] **No policy grants `INSERT`/`UPDATE`/`DELETE` to `anon`** on `storage.objects`.

#### F. Headers, CORS & Transport

- [ ] **Security headers present:** `Content-Security-Policy`, `X-Frame-Options:
      DENY` (or frameguard), `X-Content-Type-Options: nosniff`, `Referrer-Policy`.
- [ ] **CORS is not `*`** when credentials are involved. Allowlist your own origins.
- [ ] **HTTPS only** in production. No mixed content.

#### G. SSRF & External Calls

- [ ] **No `fetch(userControlledUrl)`** without an allowlist. Validate the URL
      server-side; block internal ranges (`10.*`, `172.16.*`, `192.168.*`, `127.*`,
      `169.254.*`).
- [ ] **Webhooks validate signatures** (Stripe, Supabase, etc.) before acting.

#### H. Supply Chain & Dependencies

- [ ] **No hallucinated packages.** Every dependency exists on the registry and is
      actively maintained. Check `npm audit` and `npm outdated`.
- [ ] **No deprecated/CVE libraries.** Upgrade or replace.
- [ ] **Lockfile committed** (`package-lock.json`, `pnpm-lock.yaml`, `bun.lockb`).

#### I. Concurrency & Money

- [ ] **Financial operations use transactions/locks.** No read-modify-write without
      `SELECT ... FOR UPDATE` or an atomic operation.
- [ ] **Idempotency keys** on payment endpoints to prevent double-charging.
- [ ] **No race conditions** in coupon/redemption logic.

#### J. Logging & Privacy

- [ ] **No tokens, passwords, or PII in logs.** Log correlation ids, not credentials.
- [ ] **No `console.log` of `Authorization` headers** or request bodies in production.

### 3. Fix

For each confirmed finding:

1. Apply the remediation from the scanner or the checklist.
2. Re-run `security-scan.mjs` until it exits `0`.
3. For findings the scanner cannot verify (ownership checks, policy correctness),
   add a test or a manual verification step and record it in `evidence.md`.

### 4. Verify

```bash
node ${AI_SKILLS_HOME}/tools/security-scan.mjs . --severity high   # exit 0
node ${AI_SKILLS_HOME}/tools/sdlc-verify.mjs --feature <f>          # if wired into acceptance.yaml
```

A feature is not "secure" because the scanner is clean — it is secure because every
item on the applicable checklist is confirmed and the scanner reports nothing.

## Wiring into the SDLC flow

- **feature-autopilot**: the leader adds a `kind: security` check to `acceptance.yaml`
  when the feature touches auth/db/storage. The builder's brief includes the security
  checklist for that slice.
- **bug-fix**: the verify step runs `security-scan.mjs` when the defect is security-related.
- **code review**: `pct102-review-code` includes the security checklist as a review axis.

## Completion report

Report:

- status: `clean` | `findings-fixed` | `needs-human`
- findings by severity (critical / high / medium / low)
- which checklist sections were reviewed and confirmed
- remaining items that need a human decision
- evidence: scanner output path or inline

Never report "secure" without the scanner output and the checklist review behind it.
