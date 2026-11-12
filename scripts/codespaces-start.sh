#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "${CODESPACES:-}" != true ]]; then
  echo 'This start command is for the owned GitHub Codespace only.' >&2
  exit 1
fi
state=/workspaces/.t3-code
mkdir -p "$state"
chmod 700 "$state"
export T3_PHONE_ROOT=/data T3CODE_HOME=/data/t3 OPENCODE_CONFIG=/data/opencode.json
export PATH="/opt/t3/node_modules/.bin:$PATH"
export XDG_DATA_HOME=/data/data XDG_CONFIG_HOME=/data/config XDG_CACHE_HOME=/tmp/t3-cache
export T3_PRIVATE_ONBOARDING=1 T3CODE_TRACE_MIN_LEVEL=Warn
export T3CODE_TRACE_MAX_BYTES=2097152 T3CODE_TRACE_MAX_FILES=3 PORT=3773
if curl --fail --silent --max-time 3 http://127.0.0.1:3773/.well-known/t3/environment >/dev/null; then
  echo 'T3 Code is already available on port 3773.'
  exit 0
fi
# The agent does not need the Codespace's account-management credentials.
# Keep the provider API keys that the owner supplied as Codespaces secrets.
supervisor=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/codespaces-supervise.sh
nohup env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN \
  bash "$supervisor" </dev/null >/dev/null 2>&1 &
echo 'T3 Code is starting on port 3773. Pairing is required for mobile access.'
