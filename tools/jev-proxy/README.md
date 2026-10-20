# jev-proxy

Local stand-in for a Jev "System One" endpoint. Listens on `127.0.0.1:8765/v1/systemone` only.
The `jev` CLI, `jev-mcp` and `tools/jev-check.sh` all talk to it; it never leaves this machine.

Two backends, same API surface:

| `backend` | Transport | Needs |
|---|---|---|
| `openai` | any OpenAI-compatible `/chat/completions` | just `base_url` (+ key if remote) |
| `gemini` | Google `v1beta generateContent` | a free Google AI Studio key |
| `clef` | Cloudflare Workers AI decision models | a Cloudflare account id + API token (see below) |

## Cloudflare Clef backend (recommended: purpose-built, generous free tier)

Clef (`@cf/cloudflare/clef-flash`, 9B multimodal) speaks the same state + typed-questions
protocol as Jev (`noul` / `choice` / `score` with per-option probabilities), so the proxy
mostly forwards the jev CLI's payload and reads `answers` back — no prompt engineering,
no constrained-decoding tricks, no invented-option filtering needed downstream.

Pricing at the time of writing (Workers free plan, 10,000 Neurons/day free, resets 00:00 UTC):
clef-flash costs 3455 neurons per M input tokens and nothing for output, i.e. roughly
**one neuron per jev-check call** — on the order of ten thousand judgments a day before
hitting the cap, versus 20/day on the Gemini free tier. Per-minute limits are the
standard text-generation ones (300 req/min); Clef is not on the paid-models list.
When the cap is hit the API errors and the proxy degrades to `JEV UNAVAILABLE` like any
other backend failure, so autopilot keeps running.

Setup (secrets never live in the repo — same rule as the Gemini key). No env export
is required; pick one token home and one account-id home:

1. Token, either `jev-proxy set-cf-key <token>` (stored in
   `~/.config/jev-cli/cloudflare_key.txt`, mode 600 — recommended, survives
   restarts with nothing in your shell) or `export CLOUDFLARE_API_TOKEN=<token>`
   in your shell. Get the token from the Cloudflare dashboard (Workers AI read).
2. Account id (not a secret): `export JEV_CF_ACCOUNT_ID=<id>`, or `"cf_account_id"`
   in `~/.config/jev-cli/config.json`, or `JEV_CF_ACCOUNT_ID` in `autopilot.env`
   (it is git-ignored and autopilot exports non-secret `JEV_*` keys to the run).
3. Set `"backend": "clef"` in `~/.config/jev-cli/config.json` (or `JEV_BACKEND=clef`).
   `JEV_MODEL` accepts any `@cf/...` model id; anything else falls back to clef-flash.
4. `tools/jev-proxy/jev-proxy restart` — it prints the backend it is really using.

Precedence is env > `~/.config/jev-cli/config.json` > built-in default. Keys are picked
per backend and never cross over: a Gemini key is never sent to Cloudflare and vice versa.

Note: `opencode/jev-1.13` (OpenCode Zen) exposes an OpenAI-compatible endpoint, so this
proxy could point at it — but a direct call returns 401 without an OpenCode Zen login
(`opencode auth login`; an `openrouter`/`opencode-go` key is not enough). Until that login
exists, keep `backend: gemini` and let rate-limit errors degrade to `JEV UNAVAILABLE`.

## Versioned commands + ledger

The exact questions callers send live in `commands/*.json` (`slice-order`, `defect-triage`,
`prompt-triage`), invoked with `tools/jev-check.sh <f> --command <name> "<state>" [VAR=val ...]`
(`<a>`/`<b>` placeholders are filled from `VAR=val` pairs). Every call appends one JSON line to
`.sdlc/features/<f>/jev-ledger.jsonl` (timestamp, command, question hash, answer, latency,
endpoint, cached flag); an identical triple reuses the ledger instead of spending another call.
Keep that file out of git — it is run telemetry, like `trace.*`.

## Local model (experimental, not recommended for checkpoints)

Local models were measured against the two judgments autopilot asks and found unreliable
for them (see the table below) — small models hold the JSON shape but not the judgment.
If you still want a local backend (e.g. for the frequent, low-stakes `UserPromptSubmit`
hook), the wiring below works; keep the rare checkpoints on a stronger backend.

1. Get a `llama-server` binary. **Do not `brew install llama.cpp` on an Intel Mac unless the
   Command Line Tools match the macOS version** — without a bottle it compiles from source and
   an outdated CLT aborts the build with "Your Command Line Tools (CLT) does not support macOS N".
   Use the official prebuilt instead:

   ```bash
   curl -L -o /tmp/llama.tar.gz \
     https://github.com/ggml-org/llama.cpp/releases/download/b11748/llama-b11748-bin-macos-x64.tar.gz
   mkdir -p ~/.local/share/llama.cpp && tar xzf /tmp/llama.tar.gz -C ~/.local/share/llama.cpp
   # -> ~/.local/share/llama.cpp/llama-b11748/llama-server
   ```

