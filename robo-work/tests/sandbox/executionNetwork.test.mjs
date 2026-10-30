import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createExecutionNetwork, namesFor, readResolverConfig, renderHosts, renderResolvConf } from '../../server/sandbox/executionNetwork.mjs';
import { deriveLocator } from '../../server/execution/resourceLocators.mjs';

const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OK = { status: 0, stdout: '', stderr: '' };

function rig({ failOn = null, links = '', tables = '' } = {}) {
    const calls = [];
    const run = async (command, args, options = {}) => {
        const line = `${command} ${args.join(' ')}`;
        calls.push({ command, args, line, input: options.input });
        if (failOn && line.startsWith(failOn)) return { status: 2, stdout: '', stderr: 'boom' };
        if (line === 'ip -o link show') return { status: 0, stdout: links, stderr: '' };
        if (line === 'nft list tables') return { status: 0, stdout: tables, stderr: '' };
        return OK;
    };
    return { calls, run, options: { reservationId: ID, run, listUsed: async () => new Set(), enableForwarding: async () => calls.push({ line: 'forwarding' }), exists: () => false, dnsServers: [] } };
}

test('names agree with resourceLocators for the veth and the nft table, and the netns is rw + 16 hex', () => {
    const names = namesFor(ID);
    assert.deepEqual({ host: names.host, peer: names.peer }, deriveLocator('veth', ID, {}));
    assert.equal(names.table, deriveLocator('nft-table', ID, {}).table);
    assert.match(names.netns, /^rw[0-9a-f]{16}$/);
    assert.throws(() => namesFor('nothex'), { code: 'network_setup_failed' });
});

test('setup: netns, lo, veth moved into it, /30 on both ends, default route, forwarding, nft table; in that order', async () => {
    const { calls, options } = rig();
    const network = createExecutionNetwork(options);
    await network.setup();
    const lines = calls.map((call) => call.line);
    const index = (prefix) => lines.findIndex((line) => line.startsWith(prefix));
    const inNs = (rest) => `nsenter --net=/run/netns/${network.name} -- ip ${rest}`;
    assert.ok(index(`ip netns add ${network.name}`) < index(inNs('link set lo up')));
    assert.ok(index(inNs('link set lo up')) < index(`ip link add ${network.hostVeth} type veth peer name ${network.peerVeth}`));
    assert.ok(index(`ip link set ${network.peerVeth} netns ${network.name}`) > index('ip link add'));
    assert.ok(lines.includes(`ip addr add ${network.hostAddress}/30 dev ${network.hostVeth}`));
    assert.ok(lines.includes(inNs(`addr add ${network.peerAddress}/30 dev ${network.peerVeth}`)));
    assert.ok(!lines.some((line) => line.startsWith('ip -n')), 'ip -n mounts /sys, which the nested container refuses');
    assert.ok(lines.includes(inNs(`route add default via ${network.hostAddress}`)));
    assert.ok(index('forwarding') > index('nsenter') && index('forwarding') < index('nft -f -'));
    assert.match(network.subnet, /^10\.213\.\d+\.\d+\/30$/);
    assert.equal(network.nsPath, `/run/netns/${network.name}`);
    const nft = calls.find((call) => call.command === 'nft').input;
    assert.ok(nft.includes(`table inet ${network.table}`));
    assert.ok(nft.includes(`iifname "${network.hostVeth}" drop`), 'input: nothing from the execution reaches the worker itself');
    assert.ok(nft.includes('ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8 } drop'));
    assert.ok(nft.includes(`ip saddr != ${network.peerAddress} drop`));
    assert.ok(nft.includes('meta nfproto ipv6 drop'));
    assert.ok(nft.includes(`ip saddr ${network.subnet} masquerade`));
});

