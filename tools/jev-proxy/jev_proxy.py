#!/usr/bin/env python3
"""
Jev local proxy — the "System One" endpoint that the jev CLI and jev-mcp talk to.
Listens on 127.0.0.1:8765/v1/systemone.

Two transports, picked by JEV_BACKEND (env, else ~/.config/jev-cli/config.json, else "gemini"):
  openai  any OpenAI-compatible /chat/completions server
          (llama-server, Ollama, OpenRouter, OpenCode Zen, Gemini's /v1beta/openai, ...)
  gemini  Google's v1beta generateContent API

Both are driven from the same config so the rest of the system never changes:
  tools/jev-proxy/jev-proxy {start|stop|restart|status|logs}
  JEV_ENDPOINT=http://127.0.0.1:8765/v1/systemone
"""

import http.server
import json
import os
import socketserver
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "jev-cli"
CONFIG_FILE = CONFIG_DIR / "config.json"
KEY_FILE = CONFIG_DIR / "gemini_key.txt"

DEFAULTS = {
    "backend": "gemini",
    "base_url": "http://127.0.0.1:8080/v1",
    "model": "gemini-2.5-flash",
    "api_key": "",
    "timeout": 60,
}

SYSTEM_INSTRUCTION = """You are a high-speed, calibrated decision engine (System One).
You evaluate unstructured text or JSON state against specific typed questions.
Do NOT generate explanatory text or commentary. Output ONLY valid JSON adhering strictly to the schema requested.

Question types:
1. "noul": A yes/no probability question. Output {"type": "noul", "noul": <float between 0.0 and 1.0>}, where noul is the probability that the answer is YES.
2. "choice": Select exactly one key from the provided criteria options. Output {"type": "choice", "choice": "<selected_key>", "confidence": <float between 0.0 and 1.0>, "probabilities": {<key>: <float>}}. Sum of probabilities must equal 1.0.
3. "score": Evaluate against ordered criteria levels (from lowest to highest). Output {"type": "score", "score": <float representing position from 0 to N-1>, "confidence": <float>, "legend": {<index_str>: "<level_str>"}, "probabilities": {<index_str>: <float>}}.

Your response must be a JSON object with this top-level format:
{
  "answers": {
    "<question_key>": { ... answer object as described above ... }
  }
}
"""


def log(msg):
    sys.stderr.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] [JevProxy] {msg}\n")
    sys.stderr.flush()


# --------------------------------------------------------------------------- config

def _gemini_key():
    key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if key:
        return key
    try:
        return KEY_FILE.read_text().strip() if KEY_FILE.exists() else ""
    except OSError:
        return ""


def load_config():
    """env > config.json > defaults. Restarts (autopilot does one) keep the local backend."""
    cfg = dict(DEFAULTS)
    if CONFIG_FILE.exists():
        try:
            stored = json.loads(CONFIG_FILE.read_text())
            cfg.update({k: v for k, v in stored.items() if k in DEFAULTS})
        except (OSError, ValueError) as e:
            log(f"ignoring {CONFIG_FILE}: {e}")
    for env, field in (("JEV_BACKEND", "backend"), ("JEV_BASE_URL", "base_url"),
                       ("JEV_MODEL", "model"), ("JEV_API_KEY", "api_key"), ("JEV_TIMEOUT", "timeout")):
        val = os.environ.get(env)
        if val:
            cfg[field] = int(val) if field == "timeout" and val.isdigit() else val
    if not cfg.get("api_key"):
        cfg["api_key"] = _gemini_key()
    return cfg


# ------------------------------------------------------------------------ transport

def _post_json(url, body, headers, timeout):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def answer_schema(questions):
    """A JSON schema built from the actual questions, so constrained decoding cannot
    answer a "choice" with {"noul": ...}. This is what makes a 0.5B model usable here."""
    props, required = {}, []
    for key, question in (questions or {}).items():
        qtype = (question or {}).get("type") or "choice"
        if qtype == "noul":
            prop = {"type": "object", "required": ["type", "noul"], "properties": {
                "type": {"const": "noul"}, "noul": {"type": "number", "minimum": 0, "maximum": 1}}}
        elif qtype == "score":
            levels = (question or {}).get("criteria")
            score = {"type": "number"}
            if isinstance(levels, list) and levels:
                score = {"type": "number", "minimum": 0, "maximum": len(levels) - 1}
            prop = {"type": "object", "required": ["type", "score"], "properties": {
                "type": {"const": "score"}, "score": score, "confidence": {"type": "number"}}}
        else:
            criteria = (question or {}).get("criteria") or (question or {}).get("options") or {}
            options = list(criteria) if isinstance(criteria, (dict, list)) else []
            choice = {"enum": options} if options else {"type": "string"}
            prop = {"type": "object", "required": ["type", "choice"], "properties": {
                "type": {"const": "choice"}, "choice": choice, "confidence": {"type": "number"}}}
        props[key] = prop
        required.append(key)
    return {"type": "object", "required": ["answers"], "properties": {
        "answers": {"type": "object", "required": required, "properties": props}}}


