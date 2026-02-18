#!/bin/bash
set -e

APP_DIR="/app"
CODE_DIR="/code"
SHARED_DIR="/shared/soul-gateway"

echo "=== Soul Gateway: Install ==="

# Create persistent storage
mkdir -p "$SHARED_DIR/config"
mkdir -p "$APP_DIR"

# Copy application to /app — check multiple locations
if [ -d "$CODE_DIR/app/src" ]; then
    echo "Copying app from /code/app/"
    cp -r "$CODE_DIR/app/"* "$APP_DIR/"
elif [ -n "$WORKSPACE_PATH" ] && [ -d "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/app/src" ]; then
    echo "Copying app from workspace repos"
    cp -r "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/app/"* "$APP_DIR/"
else
    echo "Warning: soul-gateway app not found, will attempt on startup"
fi

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
