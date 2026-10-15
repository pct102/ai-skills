# model-setting.sh — sourced by oc-agent.sh and autopilot.sh.
# model_setting NAME -> value from the environment, then ./.sdlc/models.env, then <ai-skills>/models.env.
model_setting() {
  local k=$1 v f root
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  v=$(printenv "$k" || true); [ -n "$v" ] && { echo "$v"; return; }
  for f in .sdlc/models.env "$root/models.env"; do
    [ -f "$f" ] || continue
    v=$(sed -n "s/^[[:space:]]*$k[[:space:]]*=[[:space:]]*//p" "$f" | tail -1 | sed 's/[[:space:]]*#.*$//;s/^["'\'']//;s/["'\'']$//')
    [ -n "$v" ] && { echo "$v"; return; }
  done
  return 0
}
