#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${CODESPACES:-}" == true ]] || exit 1
state=/workspaces/.t3-code
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec 9>"$state/runtime.lock"
# A kernel lock avoids stale PID files and duplicate servers on repeated starts.
flock -n 9 || exit 0
runtime_pid=
stopping=false
stop_runtime() {
  stopping=true
  if [[ -n "$runtime_pid" ]]; then
    kill -TERM -- "-$runtime_pid" 2>/dev/null || true
  fi
}
trap stop_runtime TERM INT
delay=2
while [[ "$stopping" == false ]]; do
  began=$SECONDS
  # Rotate during normal operation too: monitor output continues after startup.
  # The logger must not inherit the singleton lock.
  setsid bash /app/server/start.sh > >(node --max-old-space-size=32 "$scripts/codespaces-log.mjs" 9>&-) 2>&1 9>&- &
  runtime_pid=$!
  status=0
  wait "$runtime_pid" || status=$?
  if [[ "$stopping" == true ]]; then
    # Let the native supervisor finish its normal five-second shutdown.
    for attempt in {1..60}; do
      kill -0 "$runtime_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$runtime_pid" 2>/dev/null || true
    wait "$runtime_pid" 2>/dev/null || true
    break
  fi
  kill -TERM -- "-$runtime_pid" 2>/dev/null || true
  runtime_pid=
  if (( SECONDS - began >= 60 )); then delay=2; fi
  printf 'Runtime exited (%s); retrying in %s seconds.\n' "$status" "$delay" >>"$state/launcher.log"
  sleep "$delay" &
  wait $! || true
  if (( delay < 60 )); then delay=$((delay * 2)); fi
  if (( delay > 60 )); then delay=60; fi
done