2. Get a model. A classifier needs instruction-following, not size:
   `Qwen/Qwen2.5-1.5B-Instruct-GGUF` → `qwen2.5-1.5b-instruct-q4_k_m.gguf` (~1 GB).

   **Measured, and worth knowing before you trust it** (7 hand-labelled autopilot judgments —
   4 slice-order, 3 defect-triage — through the proxy, i9-9880H, AVX2, `--threads 8`):

   | model | score | latency | failure mode |
   |---|---|---|---|
   | Qwen2.5-0.5B Q4 | shape ok, judgment unusable | ~1.5 s | answers the wrong `type` without a schema |
   | Qwen2.5-1.5B Q4 | **3/7** | 2.5-5 s | flips with wording; 1/4 on slice order |
   | Qwen2.5-3B Q4 | **4/7** | 6.5-15 s | systematic: always `sequential`, often blames `env` |

   The failures are a bias, not noise, so a wrong answer can look confident. Small local models
   hold the JSON and the latency budget, but they are **not reliable for the two judgments
   autopilot asks** (can these slices run in parallel; product/test/env). Use the local model for
   the frequent, low-stakes `UserPromptSubmit` hook (5-way label), and keep the rare checkpoints
   on a stronger backend — a free Gemini project spends 0-5 requests per run, which the daily
   cap covers comfortably as long as no per-prompt hook is pointed at it.

   ```bash
   curl -L -o ~/.local/share/llama-models/qwen2.5-1.5b-instruct-q4_k_m.gguf \
     https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf
   ```

3. Start it, OpenAI-compatible on port 8080 (~1.9 GB resident, 3-5 s per decision on
   an i9-9880H; `--threads` = physical cores):

   ```bash
   nohup ~/.local/share/llama.cpp/llama-b11748/llama-server \
     -m ~/.local/share/llama-models/qwen2.5-1.5b-instruct-q4_k_m.gguf \
     --host 127.0.0.1 --port 8080 --ctx-size 4096 --threads 8 --jinja \
     > ~/.config/jev-cli/llama-server.log 2>&1 &
   ```

4. Point the proxy at it in `~/.config/jev-cli/config.json`:

   ```json
   { "backend": "openai", "base_url": "http://127.0.0.1:8080/v1",
     "model": "qwen2.5-1.5b", "timeout": 120 }
   ```

5. `tools/jev-proxy/jev-proxy restart` — it prints the backend it is really using.

The proxy sends a per-request JSON schema derived from the actual questions
(`response_format: json_schema`), so constrained decoding cannot answer a `choice`
with `{"noul": ...}`, and it normalises bare answers (`{"k": "parallel"}`) into the typed
objects (`{"k": {"type": "choice", "choice": "parallel", "confidence": 0.5}}`).
A model answer that names an option outside the offered set is dropped rather than
guessed — the client then reports `JEV UNAVAILABLE` and the caller decides.
If llama-server is not running the proxy returns 503 and every caller degrades the same way.


## Google Gemini backend

0. Install the client and MCP server (needs Python 3.13+): `uv tool install jev-cli`
   (MIT, https://github.com/tumf/jev-cli, no clone needed). This proxy is the backend they talk to.
1. Get a free key at https://aistudio.google.com/apikey (free tier is a **daily** cap, per project —
   every prompt you send through a `UserPromptSubmit` hook spends one request of it)
2. Give it to the proxy, either way (the environment wins):
   - `export GEMINI_API_KEY=...`
   - `tools/jev-proxy/jev-proxy set-key <key>` (saved to `~/.config/jev-cli/gemini_key.txt`, mode 600)
3. Set `"backend": "gemini"` in `~/.config/jev-cli/config.json` (or `JEV_BACKEND=gemini`)
4. `tools/jev-proxy/jev-proxy start` (also: `stop`, `restart`, `status`, `logs`)

Optional: `JEV_MODEL` (default `gemini-2.5-flash`), `JEV_PROXY_PORT` (default `8765`),
`JEV_TIMEOUT` (default `60`). Point the skills at it with
`JEV_ENDPOINT=http://127.0.0.1:8765/v1/systemone`.

Precedence is env > `~/.config/jev-cli/config.json` > built-in default, so
`jev-proxy restart` (which autopilot may do without env) stays on the backend you chose.
The API key is never written into the repo; the proxy sends it in a header, not in the URL.
