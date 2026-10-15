---
name: pct102-frontend-patterns
description: Guides frontend component selection and integration using reusable UI patterns, design-system conventions, animation, accessibility, and performance checks. Use when building or reviewing a React/frontend UI and considering components from React Bits or another component library; not for backend-only work.
---

# Frontend Patterns

## Purpose

Turn visual ideas and component-library choices into maintainable frontend implementations. This skill is a playbook, not a copy of a component catalog. It teaches when to reuse, adapt, or reject a component.

## Source library

React Bits is a useful reference catalog at `https://github.com/DavidHDev/react-bits`. It provides animated and customizable React components across text, UI, micro-interactions, and backgrounds, with JavaScript/TypeScript and CSS/Tailwind variants.

Use the source library as inspiration or an integration dependency. Do not copy its whole catalog into this skill repository. Before copying or installing source, check its current license and preserve attribution and license terms. For an authorized site to study, use `../../references/site-clone.md`; for architecture or flow explanations, use `../../references/archify.md`; for browser verification, use `../../references/playwright-mcp.md`.

## Workflow

### 1. Inspect the product surface

Before selecting a component:

- identify the user goal and page hierarchy
- inspect the existing design tokens, component library, CSS approach, and package manager
- identify target browsers, device sizes, and performance constraints
- determine whether the feature is static, interactive, animated, or data-driven

Reuse the existing design system before adding a new dependency.

### 2. Choose the smallest adequate pattern

Apply this order:

1. native HTML and platform behavior
2. an existing project component
3. an already-installed component
4. a compatible component library
5. new custom code

Use `pct102-ponytail` as a scope discipline. A visual flourish must not create an unnecessary dependency or a fragile component API.

### 3. Define the component contract

For each component, specify:

- user-visible outcome
- props and controlled state
- variants and responsive behavior
- loading, empty, error, and disabled states
- keyboard and screen-reader behavior
- reduced-motion behavior
- performance budget
- source and license when external code is used

Keep animation state separate from domain state. Avoid global side effects and hidden coupling.

### 4. Integrate safely

For React Bits, select a component only when its framework, runtime, styling variant, and dependency requirements match the project. When using its CLI, use the documented package identifier and inspect the generated files before committing them.

Pin external component sources to a known version or commit. Keep a record of source and license in the feature evidence. Do not import a component if its dependency tree conflicts with the project.

### 5. Verify behavior and quality

Run the relevant checks:

- component or integration tests
- keyboard and accessibility checks
- reduced-motion verification
- responsive screenshots or browser checks
- bundle and runtime performance checks
- lint, typecheck, and build

For animated components, verify the first-frame state, interaction states, cleanup, and behavior when the tab is backgrounded.

## Design constraints

Prefer clear hierarchy, restrained motion, readable content, and purposeful contrast. Avoid decorative animation that competes with the primary task. Preserve keyboard access, visible focus, semantic structure, and reduced-motion preferences.

## Modes

- `explore`: compare component directions before implementation
- `integrate`: add a compatible component to an existing frontend
- `adapt`: modify a component to match project tokens and behavior
- `audit`: review a frontend for reuse, accessibility, motion, and performance
- `review`: inspect a diff and report concrete UI or component risks

## Completion

A frontend change is complete when the component contract is satisfied, required states are covered, accessibility and reduced-motion behavior are verified, performance is acceptable for the target surface, and the source/license of external code is recorded when applicable.
