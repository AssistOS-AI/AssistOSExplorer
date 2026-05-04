#!/bin/bash
set -e

CODE_DIR="/code"
APP_DIR="/app"
SHARED_DIR="/shared/soul-gateway"

echo "=== Soul Gateway v2: Starting ==="

# Ensure directories exist
mkdir -p "$SHARED_DIR/config" "$SHARED_DIR/data" "$APP_DIR"

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

# Copy new src/ and package.json from code mount (always fresh copy)
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
elif [ -n "$WORKSPACE_PATH" ] && [ -d "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/src" ]; then
    echo "Copying v2 source from workspace repos"
    rm -rf "$APP_DIR/src"
    cp -r "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/src" "$APP_DIR/src"
    cp -f "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/package.json" "$APP_DIR/package.json"
    if [ -f "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/package-lock.json" ]; then
        cp -f "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/package-lock.json" "$APP_DIR/package-lock.json"
    else
        rm -f "$APP_DIR/package-lock.json"
    fi
fi

# Install runtime deps and let npm failures stop container startup.
install_runtime_dependencies

# Sync achillesAgentLib from ploinky workspace (same mechanism as ploinky syncCoreDependencies)
AGENTLIB_SRC=""
if [ -d "/Agent/node_modules/achillesAgentLib" ]; then
    AGENTLIB_SRC="/Agent/node_modules/achillesAgentLib"
elif [ -n "$WORKSPACE_PATH" ] && [ -d "$WORKSPACE_PATH/.ploinky/node_modules/achillesAgentLib" ]; then
    AGENTLIB_SRC="$WORKSPACE_PATH/.ploinky/node_modules/achillesAgentLib"
elif [ -d "$CODE_DIR/vendor/achillesAgentLib" ]; then
    AGENTLIB_SRC="$CODE_DIR/vendor/achillesAgentLib"
fi

if [ -n "$AGENTLIB_SRC" ]; then
    echo "Syncing achillesAgentLib from $AGENTLIB_SRC"
    mkdir -p "$APP_DIR/node_modules/achillesAgentLib"
    cp -r "$AGENTLIB_SRC/"* "$APP_DIR/node_modules/achillesAgentLib/"
else
    echo "WARNING: achillesAgentLib not found — provider transport will not work"
fi

# Load encryption key from shared storage if ENCRYPTION_KEY not set
if [ -z "$ENCRYPTION_KEY" ] && [ -f "$SHARED_DIR/config/encryption.key" ]; then
    export ENCRYPTION_KEY=$(cat "$SHARED_DIR/config/encryption.key")
fi

# Construct DATABASE_URL from PG* env vars if not already set
if [ -z "$DATABASE_URL" ]; then
    PGHOST="${PGHOST:-host.containers.internal}"
    PGPORT="${PGPORT:-5432}"
    PGUSER="${PGUSER:-postgres}"
    PGPASSWORD="${PGPASSWORD:-postgres}"
    PGDATABASE="${PGDATABASE:-postgres}"
    export DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}?search_path=soul_gateway"
fi

export PORT="${PORT:-8042}"
export HOST="${HOST:-0.0.0.0}"
export DATA_DIR="$SHARED_DIR/data"
export CREDENTIALS_DIR="$SHARED_DIR/data/credentials"

echo "DATABASE_URL=${DATABASE_URL%%@*}@***"
echo "PORT=$PORT HOST=$HOST"

cd "$APP_DIR"
exec node src/index.mjs
