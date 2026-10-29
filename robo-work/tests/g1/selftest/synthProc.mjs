// SYNTHETIC /proc trees for the G1 selftests. Nothing here reads the real /proc.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 'g1st-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function statusText({ uid = '0 0 0 0', caps = {}, noNewPrivs = 0, seccomp = 2, ppid = 1, omit = [] } = {}) {
    const values = {
        Name: 'synthetic', PPid: String(ppid), Uid: uid, Gid: uid,
        CapInh: '0000000000000000', CapPrm: '0000000000000000', CapEff: '0000000000000000',
        CapBnd: '0000000000000000', CapAmb: '0000000000000000',
        NoNewPrivs: String(noNewPrivs), Seccomp: String(seccomp), ...caps,
    };
    return Object.entries(values).filter(([key]) => !omit.includes(key)).map(([key, value]) => `${key}:\t${value}`).join('\n') + '\n';
}

export const MOUNTINFO = [
    '22 1 0:21 / / rw,relatime - fuse.fuse-overlayfs fuse-overlayfs rw,user_id=0',
    '23 22 0:22 / /proc rw,nosuid,nodev,noexec - proc proc rw',
    '24 23 0:22 /sys /proc/sys ro,nosuid,nodev,noexec - proc proc rw',
    '25 22 0:23 / /dev/shm rw,nosuid,nodev - tmpfs shm rw,size=65536k',
    '26 22 0:24 / /run rw,nosuid,nodev - tmpfs tmpfs rw',
    '27 22 0:25 / /data/with\\040space rw - ext4 /dev/x rw',
].join('\n') + '\n';

const NET_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n';
const NET6_HEADER = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n';

// ipv4 "127.0.0.1" -> "0100007F"
export function hex4(addr) {
    return addr.split('.').map(Number).reverse().map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function udpTable(entries) {
    return NET_HEADER + entries.map(([addr, port, inode = 1000], index) =>
        `  ${index}: ${hex4(addr)}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 ${inode} 2 0000000000000000 0`).join('\n') + '\n';
}

export function udp6Table(ports) {
    return NET6_HEADER + ports.map((port, index) =>
        `  ${index}: 00000000000000000000000000000000:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 ${2000 + index} 2 0000000000000000 0`).join('\n') + '\n';
}

export function tcpTable(entries) {
    return NET_HEADER + entries.map(([addr, port, state], index) =>
        `  ${index}: ${hex4(addr)}:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 ${3000 + index} 1 0000000000000000 100 0 0 10 0`).join('\n') + '\n';
}

export const LIMITS = 'Limit                     Soft Limit           Hard Limit           Units     \n'
    + 'Max cpu time              unlimited            unlimited            seconds   \n'
    + 'Max open files            1048576              1048576              files     \n';

export const ROUTE = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
    + 'eth0\t00000000\t0100590A\t0003\t0\t0\t0\t00000000\t0\t0\t0\n'
    + 'eth0\t0000590A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n';

// Build a process directory: { pid, status, cmdline: [...], ns: { net: 'net:[1]' }, fds: { 0: '/dev/null' }, files: {...} }
export function addProcess(root, { pid, status = statusText(), cmdline = ['synthetic'], ns = {}, fds = {}, files = {} }) {
    const dir = path.join(root, String(pid));
    fs.mkdirSync(path.join(dir, 'ns'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'status'), status);
    fs.writeFileSync(path.join(dir, 'cmdline'), `${cmdline.join('\0')}\0`);
    for (const [kind, link] of Object.entries(ns)) fs.symlinkSync(link, path.join(dir, 'ns', kind));
    for (const [fd, target] of Object.entries(fds)) fs.symlinkSync(target, path.join(dir, 'fd', fd));
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
    }
    return dir;
}

export function syntheticProc() {
    const root = tempDir('g1proc-');
    addProcess(root, {
        pid: 1, cmdline: ['node', '/code/server.mjs'], ns: { net: 'net:[4026532001]' },
        files: { mountinfo: MOUNTINFO, limits: LIMITS, uid_map: '         0       1000          1\n         1     100000      65536\n', gid_map: '         0       1000          1\n' },
    });
    fs.symlinkSync('1', path.join(root, 'self'));
    fs.mkdirSync(path.join(root, 'sys/user'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sys/user/max_user_namespaces'), '125023\n');
    fs.mkdirSync(path.join(root, 'net'), { recursive: true });
    fs.writeFileSync(path.join(root, 'net/route'), ROUTE);
    return root;
}
