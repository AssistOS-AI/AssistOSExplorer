#!/bin/sh
set -eu

GENERATED_DIR="/working-data/generated"
LIVEKIT_CONFIG="${GENERATED_DIR}/livekit.yaml"
EGRESS_CONFIG="${GENERATED_DIR}/egress.yaml"
EGRESS_RUNTIME_CONFIG="/run/ploinky/egress.yaml"
EGRESS_PID_FILE="/run/ploinky/egress.pid"
REDIS_CONFIG="${GENERATED_DIR}/redis.conf"
SUPERVISOR_SOCKET="/run/ploinky/livekit-supervisor.sock"
WAIT_FOR_TIMEOUT="${LIVEKIT_INFRA_WAIT_TIMEOUT:-45}"
EGRESS_CONTRACT="/usr/local/share/ploinky/livekit-egress-loopback.contract"
EGRESS_HOME="/home/egress"
# The runtime directory must live on a tmpfs. Under the container's
# fuse-overlayfs root, PulseAudio cannot apply the ownership and mode it wants
# to its native socket: the socket is left owned by root with mode 0755, so the
# unprivileged egress client is refused and `pactl info` never succeeds. The
# daemon itself starts correctly, which makes this look like a slow start
# rather than a permission fault. /dev/shm is the tmpfs available here, and
# PulseAudio already places its shared-memory segments there, so hosting the
# socket and pid file adds no meaningful space pressure.
#
# This path is fixed on purpose. prepare_egress_runtime removes it recursively
# as root, so a configurable value would turn startup cleanup into a deletion
# path for whatever it pointed at, including the durable /data mounts.
EGRESS_XDG_RUNTIME_DIR="/dev/shm/livekit-egress-xdgr"
PULSE_SERVER="unix:${EGRESS_XDG_RUNTIME_DIR}/pulse/native"

PIDS=""

log() {
  printf '[liveKitServerAgent] %s\n' "$1"
}

fail() {
  printf '[liveKitServerAgent] ERROR: %s\n' "$1" >&2
  exit 1
}

require_file() {
  [ -s "$1" ] || fail "missing generated file '$1'; attested runtime config generation must succeed first"
}

assert_egress_image_contract() {
  if [ ! -f "$EGRESS_CONTRACT" ] || [ -L "$EGRESS_CONTRACT" ]; then
    fail "LiveKit Egress v5 image contract marker is missing; publish the loopback-patched Egress image, rebuild the LiveKit image, and pin its verified index before activation"
  fi
  if [ "$(stat -c '%u:%g:%a' "$EGRESS_CONTRACT")" != '0:0:444' ]; then
    fail "LiveKit Egress v5 image contract marker ownership or mode is invalid"
  fi
  if [ "$(sed -n '1p' "$EGRESS_CONTRACT")" != 'contract_version=5' ] \
    || [ "$(sed -n '2p' "$EGRESS_CONTRACT")" != 'source_commit=ba52a026bea409bde31dcc7da9ba5322e967520c' ] \
    || [ "$(sed -n '3p' "$EGRESS_CONTRACT")" != 'health_listener=127.0.0.1:7981' ] \
    || [ "$(sed -n '4p' "$EGRESS_CONTRACT")" != 'template_listener=127.0.0.1:7980' ] \
    || [ "$(wc -l < "$EGRESS_CONTRACT")" -ne 5 ]; then
    fail "LiveKit Egress v5 image contract marker does not match the approved runtime contract"
  fi
  expected_egress_sha256="$(sed -n 's/^binary_sha256=//p' "$EGRESS_CONTRACT")"
  case "$expected_egress_sha256" in
    *[!0-9a-f]*|'') fail "LiveKit Egress v5 image contract contains an invalid binary digest" ;;
  esac
  if [ "${#expected_egress_sha256}" -ne 64 ]; then
    fail "LiveKit Egress v5 image contract contains an invalid binary digest"
  fi
  if ! printf '%s  %s\n' "$expected_egress_sha256" /usr/bin/egress | sha256sum --check --strict - >/dev/null 2>&1; then
    fail "LiveKit Egress binary digest does not match its v5 image contract"
  fi
  command -v pulseaudio >/dev/null 2>&1 || fail "LiveKit Egress image is missing PulseAudio"
  command -v setpriv >/dev/null 2>&1 || fail "LiveKit Egress image is missing setpriv"
  EGRESS_UID="$(id -u egress 2>/dev/null)" || fail "LiveKit Egress image is missing its unprivileged egress user"
  EGRESS_GID="$(id -g egress 2>/dev/null)" || fail "LiveKit Egress image is missing its unprivileged egress group"
  [ "$EGRESS_UID" -gt 0 ] || fail "LiveKit Egress user must be unprivileged"
}

