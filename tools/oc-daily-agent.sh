#!/usr/bin/env bash
# oc-daily-agent.sh "<prompt>" — AGENT_CMD for sdlc-daily: runs the prompt through oc-agent.sh as the builder role, so
# BUILDER_MODEL (comma list, falls back when a model hits its limit) applies. Run it in the directory the agent should work in.
#   AGENT_CMD="bash $AI_SKILLS_HOME/tools/oc-daily-agent.sh"
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); work=$PWD
root=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)   # project root, also from a worktree
st=$root/.sdlc/daily/oc; mkdir -p "$st"
p=$(mktemp); trap 'rm -f "$p"' EXIT; printf %s "$1" > "$p"
# a lane per call = a fresh session (one issue's context must not leak into the next); the exhausted-model list is shared
cd "$root"
OC_STATE=$st OC_DIR=$work bash "$here/oc-agent.sh" --lane "${OC_LANE:-c$(date +%s)x$$}" builder daily "$p"
