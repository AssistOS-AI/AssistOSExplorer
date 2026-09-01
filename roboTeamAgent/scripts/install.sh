#!/bin/sh
set -eu

contract_file="/opt/roboteam-runtime/contract-v3"
contract_value="roboteam-runtime-v3"
required_commands="podman fuse-overlayfs pasta node"
required_executables=""
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

if ! podman --version 2>/dev/null | grep -Eq '^podman version 6\.'; then
    missing="$missing podman-major:6"
fi

for executable_path in $required_executables; do
    if [ ! -x "$executable_path" ]; then
        missing="$missing $executable_path"
    fi
done

for asset_path in $required_assets; do
    if [ ! -f "$asset_path" ]; then
        missing="$missing $asset_path"
    fi
done

if [ -n "$missing" ]; then
    echo "ERROR: RoboTeam purpose-built runtime contract is incomplete:$missing" >&2
    exit 1
fi

echo "RoboTeam runtime contract verified"
