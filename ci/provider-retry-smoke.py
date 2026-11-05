"""Verify native OpenCode honors the queue's truthful nonretryable timeout."""
import http.server
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time

MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b"
observed = {"requests": 0, "correctKey": True}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        observed["requests"] += 1
        observed["correctKey"] &= self.headers.get("Authorization") == "Bearer ci-dummy-nvidia"
        body = json.dumps({"error": {"code": "NVIDIA_RESPONSE_TIMEOUT",
            "message": "NVIDIA model did not start responding within 60 seconds. Try another NVIDIA model or retry later."}}).encode()
        self.send_response(504)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("x-should-retry", "false")
        self.end_headers()
        self.wfile.write(body)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix="native-retry-policy-") as temp:
        root = Path(temp)
        environment = {name: value for name, value in os.environ.items()
            if name in ("PATH", "HOME", "LANG", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
                "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy")}
        environment.update({"XDG_DATA_HOME": str(root / "data"),
            "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
            "OPENCODE_CONFIG": str(root / "opencode.json"), "NVIDIA_API_KEY": "ci-dummy-nvidia"})
        config = {"enabled_providers": ["nvidia"], "model": "nvidia/" + MODEL,
            "small_model": "nvidia/" + MODEL, "permission": "allow", "providers": {"nvidia": {
                "models": {MODEL: {"disabled": False, "settings": {
                    "baseURL": f"http://127.0.0.1:{server.server_port}/v1"}}}}}}
        (root / "opencode.json").write_text(json.dumps(config))
        command = ["/opt/t3/node_modules/.bin/opencode", "run", "--standalone", "--auto",
            "--model", "nvidia/" + MODEL, "--title", "Owned native retry policy check",
            "--format", "json", "Reply exactly RETRY_POLICY_OK. Do not call tools."]
        start = time.monotonic()
        process = subprocess.Popen(command, cwd=root, env=environment, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, start_new_session=True)
        try:
            output, errors = process.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            raise AssertionError("Native retry override did not bound the failed request")
        elapsed = time.monotonic() - start
        assert process.returncode != 0, "Fixture failure was incorrectly reported as success"
        assert observed["requests"] == 1, observed
        assert observed["correctKey"], "Native NVIDIA credential binding changed"
        assert "NVIDIA model did not start responding" in output + errors, "Actionable timeout error disappeared"
        assert elapsed < 25, "Native repeated the queue's terminal timeout"
        print(json.dumps({"nativeRetryPolicy": "passed", "requests": observed["requests"],
            "elapsedSeconds": round(elapsed, 3), "realCredentialsUsed": False}), flush=True)
finally:
    server.shutdown()
    server.server_close()
