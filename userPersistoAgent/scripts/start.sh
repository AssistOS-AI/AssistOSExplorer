#!/bin/sh
set -eu
cd "${PLOINKY_CODE_DIR:-/code}"
export PERSISTENCE_FOLDER="${PERSISTENCE_FOLDER:-/root/persisto}"
mkdir -p "$PERSISTENCE_FOLDER"
exec node main.mjs
