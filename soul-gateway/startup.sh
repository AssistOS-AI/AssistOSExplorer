#!/bin/bash
set -e

IMAGE_APP_DIR="${SOUL_GATEWAY_IMAGE_APP_DIR:-/opt/soul-gateway}"
CODE_DIR="${CODE_DIR:-/code}"
APP_DIR="${APP_DIR:-/app}"
DATA_DIR="${DATA_DIR:-/data}"
CREDENTIALS_DIR="${CREDENTIALS_DIR:-$DATA_DIR/credentials}"
SQLITE_PATH="${SQLITE_PATH:-$DATA_DIR/soul-gateway.sqlite3}"

echo "=== Soul Gateway: Starting ==="

# Ensure durable + app directories exist
mkdir -p "$DATA_DIR" "$CREDENTIALS_DIR" "$APP_DIR"

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
    for candidate in "$IMAGE_APP_DIR/node_modules" /code/node_modules /Agent/node_modules; do
        if [ -d "$candidate" ]; then
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

copy_source_tree() {
    source_dir="$1"
    label="$2"
    echo "$label"
    rm -rf "$APP_DIR/src"
    cp -r "$source_dir/src" "$APP_DIR/src"
    cp -f "$source_dir/package.json" "$APP_DIR/package.json"
    if [ -f "$source_dir/package-lock.json" ]; then
        cp -f "$source_dir/package-lock.json" "$APP_DIR/package-lock.json"
    else
        rm -f "$APP_DIR/package-lock.json"
    fi
}

# Production runs the source baked into the image. Live source mounts remain
# available for development by setting SOUL_GATEWAY_USE_LIVE_SOURCE=1, or as a
# fallback when running from a base image without baked source.
USE_LIVE_SOURCE="${SOUL_GATEWAY_USE_LIVE_SOURCE:-0}"
if [ -d "$IMAGE_APP_DIR/src" ] && [ "$USE_LIVE_SOURCE" != "1" ]; then
    copy_source_tree "$IMAGE_APP_DIR" "Using baked source from $IMAGE_APP_DIR/src/"
elif [ -d "$CODE_DIR/src" ]; then
    copy_source_tree "$CODE_DIR" "Copying source from $CODE_DIR/src/"
elif [ -n "$WORKSPACE_PATH" ] && [ -d "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway/src" ]; then
    copy_source_tree "$WORKSPACE_PATH/.ploinky/repos/proxies/soul-gateway" "Copying source from workspace repos"
elif [ -d "$IMAGE_APP_DIR/src" ]; then
    copy_source_tree "$IMAGE_APP_DIR" "Using baked source from $IMAGE_APP_DIR/src/"
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

export DATA_DIR
export CREDENTIALS_DIR
export SQLITE_PATH
export PORT="${PORT:-7000}"
export HOST="${HOST:-0.0.0.0}"

echo "SQLITE_PATH=$SQLITE_PATH"
echo "PORT=$PORT HOST=$HOST"

cd "$APP_DIR"
exec node src/index.mjs
