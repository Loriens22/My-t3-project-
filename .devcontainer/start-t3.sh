#!/usr/bin/env bash
set -e
test -f "$HOME/.t3-codespaces-enabled" || exit 0
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
if pgrep -u "$(id -u)" -f '/t3.*serve' >/dev/null 2>&1; then exit 0; fi
nohup t3 serve > "$HOME/.t3-codespaces.log" 2>&1 < /dev/null &
echo "Started T3 Code server (local only)"
