#!/bin/bash
set -e

APP_DIR="/app"
CODE_DIR="/code"
SHARED_DIR="/shared/soul-gateway"

echo "=== Soul Gateway: Install ==="

# Create persistent storage
mkdir -p "$SHARED_DIR/config"

# Copy application from code mount to app directory
if [ ! -d "$APP_DIR" ]; then
    mkdir -p "$APP_DIR"
fi

cp -r "$CODE_DIR/../soul-gateway-app/"* "$APP_DIR/" 2>/dev/null || {
    echo "Warning: soul-gateway-app not found in code mount, will copy on startup"
}

# Install dependencies
if [ -f "$APP_DIR/package.json" ]; then
    cd "$APP_DIR"
    npm install --production
fi

# Generate encryption key if not present
if [ ! -f "$SHARED_DIR/config/encryption.key" ]; then
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "$SHARED_DIR/config/encryption.key"
    echo "Generated encryption key"
fi

echo "=== Soul Gateway: Install complete ==="
