#!/usr/bin/env bash
set -euo pipefail
connection=/workspaces/.t3-code/phone-connection.txt
# Open the owner-private connection card in VS Code after browser attachment.
# It stays outside the repository and all forwarded HTTP directories.
if [[ -f "$connection" ]] && command -v code >/dev/null; then
  code --reuse-window "$connection" >/dev/null 2>&1 || true
fi