run_as_egress() {
  setpriv \
    --reuid="$EGRESS_UID" \
    --regid="$EGRESS_GID" \
    --init-groups \
    env \
      HOME="$EGRESS_HOME" \
      XDG_RUNTIME_DIR="$EGRESS_XDG_RUNTIME_DIR" \
      "$@"
}

prepare_egress_runtime() {
  # Remove the runtime directory itself, not just its pulse child. It now sits
  # on a world-writable tmpfs, so another process could pre-create the path as
  # a symlink; deleting it first means install -d creates a real directory
  # instead of following that link when it applies egress ownership.
  rm -rf \
    /var/run/pulse \
    /var/lib/pulse \
    "$EGRESS_HOME/.config/pulse" \
    "$EGRESS_XDG_RUNTIME_DIR" \
    "$EGRESS_HOME/tmp/"*
  install -d -o "$EGRESS_UID" -g "$EGRESS_GID" -m 0700 \
    "$EGRESS_HOME/.config" \
    "$EGRESS_HOME/.config/pulse" \
    "$EGRESS_XDG_RUNTIME_DIR"
  chown "$EGRESS_UID:$EGRESS_GID" /data/recordings
  chmod 0750 /data/recordings
  install -o "$EGRESS_UID" -g "$EGRESS_GID" -m 0400 \
    "$EGRESS_CONFIG" \
    "$EGRESS_RUNTIME_CONFIG"
}

