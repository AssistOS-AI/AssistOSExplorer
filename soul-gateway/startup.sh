#!/bin/bash
set -e

APP_DIR="/app"
CODE_DIR="/code"
SHARED_DIR="/shared/soul-gateway"

echo "=== Soul Gateway: Starting ==="

# Ensure directories exist
mkdir -p "$SHARED_DIR/config"

# Copy/update application from code mount
if [ -d "$CODE_DIR/app/src" ]; then
    cp -r "$CODE_DIR/app/"* "$APP_DIR/"
elif [ -n "$WORKSPACE_PATH" ] && [ -d "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/app/src" ]; then
    cp -r "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/app/"* "$APP_DIR/"
fi

# Install deps if needed
if [ -f "$APP_DIR/package.json" ] && [ ! -d "$APP_DIR/node_modules" ]; then
    cd "$APP_DIR"
    npm install --production
elif [ -f "$APP_DIR/package.json" ] && [ -d "$APP_DIR/node_modules" ]; then
    # Force fresh achillesAgentLib on every start (bypass npm cache)
    cd "$APP_DIR"
    rm -rf node_modules/achillesAgentLib
    npm install --production
fi

# Load encryption key from shared storage if ENCRYPTION_KEY not set
if [ -z "$ENCRYPTION_KEY" ] && [ -f "$SHARED_DIR/config/encryption.key" ]; then
    export ENCRYPTION_KEY=$(cat "$SHARED_DIR/config/encryption.key")
fi

# Load proxy API key from shared if available
if [ -f "/shared/proxy_api_key" ]; then
    export DEFAULT_PROXY_API_KEY=$(cat /shared/proxy_api_key)
fi

# Map DEFAULT_PROXY_API_KEY to achillesAgentLib provider env vars
if [ -n "$DEFAULT_PROXY_API_KEY" ]; then
    export AXIOLOGIC_PROXY_API_KEY="${AXIOLOGIC_PROXY_API_KEY:-$DEFAULT_PROXY_API_KEY}"
fi

export PORT="${PORT:-8042}"

cd "$APP_DIR"
exec node src/index.mjs
