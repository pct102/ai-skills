---
name: pct102-jev
description: Routes and classifies bounded judgments using Jev — a System 1 fast-routing model running via local Proxy. Use for yes/no routing, option selection, scoring against explicit criteria, and evidence triage. Falls back to local reasoning when the Jev endpoint is unreachable.
---

# Personal Jev Adapter

## What Jev is

Jev is a System 1 fast-routing model (e.g. Jev 1.13) dedicated to low-latency classification and routing decisions. It runs as a background service through a local Proxy. It is not a general-purpose language model — it does not generate prose, write code, or replace tests. It answers bounded judgment questions quickly and consistently.

## Setup

`uv tool install jev-cli` (client and MCP, https://github.com/tumf/jev-cli), then start the backend with `${AI_SKILLS_HOME}/tools/jev-proxy/jev-proxy start` (needs a free Google AI Studio key, see its README). The exact questions leaders send live versioned in `${AI_SKILLS_HOME}/tools/jev-proxy/commands/*.json`, invoked via `tools/jev-check.sh <f> --command <name>`; every call lands in the feature's `jev-ledger.jsonl` and identical repeats are served from it.

## Configuration

Connect via:

- `JEV_ENDPOINT`: the local Proxy address where Jev listens
- `JEV_PROVIDER`: the provider identifier configured in the Proxy
- Proxy key: load from the environment; do not print or commit it

## When to use Jev

Use Jev only when criteria are explicit and the question is bounded:

- yes/no routing checks (e.g. "does this failure block the next step?")
- selecting among explicit options (e.g. "parallel vs. sequential task ordering")
- scoring against explicit ordered levels (e.g. risk classification: low / medium / high)
- classifying many evidence items into defined classes

Pass raw evidence and the complete criteria. A Jev result is a routing signal, not a source of truth. A low-confidence or `review` result requires local reasoning or a human decision.

## What Jev cannot replace

- Deterministic test results
- Source-code evidence
- Human product decisions
- Prose generation or code synthesis

## Fallback

If `JEV_ENDPOINT` is unreachable or returns an error:

1. Log: "Jev unavailable — using local reasoning."
2. Apply the same classification criteria using local reasoning.
3. Treat the result as `confidence: low` and mark it explicitly.
4. For a decision that was `blocking`, escalate to the user rather than proceeding on a low-confidence local result.

Do not silently ignore the unavailability or invent a confident result.
