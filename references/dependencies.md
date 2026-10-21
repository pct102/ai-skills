# Dependency Contract

These are reusable capabilities. They are not copied into this repository and must be installed or made available in the target agent environment.

## Authoritative sources

| Capability | Source | Repository adapter | Preferred installed skill | Use in this workflow |
| --- | --- | --- | --- | --- |
| `brainstorming` | `obra/superpowers` | `pct102-brainstorm` | `brainstorming` | Classify the work and establish approved design before implementation. |
| `superpowers` workflow | `obra/superpowers` | `app-sdlc`, `feature-lifecycle` | `using-git-worktrees`, `writing-plans`, `subagent-driven-development`, `executing-plans`, `test-driven-development`, `requesting-code-review`, `finishing-a-development-branch` | Isolated execution, planning, TDD, review, and branch completion. |
| `grill-me` | `mattpocock/skills` | `pct102-grill-me` | `grill-me`, `grilling`, `grill-with-docs` | One-question alignment and decision-tree stress testing. |
| `ponytail` | `DietrichGebert/ponytail` | `pct102-ponytail` | `ponytail` | YAGNI, native/stdlib reuse, minimum durable change, and scope control. |
| `jev` | `tumf/jev-cli` (`uv tool install jev-cli`) plus `tools/jev-proxy/` as the local backend | `pct102-jev` | `jev` | Typed `noul`, `choice`, and `score` judgments for routing and evidence triage. |
| `verification` | `obra/superpowers` | `app-sdlc` | `verification-before-completion` | Evidence before completion claims. |
| `tdd` | `obra/superpowers` and `mattpocock/skills` | `pct102-tdd` | `test-driven-development`, `tdd` | Red-green-refactor behavior changes and regression coverage. |
| `review-code` | `obra/superpowers` and `mattpocock/skills` | `pct102-review-code` | `requesting-code-review`, `code-review` | Final diff, spec compliance, security, and regression review. |
| `session-retro` | `mattpocock/skills` | `references/mattpocock-skills.md` | `retro` | Turn a finished run's trace and evidence into environment fixes. |
| `git-guardrails` | `mattpocock/skills` (`skills/misc`) | `references/mattpocock-skills.md` | `git-guardrails-claude-code` | Block destructive git commands in unattended sessions. |
| `spec-and-tickets` | `mattpocock/skills` | `references/mattpocock-skills.md` | `to-spec`, `to-tickets`, `implement-spec`, `handoff`, `triage`, `wayfinder` | Optional tracker-based planning and hand-off; `tools/sdlc-slices.mjs` stays the authority inside autopilot. |
| `bug-fix` | `obra/superpowers` | `bug-fix` | `systematic-debugging`, `verification-before-completion` | Reproduce, isolate, confirm root cause, regression test, minimal fix, verify. |
| `frontend-patterns` | React Bits | `pct102-frontend-patterns` | `frontend-ui-engineering`, `ckw-design` | Reusable component selection, React Bits integration, motion, accessibility, and visual QA. |
| `site-clone` | `cth9191/site-clone` | `pct102-frontend-patterns` | `clone-site`, `dom-clone`, `shader-extract`, `remix-site` | Authorized design teardown, measured rebuild, and pixel QA. |
| `public-apis` | `public-apis/public-apis` | `references/public-apis.md` | Provider-specific integration skills | Discover and evaluate external data sources. |
| `skill-spector` | `NVIDIA/SkillSpector` | `references/skillspector.md` | `skill-inspector` | Security scan and install gate for external skills and MCP servers. |
| `content-quality` | `ItsssssJack/SlopMonster` | `references/slopmonster.md` | `slopmonster` | English copy quality and unsupported-proof checks. |
| `cross-model-review` | `chaseai-yt/claudex-loop` | `references/claudex-loop.md` | `claudex-loop`, `claudex-route` | Optional high-assurance plan and implementation review. |
| `browser-qa` | `microsoft/playwright-mcp` | `references/playwright-mcp.md` | Playwright CLI + skills or Playwright MCP | Browser journeys, accessibility, visual QA, and E2E. |
| `architecture-diagrams` | `tt-a1i/archify` | `references/archify.md` | `archify` (vendored at `skills/archify/`, MIT, pinned) | Validated architecture, workflow, sequence, data-flow, and lifecycle diagrams. |
| `gstack-patterns` | `garrytan/gstack` | `references/gstack-patterns.md` | Selected gstack role skills | Optional product, engineering, design, QA, release, and safety reviews. |
| `agent-roster` | `msitarzewski/agency-agents` | `references/agency-agents.md` | Selected agency agents | Optional specialist roles selected by Jev. |

The `pct102-*` adapters and `references/*.md` files provide a stable project-local fallback and routing contract. When a preferred external skill is installed, the adapter delegates to it instead of replacing it.

## Selection rules

1. Use the narrowest capability that changes the current decision.
2. Do not invoke a helper merely because it exists.
3. If a preferred skill is unavailable, follow the fallback procedure in the owning workflow.
4. Do not duplicate an external skill's full instructions here. Keep this file as a routing and dependency contract.
5. Pin external skill versions in the installer or lock file when this repository gains an installer.
6. Preserve upstream license and attribution when copying or adapting source.
7. Run `references/skillspector.md` before installing executable external skills, plugins, or MCP servers.

## Superpowers contract

The Superpowers spine is:

```text
brainstorming → using-git-worktrees → writing-plans → subagent-driven-development or executing-plans → test-driven-development → requesting-code-review → finishing-a-development-branch
```

Use an isolated worktree for parallel or risky work. Present the written design or plan before implementation. Keep evidence at each gate. Do not skip planning or review because the change appears small.

## Jev contract

Use Jev only when the decision has explicit options, ordered levels, or a bounded yes/no question. Pass raw evidence, not a guessed conclusion. The proxy configuration may use `JEV_ENDPOINT`, `JEV_PROVIDER`, and a local proxy key; never print or commit provider secrets. Jev output never overrides failing deterministic tests or human product decisions.

At the beginning of alignment, use a bounded Jev check to identify whether an unresolved question blocks the next step, needs a user choice, or can be deferred. Use Jev to rank candidate questions, external APIs, specialist roles, and review modes when several branches compete. Do not call Jev to answer the user's product question; ask the user after the classification.

## Ponytail contract

Ponytail is a scope and simplicity discipline. Follow the source ladder: YAGNI, existing codebase, standard library, native platform, installed dependency, one line, then minimum sufficient code. It must not remove required security, accessibility, data integrity, error handling, or a runnable check for non-trivial logic.

## TDD contract

A regression test is meaningful only when it fails because of the confirmed defect and passes after the fix. A test that was already green does not prove the bug was reproduced. Agree on the public seam before writing tests and use vertical slices.

## Review contract

Review the diff against the feature contract and the repository's documented standards. A clean diff is not proof that the feature is correct; acceptance evidence remains required.
