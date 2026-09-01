#!/bin/sh
set -eu

contract_file="/opt/roboteam-runtime/contract-v1"
contract_value="roboteam-runtime-v1"
required_commands="chromium Xvfb openbox xterm x11vnc websockify"
required_executables="/usr/bin/getent /usr/sbin/useradd"
required_assets="/usr/share/novnc/core/rfb.js"
missing=""

if [ ! -f "$contract_file" ] || [ "$(cat "$contract_file" 2>/dev/null || true)" != "$contract_value" ]; then
    missing="$missing $contract_file"
fi

for command_name in $required_commands; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        missing="$missing command:$command_name"
    fi
done

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
