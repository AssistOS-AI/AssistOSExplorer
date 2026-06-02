#!/bin/bash
set -e

IMAGE_APP_DIR="${SOUL_GATEWAY_IMAGE_APP_DIR:-/opt/soul-gateway}"
CODE_DIR="${CODE_DIR:-/code}"
APP_DIR="${APP_DIR:-/app}"
DATA_DIR="${DATA_DIR:-/data}"
CREDENTIALS_DIR="${CREDENTIALS_DIR:-$DATA_DIR/credentials}"

echo "=== Soul Gateway: Install ==="

# Create durable storage (mounted volume) and app directory
mkdir -p "$DATA_DIR" "$CREDENTIALS_DIR" "$APP_DIR"

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
    # Production dependencies are baked into the image; only fall back to an
    # in-place install when no prepared node_modules tree is available.
    for candidate in "$IMAGE_APP_DIR/node_modules" /code/node_modules /Agent/node_modules; do
        if [ -d "$candidate" ]; then
            echo "Using prepared runtime dependencies from $candidate"
            return
        fi
    done

    if [ -d "$CODE_DIR/src" ]; then
        rm -rf "$APP_DIR/src"
        cp -r "$CODE_DIR/src" "$APP_DIR/src"
        cp -f "$CODE_DIR/package.json" "$APP_DIR/package.json"
        if [ -f "$CODE_DIR/package-lock.json" ]; then
            cp -f "$CODE_DIR/package-lock.json" "$APP_DIR/package-lock.json"
        else
            rm -f "$APP_DIR/package-lock.json"
        fi
    fi

    if [ ! -f "$APP_DIR/package.json" ]; then
        return
    fi

    cd "$APP_DIR"
    if [ -f "$APP_DIR/package-lock.json" ]; then
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
