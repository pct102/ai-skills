# Vendored copy of Archify

This directory is a trimmed copy of [`tt-a1i/archify`](https://github.com/tt-a1i/archify) (`archify/` subdirectory),
MIT licensed. Copyright (c) 2026 tt-a1i (Archify), (c) 2025 Cocoon AI. `LICENSE` and `THIRD_PARTY_NOTICES.md` are kept as shipped.

- Upstream commit: `d5a1333` (package version 3.0.1)
- Removed from the copy: `test/`, rendered `examples/*.html`, `package-lock.json`. Nothing else is modified; `SKILL.md` is upstream's.
- Why vendored: `tools/sdlc-diagrams.mjs` renders the autopilot trace and status as Archify diagrams on a machine that
  may have no network and no installed skill, so the renderer is pinned here.
- Runs with Node >= 18 and no `npm install`. The browser gate needs Chrome or Chromium: set `ARCHIFY_CHROME`
  to its executable, or let `sdlc-diagrams.mjs` look in the usual places.
- Update checks are switched off by `sdlc-diagrams.mjs` (`ARCHIFY_UPDATE_CHECK_DISABLED=1`); updating is a deliberate re-vendor.

To update: clone upstream, copy `archify/` over this directory with the same exclusions, run
`node bin/archify.mjs doctor`, `bash tools/selftest/run-all.sh`, and change the commit above.
