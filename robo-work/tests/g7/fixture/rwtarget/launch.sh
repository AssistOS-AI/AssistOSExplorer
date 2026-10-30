#!/bin/sh
# rwtarget management launcher (proof slices P3, P6b; helper-ticket-secret spec). Runs as container root, the main
# command under Ploinky's AgentEntrypoint. It consumes the single-use helper launch record that Ploinky provisioned in
# the control directory (so a restarted container can never present the same helper incarnation again), starts the
# target helper, and starts the distinct non-management peer under uid/gid 65534 with no capabilities and no_new_privs.
# The per-incarnation ticket secret (control/helper-secret) is never read here: only its path is passed, and the helper
# reads and unlinks the file itself. Every exit path removes it, so a refused or stopped start never leaves it behind.
set -eu

CONTROL=/run/ploinky-target/control
LAUNCH="$CONTROL/helper-launch"
SECRET="$CONTROL/helper-secret"
# Whatever path the launcher leaves by, the secret file does not outlive it (the explicit removals below stay).
trap 'rm -f -- "$SECRET"' EXIT
HELPER=/usr/libexec/ploinky-target/rw-target-helper
PEER=/usr/libexec/ploinky-target/peer

fail() {
    rm -f -- "$SECRET"
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

# Proof-fixture session (slice P6b): the helper must be the `proof-fixture` build. It consumes the ticket secret before it
# opens the journal (refusal: exit 78), then serves the A11 session handshake with the public fixture ticket key, because
# Ploinky has no Router mint route yet and the fixture worker minter holds only that key, and the fixture launcher,
# which launches no keeper (keeper launch through the helper is slice P8).
"$HELPER" serve --mailbox /run/ploinky-target/mailbox/helper.sock --journal-root /run/ploinky-target/journal \
    --store-identity "$store" --helper-incarnation "$incarnation" --secret-file "$SECRET" \
    --proof-fixture-session --proof-fixture-keeper &
helper=$!
/bin/setpriv --reuid=65534 --regid=65534 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all \
    --no-new-privs -- "$PEER" &
peer=$!

trap 'kill -TERM "$helper" "$peer" 2>/dev/null || true' TERM INT
set +e
wait "$helper"
status=$?
rm -f -- "$SECRET"
kill -TERM "$peer" 2>/dev/null
wait "$peer" 2>/dev/null
exit "$status"
