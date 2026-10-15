# Playwright Browser Reference

Source: `https://github.com/microsoft/playwright-mcp`

## Use

Use Playwright for browser exploration, accessibility snapshots, user journeys, console and network inspection, visual QA, and E2E verification. For coding agents, prefer Playwright CLI plus skills when token efficiency matters; use MCP when persistent browser state and iterative exploration are needed.

## Workflow

1. Start the target app in an approved environment.
2. Use an isolated browser context unless a persistent login is explicitly required.
3. Inspect the accessibility tree and current page state before acting.
4. Exercise the smallest relevant user journey.
5. Check console errors, failed requests, keyboard behavior, and responsive viewports.
6. Save a reproducible E2E test when the defect or behavior is durable.
7. Use screenshots or pixel diffs for visual changes.

## Security

The MCP server is not a security boundary. Restrict hosts and origins, keep file access inside the workspace, avoid remote public binding, and never expose cookies or storage state. Use a container and a separate browser profile for untrusted pages. Do not use `--no-sandbox` outside a controlled container.

## Routing

Use Jev to route browser work: UI, E2E, visual, accessibility, or live web behavior → Playwright; backend-only or static documentation work → no browser required.
