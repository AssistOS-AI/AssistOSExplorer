// The execution network (plan Revision 10, section E): one network namespace per execution, a veth pair to the worker
// container, a /30 from a private pool, and an nftables table that confines what the execution can reach. Everything is
// done by spawning the distribution's `ip` and `nft`; nothing here is native code. A step failure undoes the steps already
// done and throws `network_setup_failed`.
//
//   createExecutionNetwork({ reservationId?, names?, run?, exists?, listUsed?, enableForwarding? })
//       -> { name, nsPath, hostVeth, peerVeth, table, subnet, hostAddress, peerAddress,
//            setup(), addNetns(), addVeth(), addFirewall(), release(), verifyAbsent(), nsInode() }
//
//   Names derive from SHA-256(reservationId) exactly as resourceLocators.mjs does for the veth and the nft table
//   (`rw<10hex>h` / `rw<10hex>n`, `rw_<16hex>`), and `rw<16hex>` for the netns. A caller that records three separate
//   reservations (netns, veth, nft-table) passes `names` instead: { netns, host, peer, table } (each validated).
//   setup() runs the three steps in order; the steps are also public so that a ledger that publishes the netns, the veth
//   and the nft table as separate blockers can create them one at a time. release() undoes them in reverse and is
//   idempotent. verifyAbsent() -> { absent, problems[] } checks the netns file, the veth and the nft table by name.
//
//   run(command, args, { input? }) -> Promise<{ status, stdout, stderr }> is injected in tests (default: spawn with a fixed PATH).
//
// Firewall (all rules match the execution's veth, so a spoofed source address gains nothing):
//   input     drop everything arriving on the veth        -> the execution cannot reach the worker's own addresses
//   forward   drop IPv6; drop a source other than the peer address; accept port 53 to the configured resolvers
//             (`dnsServers`, default the IPv4 nameservers of /etc/resolv.conf); drop destinations in 10/8, 172.16/12, 192.168/16,
//             169.254/16, 100.64/10 and 127/8 (the worker, Box and Router private ranges and every other execution's /30,
//             which all lie inside the pool 10.213.0.0/16); everything else is the permitted egress
//   postrouting  masquerade the execution's /30

import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

import { sandboxError } from './sandboxErrors.mjs';

export const POOL_PREFIX = '10.213';
const SLOTS = 16384; // /30 blocks in 10.213.0.0/16
const TOOL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const NETNS_DIR = '/run/netns';
const NAME = /^rw[0-9a-f]{16}$/u;
const HOST_VETH = /^rw[0-9a-f]{10}h$/u;
const PEER_VETH = /^rw[0-9a-f]{10}n$/u;
const TABLE = /^rw_[0-9a-f]{16}$/u;
const PRIVATE_RANGES = '{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8 }';

const IPV4 = /^(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})){3}$/u;

export function readResolvers(file = '/etc/resolv.conf') {
    try {
        return fs.readFileSync(file, 'utf8').split('\n')
            .map((line) => /^\s*nameserver\s+(\S+)\s*$/u.exec(line)?.[1])
            .filter((address) => address !== undefined && IPV4.test(address) && !address.startsWith('127.'));
    } catch { return []; }
}

export const namesFor = (reservationId) => {
    if (typeof reservationId !== 'string' || !/^[0-9a-f]{16,64}$/u.test(reservationId)) throw sandboxError('network_setup_failed', 'invalid reservation id');
    const digest = crypto.createHash('sha256').update(reservationId, 'utf8').digest('hex');
    return { netns: `rw${digest.slice(0, 16)}`, host: `rw${digest.slice(0, 10)}h`, peer: `rw${digest.slice(0, 10)}n`, table: `rw_${digest.slice(0, 16)}`, digest };
};

export function defaultRun(command, args, { input = null, timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, { env: { PATH: TOOL_PATH }, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
        } catch (error) {
            resolve({ status: 127, stdout: '', stderr: String(error?.code ?? error) });
            return;
        }
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += chunk; });
        child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk; });
        child.on('error', (error) => { clearTimeout(timer); resolve({ status: 127, stdout, stderr: `${stderr}${error?.code ?? error}` }); });
        child.on('close', (status) => { clearTimeout(timer); resolve({ status: status ?? 128, stdout, stderr }); });
        if (input !== null) child.stdin.end(input);
    });
}

// Serialises slot choice inside one process: the supervisor allocates for many executions concurrently.
let allocationChain = Promise.resolve();
const claimedSlots = new Set();

function slotAddresses(slot) {
    const third = slot >> 6;
    const fourth = (slot & 63) * 4;
    const base = `${POOL_PREFIX}.${third}.${fourth}`;
    return { subnet: `${base}/30`, hostAddress: `${POOL_PREFIX}.${third}.${fourth + 1}`, peerAddress: `${POOL_PREFIX}.${third}.${fourth + 2}` };
}

