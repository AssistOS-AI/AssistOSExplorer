#!/bin/bash
# P0a capability survey. Runs as container-root inside the fixture agent container
# (same grant set as RoboTeam: nestedPodman only). It measures which confinement
# mechanisms work here; it changes nothing outside /tmp/p0a.
set -u
out() { printf '%s\t%s\n' "$1" "$2"; }
try() { local name=$1; shift; local o; o=$("$@" 2>&1); local rc=$?; out "$name" "rc=$rc $(printf '%s' "$o" | tr '\n' '|' | cut -c1-300)"; }
rm -rf /tmp/p0a; mkdir -p /tmp/p0a
out arch "$(uname -m) $(uname -r)"
out id "$(id)"
out uid_map "$(tr -s ' ' < /proc/self/uid_map | tr '\n' '|')"
out gid_map "$(tr -s ' ' < /proc/self/gid_map | tr '\n' '|')"
out caps "$(grep -E '^Cap|^NoNewPrivs|^Seccomp:' /proc/self/status | tr '\t\n' ' |')"
out proc_mounts "$(findmnt -R -n -o TARGET,FSTYPE,OPTIONS /proc 2>&1 | tr -s ' ' | tr '\n' '|' | cut -c1-600)"
out max_userns "$(cat /proc/sys/user/max_user_namespaces)"
for t in bwrap nft nsenter setpriv unshare script python3 pasta ip keyctl capsh curl getent; do out "tool:$t" "$(command -v $t || echo absent)"; done
out bwrap_version "$(bwrap --version 2>&1)"
out bwrap_bind_fd "$(bwrap --help 2>&1 | grep -c -- '--bind-fd')"
out bwrap_info_fd "$(bwrap --help 2>&1 | grep -c -- '--info-fd')"
RO='--ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin --dev /dev'
# Private /proc modes.
try M1_root_userns_proc bwrap --die-with-parent --unshare-user --unshare-pid $RO --proc /proc -- /usr/bin/true
try M2_root_outercap_proc bwrap --die-with-parent --unshare-pid --cap-drop ALL $RO --proc /proc -- /usr/bin/true
try M3_uid2001_userns_proc setpriv --reuid 2001 --regid 2001 --clear-groups -- bwrap --die-with-parent --unshare-user --unshare-pid $RO --proc /proc -- /usr/bin/true
try M3b_uid2001_userns_noproc setpriv --reuid 2001 --regid 2001 --clear-groups -- bwrap --die-with-parent --unshare-user --unshare-pid $RO -- /usr/bin/true
# Nested: outer-cap bwrap with private /proc (bwrap covers), drop to uid 2001, inner userns + proc.
try M4_outercap_bwrapproc_then_inner_userns_proc bwrap --die-with-parent --unshare-pid --unshare-ipc --unshare-uts --cap-add CAP_SETUID --cap-add CAP_SETGID $RO --proc /proc --tmpfs /tmp -- /usr/bin/setpriv --reuid 2001 --regid 2001 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- bwrap --die-with-parent --unshare-user --unshare-pid $RO --proc /proc -- /usr/bin/true
# Nested: outer via unshare --mount-proc (full procfs, no covers), pivot into a minimal root, drop uid, inner userns + proc.
mkdir -p /tmp/p0a/root
cat > /tmp/p0a/m5.sh <<'IN'
set -e
mount -t tmpfs tmpfs /tmp/p0a/root
mkdir -p /tmp/p0a/root/usr /tmp/p0a/root/proc /tmp/p0a/root/dev /tmp/p0a/root/tmp /tmp/p0a/root/old
mount --rbind /usr /tmp/p0a/root/usr; mount -o remount,bind,ro /tmp/p0a/root/usr
ln -s usr/bin /tmp/p0a/root/bin; ln -s usr/lib /tmp/p0a/root/lib; ln -s usr/lib64 /tmp/p0a/root/lib64; ln -s usr/sbin /tmp/p0a/root/sbin
mount --rbind /dev /tmp/p0a/root/dev
mount -t proc proc /tmp/p0a/root/proc
cd /tmp/p0a/root; pivot_root . old; umount -l /old; rmdir /old
exec setpriv --reuid 2001 --regid 2001 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- bwrap --die-with-parent --unshare-user --unshare-pid --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --dev /dev --proc /proc -- /usr/bin/true
IN
try M5_unshare_fullproc_pivot_then_inner_userns_proc unshare --mount --pid --fork --ipc --uts --propagation private /bin/bash /tmp/p0a/m5.sh
# Workload credentials after M4-style drop.
try M6_dropped_status bwrap --die-with-parent --unshare-pid --cap-add CAP_SETUID --cap-add CAP_SETGID $RO --proc /proc -- /usr/bin/setpriv --reuid 2001 --regid 2001 --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- /bin/sh -c 'id; grep -E "^Cap|^NoNewPrivs" /proc/self/status; ls /dev'
# Network namespace + nft + pasta.
unshare --net --fork sleep 30 & NS=$!; sleep 0.5; NSP=$(pgrep -P $NS sleep || echo $NS)
try N1_nft_in_netns nsenter -t $NSP -n nft -f - <<<'table inet p0 { chain output { type filter hook output priority 0; policy drop; oif "lo" accept; ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, 100.64.0.0/10 } drop; accept; } }'
try N2_pasta_attach pasta --config-net --no-map-gw -t none -u none -T none -U none --quiet $NSP
sleep 1
try N3_public_https nsenter -t $NSP -n curl -sS -o /dev/null -w '%{http_code}' --max-time 10 https://example.com/
try N4_ns_routes nsenter -t $NSP -n ip -brief addr
GW=$(ip route | awk '/default/{print $3; exit}')
out gw "$GW"
try N5_gateway_8081 nsenter -t $NSP -n curl -sS --max-time 4 -o /dev/null -w '%{http_code}' http://$GW:8081/
try N6_agent_loopback_7000_via_gw nsenter -t $NSP -n curl -sS --max-time 4 -o /dev/null -w '%{http_code}' http://$GW:7000/
try N7_container_loopback nsenter -t $NSP -n curl -sS --max-time 4 -o /dev/null -w '%{http_code}' http://127.0.0.1:7000/
kill $NS 2>/dev/null; pkill -f "pasta.*$NSP" 2>/dev/null
out done ok
