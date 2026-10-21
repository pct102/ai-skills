#!/usr/bin/env bash
# PreToolUse hook for the autopilot leader (installed per session by autopilot.sh, never globally).
# Blocks the git commands that destroy work or publish it. The leader never needs them: sdlc-ship commits
# and pushes from its own process, which a hook cannot see. Pattern idea from mattpocock/skills (git-guardrails-claude-code).
# Exit 2 = blocked (stderr goes back to the model); anything else lets the call through.
cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0
# `git` at the start of a command word, optionally with -C <dir> / -c k=v before the subcommand.
g='(^|[;&|(`]|\$\()[[:space:]]*git([[:space:]]+(-C|-c)[[:space:]]+[^[:space:]]+)*[[:space:]]+'
if printf '%s' "$cmd" | grep -qE "${g}(push|reset[[:space:]]+.*--hard|clean[[:space:]]+-[a-zA-Z]*f|branch[[:space:]]+-D|(checkout|restore)[[:space:]]+\.([[:space:]]|\$))"; then
  echo "BLOCKED by the autopilot git guard: '$cmd'. The leader never pushes, hard-resets, cleans or force-deletes; sdlc-ship does the commit and push." >&2
  exit 2
fi
exit 0