const slotOfAddress = (address) => {
    const match = /^10\.213\.([0-9]{1,3})\.([0-9]{1,3})(?:\/[0-9]+)?$/u.exec(address);
    return match ? (Number(match[1]) << 6) + (Number(match[2]) >> 2) : null;
};

// Default: the pool addresses already present in the worker's namespace (`ip -o -4 addr show`).
async function defaultListUsed(run) {
    const result = await run('ip', ['-o', '-4', 'addr', 'show']);
    if (result.status !== 0) throw sandboxError('network_setup_failed', 'cannot list addresses');
    const used = new Set();
    for (const line of result.stdout.split('\n')) {
        const found = /inet (10\.213\.[0-9.]+(?:\/[0-9]+)?)/u.exec(line);
        const slot = found ? slotOfAddress(found[1]) : null;
        if (slot !== null) used.add(slot);
    }
    return used;
}

async function defaultEnableForwarding(run) {
    const file = '/proc/sys/net/ipv4/ip_forward';
    try { if (fs.readFileSync(file, 'utf8').trim() === '1') return; } catch { /* written below */ }
    try {
        fs.writeFileSync(file, '1');
        return;
    } catch (error) {
        if (error?.code !== 'EROFS' && error?.code !== 'EACCES' && error?.code !== 'EPERM') throw sandboxError('network_setup_failed', `ip_forward: ${error?.code ?? 'error'}`);
    }
    // The nested container mounts /proc/sys read-only. The write is done in a private mount namespace after lazily
    // unmounting that one bind (the sysctl itself belongs to the network namespace, not to the mount namespace). The
    // script is fixed text.
    const result = await run('unshare', ['--mount', '--propagation', 'private', '--', '/bin/sh', '-c',
        'umount -l /proc/sys 2>/dev/null; echo 1 > /proc/sys/net/ipv4/ip_forward']);
    let value = '';
    try { value = fs.readFileSync(file, 'utf8').trim(); } catch { /* unreadable */ }
    if (result.status !== 0 || value !== '1') throw sandboxError('network_setup_failed', 'ip_forward could not be enabled');
}

