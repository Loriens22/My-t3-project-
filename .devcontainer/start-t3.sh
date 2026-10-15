#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"
umask 077
mkdir -p "$T3_PHONE_ROOT"
exec 9>"$T3_PHONE_ROOT/start.lock"
flock 9

ensure_project() {
  [[ -f "$T3_PHONE_ROOT/project-added" ]] && return 0
  local project_output
  if project_output="$(t3 project add --base-dir "$T3CODE_HOME" \
      --title "My T3 Project" "$T3_PHONE_REPO" 2>&1)"; then
    touch "$T3_PHONE_ROOT/project-added"
  elif [[ "$project_output" == *ProjectAlreadyExistsError* ]]; then
    touch "$T3_PHONE_ROOT/project-added"
  else
    printf '%s\n' "$project_output"
    return 1
  fi
}

if [[ -f "$T3_PHONE_ROOT/server.pid" ]] && \
   kill -0 "$(cat "$T3_PHONE_ROOT/server.pid")" 2>/dev/null && \
   curl -fsS --max-time 2 "http://127.0.0.1:$T3_PHONE_PORT/" >/dev/null 2>&1; then
  ensure_project
  echo "T3 Code is already running."
  exit 0
fi

command -v t3 >/dev/null || { echo "Run: bash .devcontainer/setup.sh"; exit 1; }
cd "$T3_PHONE_REPO"
setsid nohup t3 serve --host 127.0.0.1 --port "$T3_PHONE_PORT" \
  --base-dir "$T3CODE_HOME" \
  >"$T3_PHONE_ROOT/server.log" 2>&1 < /dev/null 9>&- &
server_pid=$!
echo "$server_pid" >"$T3_PHONE_ROOT/server.pid"

for attempt in {1..60}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$T3_PHONE_PORT/" >/dev/null 2>&1; then
    ensure_project
    echo "T3 Code is ready on http://127.0.0.1:$T3_PHONE_PORT"
    echo "Connect your phone: bash .devcontainer/finish-setup.sh"
    exit 0
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "T3 Code stopped. Check $T3_PHONE_ROOT/server.log locally."
    exit 1
  fi
  sleep 0.5
done
echo "Startup timed out. Check $T3_PHONE_ROOT/server.log locally."
exit 1
