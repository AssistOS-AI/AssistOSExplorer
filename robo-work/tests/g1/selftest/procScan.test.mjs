import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    boundOnPort, capSetNonZero, capsAllZero, createScanner, defaultGateway, mountFor, parseLimits, parseMountinfo, parseProcNet, parseStatus,
} from '../lib/procScan.mjs';
import { addProcess, LIMITS, MOUNTINFO, ROUTE, statusText, syntheticProc, tcpTable, udp6Table, udpTable } from './synthProc.mjs';

// SYNTHETIC /proc data only (selftest of the G1 scanner and parsers, plan g4 "Files to create": selftest).

test('capability parsing: all five sets zero is required, a missing set is not zero', () => {
    assert.equal(capsAllZero(parseStatus(statusText()).caps), true);
    assert.equal(capsAllZero(parseStatus(statusText({ caps: { CapBnd: '000001ffffffffff' } })).caps), false);
    assert.equal(capsAllZero(parseStatus(statusText({ omit: ['CapAmb'] })).caps), false, 'missing CapAmb must not count as zero');
    assert.equal(capSetNonZero('000001ffffffffff'), true);
    assert.equal(capSetNonZero('0000000000000000'), false);
    assert.equal(capSetNonZero(null), false);
    const status = parseStatus(statusText({ noNewPrivs: 1, seccomp: 2, uid: '1000 1000 1000 1000' }));
    assert.equal(status.noNewPrivs, 1);
    assert.equal(status.seccomp, 2);
    assert.deepEqual(status.uid, [1000, 1000, 1000, 1000]);
});

test('mountinfo: filesystem type of the covering mount, octal escapes, read-only /proc/sys', () => {
    const entries = parseMountinfo(MOUNTINFO);
    assert.equal(mountFor(entries, '/tmp').fsType, 'fuse.fuse-overlayfs');
    assert.equal(mountFor(entries, '/dev/shm').fsType, 'tmpfs');
    assert.equal(mountFor(entries, '/dev/shmx').fsType, 'fuse.fuse-overlayfs', 'a sibling name is not covered');
    assert.equal(mountFor(entries, '/run/x/y').mountPoint, '/run');
    assert.equal(mountFor(entries, '/proc/sys/net/ipv4/ip_forward').options.includes('ro'), true);
    assert.equal(entries.at(-1).mountPoint, '/data/with space');
    assert.throws(() => parseMountinfo('1 2 3\n'), /malformed/);
});

test('proc/net tables: UDP bound sockets on a port, TCP LISTEN only, IPv6 decoding', () => {
    const udp = parseProcNet(udpTable([['127.0.0.1', 17972], ['0.0.0.0', 5353]]), 'udp');
    assert.equal(udp[0].local.addr, '127.0.0.1');
    assert.equal(udp[0].local.port, 17972);
    assert.equal(boundOnPort(udp, 17972).length, 1);
    assert.equal(boundOnPort(udp, 17971).length, 0);
    const udp6 = parseProcNet(udp6Table([17971]), 'udp6');
    assert.equal(udp6[0].local.port, 17971);
    assert.equal(udp6[0].local.addr, '0:0:0:0:0:0:0:0');
    assert.equal(boundOnPort(udp6, 17971).length, 1);
    const tcp = parseProcNet(tcpTable([['0.0.0.0', 8080, '0A'], ['10.89.0.2', 8081, '01']]), 'tcp');
    assert.equal(boundOnPort(tcp, 8080).length, 1);
    assert.equal(boundOnPort(tcp, 8081).length, 0, 'an established TCP socket is not a listener');
    assert.throws(() => parseProcNet('garbage\n', 'udp'), /header/);
});

test('route and limits parsing', () => {
    assert.equal(defaultGateway(ROUTE), '10.89.0.1');
    assert.equal(defaultGateway('Iface\tDestination\tGateway\n'), null);
    assert.equal(parseLimits(LIMITS)['Max open files'].soft, '1048576');
});

test('scanner fails closed: an unreadable entry is recorded, a vanished process is not', () => {
    const root = syntheticProc();
    addProcess(root, { pid: 50, cmdline: ['node', 'harness.mjs', '--run', 'abcdef012345'] });
    fs.chmodSync(path.join(root, '50', 'status'), 0o000);
    const scanner = createScanner({ procRoot: root });
    assert.equal(scanner.status(50), null);
    assert.equal(scanner.unreadable.length, 1);
    assert.equal(scanner.unreadable[0].code, 'EACCES');
    assert.equal(scanner.status(77), null, 'pid 77 does not exist');
    assert.equal(scanner.unreadable.length, 1, 'a missing pid directory is a vanished process, not an unreadable entry');
    assert.deepEqual(scanner.vanished.map((entry) => entry.pid), [77]);
    fs.chmodSync(path.join(root, '50', 'status'), 0o600);
});

test('scanner: namespace members by link, descriptor inventory, marker scan with exclusions', () => {
    const root = syntheticProc();
    addProcess(root, { pid: 60, ns: { net: 'net:[4026532001]' }, cmdline: ['sleep', '30'], fds: { 0: '/dev/null', 3: 'socket:[99]' } });
    addProcess(root, { pid: 61, ns: { net: 'net:[4026539999]' }, cmdline: ['python3', '-c', 'x', 'g4rw-abcdef012345'] });
    addProcess(root, { pid: 62, ns: { net: 'net:[4026532001]' }, cmdline: ['node', 'harness.mjs', 'selfcheck', '--run', 'abcdef012345'] });
    const scanner = createScanner({ procRoot: root });
    assert.deepEqual(scanner.namespaceMembers('net', 'net:[4026532001]'), [1, 60, 62]);
    assert.deepEqual(scanner.fdInventory(60), [{ fd: 0, target: '/dev/null' }, { fd: 3, target: 'socket:[99]' }]);
    assert.deepEqual(scanner.markerScan('g4rw-abcdef012345').map((hit) => hit.pid), [61]);
    assert.deepEqual(scanner.markerScan('abcdef012345', { exclude: [62] }).map((hit) => hit.pid), [61]);
    assert.throws(() => scanner.markerScan('short'), /at least 8/);
    assert.equal(scanner.unreadable.length, 0);
});
