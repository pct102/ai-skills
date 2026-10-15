# Site Clone Reference

Source: `https://github.com/cth9191/site-clone`

## Use

Use this reference to study an authorized site's layout, tokens, motion, and responsive behavior when building a similar interface. It is a measurement and learning workflow, not permission to copy another product's brand or content.

## Workflow

1. Confirm the target is owned by the user or explicitly authorized for study.
2. Start with `clone-site --analyze-only` or the equivalent teardown.
3. Classify each visual surface as DOM/CSS, WebGL/WebGPU, Canvas, video, or SVG.
4. Use DOM extraction for layout, type, color, spacing, breakpoints, and normal motion.
5. Use shader extraction only for a specifically authorized GPU surface and when the effect matters.
6. Rebuild the structure with the target project's stack and design tokens.
7. Run Playwright pixel-diff checks at desktop, tablet, and mobile widths.
8. Replace brand, copy, assets, fonts, endpoints, analytics, and identity before delivery.

## Required evidence

Record the source URL, authorization basis, measured tokens, surface map, motion parameters, assets, license status, viewport coverage, and remaining differences. Label observations as confirmed, observed, or inferred.

## Guardrails

Never use a site clone for phishing, impersonation, credential collection, or passing off another brand as your own. Logos, photos, product shots, copy, and licensed fonts remain the rights of their owners.
