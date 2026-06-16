#!/bin/bash
set -e

CODE_DIR="${CODE_DIR:-/code}"
DATA_DIR="${DATA_DIR:-/data}"
CREDENTIALS_DIR="${CREDENTIALS_DIR:-$DATA_DIR/credentials}"
SQLITE_PATH="${SQLITE_PATH:-$DATA_DIR/soul-gateway.sqlite3}"
AGENT_NODE_MODULES_DIR="${AGENT_NODE_MODULES_DIR:-/Agent/node_modules}"

echo "=== Soul Gateway: Starting ==="

mkdir -p "$DATA_DIR" "$CREDENTIALS_DIR"

if [ ! -d "$CODE_DIR/src" ]; then
    echo "ERROR: Soul Gateway source not found at $CODE_DIR/src. Start this service as a Ploinky agent with the repository mounted at /code." >&2
    exit 1
fi

echo "Using mounted source from $CODE_DIR/src/"

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
    if [ -d "$CODE_DIR/node_modules" ]; then
        echo "Using prepared runtime dependencies from $CODE_DIR/node_modules"
        return
    fi

    if [ -d "$AGENT_NODE_MODULES_DIR" ]; then
        ln -s "$AGENT_NODE_MODULES_DIR" "$CODE_DIR/node_modules"
        echo "Linked prepared runtime dependencies from $AGENT_NODE_MODULES_DIR to $CODE_DIR/node_modules"
        return
    fi

    if [ ! -f "$CODE_DIR/package.json" ]; then
        echo "ERROR: package.json not found at $CODE_DIR/package.json" >&2
        exit 1
    fi

    cd "$CODE_DIR"
    if [ -f "$CODE_DIR/package-lock.json" ]; then
        env NODE_OPTIONS= npm ci --omit=dev
    else
        env NODE_OPTIONS= npm install --omit=dev --no-package-lock
    fi
}

# Install runtime deps and let npm failures stop container startup.
prepare_runtime_dependencies
ensure_browser_runtime

export DATA_DIR
export CREDENTIALS_DIR
export SQLITE_PATH
export PORT="${PORT:-7000}"
export HOST="${HOST:-0.0.0.0}"

echo "SQLITE_PATH=$SQLITE_PATH"
echo "PORT=$PORT HOST=$HOST"

cd "$CODE_DIR"
exec node src/index.mjs
