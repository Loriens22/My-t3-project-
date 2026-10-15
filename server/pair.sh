#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root="${T3_PHONE_ROOT:-/data}"
t3 pair --base-dir "$root/t3" --ttl 1h --label Android
