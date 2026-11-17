# UI UX Pro Max Reference

Source: `https://github.com/nextlevelbuilder/ui-ux-pro-max-skill` (MIT)

## Use

Design intelligence for the *decision* step of UI work: product type → style, palette, typography, landing-page pattern, per-stack guidelines (22 stacks). It generates a design system before any code is written. It does not critique or polish; that stays with `impeccable` and `pct102-ui-qa`.

## Install (not vendored: 22 stacks of CSV data would rot here)

```bash
npm install -g ui-ux-pro-max-cli      # command is still `uipro`; ignore the stale `uipro-cli`
uipro init --ai claude --global       # installs to ~/.claude/skills/
```

Or in Claude Code: `/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill`, then `/plugin install ui-ux-pro-max@ui-ux-pro-max-skill`. Python 3 is required for its search script. Run `references/skillspector.md` first, then pin the version.

## Position in the UI pipeline

```text
ui-ux-pro-max (design system) → pct102-frontend-patterns (components, motion) → impeccable (critique, polish) → pct102-ui-qa (black-box check)
```

Skip the first step for a small fix to an existing screen; use it for a new product, page, or a retheme.

## Cases

- **New landing page or app UI:** `Use ui-ux-pro-max to generate a design system for <product, audience>, then build it in <stack>.` Keep the generated system in the project (for example `design-system/`), so later sessions reuse it instead of regenerating.
- **Retheme an existing app:** name a catalog style; make it reuse existing semantic tokens and migrate one component batch at a time. Search results are guidance, they do not rewrite the app.
- **Review a screen:** use `impeccable` critique, not this skill.

## Boundary

Dark-mode and contrast claims still need `pct102-ui-qa`; a generated palette is not evidence.
