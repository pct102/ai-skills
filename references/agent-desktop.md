# agent-desktop Reference

Source: `https://github.com/vercel-labs/agent-desktop` (Apache-2.0)

## Use

CLI (Rust) that drives native desktop apps through the OS accessibility tree: macOS (13+), Windows, Linux. `snapshot` returns JSON with a ref per element; `click @ref`, `type`, then `snapshot` again to verify. No screenshots needed. Also serves MCP (`agent-desktop mcp`) and ships its own skill (`agent-desktop skills get desktop`).

Use it for apps with no web surface: Finder, native or Electron apps, system dialogs. For anything in a browser use Playwright (`references/playwright-mcp.md`).

## Install

```bash
npm install -g agent-desktop
agent-desktop status
agent-desktop permissions --guide     # macOS: grant Accessibility to the terminal app
```

Run `references/skillspector.md` first. The agent loads its own guides with `agent-desktop skills get desktop` and `skills get platform` before first use.

## Safety (this one is strict)

It can see and act on everything on the machine: windows, clipboard, notifications. Snapshots may contain private content.

- Manual sessions only. **Never** give it to `feature-autopilot`, `claude -p --dangerously-skip-permissions`, or any unattended run.
- Name the target app on every command (`--app <name>`); never snapshot "everything".
- Keep snapshots and screenshots out of issues, PRs, and public logs.
- Use `--stdin` for secrets and never batch secret steps. Retry only when `error.disposition.retry` is `safe`.
- It is not an acceptance gate. `tools/` verdicts come from deterministic checks, not from a desktop-driving agent.

## Cases

- **QA a native or Electron app by hand:** snapshot the app, act, snapshot again, report with redacted evidence.
- **Reproduce a bug that only shows in a system dialog** (file picker, permission prompt).
- **Web app:** do not use; use Playwright.
