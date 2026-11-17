# AITMPL Reference

Source: `https://www.aitmpl.com` (registry and CLI: `https://github.com/davila7/claude-code-templates`, MIT)

## Use

A searchable catalog (about 930 skills, 420 agents, 130 MCP servers, 290 commands, 60 hooks, plus plugins and settings). It is a discovery source, not a dependency. Nothing here installs by default.

## Procedure to add anything from it

1. Search the site (or `npx claude-code-templates@latest`) for the narrowest match. Prefer an item whose upstream repo is maintained and has a licence.
2. Read the component's source page, not only the description.
3. Install into a scratch dir, run `references/skillspector.md` (static first; semantic scan for hooks, MCP servers, scripts).
4. Install one item at a time: `npx claude-code-templates@latest --skill <category/name>` (`--agent`, `--mcp`, `--hook`, `--command`, `--setting` likewise). Add `--yes` only after steps 1-3.
5. Pin the version or commit, then add one row to `references/dependencies.md` naming the item, its source, and the case it serves.

## Shortlist (checked 2026-11-17 against the catalog's own scan data)

The catalog's SkillSpector scores come from aitmpl (dated 2026-10-17, many `partial`). They help triage; they do not replace the local scan in step 3.

**Worth adding only if the case arises** (each scanned `SAFE` or low risk unless noted):

| Skill | For | Note |
| --- | --- | --- |
| `business-marketing/content-research-writer` | Reports and articles with research and citations | SAFE, complete scan |
| `business-marketing/copywriting` | Landing-page and marketing copy | SAFE, complete scan |
| `business-marketing/seo-audit` | SEO check of a public site | SAFE, complete scan |
| `productivity/doc-coauthoring` | Structured co-writing of documentation | 0 findings, partial scan |
| `web-development/react-best-practices` (Vercel Engineering, MIT) | React and Next.js performance rules | MEDIUM (score 41, partial): read the flagged files before installing |

**Do not install despite high downloads:**

- `creative-design/mobile-design` (10,585 downloads): scan says `DO_NOT_INSTALL`, score 96, 14 findings.
- `scientific/citation-management`: scan says `DO_NOT_INSTALL`.

**Skip: this repo or the host already covers it.** `brainstorming`, `systematic-debugging`, `writing-plans`, `code-reviewer` (superpowers); `ui-ux-pro-max` (`references/ui-ux-pro-max.md`); `frontend-design` and `ui-design-system` (`impeccable`); `docx`, `pdf`, `pptx`, `xlsx` (the installed Anthropic skills); `webapp-testing` (`references/playwright-mcp.md`); `mermaid-diagrams`, `draw-io`, `excalidraw` (`archify`); `humanizer` (`references/slopmonster.md`, `references/instagram-agent-skill.md`); the generic `senior-*` skills.

**Skip: wrong domain.** About 270 skills in `scientific` and `ai-research`, plus vendor-specific groups (doordash, railway, sentry, pocketbase…). Look there only for a concrete need.

**Gaps the catalog does not fill:** no usable skill for exam writing (blueprint, scoring, answer key) or lesson design. Those need a repo-owned skill.

## Rules

- Hooks, MCP servers, and settings run with the user's authority; treat them as code review, not as copy-paste.
- Registry listings are community submissions. A star count is not a safety signal.
- Do not mass-install. A skill that is never routed to only adds to every session's context.

## Cases

- **Need a capability the repo lacks** (for example a database MCP): search, scan, install one, record it.
- **Find a better version of an existing skill:** compare against the repo's adapter first (`pct102-*`); keep the adapter as the entry point.