test('resolvers are the only private destinations allowed, and only on port 53', async () => {
    const { calls, options } = rig();
    const network = createExecutionNetwork({ ...options, dnsServers: ['10.0.2.3'] });
    await network.setup();
    const nft = calls.find((call) => call.command === 'nft').input;
    assert.ok(nft.indexOf('ip daddr { 10.0.2.3 } meta l4proto { tcp, udp } th dport 53 accept') < nft.indexOf('ip daddr { 10.0.0.0/8'));
    assert.throws(() => createExecutionNetwork({ ...options, dnsServers: ['10.0.2.3; flush ruleset'] }), { code: 'network_setup_failed' });
});

test('a failing step undoes the earlier ones in reverse order and throws network_setup_failed', async () => {
    for (const failOn of ['ip link set rw', 'nft -f', 'nsenter']) {
        const { calls, options } = rig({ failOn });
        const network = createExecutionNetwork(options);
        await assert.rejects(network.setup(), { code: 'network_setup_failed' });
        const lines = calls.map((call) => call.line);
        const deletes = lines.filter((line) => /delete table|link del|netns del/.test(line));
        deletes.splice(0, deletes.indexOf(`nft delete table inet ${network.table}`)); // the final release
        assert.ok(lines.some((line) => line === `ip netns del ${network.name}`), failOn);
        assert.ok(deletes.indexOf(`nft delete table inet ${network.table}`) < deletes.indexOf(`ip link del ${network.hostVeth}`), failOn);
        assert.ok(deletes.indexOf(`ip link del ${network.hostVeth}`) < deletes.indexOf(`ip netns del ${network.name}`), failOn);
    }
});

test('release deletes in reverse order and may be repeated', async () => {
    const { calls, options } = rig();
    const network = createExecutionNetwork(options);
    await network.setup();
    calls.length = 0;
    await network.release();
    await network.release();
    const lines = calls.map((call) => call.line);
    assert.deepEqual(lines.slice(0, 3), [`nft delete table inet ${network.table}`, `ip link del ${network.hostVeth}`, `ip netns del ${network.name}`]);
});

test('verifyAbsent reports a leftover netns file, veth or nft table by name', async () => {
    const present = rig({ links: '1: lo: <LOOPBACK>\n7: rw1234567890h@if6: <UP>\n' });
    const clean = createExecutionNetwork(present.options);
    assert.deepEqual(await clean.verifyAbsent(), { absent: true, problems: [] });
    const leftovers = createExecutionNetwork({ ...present.options, exists: () => true, run: async (command, args) => {
        if (args.join(' ') === '-o link show') return { status: 0, stdout: `3: ${clean.hostVeth}@if4: <UP>\n`, stderr: '' };
        if (command === 'nft') return { status: 0, stdout: `table inet ${clean.table}\ntable ip other\n`, stderr: '' };
        return OK;
    } });
    assert.deepEqual((await leftovers.verifyAbsent()).problems, ['netns_file', 'veth', 'nft_table']);
    const unreadable = createExecutionNetwork({ ...present.options, run: async () => ({ status: 1, stdout: '', stderr: '' }) });
    assert.equal((await unreadable.verifyAbsent()).absent, false);
});

test('concurrent executions never get the same /30, and a used slot is skipped', async () => {
    const a = rig();
    const first = createExecutionNetwork(a.options);
    await first.setup();
    const used = new Set([Number(first.subnet.split('.')[2]) * 64 + Number(first.subnet.split('.')[3].split('/')[0]) / 4]);
    const second = createExecutionNetwork({ ...a.options, reservationId: 'f'.repeat(32), listUsed: async () => used });
    const third = createExecutionNetwork({ ...a.options, reservationId: 'f'.repeat(32), names: { ...namesFor('e'.repeat(32)) }, listUsed: async () => used });
    await Promise.all([second.setup(), third.setup()]);
    assert.equal(new Set([first.subnet, second.subnet, third.subnet]).size, 3);
    await Promise.all([first.release(), second.release(), third.release()]);
});

test('explicit names must have the locator shapes', () => {
    assert.throws(() => createExecutionNetwork({ names: { netns: 'x', host: 'y', peer: 'z', table: 't' }, run: async () => OK }), { code: 'network_setup_failed' });
});

