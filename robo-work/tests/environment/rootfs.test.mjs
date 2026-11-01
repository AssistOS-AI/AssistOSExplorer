import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { openImageRoot, prepareImageRoot, createEnvironmentRootfs, createRootfsRecovery } from '../../server/sandbox/environmentRootfs.mjs';
import { checkImageCompatibility, elfDefinedVersions } from '../../server/runtime/environmentImages.mjs';
import { buildBwrapArgs, FIXED_DESTINATIONS } from '../../server/sandbox/bwrapArgs.mjs';
import { deriveLocator } from '../../server/execution/resourceLocators.mjs';
import { makeTempDir } from '../helpers/synthetic.mjs';

// macOS has no procfs openat path. Pure fixture checks remap held directory identities; Linux uses the actual procfs path.
const directories = new Map();
const options = { fdPath: (fd) => process.platform === 'linux' ? `/proc/self/fd/${fd}` : directories.get(String(fs.fstatSync(fd).ino)) };
const contract = { architecture: process.arch === 'x64' ? 'amd64' : process.arch, glibcFloor: '2.28', glibcxxVersions: ['3.4.30'], cxxabiVersions: ['1.3.9'] };
function elf(versions) {
    const names = Buffer.from(`\0${versions.join('\0')}\0`);
    const definitions = Buffer.alloc(versions.length * 28);
    let name = 1;
    versions.forEach((version, i) => { const at = i * 28; definitions.writeUInt16LE(1, at); definitions.writeUInt32LE(20, at + 12);
        definitions.writeUInt32LE(i === versions.length - 1 ? 0 : 28, at + 16); definitions.writeUInt32LE(name, at + 20); name += version.length + 1; });
    const bytes = Buffer.alloc(256 + names.length + definitions.length);
    Buffer.from('7f454c46', 'hex').copy(bytes); bytes[4] = 2; bytes[5] = 1;
    bytes.writeBigUInt64LE(64n, 40); bytes.writeUInt16LE(64, 58); bytes.writeUInt16LE(3, 60);
    bytes.writeUInt32LE(3, 128 + 4); bytes.writeBigUInt64LE(256n, 128 + 24); bytes.writeBigUInt64LE(BigInt(names.length), 128 + 32);
    bytes.writeUInt32LE(0x6ffffffd, 192 + 4); bytes.writeBigUInt64LE(BigInt(256 + names.length), 192 + 24);
    bytes.writeBigUInt64LE(BigInt(definitions.length), 192 + 32); bytes.writeUInt32LE(1, 192 + 40);
    names.copy(bytes, 256); definitions.copy(bytes, 256 + names.length);
    return bytes;
}
function root(t) {
    const dir = makeTempDir(t);
    for (const name of ['etc', 'opt', 'usr/bin', 'usr/lib', 'bin', 'lib']) fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(`${dir}/bin/sh`, 'shell', { mode: 0o755 }); fs.writeFileSync(`${dir}/usr/bin/env`, 'env', { mode: 0o755 });
    fs.writeFileSync(`${dir}/lib/libc.so.6`, elf(['GLIBC_2.9', 'GLIBC_2.28', 'GLIBC_2.36']));
    fs.writeFileSync(`${dir}/lib/libstdc++.so.6`, elf(['GLIBCXX_3.4.30', 'CXXABI_1.3.9'])); fs.writeFileSync(`${dir}/lib/libgcc_s.so.1`, 'gcc');
    for (const name of ['', 'etc', 'opt', 'usr', 'usr/bin', 'usr/lib', 'bin', 'lib']) {
        const location = path.join(dir, name); directories.set(String(fs.statSync(location).ino), location);
    }
    return dir;
}

