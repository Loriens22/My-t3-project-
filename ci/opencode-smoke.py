"""Isolated upgrade checks using local model fixtures and dummy credentials."""
import http.server
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import tempfile
import threading

BINARY = "/opt/t3/node_modules/.bin/opencode"
VERSION = "2.2.5"


def run(arguments, environment, directory, timeout=90):
    process = subprocess.Popen([BINARY, *arguments], cwd=directory, env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        output, errors = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise AssertionError("Native command exceeded deadline")
    if process.returncode:
        raise AssertionError("Native fixture failed: " + errors[-1200:] + output[-1200:])
    return output


def isolated_environment(root):
    selected = {name: value for name, value in os.environ.items()
        if name in ("PATH", "HOME", "LANG", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
                    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
                    "http_proxy", "https_proxy", "no_proxy")}
    selected.update({"XDG_DATA_HOME": str(root / "data"),
        "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
        "OPENCODE_CONFIG": str(root / "opencode.json")})
    return selected


def native_tool_loop(base, provider, model, key_variable):
    root = base / (provider + "-" + re.sub(r"[^A-Za-z0-9_-]", "_", model))
    root.mkdir()
    work = root / "project"
    work.mkdir()
    marker = "NATIVE_UPGRADE_TOOL_VERIFIED"
    fake_key = "ci-dummy-" + provider
    reasoning = "I will verify the fixture using the shell tool."
    requires_reasoning = provider in ("moonshotai", "kimi-code-plan-global", "modelscope")
    reasoning_field = "reasoning_content" if requires_reasoning else "reasoning"
    code = ("import json,pathlib; p=pathlib.Path('upgrade-proof.json'); "
        "p.write_text(json.dumps({'verified':True,'answer':42})); "
        "assert json.loads(p.read_text())=={'verified':True,'answer':42}; "
        f"print('{marker}')")
    command = "python3 -c " + shlex.quote(code)
    observed = {"requests": 0, "nativeIdentity": True, "correctKey": True,
        "reasoningPreserved": False, "toolResultPreserved": False,
        "thinkingEnabled": True, "toolSchemaSupported": True, "groqOptionsValid": True,
        "modelIdentity": True}
    owner_rule = "CI_OWNER_INSTRUCTIONS_PRESERVE_EXACTLY: Never change the owner's draft."
    (work / "AGENTS.md").write_text(owner_rule + "\n")
    if provider == "groq":
        observed.update(compactStockPrompt=True, ownerInstructionsPreserved=True,
            compactShellDocumentation=True, compactReadEditDocumentation=True)

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *arguments):
            pass

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            observed["requests"] += 1
            observed["correctKey"] &= self.headers.get("Authorization") == "Bearer " + fake_key
            user_agent = self.headers.get("User-Agent", "")
            observed["nativeIdentity"] &= "opencode" in user_agent.lower() and VERSION in user_agent
            if provider in ("moonshotai", "kimi-code-plan-global"):
                observed["thinkingEnabled"] &= payload.get("thinking", {}).get("type") == "enabled"
            if provider == "groq":
                groq_format_valid = ("reasoning_format" not in payload if model.startswith("openai/gpt-oss-")
                    else payload.get("reasoning_format") == "parsed")
                observed["groqOptionsValid"] &= groq_format_valid and "thinking" not in payload
            observed["modelIdentity"] &= payload.get("model") == model
            messages = payload.get("messages", [])
            if provider == "groq":
                system = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
                observed["compactStockPrompt"] &= "You are OpenCode's coding agent: finish the user's task." in system
                observed["ownerInstructionsPreserved"] &= owner_rule in system
                shell = next((t.get("function", {}) for t in payload.get("tools", [])
                    if t.get("function", {}).get("name") == "shell"), {})
                observed["compactShellDocumentation"] &= shell.get("description", "").startswith("Run a shell command")
                definitions = {t.get("function", {}).get("name"):t.get("function", {})
                    for t in payload.get("tools", [])}
                observed["compactReadEditDocumentation"] &= (
                    definitions.get("read", {}).get("description", "").startswith("Read a file or directory:") and
                    definitions.get("edit", {}).get("description", "").startswith("Replace exact file text;"))
            if any(m.get("role") == "tool" for m in messages):
                observed["reasoningPreserved"] = any(m.get("role") == "assistant" and
                    reasoning in str(m.get(reasoning_field, "")) for m in messages)
                observed["toolResultPreserved"] = any(m.get("role") == "tool" and
                    marker in str(m.get("content", "")) for m in messages)
                delta = {"role": "assistant", "content": marker}
                finish = "stop"
            else:
                tools = [t.get("function", {}) for t in payload.get("tools", [])]
                tool = next((t for t in tools if t.get("name") in ("shell", "bash")), None)
                if not tool or "command" not in tool.get("parameters", {}).get("properties", {}):
                    observed["toolSchemaSupported"] = False
                    self.send_error(400, "Expected native shell command tool")
                    return
                arguments = {"command": command, "description": "Verify isolated upgrade fixture"}
                properties = tool["parameters"].get("properties", {})
                if "workdir" in properties:
                    arguments["workdir"] = str(work)
                if "timeout" in properties:
                    arguments["timeout"] = 30000
                delta = {"role": "assistant", reasoning_field: reasoning,
                    "tool_calls": [{"index": 0, "id": "call_upgrade_fixture", "type": "function",
                        "function": {"name": tool["name"], "arguments": json.dumps(arguments)}}]}
                finish = "tool_calls"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            for content, reason in ((delta, None), ({}, finish)):
                event = {"id": "chatcmpl-upgrade-fixture", "object": "chat.completion.chunk",
                    "created": 1, "model": model,
                    "choices": [{"index": 0, "delta": content, "finish_reason": reason}]}
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    entry = {"disabled": False, "settings": {
        "baseURL": f"http://127.0.0.1:{server.server_port}/v1"}}
    if provider in ("moonshotai", "kimi-code-plan-global"):
        entry["settings"]["thinking"] = {"type": "enabled"}
    if provider == "kimi-code-plan-global":
        entry["package"] = "@opencode/ai/providers/moonshot/chat"
    config = {"enabled_providers": [provider], "model": provider + "/" + model,
        "small_model": provider + "/" + model, "permission": "allow",
        "providers": {provider: {"models": {model: entry}}}}
    if provider == "groq":
        config["plugins"] = ["/app/server/plugins/groq-context"]
    if provider == "modelscope":
        seed = subprocess.check_output(["node", "--input-type=module", "-e",
            "import {configureModelScope} from '/app/server/modelscope.mjs'; const c={}; "
            "configureModelScope(c,[],{MODELSCOPE_API_KEY:'ci-dummy-modelscope'},"
            "{reason:'ready',modelIds:['deepseek-ai/DeepSeek-V4.1-Flash-1017']},{seedDiscovery:true});"
            "process.stdout.write(JSON.stringify(c));"], text=True)
        config = json.loads(seed)
        config.update(model=provider + "/" + model, small_model=provider + "/" + model, permission="allow")
        config["providers"][provider]["settings"]["baseURL"] = entry["settings"]["baseURL"]
        config["providers"][provider]["models"][model]["settings"]["baseURL"] = entry["settings"]["baseURL"]
    (root / "opencode.json").write_text(json.dumps(config))
    environment = isolated_environment(root)
    environment[key_variable] = fake_key
    try:
        output = run(["run", "--standalone", "--auto", "--model", provider + "/" + model,
            "--title", "Isolated upgrade check", "--thinking", "--format", "json",
            "Use one shell command to write and verify upgrade-proof.json, then reply exactly " +
            marker + ". Do not install dependencies or delegate."], environment, work, timeout=150)
        assert json.loads((work / "upgrade-proof.json").read_text()) == {"verified": True, "answer": 42}
        events = []
        for line in output.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                pass
        assert any(e.get("type") == "text" and
            e.get("part", {}).get("text", "").strip() == marker for e in events)
        assert any(e.get("part", {}).get("type") == "tool" and
            e["part"].get("state", {}).get("status") == "completed" for e in events)
        assert observed["requests"] >= 2
        assert all(value for name, value in observed.items() if name not in ("requests", "reasoningPreserved")), observed
        if requires_reasoning:
            assert observed["reasoningPreserved"], observed
        else:
            assert any(e.get("type") == "reasoning" and reasoning in str(e.get("part", {}).get("text", "")) for e in events), "Native reasoning stream was not decoded"
        print(json.dumps({"provider": provider, "nativeToolLoop": "passed", **observed}), flush=True)
    finally:
        server.shutdown()
        server.server_close()