wait_for_pulse() {
  deadline=$(( $(date +%s) + WAIT_FOR_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # pulseaudio --check relies on process lookup that is unavailable in a
    # rootless container nested inside Ploinky Box. Prove readiness through
    # the exact private native socket Egress will use instead.
    if run_as_egress env PULSE_SERVER="$PULSE_SERVER" pactl info >/dev/null 2>&1; then
      log "PulseAudio is ready for unprivileged Egress recording"
      return 0
    fi
    sleep 1
  done
  fail "PulseAudio did not become ready for Egress within ${WAIT_FOR_TIMEOUT}s"
}

wait_for_tcp() {
  label="$1"
  host="$2"
  port="$3"
  deadline=$(( $(date +%s) + WAIT_FOR_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if nc -z -w 1 "$host" "$port" >/dev/null 2>&1; then
      log "$label is ready on $host:$port"
      return 0
    fi
    sleep 1
  done
  fail "$label did not become ready on $host:$port within ${WAIT_FOR_TIMEOUT}s"
}

wait_for_udp_owner() {
  deadline=$(( $(date +%s) + WAIT_FOR_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ss -H -lunp 2>/dev/null | awk '$4 ~ /:7882$/ && /livekit-server/ { found=1 } END { exit(found ? 0 : 1) }'; then
      log "livekit-server owns the fixed UDP mux on 0.0.0.0:7882"
      return 0
    fi
    sleep 1
  done
  fail "livekit-server did not acquire the fixed UDP mux 7882/udp"
}

assert_forbidden_listeners_absent() {
  if ss -H -lnt 2>/dev/null | awk '$4 ~ /:(80|443|3478|5349|7881)$/ { found=1 } END { exit(found ? 0 : 1) }'; then
    fail "a forbidden TCP listener (80, 443, 3478, 5349, or 7881) is active"
  fi
  if ss -H -lun 2>/dev/null | awk '$4 ~ /:(3478|5349|7883|7884|7885|7886|7887|7888|7889|7890|7891|7892)$/ { found=1 } END { exit(found ? 0 : 1) }'; then
    fail "a forbidden local TURN or LiveKit UDP-range listener is active"
  fi
}

assert_egress_listener() {
  label="$1"
  port="$2"
  if ! ss -H -lnt 2>/dev/null | awk -v port=":${port}$" '
    $4 ~ port && ($4 ~ /^127\.0\.0\.1:/ || $4 ~ /^\[::1\]:/) { found=1 }
    END { exit(found ? 0 : 1) }
  '; then
    fail "$label must be bound to loopback on TCP $port"
  fi
  if ss -H -lnt 2>/dev/null | awk -v port=":${port}$" '
    $4 ~ port && !($4 ~ /^127\.0\.0\.1:/ || $4 ~ /^\[::1\]:/) { found=1 }
    END { exit(found ? 0 : 1) }
  '; then
    fail "$label has a non-loopback TCP $port listener"
  fi
}

assert_egress_process_identity() {
  [ -s "$EGRESS_PID_FILE" ] || fail "Egress pid file is missing"
  pid="$(cat "$EGRESS_PID_FILE")"
  [ "$pid" = "$EGRESS_PID" ] || fail "Egress pid file does not match the supervised process"
  case "$pid" in
    *[!0-9]*|'') fail "Egress pid file is invalid" ;;
  esac
  kill -0 "$pid" 2>/dev/null \
    || fail "supervised Egress process is not running"
  for port in 7980 7981; do
    ss -H -lntpe 2>/dev/null | awk -v port=":${port}$" -v uid="$EGRESS_UID" '
      $4 ~ port && index($0, "uid:" uid) { found=1 }
      END { exit(found ? 0 : 1) }
    ' || fail "supervised Egress listener TCP ${port} is not owned by the unprivileged egress user"
  done
}

shutdown_children() {
  log "stopping supervised services"
  for pid in $PIDS; do
    [ -n "$pid" ] || continue
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $PIDS; do
    [ -n "$pid" ] || continue
    kill -9 "$pid" 2>/dev/null || true
  done
}

assert_egress_image_contract
node /code/scripts/generate-config.mjs
require_file "$LIVEKIT_CONFIG"
require_file "$EGRESS_CONFIG"
require_file "$REDIS_CONFIG"
mkdir -p /data/redis /data/recordings /run/ploinky
rm -f "$SUPERVISOR_SOCKET" "$EGRESS_PID_FILE"
prepare_egress_runtime

trap 'shutdown_children; exit 0' INT TERM
trap 'rc=$?; shutdown_children; exit $rc' EXIT

log "starting loopback Redis"
redis-server "$REDIS_CONFIG" --dir /data/redis &
REDIS_PID=$!
PIDS="$PIDS $REDIS_PID"
wait_for_tcp redis 127.0.0.1 6379

log "starting loopback LiveKit signaling with one UDP mux"
livekit-server --config "$LIVEKIT_CONFIG" &
LIVEKIT_PID=$!
PIDS="$PIDS $LIVEKIT_PID"
wait_for_tcp livekit 127.0.0.1 7880
wait_for_udp_owner
assert_forbidden_listeners_absent

log "starting unprivileged PulseAudio for LiveKit Egress"
setpriv \
  --reuid="$EGRESS_UID" \
  --regid="$EGRESS_GID" \
  --init-groups \
  env \
    HOME="$EGRESS_HOME" \
    XDG_RUNTIME_DIR="$EGRESS_XDG_RUNTIME_DIR" \
  pulseaudio \
  --daemonize=no \
  --verbose \
  --exit-idle-time=-1 \
  --disallow-exit &
PULSE_PID=$!
PIDS="$PIDS $PULSE_PID"
wait_for_pulse

log "starting LiveKit Egress (template 7980, health 7981)"
setpriv \
  --reuid="$EGRESS_UID" \
  --regid="$EGRESS_GID" \
  --init-groups \
  env \
    HOME="$EGRESS_HOME" \
    XDG_RUNTIME_DIR="$EGRESS_XDG_RUNTIME_DIR" \
    PULSE_SERVER="$PULSE_SERVER" \
    EGRESS_CONFIG_FILE="$EGRESS_RUNTIME_CONFIG" \
  egress &
EGRESS_PID=$!
PIDS="$PIDS $EGRESS_PID"
printf '%s\n' "$EGRESS_PID" > "$EGRESS_PID_FILE"
chmod 0444 "$EGRESS_PID_FILE"
wait_for_tcp egress-template 127.0.0.1 7980
wait_for_tcp egress-health 127.0.0.1 7981
assert_egress_process_identity
assert_egress_listener egress-template 7980
assert_egress_listener egress-health 7981
node /code/scripts/health/egress-semantic-health.mjs

log "starting private supervisor health endpoints"
SUPERVISED_PIDS="$REDIS_PID,$LIVEKIT_PID,$PULSE_PID,$EGRESS_PID" \
SUPERVISOR_SOCKET="$SUPERVISOR_SOCKET" \
node /code/scripts/health/supervisor-health.mjs &
HEALTH_PID=$!
PIDS="$PIDS $HEALTH_PID"
wait_for_tcp supervisor-health 127.0.0.1 17000

sh /code/scripts/health/livekit-server-agent-health.sh
log "all required services are ready"

while true; do
  for pid in "$REDIS_PID" "$LIVEKIT_PID" "$PULSE_PID" "$EGRESS_PID" "$HEALTH_PID"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      fail "supervised service pid $pid exited"
    fi
  done
  sleep 5
done