test('anchored upper preparation replaces resolver symlinks, never follows outside paths, refuses reserved directories', (t) => {
    const dir = root(t); const outside = makeTempDir(t);
    fs.writeFileSync(`${outside}/victim`, 'untouched');
    fs.symlinkSync(`${outside}/victim`, `${dir}/etc/resolv.conf`);
    prepareImageRoot(dir, options);
    assert.equal(fs.lstatSync(`${dir}/etc/resolv.conf`).isFile(), true);
    assert.equal(fs.readFileSync(`${dir}/etc/resolv.conf`, 'utf8'), '');
    assert.equal(fs.readFileSync(`${outside}/victim`, 'utf8'), 'untouched');
    const image = openImageRoot(dir, options);
    try { assert.throws(() => image.read(`${outside}/victim`), { code: 'ENOENT' }); } finally { image.close(); }
    fs.rmdirSync(`${dir}/opt`); fs.symlinkSync('/tmp', `${dir}/opt`);
    assert.throws(() => prepareImageRoot(dir, options), { reason: 'image_reserved_path' });
});

test('ELF definitions, numeric glibc floor and required ABI definitions; missing shell/musl/old glibc refuse', (t) => {
    assert.deepEqual(elfDefinedVersions(elf(['GLIBC_2.28'])), ['GLIBC_2.28']);
    const dir = root(t);
    assert.equal(checkImageCompatibility(dir, contract, options).glibc, '2.36');
    fs.writeFileSync(`${dir}/lib/libc.so.6`, elf(['GLIBC_2.9']));
    assert.throws(() => checkImageCompatibility(dir, contract, options), { reason: 'image_glibc_old' });
    fs.unlinkSync(`${dir}/lib/libc.so.6`); fs.writeFileSync(`${dir}/lib/ld-musl-x86_64.so.1`, 'musl');
    assert.throws(() => checkImageCompatibility(dir, contract, options), { reason: 'image_musl' });
    fs.unlinkSync(`${dir}/bin/sh`);
    assert.throws(() => checkImageCompatibility(dir, contract, options), { reason: 'image_no_shell' });
});

test('rootfs preparation skips FIFO and socket entries and logs bounded escaped names through the supplied callback', async (t) => {
    const dir = root(t); const name = `fifo\t\u202e${'x'.repeat(180)}`;
    execFileSync('/usr/bin/mkfifo', [path.join(dir, name)]);
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(dir, 'socket'), resolve); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const events = [];
    const locator = deriveLocator('env-rootfs', '2'.repeat(32), {});
    const imageId = `sha256:${'b'.repeat(64)}`;
    const podman = { async run(args) { return { status: 0, stdout: args[0] === 'create' ? 'c'.repeat(64) : dir }; } };
    const rootfs = await createEnvironmentRootfs({ podman, imageId, locator, workspaceId: 'ws', executionId: 'execution',
        log: (event, fields) => events.push({ event, ...fields }), inspectRoot: (root, opts) => prepareImageRoot(root, { ...options, ...opts }) });
    assert.equal(rootfs.entries.some((entry) => entry.name === name || entry.name === 'socket'), false);
    assert.deepEqual(events.map((entry) => entry.kind).sort(), ['fifo', 'socket']);
    assert.deepEqual(events.map((entry) => entry.count), [1, 2]);
    for (const event of events) {
        assert.equal(event.event, 'environment_image_entry_skipped');
        assert.ok(event.name.length <= 128); assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/u.test(event.name));
    }
    assert.ok(events[0].name.includes('\\t\\u202e'));
});

