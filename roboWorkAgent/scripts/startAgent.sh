#!/bin/sh
set -eu

# Re-establish disposable storage after a container restart, before Podman use.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/roboteam-podman-xdg}"
mkdir -p -m 700 -- "$XDG_RUNTIME_DIR"
if [ -L "$XDG_RUNTIME_DIR" ] || [ ! -d "$XDG_RUNTIME_DIR" ] || [ ! -O "$XDG_RUNTIME_DIR" ]; then
    echo 'Unsafe Podman runtime directory' >&2
    exit 1
fi
chmod 700 "$XDG_RUNTIME_DIR"
roboteam-podman-init

# Fresh per launch, shared only by AgentServer callbacks and the HTTP service.
ROBOWORK_INTERNAL_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
export ROBOWORK_INTERNAL_TOKEN

export ROBOWORK_SERVICE_HOST="${ROBOWORK_SERVICE_HOST:-0.0.0.0}"
export ROBOWORK_SERVICE_PORT="${ROBOWORK_SERVICE_PORT:-3001}"
export ROBOWORK_MCP_PORT="${ROBOWORK_MCP_PORT:-${PORT:-7000}}"

agent_server_script="${ROBOWORK_AGENT_SERVER_SCRIPT:-/Agent/server/AgentServer.sh}"
service_main="${ROBOWORK_SERVICE_MAIN:-/code/server/main.mjs}"
service_check="${ROBOWORK_SERVICE_CHECK:-/code/scripts/check-service.mjs}"

PORT="$ROBOWORK_MCP_PORT" sh "$agent_server_script" &
MCP_PID="$!"

node "$service_main" &
SERVICE_PID="$!"

cleanup() {
    kill "$SERVICE_PID" "$MCP_PID" 2>/dev/null || true
    wait "$SERVICE_PID" 2>/dev/null || true
    wait "$MCP_PID" 2>/dev/null || true
}

# Ploinky's targeted restart sends TERM and accepts only exit 0 as the
# acknowledgement that the drain completed. Forward one TERM to each child,
# wait for both, and exit 0 only when both shut down cleanly; otherwise exit
# with the first non-zero status, the service's before AgentServer's. The
# trap is installed only after both PIDs are recorded, so an earlier TERM
# keeps the default signal status and fails the drain.
drain() {
    set +e
    trap '' HUP INT TERM
    echo "RoboWork received TERM; stopping service and AgentServer" >&2
    kill -TERM "$SERVICE_PID" "$MCP_PID" 2>/dev/null
    drain_status=0
    for child_pid in "$SERVICE_PID" "$MCP_PID"; do
        wait "$child_pid"
        child_status="$?"
        if [ "$drain_status" -eq 0 ]; then
            drain_status="$child_status"
        fi
    done
    if [ "$drain_status" -ne 0 ]; then
        echo "RoboWork drain failed with status $drain_status" >&2
    fi
    # Both children are reaped; cleanup must not signal their recycled PIDs.
    trap - EXIT
    exit "$drain_status"
}
trap 'exit 130' INT
trap drain TERM
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
        echo "RoboWork service exited during startup" >&2
        child_exit_status "$SERVICE_PID"
    fi
    if ! kill -0 "$MCP_PID" 2>/dev/null; then
        echo "RoboWork AgentServer exited during startup" >&2
        child_exit_status "$MCP_PID"
    fi
    attempt=$((attempt + 1))
    sleep 0.1
done

if [ "$attempt" -ge 100 ]; then
    echo "RoboWork service did not become ready" >&2
    exit 1
fi

while :; do
    if ! kill -0 "$SERVICE_PID" 2>/dev/null; then
        echo "RoboWork service exited; stopping AgentServer" >&2
        child_exit_status "$SERVICE_PID"
    fi
    if ! kill -0 "$MCP_PID" 2>/dev/null; then
        echo "RoboWork AgentServer exited; stopping service" >&2
        child_exit_status "$MCP_PID"
    fi
    sleep 0.1
done
