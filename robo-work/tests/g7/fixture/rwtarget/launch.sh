#!/bin/sh
# rwtarget management launcher (proof slices P3, P6b). Runs as container root, the main command under Ploinky's
# AgentEntrypoint. It consumes the single-use helper launch record that Ploinky provisioned in the control directory
# (so a restarted container can never present the same helper incarnation again), starts the target helper, and
# starts the distinct non-management peer under uid/gid 65534 with no capabilities and no_new_privs.
set -eu

CONTROL=/run/ploinky-target/control
LAUNCH="$CONTROL/helper-launch"
HELPER=/usr/libexec/ploinky-target/rw-target-helper
PEER=/usr/libexec/ploinky-target/peer

fail() {
    printf 'rwtarget launcher: %s\n' "$*" >&2
    exit 78
}

[ -f "$LAUNCH" ] && [ ! -L "$LAUNCH" ] || fail 'helper launch record is absent (not provisioned, or already consumed)'
version='' store='' incarnation=''
while IFS='=' read -r key value; do
    case "$key" in
        version) version=$value ;;
        journalStoreIdentity) store=$value ;;
        helperIncarnation) incarnation=$value ;;
        *) fail 'helper launch record has an unexpected field' ;;
    esac
done < "$LAUNCH"
rm -f -- "$LAUNCH"
[ ! -e "$LAUNCH" ] || fail 'helper launch record could not be consumed'
[ "$version" = 1 ] || fail 'helper launch record version is unsupported'
case "$store$incarnation" in
    *[!A-Za-z0-9_-]*) fail 'helper launch record has a malformed identity' ;;
esac
[ "${#store}" -eq 22 ] && [ "${#incarnation}" -eq 22 ] || fail 'helper launch record has a malformed identity'

# Proof-fixture session (slice P6b): the helper must be the `proof-fixture` build. It serves the A11 session handshake with
# the public fixture ticket key and the fixture launcher, which launches no keeper (P6b does not use keeper launch).
"$HELPER" serve --mailbox /run/ploinky-target/mailbox/helper.sock --journal-root /run/ploinky-target/journal \
    --store-identity "$store" --helper-incarnation "$incarnation" --proof-fixture-session --proof-fixture-keeper &
helper=$!
/bin/setpriv --reuid=65534 --regid=65534 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
    --no-new-privs -- "$PEER" &
peer=$!

trap 'kill -TERM "$helper" "$peer" 2>/dev/null || true' TERM INT
set +e
wait "$helper"
status=$?
kill -TERM "$peer" 2>/dev/null
wait "$peer" 2>/dev/null
exit "$status"
