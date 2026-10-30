import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyProcMasks, procMaskArgs, readProcMasks } from '../../server/sandbox/procMasks.mjs';

const FIXTURE = fs.readFileSync(fileURLToPath(new URL('./fixtures/podman-nested-mountinfo.txt', import.meta.url)), 'utf8');

test('the nested-podman mountinfo yields the runtime masks, deepest first, nothing unclassified', () => {
    const { masks, unclassified } = classifyProcMasks(FIXTURE);
    assert.deepEqual(unclassified, []);
    const byPath = Object.fromEntries(masks.map((mask) => [mask.path, mask]));
    for (const file of ['kcore', 'keys', 'latency_stats', 'timer_list', 'interrupts']) assert.equal(byPath[`/proc/${file}`].kind, 'null-file', file);
    for (const dir of ['acpi', 'scsi']) assert.equal(byPath[`/proc/${dir}`].kind, 'empty-dir', dir);
    for (const name of ['sys', 'sysrq-trigger', 'irq', 'bus', 'fs', 'asound']) assert.equal(byPath[`/proc/${name}`].kind, 'proc-ro', name);
    assert.equal(byPath['/proc/sys'].bwrap, 'ro-bind-self');
    assert.equal(byPath['/proc/sysrq-trigger'].bwrap, 'ro-bind-null');
    assert.equal(byPath['/proc/fs'].bwrap, 'empty-dir');
    assert.equal(masks.length, 13);
    // /proc itself and the /dev and /sys mounts are not masks
    assert.ok(!masks.some((mask) => mask.path === '/proc' || mask.path.startsWith('/dev') || mask.path.startsWith('/sys')));
    const depths = masks.map((mask) => mask.path.split('/').length);
    assert.deepEqual(depths, [...depths].sort((a, b) => b - a));
});

test('a submount that is not a known mask shape is unclassified, and readProcMasks fails closed with sandbox_unavailable', () => {
    const odd = `${FIXTURE.trimEnd()}\n9000 7333 0:200 / /proc/odd rw,nosuid - ext4 /dev/sda1 rw\n9001 7333 0:112 /other /proc/other ro - proc proc rw\n9002 7333 0:201 /sub /proc/sub ro - tmpfs tmpfs rw\n`;
    const { unclassified } = classifyProcMasks(odd);
    assert.deepEqual(unclassified.map((entry) => entry.path).sort(), ['/proc/odd', '/proc/other', '/proc/sub']);
    assert.throws(() => readProcMasks({ readFile: () => odd }), { code: 'sandbox_unavailable' });
    assert.throws(() => readProcMasks({ readFile: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }), { code: 'sandbox_unavailable' });
    assert.throws(() => readProcMasks({ readFile: () => 'garbage line' }), { code: 'sandbox_unavailable' });
    assert.equal(readProcMasks({ readFile: () => FIXTURE }).length, 13);
});

test('a proc bind is accepted only at its own mountpoint', () => {
    const wrong = '1 2 0:1 /sys /proc/other ro - proc proc rw\n';
    assert.equal(classifyProcMasks(wrong).unclassified.length, 1);
});

test('procMaskArgs: ro-bind /dev/null for files, empty read-only dirs, self ro-bind for sys; absent paths are skipped', () => {
    const masks = readProcMasks({ readFile: () => FIXTURE });
    const args = procMaskArgs(masks, (path) => path !== '/proc/latency_stats');
    const line = args.join(' ');
    assert.ok(line.includes('--ro-bind /dev/null /proc/kcore'));
    assert.ok(!line.includes('latency_stats'));
    assert.ok(line.includes('--perms 0555 --tmpfs /proc/acpi --remount-ro /proc/acpi'));
    assert.ok(line.includes('--perms 0555 --tmpfs /proc/fs --remount-ro /proc/fs'));
    assert.ok(line.includes('--ro-bind /proc/sys /proc/sys'));
    assert.ok(line.includes('--ro-bind /dev/null /proc/sysrq-trigger'));
    assert.throws(() => procMaskArgs([{ path: '/proc/x', bwrap: 'bogus' }]), { code: 'invalid_request' });
});
