#!/bin/sh
# rwtarget non-management peer (proof slice P3). Stands in for the target's ordinary service: started by the launcher
# as uid/gid 65534 with empty capability sets and no_new_privs. At start it records, one line each, what it can reach
# of the management state (expected: denied), then idles. It never writes outside /tmp.
probe() {
    label=$1
    shift
    if output=$("$@" 2>&1); then
        printf 'peer-probe %s allowed %s\n' "$label" "$(printf '%s' "$output" | tr '\n' ' ' | cut -c1-200)"
    else
        printf 'peer-probe %s denied %s\n' "$label" "$(printf '%s' "$output" | tr '\n' ' ' | cut -c1-200)"
    fi
}

# Give the helper time to bind its mailbox.
sleep 2
printf 'peer-identity %s\n' "$(id)"
grep -E '^(Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Uid|Gid):' /proc/self/status | tr '\t' ' ' | sed 's/^/peer-status /'
probe mailbox-list ls -la /run/ploinky-target/mailbox
probe mailbox-socket-stat stat /run/ploinky-target/mailbox/helper.sock
probe mailbox-connect /usr/libexec/ploinky-target/rw-target-helper worker-peer --mailbox /run/ploinky-target/mailbox/helper.sock --probe
probe journal-list ls -la /run/ploinky-target/journal
probe journal-witness cat /run/ploinky-target/journal/journal/journal-store.json
probe control-list ls -la /run/ploinky-target/control
helper=$(pidof rw-target-helper | cut -d' ' -f1)
if [ -n "$helper" ]; then
    probe helper-root ls /proc/"$helper"/root/
    probe helper-fd ls /proc/"$helper"/fd
    probe helper-environ cat /proc/"$helper"/environ
else
    printf 'peer-probe helper-pid missing\n'
fi
if [ -n "${PLOINKY_WORKSPACE_ROOT:-}" ]; then
    probe workspace-controller-state ls -la "$PLOINKY_WORKSPACE_ROOT/.ploinky/data"
fi
printf 'peer-probes done\n'
exec sleep 2147483647
