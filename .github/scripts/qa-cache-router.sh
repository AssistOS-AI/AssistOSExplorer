#!/usr/bin/env bash
# Run on the Actions runner after verifying the host key and pinned Node runtime.
set +x
set -euo pipefail
export -n EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN
phase="${1:?Expected pre or post}"
t9="${QA_CACHE_FORCE_PROBE_FAILURE:-false}"
if ! [[ "$phase" =~ ^(pre|post)$ && "$t9" =~ ^(false|true)$ &&
    "$PUBLIC_HOST" == explorer-qa.axiologic.dev && "$ROUTER_PORT" == 8097 &&
    "$SSH_USER" == admin && "$SSH_HOST" == 45.136.70.141 && "$WORKSPACE" == explorerQaWorkspace &&
    "$QA_NODE_HOME" =~ ^/home/admin/\.qa-deployment-tools/node-v24\.19\.0-linux-(x64|arm64)$ &&
    "$CLOUDFLARE_ZONE_ID" =~ ^[0-9a-fA-F]{32}$ ]]; then
    echo '::error::Invalid Explorer QA cache configuration.' >&2
    exit 1
fi

ssh_qa=(ssh -T -i "$HOME/.ssh/deploy_key" -o BatchMode=yes -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$HOME/.ssh/explorer_qa_known_hosts" -o ConnectTimeout=15
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 "$SSH_USER@$SSH_HOST")
lock='flock -n -E 75 --close /home/admin/.qa-deployment-operation.lock'
probe="$(dirname "${BASH_SOURCE[0]}")/qa-cache-origin.mjs"
origin_probe() {
    "${ssh_qa[@]}" "$lock '$QA_NODE_HOME/bin/node' --input-type=module - '$1' '$PUBLIC_HOST' '$ROUTER_PORT' '$t9' '${2:-}' '${3:-}'" < "$probe"
}
# Both deploy workflows reach the pre phase only after disabling R2.
cli_refused=42
purge_failure() {
    if [[ -n "${2:-}" && "$2" != "$cli_refused" ]]; then
        echo "::error::QA host lock, container execution or SSH refused the operation (exit $2)." >&2
        exit "$2"
    fi
    if [[ "$phase" == pre ]]; then
        echo "::warning::$1 Skipping the initial purge with R2 off." >&2
        exit 0
    fi
    echo "::error::$1" >&2
    exit 1
}
if [[ "$phase" == post ]]; then
    inspected="$(origin_probe identify)"
    [[ "$inspected" =~ ^[0-9a-f]{64}$ ]]
    fingerprint="$(node "$probe" "$GITHUB_WORKSPACE/.qa-bizanso-source/bizanso")"
    [[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]]
    nested="$lock podman exec -i --user podman '$inspected' podman"
    application="$("${ssh_qa[@]}" "$nested ps --quiet --no-trunc --filter 'name=^ploinky_bizanso_bizanso_'" < /dev/null)"
    [[ "$application" =~ ^[0-9a-f]{64}$ ]]
    release="$("${ssh_qa[@]}" "$nested exec -i '$application' node --input-type=module - running '$fingerprint'" < "$probe")"
    [[ "$release" =~ ^[0-9a-f]{24}$ ]]
    result="$(origin_probe post "$release" "$inspected")"
else
    result="$(origin_probe pre)"
fi
if [[ "$phase" == pre && "$result" == absent ]]; then
    echo '::warning::No running QA Box. Skipping the initial purge with R2 off.'
    exit 0
fi
if ! [[ "$result" =~ ^(legacy|unverified|supported|verified)\ ([a-f0-9]{64})$ ]]; then
    echo '::error::Invalid QA origin probe result.' >&2
    exit 1
fi
feature="${BASH_REMATCH[1]}"
box_id="${BASH_REMATCH[2]}"
case "$phase:$feature" in
    pre:unverified) purge_failure 'Could not verify the existing QA origin.' ;;
    pre:supported|post:verified|*:legacy) ;;
    *) echo '::error::Incomplete QA origin probe.' >&2; exit 1 ;;
esac

# Address the inspected container by its immutable ID. A stopped or replaced Box
# cannot receive a secret or cause the host launcher to create a different Box.
# Plain podman exec does not inherit the Box's physical Router host port, which the
# host launcher normally passes; without it the in-Box CLI assumes 8080 and refuses
# the active generation compiled for QA's port. QA keeps the default media port.
ploinky_locked() {
    # Normalize CLI refusals inside the container. Outer lock, Podman and SSH
    # failures keep their original statuses even when a CLI uses the same codes.
    local command='ploinky "$@" || exit '"$cli_refused"
    "${ssh_qa[@]}" "$lock podman container exec -i --user podman --workdir '/home/admin/$WORKSPACE' --env 'PLOINKY_WORKSPACE_ROOT=/home/admin/$WORKSPACE' --env 'PLOINKY_ROUTER_HOST_PORT=$ROUTER_PORT' '$box_id' sh -c '$command' sh $*"
}
if [[ "$feature" == legacy ]]; then
    echo '::warning::The QA Router omitted the CDN header on /docs. Skipping this purge and keeping R2 off.'
    if [[ "$phase" == post ]]; then echo 'verified=false' >> "$GITHUB_OUTPUT"; fi
    exit 0
fi

# A Router can have the S2 header policy before it gains S3's protected
# publication handles. Verify that this Box advertises the purge command first.
help="$(ploinky_locked help < /dev/null)" || purge_failure 'Could not check QA purge command support.' "$?"
if [[ "$help" != *'cache purge-config'* ]]; then
    purge_failure 'The QA Box needs Ploinky cache purge-config and protected publication handles.'
fi
if [[ -z "${EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN:-}" ]]; then
    purge_failure 'The QA purge credential is missing.'
fi
printf '%s' "$EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN" | ploinky_locked var publication/explorer-qa-purge --stdin >/dev/null 2>&1 ||
    purge_failure 'Failed to store the QA purge credential.' "$?"
unset EXPLORER_QA_CLOUDFLARE_PURGE_TOKEN
if [[ "$phase" == post ]]; then
    echo "Verified the QA Router's Bizanso release $release and CDN headers on port $ROUTER_PORT."
fi
ploinky_locked cache purge-config --host "$PUBLIC_HOST" --zone "$CLOUDFLARE_ZONE_ID" --secret publication/explorer-qa-purge < /dev/null ||
    purge_failure 'Failed to configure the QA purge.' "$?"
ploinky_locked cache clear --host "$PUBLIC_HOST" < /dev/null ||
    purge_failure 'The QA Router did not accept the purge.' "$?"
echo "QA Router accepted the $phase-deploy purge for $PUBLIC_HOST."
if [[ "$phase" == post ]]; then echo 'verified=true' >> "$GITHUB_OUTPUT"; fi