with tempfile.TemporaryDirectory(prefix="opencode-upgrade-") as temporary:
    base = Path(temporary)
    environment = isolated_environment(base)
    (base / "opencode.json").write_text(json.dumps({"enabled_providers": ["opencode"]}))
    version = run(["--version"], environment, base)
    assert re.search(r"(?<!\d)2\.2\.5(?!\d)", version), "Wrong installed version"
    models = json.loads(run(["api", "--standalone", "model.list"], environment, base))["data"]
    assert any(m["providerID"] == "opencode" and
        m["id"] == "deepseek-v4.1-flash-free" for m in models)
    print(json.dumps({"version": VERSION, "standaloneModelList": "passed",
        "modelCount": len(models)}), flush=True)
    native_tool_loop(base, "moonshotai", "kimi-k3.1-pro", "MOONSHOT_API_KEY")
    native_tool_loop(base, "kimi-code-plan-global", "k3.1-pro", "KIMI_API_KEY")

    native_tool_loop(base, "groq", "qwen/qwen3.8-27b", "GROQ_API_KEY")
    native_tool_loop(base, "groq", "openai/gpt-oss-20b", "GROQ_API_KEY")
    native_tool_loop(base, "openrouter", "nvidia/nemotron-3.5-lightning:free", "OPENROUTER_API_KEY")

    native_tool_loop(base, "modelscope", "deepseek-ai/DeepSeek-V4.1-Flash-1017", "MODELSCOPE_API_KEY")
