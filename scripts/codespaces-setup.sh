#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ "${CODESPACES:-}" != true ]]; then
  echo 'This setup is for the owned GitHub Codespace only.' >&2
  exit 1
fi
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
state=/workspaces/.t3-code
runtime="$state/runtime"
mkdir -p "$state" "$runtime" "$state/data"
chmod 700 "$state" "$state/data"
if [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 24 ]]; then
  echo 'Node 24 is required; rebuild with the supplied devcontainer feature.' >&2
  exit 1
fi
if [[ $(id -u) == 0 ]]; then privileged=(); else privileged=(sudo); fi
if ! ldconfig -p 2>/dev/null | rg 'libatomic\.so\.1' >/dev/null; then
  "${privileged[@]}" apt-get update
  "${privileged[@]}" apt-get install -y --no-install-recommends libatomic1
fi
if ! node - "$runtime" <<'JS'
const fs = require('node:fs');
try {
  const root = process.argv[2] + '/node_modules/';
  process.exit(JSON.parse(fs.readFileSync(root + 't3/package.json')).version === '0.1.0' &&
    JSON.parse(fs.readFileSync(root + '@opencode/cli/package.json')).version === '2.2.5' ? 0 : 1);
} catch { process.exit(1); }
JS
then
  npm install --prefix "$runtime" --cache /tmp/t3-codespaces-npm-cache --no-audit --no-fund t3@0.1.0 @opencode/cli@2.2.5
fi
link_owned() {
  local destination=$1 source=$2
  if [[ -L "$destination" ]]; then
    [[ $(readlink -f -- "$destination") == "$source" ]] || { echo "Unexpected existing link: $destination" >&2; exit 1; }
  elif [[ -e "$destination" ]]; then
    echo "Refusing to replace an existing path: $destination" >&2
    exit 1
  else
    "${privileged[@]}" ln -s -- "$source" "$destination"
  fi
}
"${privileged[@]}" mkdir -p /app
link_owned /opt/t3 "$runtime"
link_owned /app/server "$repository/server"
link_owned /data "$state/data"
printf '%s\n' 'Pinned T3/OpenCode runtime installed. Data persists under /workspaces/.t3-code/data.'
