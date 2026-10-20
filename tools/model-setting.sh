# model-setting.sh — sourced by oc-agent.sh and autopilot.sh.
# model_export_env: export the non-secret Jev routing keys so the proxy daemon
# started by autopilot (and the leader it spawns) inherits them. Provider keys
# are deliberately NOT on this list: the repo rule is that secrets never live
# in these files, so JEV_API_KEY / CLOUDFLARE_API_TOKEN must come from the real
# environment, a 0600 key file, or `opencode auth login`.
model_export_env() {
  local k v
  for k in JEV_BACKEND JEV_MODEL JEV_CF_ACCOUNT_ID JEV_ENDPOINT JEV_PROVIDER JEV_TIMEOUT JEV_PROXY_PORT; do
    v=$(model_setting "$k"); [ -n "$v" ] && export "$k=$v"
  done
  return 0 # the last key is usually unset; that must not fail the caller under set -e
}
# model_setting NAME -> value from the environment, then ./.sdlc/autopilot.env, then <ai-skills>/autopilot.env.
model_setting() {
  local k=$1 v f root
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  v=$(printenv "$k" || true); [ -n "$v" ] && { echo "$v"; return; }
  for f in .sdlc/autopilot.env "${AUTOPILOT_GLOBAL_ENV:-$root/autopilot.env}"; do
    [ -f "$f" ] || continue
    v=$(sed -n "s/^[[:space:]]*$k[[:space:]]*=[[:space:]]*//p" "$f" | tail -1 | sed 's/[[:space:]]*#.*$//;s/^["'\'']//;s/["'\'']$//')
    [ -n "$v" ] && { echo "$v"; return; }
  done
  return 0
}
