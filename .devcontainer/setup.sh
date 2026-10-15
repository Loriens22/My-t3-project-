#!/usr/bin/env bash
set -Eeuo pipefail
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

echo "[1/3] Checking T3 Code..."
if ! command -v t3 >/dev/null 2>&1; then
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://t3.codes/install.sh -o "$installer"
  sh "$installer"
fi
if ! command -v t3 >/dev/null 2>&1; then
  echo "ERROR: T3 Code did not install into $HOME/.local/bin"
  exit 1
fi

echo "[2/3] Configuring user-owned npm directory..."
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

echo "[3/3] Installing OpenCode 2..."
if ! command -v opencode >/dev/null 2>&1; then
  npm install -g @opencode/cli
fi
if ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: OpenCode install did not finish."
  exit 1
fi

echo "Installed T3 Code:"
t3 --version
echo "Installed OpenCode:"
opencode --version
echo "READY. Next: bash .devcontainer/finish-setup.sh"
