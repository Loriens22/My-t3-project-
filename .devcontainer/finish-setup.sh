#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"
cd "$T3_PHONE_REPO"
if [[ ! -x "$T3_PHONE_ROOT/tools/node_modules/.bin/t3" || \
      ! -x "$T3_PHONE_ROOT/tools/node_modules/.bin/opencode" ]]; then
  bash .devcontainer/setup.sh
fi

if [[ "${1:-}" == "--connect" ]]; then
  echo "Open the official T3 login link on your phone and confirm the code."
  echo "If asked, allow T3 to download its Cloudflare tunnel helper."
  t3 connect link --headless --base-dir "$T3CODE_HOME"
  echo "T3 Connect is linked. Restart the Codespace at github.com/codespaces."
  echo "Then sign into the same T3 Connect account in the Android app."
  exit 0
fi

bash .devcontainer/start-t3.sh
if [[ -z "${CODESPACE_NAME:-}" ]]; then
  echo "Outside Codespaces, use T3 Connect: bash .devcontainer/finish-setup.sh --connect"
  exit 0
fi

echo "Making only the authenticated T3 Code port reachable by the Android app..."
if ! gh codespace ports visibility "$T3_PHONE_PORT:public" --codespace "$CODESPACE_NAME"; then
  echo "In the Codespace, open PORTS > $T3_PHONE_PORT > Port Visibility > Public."
fi
pair_output="$(t3 pair --ttl 15m --label Android --base-dir "$T3CODE_HOME")"
pair_token="$(printf '%s\n' "$pair_output" | sed -nE 's/.*[Tt]oken[:=] *([A-Za-z0-9_-]+).*/\1/p' | head -n 1)"
if [[ -z "$pair_token" ]]; then
  echo "Could not read the pairing code. Run: t3 pair --base-dir \"$T3CODE_HOME\""
  exit 1
fi
phone_host="https://${CODESPACE_NAME}-${T3_PHONE_PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
printf '\nOn Android: Add Environment\nHOST: %s\nPAIRING CODE: %s\n' "$phone_host" "$pair_token"
printf '\nBrowser pairing link: %s/pair#token=%s\n' "$phone_host" "$pair_token"
echo "This code works once and expires after 15 minutes. Keep it private."
echo "Choose OpenCode > DeepSeek V4.1 Flash Free in a new thread."
