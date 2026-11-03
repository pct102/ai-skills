---
name: morphicons-animate
description: Makes icons that can be clicked, toggled or hovered move instead of snapping (hamburger to X, plus to minus, chevron, heart or bookmark pop, sun to moon, bell swing, arrow nudge). Transform-only CSS driven by aria-expanded or aria-pressed, with reduced-motion support. Use when adding or polishing interactive icons in a UI; not for decorative icons, loaders, or illustrations.
---

# Morphicons Animate

An icon the user presses should answer the press. This skill gives you a small stylesheet (`assets/morph.css`) and SVG markup for the common cases; the button's own state drives the motion, so no animation JS is needed.

## When to use
Icon-only or icon+label controls that change meaning (menu open/close, expand/collapse, like, theme, mute) or that invite a click (bell, "next" arrows). Skip decorative icons and anything that loops forever.

## Rules
- **State on the button, motion on the SVG.** `aria-expanded` (menu, accordion, dropdown) or `aria-pressed` (like, theme, bookmark) is both the accessibility state and the CSS hook. Never animate from a separate `.is-open` class that screen readers cannot see.
- **Transforms and opacity only** (`transform`, `opacity`, `fill`). They run on the GPU and work in every browser. Do not morph the `d` attribute with CSS: only Chromium supports it.
- **Short and quiet:** 200-360 ms, one gesture per icon, nothing that competes with the task. Hover hints (bell swing, arrow nudge) play once, never loop.
- **Reduced motion:** the stylesheet already disables all of it under `prefers-reduced-motion: reduce`; keep that block if you copy the CSS.
- **Accessible:** the button carries `aria-label` (or visible text); the SVG gets `aria-hidden="true"`; keep the focus ring visible. Touch target at least 40x40 px.

## Workflow
1. **Find targets.** In the component, list icon buttons and what state each changes. Ignore decorative icons.
2. **Match each to a pattern** in `assets/morph.css`: `mi-menu`, `mi-plus`, `mi-chev`, `mi-heart`, `mi-theme`, `mi-bell`, `mi-nudge`. Markup for each is in `examples/button-with-morphicon.html` (copy the `<svg>`).
3. **Wire the state.** Make sure the button already toggles `aria-expanded` / `aria-pressed` from React state (`aria-expanded={open}`); that is all the logic needed.
4. **Add the CSS once** (import `morph.css` globally, or paste the needed blocks into the project's global stylesheet; Tailwind projects can keep it as plain CSS next to `globals.css`). If the project uses an icon library (lucide, heroicons), wrap its SVG in the same `.mi` classes and give the moving parts the class names the pattern expects (`t`, `m`, `b`, `v`, `sun`, `moon`, `swing`); when the library icon is one solid path, use the whole-icon patterns (`mi-chev`, `mi-heart`, `mi-nudge`) and skip menu/plus.
5. **Check:** keyboard (Tab, Enter, Space), both states in light and dark, reduced motion on, and the header/mobile widths the icon lives in. Run `pct102-ui-qa` on the page if the app has it set up.

## Limits
Only the patterns above are prepared. A new gesture (say a mic that pulses while recording) is one more block in the same style: transform/opacity, state from `aria-*`, reduced-motion covered. Do not pull in an animation library for these.