test('image bind ordering and protected runtime names preserve workload confinement', () => {
    const spec = { role: 'workload', marker: 'rwMarker0123456789_-ab', seccompFd: 5, blockFd: 6, infoFd: 7, jsonStatusFd: 8,
        cwd: '/home/robot', argv: ['codex'], env: { HOME: '/home/robot', PATH: '/rw-opt/bin:/usr/bin' }, netMode: 'none',
        stagingDir: '/rt/stage', channelsDir: '/rt/channels', stageScript: '/rw-stage/stage.sh', grants: [],
        imageRoot: { path: '/store/merged', entries: [{ name: 'etc', kind: 'directory' }, { name: 'usr', kind: 'directory' }, { name: 'bin', kind: 'symlink', target: 'usr/bin' }] },
        roBinds: [{ source: '/worker/tools', dest: '/rw-opt/tools' }, { source: '/worker/wrappers', dest: '/rw-opt/bin' }],
        roFiles: [{ source: '/rt/etc/resolv.conf', dest: '/etc/resolv.conf' }],
    };
    const args = buildBwrapArgs(spec).toString().split('\0');
    const rendered = args.join(' ');
    assert.ok(rendered.indexOf('--bind /store/merged/etc /etc') < rendered.indexOf('--ro-bind /rt/etc/resolv.conf /etc/resolv.conf'));
    assert.ok(rendered.includes('--remount-ro /'));
    assert.ok(FIXED_DESTINATIONS.includes('/rw-opt'));
    for (const name of ['home', 'proc', 'run', 'tmp', 'dev', 'sys', 'rw-opt', '../x', 'a/b', '..', 'bad\nname']) {
        assert.throws(() => buildBwrapArgs({ ...spec, imageRoot: { path: '/store/merged', entries: [{ name, kind: 'directory' }] } }), { code: 'invalid_request' });
    }
    assert.throws(() => buildBwrapArgs({ ...spec, role: 'orchestration' }), { code: 'invalid_request' });
    assert.throws(() => buildBwrapArgs({ ...spec, binds: [{ source: '/worker', dest: '/rw-opt/bin', mode: 'rw' }] }), { code: 'invalid_request' });
    assert.throws(() => buildBwrapArgs({ ...spec, symlinks: [{ target: '/tmp', dest: '/rw-opt' }] }), { code: 'invalid_request' });
    assert.ok(!args.some((arg) => /^\/store\/merged\/(home|proc|run|tmp|dev|sys)$/u.test(arg)));
});

test('rootfs uses a never-started per-workload exact image; recovery fails closed and removes exact labelled objects', async () => {
    const id = `sha256:${'b'.repeat(64)}`; const locator = deriveLocator('env-rootfs', '1'.repeat(32), {});
    const calls = []; let present = false; let mounted = false; let unavailable = false;
    const run = (args) => {
        calls.push(args);
        if (unavailable) return { status: 125, stdout: '' };
        if (args[0] === 'create') { present = true; return { status: 0, stdout: 'c'.repeat(64) }; }
        if (args[0] === 'mount') return { status: 0, stdout: '/store/merged\n' };
        if (args[0] === 'container') return { status: present ? 0 : 1, stdout: '' };
        if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify([{ Config: { Labels: { 'robo-work.reservation': '1'.repeat(32) } }, GraphDriver: { Data: { MergedDir: '/store/merged' } } }]) };
        if (args[0] === 'umount') { mounted = false; return { status: 0, stdout: '' }; }
        if (args[0] === 'rm') { present = false; return { status: 0, stdout: '' }; }
        throw new Error('Unexpected operation');
    };
    const podman = { run: async (...args) => run(...args), runSync: run };
    const rootfs = await createEnvironmentRootfs({ podman, imageId: id, locator, workspaceId: 'ws', executionId: 'execution', inspectRoot: () => [] });
    assert.equal(rootfs.identity.imageId, id);
    const recovery = createRootfsRecovery({ podman, readMounts: () => mounted ? '1 0 0:1 / /store/merged rw - overlay overlay rw' : '' });
    unavailable = true;
    assert.equal(recovery.exists(locator), true); assert.equal(recovery.remove(locator), false);
    unavailable = false;
    assert.equal(recovery.remove(locator), true); assert.equal(recovery.remove({ ...locator, mergedPath: '/store/merged' }), true);
    assert.ok(!calls.some((args) => ['run', 'start', 'exec', 'prune', 'reset'].includes(args[0]) || args.includes('-a') || args.includes('--all')));
    assert.ok(calls[0].includes('--pull=never')); assert.ok(calls[0].includes(id));
});
