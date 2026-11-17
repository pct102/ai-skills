# Vercel React Best Practices (vendored)

Source: `https://github.com/vercel-labs/agent-skills`, path `skills/react-best-practices`, pinned at commit `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` (2026-11-17). License: MIT, declared in the skill's own `SKILL.md` frontmatter; the upstream repo ships no separate LICENSE file.

Vendored at `skills/vercel-react-best-practices/` as an exception to the "do not copy" rule in `dependencies.md`: it is 416 KB of Markdown and JSON only, with no scripts and no network access, so there is nothing to run and nothing to rot except the rules themselves.

## Use

70 performance rules for React and Next.js in 8 categories, by impact: eliminating waterfalls, bundle size, server-side performance, client data fetching, re-renders, rendering, JavaScript, advanced patterns. Use it when writing, reviewing, or refactoring Next.js or React code, especially data fetching and bundle size. It complements `pct102-frontend-patterns` (what to build); this says how to build it fast.

## Review notes (why it is safe to link)

- The catalog's own scan (aitmpl, `MEDIUM`, partial) flags "unvalidated output injection" on two code examples and `npx` without a version in two examples. These are sample snippets inside rule text, not instructions. No other file types exist, and a grep for override phrases, `curl | sh`, `child_process`, and base64 found nothing.
- The copy already on this machine at `~/.agents/skills/react-best-practices` is a stale community repackaging (45 rules). Use this vendored one, not that one.

## Update

Re-run the download for the new commit, diff against `skills/vercel-react-best-practices/`, read the changed rules, then update the pinned SHA above. Never auto-update.

## Related upstream skills (not installed)

`composition-patterns` (React component composition), `web-design-guidelines` (UI review against Vercel's guidelines), and `vercel-optimize`, in the same repo. Add one only for a concrete case, via the same procedure.
