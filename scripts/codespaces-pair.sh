#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${CODESPACES:-}" == true && -n "${CODESPACE_NAME:-}" ]] || exit 1
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
bash "$repository/scripts/codespaces-start.sh"
# A fresh workspace can still be initializing its database. Issue the grant only
# after the actual protocol-2 server is ready, not after a fixed sleep.
python3 - <<'PY'
import json,time,urllib.request
deadline=time.monotonic()+180
while time.monotonic()<deadline:
    try:
        with urllib.request.urlopen('http://127.0.0.1:3773/.well-known/t3/environment',timeout=2) as response:
            if json.load(response).get('orchestrationProtocolVersion')==2:
                break
    except (OSError,ValueError):
        pass
    time.sleep(0.5)
else:
    raise SystemExit('T3 did not become ready. Check the private /workspaces/.t3-code/launcher.log.')
PY
gh codespace ports visibility 3773:public --codespace "$CODESPACE_NAME"
export PATH="/opt/t3/node_modules/.bin:$PATH"
host="https://${CODESPACE_NAME}-3773.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
t3 auth pairing create --base-dir /data/t3 --ttl 1h --label Android --json | node -e '
let input=""; process.stdin.on("data", c=>input+=c); process.stdin.on("end",()=>{
  const grant=JSON.parse(input);
  console.log("HOST: " + process.argv[1]);
  console.log("PAIRING CODE: " + grant.credential);
  console.log("Expires: " + grant.expiresAt);
  console.log("Paste HOST and PAIRING CODE into T3 Code mobile > Add environment.");
  console.log("This code works once. Keep it private.");
});' "$host"
