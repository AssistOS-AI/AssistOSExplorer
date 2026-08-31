#!/bin/sh
set -eu

required_commands="chromium Xvfb openbox xterm x11vnc websockify"
missing=0
for command_name in $required_commands; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        missing=1
    fi
done

if [ "$missing" -eq 0 ] && [ -f /usr/share/novnc/core/rfb.js ]; then
    echo "RoboTeam desktop runtime is already installed"
    exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
    echo "ERROR: RoboTeam requires a Debian-compatible image with apt-get" >&2
    exit 1
fi

echo "Installing RoboTeam desktop runtime"
apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    dbus-x11 \
    fonts-liberation \
    novnc \
    openbox \
    passwd \
    websockify \
    x11vnc \
    xfonts-base \
    xterm \
    xvfb
rm -rf /var/lib/apt/lists/*
