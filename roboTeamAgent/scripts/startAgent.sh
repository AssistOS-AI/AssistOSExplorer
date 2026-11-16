#!/bin/sh
set -eu

# Required source mounts must be usable before either readiness surface opens.
required_skills_check="${ROBOTEAM_REQUIRED_SKILLS_CHECK:-/code/scripts/check-required-skills.mjs}"
node "$required_skills_check"

# Fresh per launch, shared only by AgentServer callbacks and the HTTP service.
ROBOTEAM_INTERNAL_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
export ROBOTEAM_INTERNAL_TOKEN

export ROBOTEAM_SERVICE_HOST="${ROBOTEAM_SERVICE_HOST:-0.0.0.0}"
export ROBOTEAM_SERVICE_PORT="${ROBOTEAM_SERVICE_PORT:-3001}"
export ROBOTEAM_MCP_PORT="${ROBOTEAM_MCP_PORT:-${PORT:-7000}}"

agent_server_script="${ROBOTEAM_AGENT_SERVER_SCRIPT:-/Agent/server/AgentServer.sh}"
service_main="${ROBOTEAM_SERVICE_MAIN:-/code/server/main.mjs}"
service_check="${ROBOTEAM_SERVICE_CHECK:-/code/scripts/check-service.mjs}"

# The service prepares every robot through RoboWork before it listens, about half a second per robot, so the wait
# for it cannot be a fixed few seconds: a workspace with many robots would never start. Both children are watched
# during the wait, so a service that dies still fails the container at once; the limit only ends a start that hangs.
# A leading zero would be read as octal and a very long value would overflow, so both are refused here, before
# either child starts.
startup_wait_seconds="${ROBOTEAM_STARTUP_WAIT_SECONDS:-600}"
case "$startup_wait_seconds" in
    ''|*[!0-9]*|0*|???????*)
        echo "ROBOTEAM_STARTUP_WAIT_SECONDS must be a whole number of seconds from 1 to 999999, without a leading zero" >&2
        exit 1 ;;
esac

PORT="$ROBOTEAM_MCP_PORT" sh "$agent_server_script" &
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
    echo "RoboTeam received TERM; stopping service and AgentServer" >&2
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
        echo "RoboTeam drain failed with status $drain_status" >&2
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

service_ready=0
startup_deadline=$(($(date +%s) + startup_wait_seconds))
while [ "$(date +%s)" -lt "$startup_deadline" ]; do
    if node "$service_check"; then
        service_ready=1
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
    sleep 0.1
done

if [ "$service_ready" -ne 1 ]; then
    echo "RoboTeam service did not become ready within ${startup_wait_seconds} seconds" >&2
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
