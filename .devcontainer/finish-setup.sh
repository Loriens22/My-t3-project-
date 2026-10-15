#!/usr/bin/env bash
set -e
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
echo "Step 1: Sign in to T3 Connect on your phone using the displayed link."
echo "Decline the background service offer if it appears."
t3 connect
touch "$HOME/.t3-codespaces-enabled"
bash .devcontainer/start-t3.sh
echo "Step 2: Sign in to OpenCode, select the free option when available."
opencode auth login
echo "Next: Sign in to T3 Connect on the Android app and select this environment."
