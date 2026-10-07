#!/bin/sh
set -eu

contract_file="/opt/roboteam-runtime/contract-v5"
contract_value="roboteam-runtime-v5"
required_commands="podman fuse-overlayfs pasta node npm bwrap"
required_assets="/opt/roboteam-runtime/storage.conf"
missing=""

if [ ! -f "$contract_file" ] || [ "$(cat "$contract_file" 2>/dev/null || true)" != "$contract_value" ]; then
    missing="$missing $contract_file"
fi

for command_name in $required_commands; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        missing="$missing command:$command_name"
    fi
done

if [ "$(podman --version 2>/dev/null || true)" != "podman version 5.8.7" ]; then
    missing="$missing podman-version:5.8.7"
fi

if ! NODE_OPTIONS= npm --version >/dev/null 2>&1; then
    missing="$missing npm-runtime"
fi

for asset_path in $required_assets; do
    if [ ! -f "$asset_path" ]; then
        missing="$missing $asset_path"
    fi
done

if ! grep -Eq '^force_mask = "0700"$' /opt/roboteam-runtime/storage.conf 2>/dev/null; then
    missing="$missing storage-force-mask:0700"
fi
if ! grep -Eq '^graphroot = "/var/lib/roboteam-podman/storage"$' /opt/roboteam-runtime/storage.conf 2>/dev/null \
    || ! grep -Eq '^imagestore = "/data/podman/images"$' /opt/roboteam-runtime/storage.conf 2>/dev/null \
    || ! grep -Eq '^transient_store = true$' /opt/roboteam-runtime/storage.conf 2>/dev/null; then
    missing="$missing storage-layout:split-transient"
fi

if [ -n "$missing" ]; then
    echo "ERROR: RoboTeam purpose-built runtime contract is incomplete:$missing" >&2
    exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

node "$script_dir/prepare-data.mjs"
mkdir -p /etc/ploinky
ln -sfn /code/scripts/webtty-env.sh /etc/ploinky/webtty-env.sh

echo "RoboTeam runtime contract verified"

# RoboFlow uses the embedded SQLite driver shipped with Node.js.
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:'); db.close();"
