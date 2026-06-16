#!/bin/bash
set -e

CODE_DIR="${CODE_DIR:-/code}"
DATA_DIR="${DATA_DIR:-/data}"
CREDENTIALS_DIR="${CREDENTIALS_DIR:-$DATA_DIR/credentials}"
AGENT_NODE_MODULES_DIR="${AGENT_NODE_MODULES_DIR:-/Agent/node_modules}"

echo "=== Soul Gateway: Install ==="

mkdir -p "$DATA_DIR" "$CREDENTIALS_DIR"

ensure_browser_runtime() {
    case "${BROWSER_POOL_SIZE:-0}" in
        ""|0) return ;;
    esac

    if command -v chromium >/dev/null 2>&1 \
        || command -v chromium-browser >/dev/null 2>&1 \
        || command -v google-chrome >/dev/null 2>&1; then
        return
    fi

    if command -v apt-get >/dev/null 2>&1; then
        echo "Installing Chromium runtime for headless browser search"
        apt-get update
        apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation
        rm -rf /var/lib/apt/lists/*
    else
        echo "WARNING: BROWSER_POOL_SIZE is set but apt-get is unavailable; install Chromium manually"
    fi
}

prepare_runtime_dependencies() {
    if [ -d "$CODE_DIR/node_modules" ]; then
        echo "Using prepared runtime dependencies from $CODE_DIR/node_modules"
        return
    fi

    if [ -d "$AGENT_NODE_MODULES_DIR" ]; then
        ln -s "$AGENT_NODE_MODULES_DIR" "$CODE_DIR/node_modules"
        echo "Linked prepared runtime dependencies from $AGENT_NODE_MODULES_DIR to $CODE_DIR/node_modules"
        return
    fi

    if [ ! -f "$CODE_DIR/package.json" ]; then
        return
    fi

    cd "$CODE_DIR"
    if [ -f "$CODE_DIR/package-lock.json" ]; then
        env NODE_OPTIONS= npm ci --omit=dev
    else
        env NODE_OPTIONS= npm install --omit=dev --no-package-lock
    fi
}

prepare_runtime_dependencies
ensure_browser_runtime

# Generate the encryption key under DATA_DIR so it matches ensureEncryptionKey,
# which reads/writes DATA_DIR/encryption.key. The app regenerates it on first
# run if missing; this keeps a stable key across container rebuilds.
if [ ! -f "$DATA_DIR/encryption.key" ]; then
    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > "$DATA_DIR/encryption.key"
    chmod 600 "$DATA_DIR/encryption.key"
    echo "Generated encryption key at $DATA_DIR/encryption.key"
fi

echo "=== Soul Gateway: Install complete ==="
