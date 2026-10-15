#!/usr/bin/env python3
"""
Jev Gemini Local Proxy
Translates TypeSafe Jev System One API requests to Google Gemini Flash API.
Runs locally at http://127.0.0.1:8765/v1/systemone
"""

import os
import sys
import json
import http.server
import socketserver
import urllib.request
import urllib.error
from pathlib import Path

MODEL = os.environ.get("JEV_MODEL", "gemini-2.5-flash")   # any Gemini model your AI Studio key can use
PORT = int(os.environ.get("JEV_PROXY_PORT", "8765"))
CONFIG_DIR = Path.home() / ".config" / "jev-cli"
KEY_FILE = CONFIG_DIR / "gemini_key.txt"

def get_gemini_key() -> str:
    key = os.environ.get("GEMINI_API_KEY")
    if key and key.strip():
        return key.strip()
    if KEY_FILE.exists():
        content = KEY_FILE.read_text().strip()
        if content:
            return content
    return ""

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

def call_gemini(state: any, questions: dict, api_key: str) -> dict:
    prompt_payload = {
        "state": state,
        "questions": questions
    }
    
    gemini_body = {
        "contents": [
            {
                "parts": [
                    {"text": SYSTEM_INSTRUCTION},
                    {"text": f"Evaluate the following payload:\n```json\n{json.dumps(prompt_payload, ensure_ascii=False, indent=2)}\n```"}
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.1
        }
    }

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    req = urllib.request.Request(
        url,
        data=json.dumps(gemini_body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            result = json.loads(text)
            
            usage = data.get("usageMetadata", {})
            return {
                "model": MODEL,
                "answers": result.get("answers", {}),
                "usage": {
                    "input_tokens": usage.get("promptTokenCount", 0),
                    "output_tokens": usage.get("candidatesTokenCount", 0)
                }
            }
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8", errors="ignore")
        import traceback
        traceback.print_exc()
        return {"error": True, "status": e.code, "message": f"Gemini API Error: {err_msg}"}
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"error": True, "message": str(e)}


class JevProxyHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Concise logging to stderr
        sys.stderr.write(f"[JevProxy] {args[0]} - {args[1]} {args[2]}\n")

    def do_GET(self):
        if self.path in ("/health", "/api/v1/health"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "provider": "gemini-flash"}).encode())
        elif self.path in ("/api/v1/credits", "/v1/credits"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "creditsRemaining": 999999,
                "paidInputTokensRemaining": 999999999,
                "freeRunsRemaining": 999999
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        key = get_gemini_key()
        if not key:
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            err = {
                "ok": False,
                "error": f"GEMINI_API_KEY is not set. Please save your free Google AI Studio key to {KEY_FILE} or set export GEMINI_API_KEY='...'"
            }
            self.wfile.write(json.dumps(err).encode())
            return

        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len).decode("utf-8")
        
        try:
            req_data = json.loads(body)
        except Exception as e:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": f"Invalid JSON: {e}"}).encode())
            return

        state = req_data.get("state")
        questions = req_data.get("questions", {})

        response = call_gemini(state, questions, key)

        if response.get("error"):
            status_code = response.get("status", 500)
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": response.get("message")}).encode())
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))


def run():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    server_address = ("127.0.0.1", PORT)
    with socketserver.TCPServer(server_address, JevProxyHandler) as httpd:
        httpd.allow_reuse_address = True
        print(f"[*] Jev Gemini Proxy running at http://127.0.0.1:{PORT}/v1/systemone", file=sys.stderr)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down proxy...", file=sys.stderr)

if __name__ == "__main__":
    run()
