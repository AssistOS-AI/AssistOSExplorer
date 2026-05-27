#!/bin/bash
set -e

CODE_DIR="/code"
APP_DIR="/app"
SHARED_DIR="/shared/soul-gateway"

echo "=== Soul Gateway: Starting ==="

# Ensure directories exist
mkdir -p "$SHARED_DIR/config" "$SHARED_DIR/data" "$APP_DIR"

ensure_browser_runtime() {
    case "${BROWSER_POOL_SIZE:-0}" in
        ""|0) return ;;
    esac

    if [ -z "${BROWSER_EXECUTABLE_PATH:-}" ]; then
        if command -v chromium >/dev/null 2>&1; then
            export BROWSER_EXECUTABLE_PATH="$(command -v chromium)"
        elif command -v chromium-browser >/dev/null 2>&1; then
            export BROWSER_EXECUTABLE_PATH="$(command -v chromium-browser)"
        elif command -v google-chrome >/dev/null 2>&1; then
            export BROWSER_EXECUTABLE_PATH="$(command -v google-chrome)"
        fi
    fi

    if [ -n "${BROWSER_EXECUTABLE_PATH:-}" ] && [ -x "$BROWSER_EXECUTABLE_PATH" ]; then
        return
    fi

    if command -v apt-get >/dev/null 2>&1; then
        echo "Installing Chromium runtime for headless browser search"
        apt-get update
        apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation
        rm -rf /var/lib/apt/lists/*

        if [ -z "${BROWSER_EXECUTABLE_PATH:-}" ] && command -v chromium >/dev/null 2>&1; then
            export BROWSER_EXECUTABLE_PATH="$(command -v chromium)"
        fi
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

# Copy src/ and package.json from code mount (always fresh copy)
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
elif [ -n "$WORKSPACE_PATH" ] && [ -d "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/src" ]; then
    echo "Copying source from workspace repos"
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
prepare_runtime_dependencies
ensure_browser_runtime

# Sync achillesAgentLib from ploinky workspace (same mechanism as ploinky syncCoreDependencies)
AGENTLIB_SRC=""
if [ -e "$APP_DIR/node_modules/achillesAgentLib" ]; then
    echo "achillesAgentLib available in runtime dependencies"
elif [ -d "/Agent/node_modules/achillesAgentLib" ]; then
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
elif [ ! -e "$APP_DIR/node_modules/achillesAgentLib" ]; then
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

export PORT="${PORT:-7000}"
export HOST="${HOST:-0.0.0.0}"
export DATA_DIR="$SHARED_DIR/data"
export CREDENTIALS_DIR="$SHARED_DIR/data/credentials"

echo "DATABASE_URL=${DATABASE_URL%%@*}@***"
echo "PORT=$PORT HOST=$HOST"

cd "$APP_DIR"
exec node src/index.mjs
