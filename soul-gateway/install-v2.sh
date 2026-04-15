#!/bin/bash
set -e

CODE_DIR="/code"
APP_DIR="/app"
SHARED_DIR="/shared/soul-gateway"

echo "=== Soul Gateway v2: Install ==="

# Create persistent storage
mkdir -p "$SHARED_DIR/config" "$SHARED_DIR/data/credentials" "$APP_DIR"

# Copy new src/ and package.json
if [ -d "$CODE_DIR/src" ]; then
    echo "Copying v2 source from /code/src/"
    cp -r "$CODE_DIR/src" "$APP_DIR/src"
    cp -f "$CODE_DIR/package.json" "$APP_DIR/package.json"
fi

# Install runtime dependencies, including achillesAgentLib for provider/wrapper
# plugins that depend on it in src-based deployments.
if [ -f "$APP_DIR/package.json" ]; then
    cd "$APP_DIR"
    npm install --production --no-package-lock 2>&1 | tail -3
fi

# Generate encryption key if not present
if [ ! -f "$SHARED_DIR/config/encryption.key" ]; then
    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > "$SHARED_DIR/config/encryption.key"
    echo "Generated encryption key"
fi

echo "=== Soul Gateway v2: Install complete ==="
