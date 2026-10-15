# jev-proxy

Local stand-in for a Jev "System One" endpoint, backed by Google Gemini.
Listens on `127.0.0.1:8765/v1/systemone` only.

0. Install the client and MCP server (needs Python 3.13+): `uv tool install jev-cli`
   (MIT, https://github.com/tumf/jev-cli, no clone needed). This proxy is the backend they talk to.
1. Get a free key at https://aistudio.google.com/apikey
2. Give it to the proxy, either way (the environment wins):
   - `export GEMINI_API_KEY=...`
   - `tools/jev-proxy/jev-proxy set-key <key>` (saved to `~/.config/jev-cli/gemini_key.txt`, mode 600)
3. `tools/jev-proxy/jev-proxy start` (also: `stop`, `restart`, `status`, `logs`)

Optional: `JEV_MODEL` (default `gemini-2.5-flash`), `JEV_PROXY_PORT` (default `8765`).
Point the skills at it with `JEV_ENDPOINT=http://127.0.0.1:8765/v1/systemone`.
The key is never written into the repo; the proxy sends it in a header, not in the URL.
