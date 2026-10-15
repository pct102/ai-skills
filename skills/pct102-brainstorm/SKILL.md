---
name: pct102-brainstorm
description: Explores options and classifies work scope before locking a feature contract. Use when a feature is vague, has competing directions, or needs design options before planning. Delegates to the installed brainstorming skill when available; otherwise executes the brainstorm contract inline.
---

# Personal Brainstorm Adapter

If the `brainstorming` skill from `obra/superpowers` is installed, invoke it directly — do not re-run this skill's workflow.

Otherwise, execute the following contract:

## Step 1 — Classify the work

Classify the request as one of:

- `spike`: answer a feasibility question with a throwaway probe
- `bounded`: change an existing flow with a small, local design
- `architectural`: add a subsystem, change public interfaces, or create a new project

When uncertain, choose the heavier classification. A new project is architectural even when the feature list is short.

## Step 2 — Inspect before asking

Read the repository, docs, and recent context before asking questions the codebase can answer. Use `pct102-jev` to classify whether each unresolved branch blocks the next step, needs a user choice, or can be deferred. The user answers the actual product question — Jev only classifies the routing.

## Step 3 — Offer options

Ask only decision-bearing questions, one at a time. Present two or three materially different approaches with explicit trade-offs at the scale of the selected classification path.

## Step 4 — Gate on approval

Obtain explicit human approval for the selected design before implementation.

- `architectural` path: write the approved spec and hand off to `feature-lifecycle`
- `bounded` path: stop after the in-chat design is approved
- `spike` path: label any code or experiment as throwaway

Do not write production code before the approval gate. Read-only exploration is allowed.
