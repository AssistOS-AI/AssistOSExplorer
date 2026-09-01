#!/bin/sh
set -eu

export ROBOTEAM_SERVICE_HOST="${ROBOTEAM_SERVICE_HOST:-0.0.0.0}"
export ROBOTEAM_SERVICE_PORT="${ROBOTEAM_SERVICE_PORT:-3001}"
export ROBOTEAM_MCP_PORT="${ROBOTEAM_MCP_PORT:-${PORT:-7000}}"

agent_server_script="${ROBOTEAM_AGENT_SERVER_SCRIPT:-/Agent/server/AgentServer.sh}"
service_main="${ROBOTEAM_SERVICE_MAIN:-/code/server/main.mjs}"
service_check="${ROBOTEAM_SERVICE_CHECK:-/code/scripts/check-service.mjs}"

PORT="$ROBOTEAM_MCP_PORT" sh "$agent_server_script" &
MCP_PID="$!"

node "$service_main" &
SERVICE_PID="$!"

cleanup() {
    kill "$SERVICE_PID" "$MCP_PID" 2>/dev/null || true
    wait "$SERVICE_PID" 2>/dev/null || true
    wait "$MCP_PID" 2>/dev/null || true
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

child_exit_status() {
    child_pid="$1"
    set +e
    wait "$child_pid"
    child_status="$?"
    set -e
    if [ "$child_status" -eq 0 ]; then
        child_status=1
    fi
    return "$child_status"
}

attempt=0
while [ "$attempt" -lt 100 ]; do
    if node "$service_check"; then
        break
    fi
    if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
        echo "RoboTeam service exited during startup" >&2
        child_exit_status "$SERVICE_PID"
    fi
    if ! kill -0 "$MCP_PID" 2>/dev/null; then
        echo "RoboTeam AgentServer exited during startup" >&2
        child_exit_status "$MCP_PID"
    fi
    attempt=$((attempt + 1))
    sleep 0.1
done

if [ "$attempt" -ge 100 ]; then
    echo "RoboTeam service did not become ready" >&2
    exit 1
fi

while :; do
    if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
        echo "RoboTeam service exited; stopping AgentServer" >&2
        child_exit_status "$SERVICE_PID"
    fi
    if ! kill -0 "$MCP_PID" 2>/dev/null; then
        echo "RoboTeam AgentServer exited; stopping service" >&2
        child_exit_status "$MCP_PID"
    fi
    sleep 0.1
done
