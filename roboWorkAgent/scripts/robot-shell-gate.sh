#!/bin/sh
set -eu
[ "${PLOINKY_WEBTTY_PROFILE_PROVIDER:-}" = roboWorkAgent ] || exit 124
[ -n "${PLOINKY_WEBTTY_PROFILE_ID:-}" ] || exit 124
exec /usr/bin/env node /code/scripts/robot-shell.mjs
