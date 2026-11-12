"""Exercise the real Codespaces launcher inside the isolated pinned image."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import time
import urllib.request

STATE = Path("/workspaces/.t3-code")
SCRIPTS = Path("/source/scripts")
environment = dict(os.environ, CODESPACES="true")


def matching_processes(argument):
    result = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            arguments = (entry / "cmdline").read_bytes().split(b"\0")
            if argument.encode() in arguments:
                result.append(int(entry.name))
        except OSError:
            pass
    return result


def ready():
    try:
        with urllib.request.urlopen("http://127.0.0.1:3773/.well-known/t3/environment", timeout=2) as response:
            return json.load(response).get("orchestrationProtocolVersion") == 2
    except (OSError, ValueError):
        return False


def await_condition(predicate, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.25)
    raise AssertionError("Codespaces runtime did not reach its expected state")


def launch():
    subprocess.run(["bash", str(SCRIPTS / "codespaces-start.sh")], env=environment, check=True, timeout=15)


launch()
await_condition(ready)
wrapper = str(SCRIPTS / "codespaces-supervise.sh")
native = "/app/server/supervise.mjs"
await_condition(lambda: len(matching_processes(wrapper)) == 1 and len(matching_processes(native)) == 1)
first = matching_processes(native)[0]
marker = Path("/data/codespaces-persistence-proof")
marker.write_text("preserve-existing-data")
launch()
time.sleep(1)
assert matching_processes(native) == [first], "Duplicate startup replaced or duplicated the runtime"
assert len(matching_processes(wrapper)) == 1

# Abrupt loss skips the native supervisor's shutdown; the outer launcher must
# release its descendants, restart the services, and retain existing data.
os.kill(first, signal.SIGKILL)
await_condition(lambda: ready() and len(matching_processes(native)) == 1 and matching_processes(native)[0] != first)
assert marker.read_text() == "preserve-existing-data"
assert len(matching_processes(wrapper)) == 1

os.kill(matching_processes(wrapper)[0], signal.SIGTERM)
await_condition(lambda: not matching_processes(native) and not matching_processes(wrapper), seconds=15)
assert not ready()
launch()
await_condition(ready)
assert marker.read_text() == "preserve-existing-data"
assert len(matching_processes(wrapper)) == len(matching_processes(native)) == 1

# The actual logger must enforce the bound even if the server never restarts.
log_check = subprocess.Popen(["node", str(SCRIPTS / "codespaces-log.mjs")], stdin=subprocess.PIPE)
for _ in range(7):
    log_check.stdin.write(b"diagnostic-fixture\n" * 30000)
log_check.stdin.close()
assert log_check.wait(timeout=10) == 0
assert (STATE / "launcher.log").stat().st_size <= 2097152
assert (STATE / "launcher.log.1").stat().st_size <= 2097152

# Only the GitHub control-plane call is replaced: readiness and the pairing
# grant use the actual running T3 runtime. Never print the one-time credential.
fake_bin = STATE / "fixture-bin"
fake_bin.mkdir()
fake_gh = fake_bin / "gh"
fake_gh.write_text('#!/bin/sh\n[ "$*" = "codespace ports visibility 3773:public --codespace fixture" ]\n')
fake_gh.chmod(0o700)
phone_environment = dict(environment, CODESPACE_NAME="fixture", PATH=str(fake_bin)+os.pathsep+environment["PATH"])
connection = subprocess.run(["bash", str(SCRIPTS / "codespaces-ready.sh")], env=phone_environment,
    check=True, capture_output=True, text=True, timeout=200)
card = STATE / "phone-connection.txt"
assert "HOST: https://fixture-3773.app.github.dev" in card.read_text()
assert "PAIRING CODE: " in card.read_text() and "Expires: " in card.read_text()
assert stat.S_IMODE(card.stat().st_mode) == 0o600
assert card.read_text() == connection.stdout
assert not list(STATE.glob("phone-connection.??????")), "Partial credential cards were left behind"
print("Codespaces launcher: singleton, recovery, persistence, log bounds and private protocol-2 phone card passed", flush=True)
