#!/bin/sh
set -eu

export ROBOTEAM_SERVICE_HOST="${ROBOTEAM_SERVICE_HOST:-0.0.0.0}"
export ROBOTEAM_SERVICE_PORT="${ROBOTEAM_SERVICE_PORT:-${PORT:-7000}}"
export ROBOTEAM_MCP_PORT="${ROBOTEAM_MCP_PORT:-7001}"

PORT="$ROBOTEAM_MCP_PORT" sh /Agent/server/AgentServer.sh &
MCP_PID="$!"

node /code/server/main.mjs &
SERVICE_PID="$!"

cleanup() {
    kill "$SERVICE_PID" "$MCP_PID" 2>/dev/null || true
    wait "$SERVICE_PID" 2>/dev/null || true
    wait "$MCP_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

attempt=0
while [ "$attempt" -lt 100 ]; do
    if node /code/scripts/check-service.mjs; then
        break
    fi
    if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
        echo "RoboTeam service exited during startup" >&2
        exit 1
    fi
    attempt=$((attempt + 1))
    sleep 0.1
done

if [ "$attempt" -ge 100 ]; then
    echo "RoboTeam service did not become ready" >&2
    exit 1
fi

wait "$SERVICE_PID"
