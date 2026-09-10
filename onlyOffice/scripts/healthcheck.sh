#!/usr/bin/env bash
set -euo pipefail

curl -fsS --max-time 2 http://127.0.0.1:80/web-apps/apps/api/documents/api.js >/dev/null
bootstrap_nonce="$(/usr/local/bin/node /code/scripts/document-server-bootstrap.mjs verify)"
# The sentinel preserves trailing newlines through command substitution.
docservice_health="$(curl --noproxy '*' -fsS --connect-timeout 1 --max-time 2 http://127.0.0.1:80/healthcheck && printf '.')"
[ "$docservice_health" = 'true.' ]
curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:7000/__ready | grep -qx '404'
curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:9100/__ready | grep -qx '404'
/usr/local/bin/node /code/scripts/verify-document-server-jwt-config.mjs

assert_loopback_owner() {
  label="$1"
  port="$2"
  owner_pattern="$3"
  required="${4:-true}"
  listeners="$(ss -H -lntpe "sport = :${port}" 2>/dev/null || true)"

  if [ -z "$listeners" ]; then
    if [ "$required" = true ]; then
      echo "$label listener ${port}/tcp is absent." >&2
      exit 1
    fi
    return 0
  fi
  if printf '%s\n' "$listeners" | awk '$4 !~ /^127\.0\.0\.1:/ && $4 !~ /^\[::1\]:/ { bad=1 } END { exit(bad ? 0 : 1) }'; then
    echo "$label listener ${port}/tcp is not process-local: $listeners" >&2
    exit 1
  fi

  # Rootless nested Podman intentionally hides cross-user /proc fd links, so
  # ss may omit users:(...) even for uid 0 in the inner container. Prefer the
  # exact process name when available; otherwise bind the socket's kernel UID
  # to the UID of a process with the expected comm name.
  if ! printf '%s\n' "$listeners" | grep -Eq "users:\(\(\"(${owner_pattern})\""; then
    listener_uids="$(printf '%s\n' "$listeners" | sed -n 's/.* uid:\([0-9][0-9]*\) .*/\1/p' | sort -u)"
    expected_uids="$(
      for comm_path in /proc/[0-9]*/comm; do
        [ -r "$comm_path" ] || continue
        if grep -Eq "^(${owner_pattern})$" "$comm_path"; then
          awk '/^Uid:/{print $2}' "${comm_path%/comm}/status"
        fi
      done | sort -u
    )"
    if [ -z "$listener_uids" ] || [ -z "$expected_uids" ]; then
      echo "$label listener ${port}/tcp has an unverifiable socket owner: $listeners" >&2
      exit 1
    fi
    while IFS= read -r listener_uid; do
      if ! printf '%s\n' "$expected_uids" | grep -qx "$listener_uid"; then
        echo "$label listener ${port}/tcp has an unexpected socket owner: $listeners" >&2
        exit 1
      fi
    done <<EOF
$listener_uids
EOF
  fi
}

assert_no_wildcard_support_listener() {
  label="$1"
  port="$2"
  listeners="$(ss -H -lntp "sport = :${port}" 2>/dev/null || true)"
  if [ -n "$listeners" ] && printf '%s\n' "$listeners" | awk '$4 !~ /^127\.0\.0\.1:/ && $4 !~ /^\[::1\]:/ { bad=1 } END { exit(bad ? 0 : 1) }'; then
    echo "$label ${port}/tcp is wildcard-bound by the pinned DocumentServer package; no supported bind-host setting exists, so v5 route activation is blocked: $listeners" >&2
    exit 1
  fi
}

assert_exact_docservice_listener() {
  listeners="$(ss -H -lnt "sport = :8000" 2>/dev/null || true)"
  if [ "$(printf '%s\n' "$listeners" | sed '/^[[:space:]]*$/d' | wc -l)" -ne 1 ] \
    || ! printf '%s\n' "$listeners" | awk '$4 == "[::1]:8000" { exact=1 } END { exit(exact ? 0 : 1) }'; then
    echo "OnlyOffice DocService must expose exactly [::1]:8000 for its pinned nginx upstream: $listeners" >&2
    exit 1
  fi
}

for port in 7000 8080 9100; do
  ss -H -lnt "sport = :${port}" | grep -q . || {
    echo "OnlyOffice listener ${port}/tcp is absent." >&2
    exit 1
  }
done

for port in 7000 8080; do
  ss -H -lnt "sport = :${port}" | grep -Eq '0\.0\.0\.0|\*|::' || {
    echo "OnlyOffice routed listener ${port}/tcp is not reachable from its managed target." >&2
    exit 1
  }
done

ss -H -lnt "sport = :9100" | grep -Eq '127\.0\.0\.1|\[::1\]' || {
  echo 'OnlyOffice storage/callback listener must be loopback-only.' >&2
  exit 1
}

assert_loopback_owner 'OnlyOffice nginx transport' 80 nginx
assert_loopback_owner 'OnlyOffice PostgreSQL' 5432 postgres
assert_loopback_owner 'OnlyOffice RabbitMQ AMQP' 5672 'beam\.smp'
assert_loopback_owner 'OnlyOffice Erlang port mapper' 4369 epmd
assert_loopback_owner 'OnlyOffice RabbitMQ distribution' 25672 'beam\.smp'
assert_loopback_owner 'OnlyOffice Redis' 6379 redis-server false

# DocumentServer 9.3.1's embedded DocService binary exposes no supported bind
# host setting. The pinned, exact-port build-time interposer forces its IPv6
# wildcard port 8000 bind onto process loopback, and nginx must use that exact
# address rather than resolving localhost to IPv4.
/usr/local/bin/node /code/scripts/configure-docservice-nginx-loopback.mjs --verify-runtime
assert_exact_docservice_listener
assert_loopback_owner 'OnlyOffice DocService' 8000 docservice
assert_no_wildcard_support_listener 'OnlyOffice AdminPanel' 9000

# Recheck after the listener/configuration probes so an overlapping restart
# cannot reuse the completion observed at the beginning of this readiness run.
/usr/local/bin/node /code/scripts/document-server-bootstrap.mjs verify "$bootstrap_nonce" >/dev/null