test('F6: the accept for port 53 to the nameserver comes BEFORE the private-range drop in the same chain, for tcp and udp, from the execution veth only', async () => {
    const { calls, options } = rig();
    const network = createExecutionNetwork({ ...options, dnsServers: ['10.89.5.1'], dnsOptions: [] });
    await network.setup();
    const nft = calls.find((call) => call.command === 'nft').input;
    const forward = nft.slice(nft.indexOf('chain forward'), nft.indexOf('chain postrouting'));
    const accept = forward.indexOf('ip daddr { 10.89.5.1 } meta l4proto { tcp, udp } th dport 53 accept');
    const drop = forward.indexOf('ip daddr { 10.0.0.0/8, 172.16.0.0/12');
    assert.ok(accept > 0 && drop > accept, 'nameserver accept precedes the 10/8 drop (10.89.5.1 lies inside 10/8)');
    const line = forward.split('\n').find((entry) => entry.includes('10.89.5.1'));
    assert.ok(line.includes(`iifname "${network.hostVeth}"`) && line.includes('tcp, udp') && line.includes('th dport 53'), line);
    assert.ok(forward.indexOf('ip saddr !=') < accept, 'a spoofed source is dropped before the accept');
    assert.deepEqual(network.resolvers, ['10.89.5.1']);
    // port 53 only: other ports of the nameserver, and any other private address, stay dropped by the rule that follows
    assert.ok(!forward.includes('10.89.5.1 } accept') && !/daddr \{ 10\.89\.5\.1 \} accept/.test(forward));
});

test('F6: resolv.conf is read through a symlink; only IPv4 non-loopback nameservers and the harmless options are kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-resolv-'));
    try {
        fs.writeFileSync(path.join(dir, 'stub'), [
            '# comment', 'search dns.podman tailfa185c.ts.net', 'nameserver 10.89.5.1', 'nameserver 127.0.0.53', 'nameserver ::1', 'nameserver 10.89.5.1',
            'nameserver 192.168.0.2 extra', 'nameserver 1.1.1.1', 'options edns0 trust-ad ndots:3 timeout:2 attempts:9 rotate use-vc timeout:20 inet6', 'options attempts:2 ndots:99'
        ].join('\n'));
        fs.symlinkSync('stub', path.join(dir, 'resolv.conf'));
        assert.deepEqual(readResolverConfig(path.join(dir, 'resolv.conf')), { nameservers: ['10.89.5.1', '1.1.1.1'], options: ['ndots:3', 'timeout:2', 'attempts:2'] });
        assert.deepEqual(readResolverConfig(path.join(dir, 'missing')), { nameservers: [], options: [] });
        assert.deepEqual(readResolverConfig(path.join(dir, 'dangling-target-is-missing')), { nameservers: [], options: [] });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('F6: the generated resolv.conf lists exactly the firewall\'s nameservers (no search, no copied extras); hosts resolves localhost', () => {
    assert.equal(renderResolvConf({ nameservers: ['10.89.5.1', '1.1.1.1'], options: ['ndots:2'] }),
        '# generated for this execution; only the nameservers its firewall allows\nnameserver 10.89.5.1\nnameserver 1.1.1.1\noptions ndots:2\n');
    assert.equal(renderResolvConf({}), '# generated for this execution; only the nameservers its firewall allows\n');
    assert.throws(() => renderResolvConf({ nameservers: ['10.0.0.1\nsearch evil'] }), { code: 'network_setup_failed' });
    assert.equal(renderHosts(), '127.0.0.1 localhost\n::1 localhost\n');
    const { options } = rig();
    const network = createExecutionNetwork({ ...options, dnsServers: ['10.89.5.1'], dnsOptions: ['timeout:2'] });
    assert.equal(renderResolvConf({ nameservers: network.resolvers, options: network.resolverOptions }).includes('nameserver 10.89.5.1\noptions timeout:2'), true);
});