export function createExecutionNetwork({
    reservationId, names = null, run = defaultRun, exists = (file) => fs.existsSync(file), listUsed = null, enableForwarding = null,
    statNs = (file) => fs.statSync(file, { bigint: true }), dnsServers = null
} = {}) {
    const resolvers = [...new Set(dnsServers ?? readResolvers())];
    if (resolvers.some((address) => !IPV4.test(address))) throw sandboxError('network_setup_failed', 'invalid resolver address');
    let resolved;
    if (names !== null) {
        resolved = { netns: names.netns, host: names.host, peer: names.peer, table: names.table };
        if (!NAME.test(resolved.netns) || !HOST_VETH.test(resolved.host) || !PEER_VETH.test(resolved.peer) || !TABLE.test(resolved.table)) {
            throw sandboxError('network_setup_failed', 'invalid resource names');
        }
    } else {
        resolved = namesFor(reservationId);
    }
    const slotSeed = Number.parseInt(crypto.createHash('sha256').update(`slot:${resolved.netns}`).digest('hex').slice(0, 8), 16);
    const state = { netns: false, veth: false, firewall: false, slot: null };
    const nsPath = `${NETNS_DIR}/${resolved.netns}`;
    const self = {
        name: resolved.netns, nsPath, hostVeth: resolved.host, peerVeth: resolved.peer, table: resolved.table,
        subnet: null, hostAddress: null, peerAddress: null
    };

    // `ip -n <ns> ...` would mount a fresh /sys for the namespace, which the nested container refuses (observed: "mount of
    // /sys failed"); `nsenter --net=<file> -- ip ...` only enters the namespace.
    async function ipIn(args, options) {
        return ip(['__in__', ...args], options);
    }

    async function ip(args, { allowFail = false } = {}) {
        const inNs = args[0] === '__in__';
        const result = inNs ? await run('nsenter', [`--net=${nsPath}`, '--', 'ip', ...args.slice(1)]) : await run('ip', args);
        if (result.status !== 0 && !allowFail) throw sandboxError('network_setup_failed', `ip ${args.slice(inNs ? 1 : 0, inNs ? 4 : 3).join(' ')}: ${String(result.stderr).trim().slice(0, 120)}`);
        return result;
    }

    function claimSlot() {
        const claim = allocationChain.then(async () => {
            const used = await (listUsed ? listUsed() : defaultListUsed(run));
            for (let probe = 0; probe < SLOTS; probe += 1) {
                const slot = (slotSeed + probe) % SLOTS;
                if (used.has(slot) || claimedSlots.has(slot)) continue;
                claimedSlots.add(slot);
                return slot;
            }
            throw sandboxError('network_setup_failed', 'address pool exhausted');
        });
        allocationChain = claim.catch(() => {});
        return claim;
    }

    function ensureAddresses() {
        if (state.slot === null) return false;
        Object.assign(self, slotAddresses(state.slot));
        return true;
    }

    const ruleset = () => `table inet ${resolved.table} {
    chain input {
        type filter hook input priority 0; policy accept;
        iifname "${resolved.host}" drop
    }
    chain forward {
        type filter hook forward priority 0; policy accept;
        iifname "${resolved.host}" meta nfproto ipv6 drop
        iifname "${resolved.host}" ip saddr != ${self.peerAddress} drop
${resolvers.length > 0 ? `        iifname "${resolved.host}" ip daddr { ${resolvers.join(', ')} } meta l4proto { tcp, udp } th dport 53 accept\n` : ''}        iifname "${resolved.host}" ip daddr ${PRIVATE_RANGES} drop
    }
    chain postrouting {
        type nat hook postrouting priority 100; policy accept;
        ip saddr ${self.subnet} masquerade
    }
}
`;

    async function addNetns() {
        if (state.netns) return;
        await ip(['netns', 'add', resolved.netns]);
        state.netns = true;
        try {
            await ipIn(['link', 'set', 'lo', 'up']);
        } catch (error) {
            await removeNetns();
            throw error;
        }
    }

    async function addVeth() {
        if (state.veth) return;
        if (!state.netns) throw sandboxError('network_setup_failed', 'veth before netns');
        state.slot = await claimSlot();
        ensureAddresses();
        state.veth = true; // set first so that a partial failure is undone by release()
        try {
            await ip(['link', 'add', resolved.host, 'type', 'veth', 'peer', 'name', resolved.peer]);
            await ip(['link', 'set', resolved.peer, 'netns', resolved.netns]);
            await ip(['addr', 'add', `${self.hostAddress}/30`, 'dev', resolved.host]);
            await ip(['link', 'set', resolved.host, 'up']);
            await ipIn(['addr', 'add', `${self.peerAddress}/30`, 'dev', resolved.peer]);
            await ipIn(['link', 'set', resolved.peer, 'up']);
            await ipIn(['route', 'add', 'default', 'via', self.hostAddress]);
            await (enableForwarding ? enableForwarding() : defaultEnableForwarding(run));
        } catch (error) {
            await removeVeth();
            throw error;
        }
    }

    async function addFirewall() {
        if (state.firewall) return;
        if (!ensureAddresses()) throw sandboxError('network_setup_failed', 'firewall before veth');
        state.firewall = true;
        const result = await run('nft', ['-f', '-'], { input: ruleset() });
        if (result.status !== 0) {
            await removeFirewall();
            throw sandboxError('network_setup_failed', `nft: ${String(result.stderr).trim().slice(0, 120)}`);
        }
    }

    async function removeFirewall() {
        state.firewall = false;
        await run('nft', ['delete', 'table', 'inet', resolved.table]);
    }

    async function removeVeth() {
        state.veth = false;
        await ip(['link', 'del', resolved.host], { allowFail: true });
        if (state.slot !== null) { claimedSlots.delete(state.slot); state.slot = null; }
    }

    async function removeNetns() {
        state.netns = false;
        await ip(['netns', 'del', resolved.netns], { allowFail: true });
    }

    async function setup() {
        try {
            await addNetns();
            await addVeth();
            await addFirewall();
        } catch (error) {
            await release();
            throw error.code === 'network_setup_failed' ? error : sandboxError('network_setup_failed', error?.code ?? error?.message);
        }
    }

    // Reverse order, each step attempted whatever the state (a partial setup, or a recovery that only knows the names).
    async function release() {
        await removeFirewall();
        await removeVeth();
        await removeNetns();
    }

    async function verifyAbsent() {
        const problems = [];
        if (exists(nsPath)) problems.push('netns_file');
        const links = await run('ip', ['-o', 'link', 'show']);
        if (links.status !== 0) problems.push('link_list_failed');
        else if (links.stdout.split('\n').some((line) => new RegExp(`^[0-9]+: (${resolved.host}|${resolved.peer})[@:]`, 'u').test(line))) problems.push('veth');
        const tables = await run('nft', ['list', 'tables']);
        if (tables.status !== 0) problems.push('nft_list_failed');
        else if (tables.stdout.split('\n').some((line) => line.trim().endsWith(` ${resolved.table}`))) problems.push('nft_table');
        return { absent: problems.length === 0, problems };
    }

    return Object.assign(self, {
        setup, addNetns, addVeth, addFirewall, release, verifyAbsent,
        nsInode: () => String(statNs(nsPath).ino),
        removeFirewall, removeVeth, removeNetns
    });
}
