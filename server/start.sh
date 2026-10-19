#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export T3_PHONE_ROOT="${T3_PHONE_ROOT:-/data}"
export T3CODE_HOME="$T3_PHONE_ROOT/t3"
export OPENCODE_CONFIG="$T3_PHONE_ROOT/opencode.json"
export XDG_DATA_HOME="$T3_PHONE_ROOT/data"
export XDG_CONFIG_HOME="$T3_PHONE_ROOT/config"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/t3-cache}"
if [[ "$XDG_CACHE_HOME" == "$T3_PHONE_ROOT/cache" ]]; then
  export XDG_CACHE_HOME=/tmp/t3-cache
fi
export PORT="${PORT:-3773}"
if [[ "${T3_RECOVERY_ONLY:-0}" == "1" ]]; then
  exec node /app/server/recovery.mjs
fi
python3 /app/server/storage.py
node /app/server/configure.mjs
cd "$T3_PHONE_ROOT/projects/my-project"
if [[ ! -d .git ]]; then
  git init --initial-branch=main -q
  git -c user.name="T3 Code" -c user.email="t3@localhost" \
    commit --allow-empty --quiet -m "Initialize project"
fi

# Register the project offline so a second T3 runtime does not overlap startup
# and provider discovery on a small machine.
if [[ ! -f "$T3_PHONE_ROOT/project-added" ]]; then
  if output="$(t3 project add --base-dir "$T3CODE_HOME" --title "My Project" "$PWD" 2>&1)"; then
    touch "$T3_PHONE_ROOT/project-added"
  elif [[ "$output" == *ProjectAlreadyExistsError* ]]; then
    touch "$T3_PHONE_ROOT/project-added"
  else
    printf '%s\n' "$output"
    exit 1
  fi
fi
echo "Starting T3 Code. Persistent data: $T3_PHONE_ROOT"
echo "Create a private phone pairing code with: bash /app/server/pair.sh"
if [[ "${T3_PRIVATE_ONBOARDING:-0}" == "1" ]]; then
  # Enable only after confirming the provider's deployment logs are owner-private.
  # Issue the phone grant offline, before provider discovery consumes memory.
  t3 auth pairing create --base-dir "$T3CODE_HOME" --ttl 1h --label Android --json \
    | node -e 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{ const p=JSON.parse(s); console.log("PHONE_PAIRING_CODE: "+p.credential); console.log("PHONE_PAIRING_EXPIRES_AT: "+p.expiresAt); });'
fi
# Keep startup grants and diagnostics off public HTTP endpoints and normal logs.
exec node /app/server/supervise.mjs
