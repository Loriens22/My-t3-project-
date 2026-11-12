#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "${CODESPACES:-}" == true && -n "${CODESPACE_NAME:-}" ]] || exit 1
repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
state=/workspaces/.t3-code
mkdir -p "$state"
chmod 700 "$state"
connection_file=$(mktemp "$state/phone-connection.XXXXXX")
trap 'rm -f -- "$connection_file"' EXIT
bash "$repository/scripts/codespaces-pair.sh" >"$connection_file"
mv -f -- "$connection_file" "$state/phone-connection.txt"
cat "$state/phone-connection.txt"
