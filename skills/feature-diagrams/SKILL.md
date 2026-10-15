---
name: feature-diagrams
description: Draws the two code-derived diagrams of a finished feature, how it is built (architecture) and what the user does (workflow), as validated Archify HTML. Use after a feature reaches accepted; autopilot.sh runs it as its own pass. Not for the trace or status diagrams, which tools/sdlc-diagrams.mjs generates.
---

# Feature diagrams

## Purpose

After autopilot accepts a feature, a reader should be able to open one page and see, without reading the
code, how the feature is built and what a user does with it. This skill draws those two pictures. They are
the only diagrams that need a model: the trace and the status map (only while the feature is not accepted) are generated from
recorded facts by `tools/sdlc-diagrams.mjs`.

Always draw **both**, even when the feature is one file. A one-file feature still has parts (state, rendering,
input, text, storage) and a picture of how they fit is the point.

## Invocation

`autopilot.sh` runs this after the main run when the feature is `accepted` and the two diagrams are missing:
`claude -p "/feature-diagrams feature name: <f>" --dangerously-skip-permissions`. It can also be run by hand.

The feature name is in the prompt (`feature name: <f>`). Work from the project root, where `.sdlc/` lives.

## Procedure

1. **Check the gate.** Read `.sdlc/features/<f>/status.json`. If `phase` is not `accepted`, stop and say so;
   do not draw a picture of unproven work.
2. **Read what you are drawing.** `spec.md`, `plan.md`, `ownership.json`, then the owned files. For a large
   feature read the entry points and what they call, not every file. Take facts from the code, not from the plan.
3. **Read the renderer's rules.** `${AI_SKILLS_HOME}/skills/archify/SKILL.md`, fast authoring path, and the
   shape examples beside this file: `references/example.architecture.json`, `references/example.workflow.json`.
   They are validated; copy their structure, never their words.
4. **Draw `architecture`** to `.sdlc/features/<f>/diagrams/architecture.json`:
   - Components are the real parts: modules, or for one file its internal sections (state, drawing, input
     handling, text/i18n, storage). Say what each is for in its `sublabel`.
   - Connections are real calls and data movement, labelled with the action. Put a one-file feature inside a
     boundary named after the file.
   - Mention file names in sublabels or cards as plain text.
5. **Draw `workflow`** to `.sdlc/features/<f>/diagrams/workflow.json`:
   - What the user does, in order, with the system's response, in two lanes (the user, the feature).
   - Include the branches the spec or QA exercised: the error, the empty state, the undo, the end.
6. **Rules for both.**
   - Do **not** set `meta.repository`, do not add `sources`, do not pass `--repo-root`. Archify verifies those
     against committed bytes, and a feature that was just built is usually not committed yet.
   - `meta.output` is the HTML path: `.sdlc/features/<f>/diagrams/<type>.html`. `meta.quality_profile` is `showcase`.
   - Two to three cards of two short bullets each. Labels short. No node, edge or card quota beyond that.
   - One language: English labels, unless the spec is written in another language and the user wrote in it.
7. **Finalize each**, from the project root:

   ```bash
   ARCHIFY_UPDATE_CHECK_DISABLED=1 node ${AI_SKILLS_HOME}/skills/archify/bin/archify.mjs finalize \
     <architecture|workflow> .sdlc/features/<f>/diagrams/<type>.json \
     .sdlc/features/<f>/diagrams/<type>.html --quality showcase --json
   ```

   If the browser gate says Chrome is unavailable, set `ARCHIFY_CHROME` to its executable and rerun.
   A non-zero exit is not success: read the compact result, repair the named gate as Archify's own
   references describe, rerun the whole command. At most two repair rounds per diagram. If one still fails,
   leave its JSON in place, say which gate failed, and move on.
8. **Refresh the hub:** `node ${AI_SKILLS_HOME}/tools/sdlc-diagrams.mjs --feature <f>`. It links every diagram in
   `.sdlc/features/<f>/diagrams/index.html` and lists any that are still missing.

## Output

Report: the two HTML paths, each diagram's gate result (validate, deliver, check, browser) as Archify printed
it, anything that failed with its error, and the hub path. Do not claim the pictures look good: say that
automated checks passed, or what failed. Do not commit anything; `sdlc-ship` commits the two `.json` sources
and leaves the rendered HTML out.
