#!/bin/sh
set -eu

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required" >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$script_dir/prepare-data.mjs"

# RoboFlow uses the embedded SQLite driver shipped with Node.js.
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.close();"
