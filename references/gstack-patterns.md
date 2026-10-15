# Gstack Pattern Reference

Source: `https://github.com/garrytan/gstack`

## Use

Use selected gstack patterns as optional review roles inside `app-sdlc`; do not install the full bundle by default.

## Selected patterns

- `office-hours`: product reframing and forcing questions
- `plan-ceo-review`: scope and product-value challenge
- `plan-eng-review`: architecture, data flow, edge cases, and test plan
- `plan-design-review`: design-quality challenge
- `review`: production-oriented code review
- `qa` and `qa-only`: browser and user-journey verification
- `ship` and `land-and-deploy`: release coordination
- `canary`: post-deploy monitoring
- `retro`: process learning
- `careful`, `freeze`, and `guard`: destructive-operation and edit-boundary guardrails

## Routing

Use Jev to select the smallest role set for the current stage. Do not run every role for every task. Repository standards, human approval, deterministic tests, and security gates remain authoritative over a role persona.

## Installation boundary

gstack has its own setup, browser, global hooks, and multi-agent commands. Treat installation as a separate reviewed change. Audit scripts and generated files with SkillSpector before enabling them.