def call_openai(state, questions, cfg):
    """Any OpenAI-compatible chat endpoint. This is what points Jev at a local model."""
    body = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_INSTRUCTION},
            {"role": "user", "content": "Evaluate the following payload:\n```json\n"
             + json.dumps({"state": state, "questions": questions}, ensure_ascii=False, indent=2) + "\n```"},
        ],
        "temperature": 0.1,
        "stream": False,
        "response_format": {"type": "json_object"},
    }
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    url = cfg["base_url"].rstrip("/") + "/chat/completions"

    # Constrained decoding where the server supports it; fall back to plain JSON mode.
    body["response_format"] = {"type": "json_schema",
                               "json_schema": {"name": "jev_answers", "schema": answer_schema(questions)}}
    try:
        data = _post_json(url, body, headers, cfg["timeout"])
    except urllib.error.HTTPError as e:
        if e.code not in (400, 422, 501):
            raise
        log(f"{cfg['model']} rejected json_schema ({e.code}); retrying in json_object mode")
        body["response_format"] = {"type": "json_object"}
        data = _post_json(url, body, headers, cfg["timeout"])

    text = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    usage = data.get("usage") or {}
    return {
        "model": data.get("model") or cfg["model"],
        "answers": parse_answers(text),
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


def call_gemini(state, questions, cfg):
    body = {
        "contents": [{"parts": [
            {"text": SYSTEM_INSTRUCTION},
            {"text": "Evaluate the following payload:\n```json\n"
             + json.dumps({"state": state, "questions": questions}, ensure_ascii=False, indent=2) + "\n```"},
        ]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.1},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{cfg['model']}:generateContent"
    data = _post_json(url, body, {"Content-Type": "application/json", "x-goog-api-key": cfg["api_key"]}, cfg["timeout"])
    text = (data.get("candidates") or [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
    usage = data.get("usageMetadata") or {}
    return {
        "model": cfg["model"],
        "answers": parse_answers(text),
        "usage": {
            "input_tokens": usage.get("promptTokenCount", 0),
            "output_tokens": usage.get("candidatesTokenCount", 0),
        },
    }


BACKENDS = {"openai": call_openai, "gemini": call_gemini}


def parse_answers(text):
    """Models wrapped in a fence, or return the answers object directly. Accept both."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("```")[1] if "```" in text[3:] else text.strip("`")
        text = text.removeprefix("json").strip()
    try:
        doc = json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            return {}
        try:
            doc = json.loads(text[start:end + 1])
        except ValueError:
            return {}
    return doc.get("answers", doc) if isinstance(doc, dict) else {}


# ----------------------------------------------------------------------- answer shape

def _num(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize(questions, raw):
    """Coerce what the model actually produced into the typed objects the jev client expects.

    Small local models often answer {"key": "parallel"} or omit "type"; the client needs
    {"key": {"type": "choice", "choice": "parallel", "confidence": 0.5}}. Keep every extra
    field the model did send, then enforce the required ones.
    """
    out = {}
    for key, question in (questions or {}).items():
        qtype = (question or {}).get("type") or "choice"
        value = raw.get(key)
        bare_field = "noul" if qtype == "noul" else "score" if qtype == "score" else "choice"
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            value = {bare_field: value}
        elif isinstance(value, str):
            value = {bare_field: value}
        if not isinstance(value, dict):
            continue

        answer = dict(value)
        answer.setdefault("type", qtype)
        if qtype == "noul":
            prob = _num(answer.get("noul"))
            if prob is None:
                continue
            answer["noul"] = min(1.0, max(0.0, prob))
        elif qtype == "score":
            score = _num(answer.get("score"))
            if score is None:  # small models often answer with the level name
                levels = (question or {}).get("criteria") or []
                said = answer.get("score", answer.get("choice"))
                if isinstance(levels, list):
                    match = [i for i, lvl in enumerate(levels) if str(lvl).lower() == str(said).lower()]
                    score = float(match[0]) if match else None
            if score is None:
                continue
            answer["score"] = score
            answer["confidence"] = _num(answer.get("confidence"), 0.5)
        else:
            criteria = (question or {}).get("criteria") or (question or {}).get("options") or {}
            options = list(criteria) if isinstance(criteria, (dict, list)) else []
            choice = answer.get("choice")
            if not choice and isinstance(answer.get("probabilities"), dict):
                # a model that answered with a distribution still said something usable
                choice = max(answer["probabilities"], key=lambda k: _num(answer["probabilities"][k], 0))
            if options and choice not in options:
                # accept a case-only difference; never invent an option, the client would
                # read a made-up key as a real verdict and act on it
                choice = next((o for o in options if str(o).lower() == str(choice).lower()), None)
            if not choice:
                continue
            answer["choice"] = choice
            answer["confidence"] = _num(answer.get("confidence"), 0.5)
        out[key] = answer
    return out


# --------------------------------------------------------------------------- handler

class JevProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        pass  # we log a single explicit line per request instead

    def _reply(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        cfg = load_config()
        if self.path in ("/health", "/api/v1/health"):
            self._reply(200, {"status": "ok", "backend": cfg["backend"], "model": cfg["model"],
                              "base_url": cfg["base_url"] if cfg["backend"] == "openai" else "google"})
        elif self.path in ("/api/v1/credits", "/v1/credits"):
            self._reply(200, {"creditsRemaining": 999999, "paidInputTokensRemaining": 999999999,
                              "freeRunsRemaining": 999999})
        else:
            self._reply(404, {"ok": False, "error": f"no route {self.path}"})

    def do_POST(self):
        started = time.monotonic()
        cfg = load_config()
        backend = BACKENDS.get(cfg["backend"])
        if backend is None:
            self._reply(500, {"ok": False, "error": f"unknown JEV_BACKEND {cfg['backend']!r}"})
            return
        if cfg["backend"] == "gemini" and not cfg["api_key"]:
            self._reply(401, {"ok": False, "error":
                              f"GEMINI_API_KEY is not set. Save a free key to {KEY_FILE} "
                              f"or set JEV_BACKEND=openai with a local JEV_BASE_URL."})
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        try:
            request = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except ValueError as e:
            self._reply(400, {"ok": False, "error": f"invalid JSON: {e}"})
            return

        state = request.get("state")
        questions = request.get("questions") or {}

        try:
            result = backend(state, questions, cfg)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="ignore")
            log(f"POST {self.path} - {e.code} upstream {cfg['model']}: {detail[:400]}")
            self._reply(e.code if 400 <= e.code < 600 else 502,
                        {"ok": False, "error": f"upstream {e.code}: {detail[:400]}"})
            return
        except Exception as e:  # connection refused when llama-server is down, timeouts, ...
            log(f"POST {self.path} - 503 {cfg['base_url']}: {type(e).__name__}: {e}")
            self._reply(503, {"ok": False, "error": f"backend unreachable ({cfg['backend']}): {e}"})
            return

        answers = normalize(questions, result.get("answers") or {})
        elapsed = (time.monotonic() - started) * 1000
        keys = ",".join(answers) or "-"
        if not answers:
            log(f"POST {self.path} - 502 {int(elapsed)}ms: no usable answer for {list(questions) or '[]'}")
            self._reply(502, {"ok": False, "error": "model returned no usable answer object"})
            return

        log(f"POST {self.path} - 200 {int(elapsed)}ms {cfg['backend']}/{cfg['model']} answers={keys}")
        self._reply(200, result | {"answers": answers})


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run():
    cfg = load_config()
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("JEV_PROXY_PORT", "8765"))
    if cfg["backend"] == "openai":
        where = f"{cfg['base_url']} ({cfg['model']})"
    else:
        where = f"Google Gemini ({cfg['model']}, key {'set' if cfg['api_key'] else 'MISSING'})"
    log(f"listening on http://127.0.0.1:{port}/v1/systemone -> {where}")
    try:
        ThreadedServer(("127.0.0.1", port), JevProxyHandler).serve_forever()
    except KeyboardInterrupt:
        log("shutting down")


if __name__ == "__main__":
    run()
