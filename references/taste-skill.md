# Taste Skill Reference

Source: `https://github.com/Leonxlnx/taste-skill` (MIT), skill `design-taste-frontend` v2.5.x

## Use

Builds or redesigns **company and marketing websites** (landing page, SaaS, shop, cafe, hotel, studio, game site) so they do not look templated: one dealt palette and font pairing per business kind, one of eleven hero layouts, real photographs and product UI, a hero entrance plus one or two "moments" per page, and a checker that renders the page in headless Chrome at 1440 / 1024 / 768 / 390 and fails the build on empty visuals, misaligned columns, low contrast, or placeholder text.

This is the "make the page stand out" skill. It is opinionated: it forbids captions under images, requires one section per screen, and allows shader effects, scroll scenes, and 3D only on `software`, `tech`, and `gaming` pages. Cafes, hotels, shops, and services get photo- and type-led moments and zero WebGL, by design.

Not for: dashboards, app screens, admin tools, or design-system work (use `ui-ux-pro-max` then `pct102-frontend-patterns`), and not for critique of an existing product UI (`impeccable`).

## Install (not vendored: about 1,600 files and 100 MB of photos and components)

```bash
npx skills add https://github.com/Leonxlnx/taste-skill --skill "design-taste-frontend"
```

Or `/plugin marketplace add Leonxlnx/taste-skill` then `/plugin install taste-skill@taste-skill`. Needs Node 22+ and Chrome, Edge, or Chromium. No API keys. Network is used only to fetch extra photographs, Google Fonts, and brand icons. Run `references/skillspector.md` first and pin the version.

## Choosing between the three UI skills

| Situation | Use |
| --- | --- |
| Company or marketing site that must look distinctive | taste-skill |
| New product UI, no design system yet | `ui-ux-pro-max`, then `pct102-frontend-patterns` |
| Existing screen to critique or polish | `impeccable` |
| Anything to verify live | `pct102-ui-qa` |

Do not run two of them as the primary builder on the same page. Pick one; the others may review.

## Rules

- **Stop hook.** The skill declares a `Stop` hook running `scripts/gate.mjs`, with a 600 s timeout. The hook acts only in a folder where a deal armed the gate (`scripts/start.mjs deal ...`). Never arm it inside a `feature-autopilot` run: the gate can hold the finish for up to three rounds and would fight `tools/` as the acceptance authority. Autopilot acceptance stays with `tools/`.
- Its checker is a design-rule gate, not product acceptance. A `GATE: PASS` does not replace `pct102-ui-qa` or the feature's own e2e tests.
- Photographs: use its credited stand-ins only as marked drafts; replace them with the client's own images before launch.
- Treat the sponsor links and the TasteCode promotion in its README as marketing, not as part of the skill.

## Cases

- **A page that must make an impression** (launch page, portfolio, event): `Use design-taste-frontend to build a <kind> site for <business>`; state the kind (`software`, `gaming`, `tech`, `product`, `service`, `place`) so it deals the right effects.
- **Page that feels generic or "AI-made":** ask it to audit the existing page in a browser first; it changes nothing before auditing.
- **Non-tech business wanting more flash:** the skill will refuse shaders on purpose. Ask for a stronger photo or typography moment instead, or decide explicitly to override.
