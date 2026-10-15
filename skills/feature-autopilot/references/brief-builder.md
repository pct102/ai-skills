# Builder brief: <slice id or "whole feature">

You are the builder. Work only inside your own files. Another builder may be working next to you on
other files and you cannot see their work, so rely only on the interfaces written here.

## What to build

Read, in the project root: `.sdlc/features/<f>/spec.md` sections <headings that are this slice's job> and
`.sdlc/features/<f>/plan.md` sections <headings>. Do not paste the spec here: point to it.

## Your files (and nothing else)

<owns globs>

Do not create or edit any other file, not even to fix something that looks wrong. Say so in your reply instead.

## Interfaces you must keep exactly

Copy from `plan.md`: names, signatures, event names, data shapes, the hooks in `test-contract.md`.
If a name here is missing something you need, ask in your reply; do not invent a different one.

## How to test (read this, it saves most of your time)

- Run only the tests for your own files, never the whole suite: `<slice check command>`.
- Always use `--max-failures=1` (or `--bail`) and, for browser tests, `--timeout=15000`. Fix the first
  failure, then run again. Do not read a long list of failures.
- Run fast tests while you work. Do not run tests marked `slow` in `test-contract.md`; the leader runs them once at the end.
- Never start a command that waits for input or runs a watcher.
- If one command runs longer than 2 minutes, stop it, say what hung, and go on.
- Do not write the end-to-end (browser) suite. QA writes it from the test contract.

## Security (read this if the feature touches auth, db, storage, or payments)

- **No string-built SQL.** Use parameters (`$1`, `$2`) or the query builder. Never interpolate
  values into SQL strings or template literals.
- **RLS on every table** that holds user data. Enable it and write policies for SELECT/INSERT/UPDATE/DELETE.
- **No `SECURITY DEFINER` without a guard** (`SET search_path`, `auth.uid()` check).
- **No secrets in source.** Use env vars. The anon key is the only key that ships to the client.
- **Authorization is server-side.** No `localStorage.isAdmin`, no CSS-only paywalls.
- **No `dangerouslySetInnerHTML` without DOMPurify.** Render user content as text or sanitized HTML.
- **Storage buckets are not public.** Use signed URLs and per-user policies.
- **No `fetch(userControlledUrl)`** without a server-side allowlist.
- **No tokens or PII in logs.**

If you are unsure whether something is safe, say so in your reply — the leader will decide.

## When you are done

Reply with: files created or changed, the interfaces you exposed (one line each), the exact check command
and its result, and anything you could not do. Keep it under 30 lines.
