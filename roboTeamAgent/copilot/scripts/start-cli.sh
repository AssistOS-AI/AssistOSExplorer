#!/usr/bin/env sh
set -eu

NATIVE_PREFIX="${ACHILLES_NATIVE_PREFIX:-/root/.cache/achilles-native}"
export CODEX_BIN="${CODEX_BIN:-$NATIVE_PREFIX/codex/node_modules/.bin/codex}"
export OPENCODE_BIN="${OPENCODE_BIN:-$NATIVE_PREFIX/opencode/node_modules/.bin/opencode}"
export PI_BIN="${PI_BIN:-$NATIVE_PREFIX/pi/node_modules/.bin/pi}"

exec node /code/src/cli.mjs "$@"
