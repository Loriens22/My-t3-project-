#!/usr/bin/env bash
set -Eeuo pipefail
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
cd "$(git rev-parse --show-toplevel)"

if ! command -v t3 >/dev/null 2>&1 || ! command -v opencode >/dev/null 2>&1; then
  echo "Missing tools detected. Installing them automatically..."
  bash .devcontainer/setup.sh
fi

echo
echo "STEP 1: Sign in to T3 Connect with the link/code shown below."
echo "Approve the login from your phone. Skip background-service installation if offered."
t3 connect
touch "$HOME/.t3-codespaces-enabled"
bash .devcontainer/start-t3.sh

echo
echo "STEP 2: Authenticate OpenCode."
echo "Choose the free OpenCode provider/model when available."
opencode auth login

echo
echo "DONE. On Android open T3 Code > Settings > Environments > T3 Connect."
echo "Sign in to the same account, select your Codespace, and choose OpenCode."
echo "You can refresh models inside thread settings."
