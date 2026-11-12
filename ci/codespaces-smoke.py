"""Exercise the real Codespaces launcher inside the isolated pinned image."""
import json
import os
from pathlib import Path
import signal
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
print("Codespaces launcher: single instance, crash recovery, stop/start persistence and bounded logs passed", flush=True)
