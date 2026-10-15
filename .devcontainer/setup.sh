#!/usr/bin/env bash
set -e
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
if ! command -v t3 >/dev/null 2>&1; then curl -fsSL https://t3.codes/install.sh | sh; fi
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
npm install -g @opencode/cli
echo "Tools installed. Next run: bash .devcontainer/finish-setup.sh"
