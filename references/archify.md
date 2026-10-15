# Archify Reference

Source: `https://github.com/tt-a1i/archify` (MIT). A trimmed copy is vendored at `skills/archify/`; see
`skills/archify/VENDORED.md` for the pinned commit, what was removed, and how to update.

## Use

Archify turns typed JSON into a self-contained, explorable HTML diagram (inline SVG, dark/light, trace
motion, export) and gates it: schema and layout validation, delivery, HTML checks, and a real-browser check.
Five types: `architecture`, `workflow`, `sequence`, `dataflow`, `lifecycle`.

In this repo it is used two ways:

1. **Generated from recorded facts.** `tools/sdlc-diagrams.mjs --feature <f>` draws the autopilot
   trace as a `sequence` diagram and the feature status as a `lifecycle` diagram. No model is involved.
2. **Authored by the leader.** At the end of a feature the leader draws an `architecture` diagram (what was
   built) and a `workflow` diagram (what the user can do) from the code it reviewed, following
   `skills/archify/SKILL.md`. Also useful during design for any system that needs an architecture, workflow,
   sequence, data-flow or lifecycle artifact.

## Workflow

1. Choose the diagram type from the question.
2. Write typed JSON with only authored components and relationships; mark source-backed claims with `sources`.
3. `node skills/archify/bin/archify.mjs finalize <type> <candidate.json> <output.html> --quality showcase --json`
4. Fix the failing gate and rerun the whole command. A non-zero exit is not success.
5. Keep the editable JSON beside the HTML.

## Guardrails

Do not use Archify to claim live infrastructure facts that were not inspected. Keep the diagram at the level
of decision value; put supporting detail in cards instead of adding noisy edges. A visual artifact is
communication, not a substitute for the spec, ADR, or tests. The browser gate needs Chrome or Chromium
(`ARCHIFY_CHROME`); without it the HTML is still produced and the run says the check was skipped.
Update checks are off (`ARCHIFY_UPDATE_CHECK_DISABLED=1`): updating the vendored copy is a deliberate re-vendor.
