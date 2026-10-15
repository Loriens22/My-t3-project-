#!/usr/bin/env bash
# Runtime files live beside the repository, outside Git and across rebuilds.
T3_PHONE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export T3_PHONE_ROOT="${T3_PHONE_ROOT:-$(dirname "$T3_PHONE_REPO")/.t3-phone}"
export T3CODE_HOME="$T3_PHONE_ROOT/t3"
export OPENCODE_CONFIG="$T3_PHONE_ROOT/opencode.json"
export XDG_DATA_HOME="$T3_PHONE_ROOT/data"
export XDG_CONFIG_HOME="$T3_PHONE_ROOT/config"
export XDG_CACHE_HOME="$T3_PHONE_ROOT/cache"
export PATH="$T3_PHONE_ROOT/tools/node_modules/.bin:$PATH"
export T3_PHONE_PORT="${T3_PHONE_PORT:-3773}"
T3_PHONE_MODEL="opencode/deepseek-v4.1-flash-free"
T3_PHONE_T3_VERSION="0.0.45"
T3_PHONE_OPENCODE_VERSION="1.19.1"
