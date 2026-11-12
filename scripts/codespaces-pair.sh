#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${CODESPACES:-}" == true && -n "${CODESPACE_NAME:-}" ]] || exit 1
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
bash "$repository/scripts/codespaces-start.sh"
gh codespace ports visibility 3773:public --codespace "$CODESPACE_NAME"
export PATH="/opt/t3/node_modules/.bin:$PATH"
host="https://${CODESPACE_NAME}-3773.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
t3 auth pairing create --base-dir /data/t3 --ttl 1h --label Android --json | node -e '
let input=""; process.stdin.on("data", c=>input+=c); process.stdin.on("end",()=>{
  const grant=JSON.parse(input);
  console.log("HOST: " + process.argv[1]);
  console.log("PAIRING CODE: " + grant.credential);
  console.log("Expires: " + grant.expiresAt);
});' "$host"
