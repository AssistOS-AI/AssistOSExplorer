#!/bin/bash
set -e

CODE_DIR="/code"
APP_DIR="/app"
SHARED_DIR="/shared/soul-gateway"

echo "=== Soul Gateway: Install ==="

# Create persistent storage
mkdir -p "$SHARED_DIR/config" "$SHARED_DIR/data/credentials" "$APP_DIR"

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
    for candidate in /code/node_modules /Agent/node_modules; do
        if [ -d "$candidate/pg" ]; then
            echo "Using prepared runtime dependencies from $candidate"
            rm -rf "$APP_DIR/node_modules"
            ln -s "$candidate" "$APP_DIR/node_modules"
            return
        fi
    done

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

# Copy src/ and package.json
if [ -d "$CODE_DIR/src" ]; then
    echo "Copying source from /code/src/"
    rm -rf "$APP_DIR/src"
    cp -r "$CODE_DIR/src" "$APP_DIR/src"
    cp -f "$CODE_DIR/package.json" "$APP_DIR/package.json"
    if [ -f "$CODE_DIR/package-lock.json" ]; then
        cp -f "$CODE_DIR/package-lock.json" "$APP_DIR/package-lock.json"
    else
        rm -f "$APP_DIR/package-lock.json"
    fi
fi

# Install runtime dependencies, including achillesAgentLib for provider/wrapper
# plugins that depend on it in src-based deployments.
prepare_runtime_dependencies
ensure_browser_runtime

# Generate encryption key if not present
if [ ! -f "$SHARED_DIR/config/encryption.key" ]; then
    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > "$SHARED_DIR/config/encryption.key"
    echo "Generated encryption key"
fi

echo "=== Soul Gateway: Install complete ==="
