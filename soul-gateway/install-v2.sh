#!/bin/bash
set -e

CODE_DIR="/code"
APP_DIR="/app"
SHARED_DIR="/shared/soul-gateway"

echo "=== Soul Gateway v2: Install ==="

# Create persistent storage
mkdir -p "$SHARED_DIR/config" "$SHARED_DIR/data/credentials" "$APP_DIR"

install_runtime_dependencies() {
    if [ ! -f "$APP_DIR/package.json" ]; then
        return
    fi

    cd "$APP_DIR"
    if [ -f "$APP_DIR/package-lock.json" ]; then
        npm ci --omit=dev
    else
        npm install --omit=dev --no-package-lock
    fi
}

# Copy new src/ and package.json
if [ -d "$CODE_DIR/src" ]; then
    echo "Copying v2 source from /code/src/"
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
install_runtime_dependencies

# Generate encryption key if not present
if [ ! -f "$SHARED_DIR/config/encryption.key" ]; then
    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > "$SHARED_DIR/config/encryption.key"
    echo "Generated encryption key"
fi

echo "=== Soul Gateway v2: Install complete ==="
