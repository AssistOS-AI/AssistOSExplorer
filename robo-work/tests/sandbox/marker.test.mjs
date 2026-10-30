// Decision M-18: the reservation marker (an S1 id, which may start with '-') is only ever the value of bwrap's `--hostname` or a
// positional argument after a script/command name; no option parser reads it, and it is never a filename or a resource name.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MARKER_PATTERN, isMarker, markerSlot } from '../../server/sandbox/marker.mjs';
import { bwrapRealArgv } from '../../server/sandbox/bwrapArgs.mjs';
import { createSandboxLauncher } from '../../server/sandbox/sandboxLauncher.mjs';
import { createExecutionSupervisor } from '../../server/sandbox/executionSupervisor.mjs';
import { readProcMasks } from '../../server/sandbox/procMasks.mjs';
import { SUPERVISOR_PID, createFakeSpawn, createFakeView, fakeClock } from './helpers/fakes.mjs';

const DASHED = '-AbCdEf12345678901234';
const ROOT = fileURLToPath(new URL('../../server/', import.meta.url));
const STAGE = path.join(ROOT, 'sandbox/stage.sh');
const NETNS = '/run/netns/rw0123456789abcdef';
const TOOLS = { setpriv: '/usr/bin/setpriv', unshare: '/usr/bin/unshare', mount: '/usr/bin/mount', umount: '/usr/bin/umount', node: '/usr/bin/node', nsenter: '/usr/bin/nsenter' };
const MASKS = readProcMasks({ readFile: () => fs.readFileSync(new URL('./fixtures/podman-nested-mountinfo.txt', import.meta.url), 'utf8') });
const fsWithBwrap = { ...fs, existsSync: (file) => file === '/usr/bin/bwrap' || fs.existsSync(file) };

// Every occurrence of the marker in `argv` must directly follow one of `allowed`; returns the occurrence count.
function onlyAfter(argv, allowed, label) {
    let count = 0;
    argv.forEach((item, index) => {
        if (!String(item).includes(DASHED)) return;
        count += 1;
        assert.equal(item, DASHED, `${label}: the marker is a whole element`);
        assert.ok(index > 0 && allowed.includes(argv[index - 1]), `${label}: marker at ${index} follows ${JSON.stringify(argv[index - 1])}`);
    });
    return count;
}

test('the single validator accepts a leading dash and rejects everything else outside [A-Za-z0-9_-]{8,64}', () => {
    assert.equal(MARKER_PATTERN.source, '^[A-Za-z0-9_-]{8,64}$');
    assert.ok(isMarker(DASHED) && isMarker('-'.repeat(8)) && isMarker('a'.repeat(64)));
    for (const bad of ['', 'short', 'a'.repeat(65), 'has space1234', 'a/b/c/d/e/f/g', '..12345678', 'a=b12345678', 'ab\n1234567', 1, null, undefined]) assert.equal(isMarker(bad), false, String(bad));
});

test('no other marker validator exists in server/sandbox or server/execution (source scan)', () => {
    const files = [];
    for (const dir of ['sandbox', 'execution']) for (const name of fs.readdirSync(path.join(ROOT, dir))) if (/\.(mjs|sh)$/u.test(name)) files.push(path.join(ROOT, dir, name));
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|#)/u.test(line)).join('\n');
        if (path.basename(file) === 'marker.mjs') continue;
        if (path.basename(file) === 'stage.sh') {
            // the shell mirror: exactly the same character set and length bounds as MARKER_PATTERN
            assert.ok(text.includes("*[!A-Za-z0-9_-]*"), 'stage.sh mirrors the character set');
            assert.ok(text.includes('-ge 8 ]') && text.includes('-le 64 ]'), 'stage.sh mirrors the length bounds');
            continue;
        }
        assert.ok(!/A-Za-z0-9_-\]\{|MARKER_RE|const\s+MARKER\b/u.test(text), `${path.basename(file)} defines its own marker check`);
    }
});

test('bwrapRealArgv: the marker is only the value of --hostname', () => {
    for (const command of [[], ['/bin/sh', '/s/stage.sh', 'final', '0,1,2', 'A', '/bin/echo']]) {
        const argv = bwrapRealArgv({ argsFd: 4, marker: DASHED, command });
        assert.equal(onlyAfter(argv, ['--hostname'], 'bwrapRealArgv'), 1);
    }
});

function launcherRig() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-marker-'));
    const view = createFakeView();
    const { spawnImpl, spawned } = createFakeSpawn(view, {});
    const launcher = createSandboxLauncher({
        view, spawnImpl, signal: () => {}, clock: fakeClock(), procMasks: MASKS, tools: TOOLS, supervisorPid: SUPERVISOR_PID,
        openNamespace: (pid, type) => { const entry = view.process(pid); return { inode: type === 'pid' ? entry.pidNs : entry.mntNs, close() {} }; }, stageScript: '/opt/robo-work/server/sandbox/stage.sh', arch: 'x86_64', fsImpl: fsWithBwrap
    });
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    return { dir, dirFd, spawned, launcher, done: () => { fs.closeSync(dirFd); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const specFor = (world, role) => {
    const base = { role, marker: DASHED, runtimeDir: world.dir, roBinds: [{ source: '/usr', dest: '/usr' }], env: {}, verifyTimeoutMs: 200, channelsDir: `${world.dir}/channels`, tmpDir: `${world.dir}/tmp` };
    if (role === 'workload' || role === 'terminal') {
        return { ...base, netns: NETNS, env: { HOME: '/home/robot' }, cwd: '/projects/a', argv: ['/usr/bin/echo', 'hi'], home: { path: world.dir, fd: world.dirFd },
            grants: [{ name: 'a', path: world.dir, fd: world.dirFd, mode: 'rw' }], stdio: ['ignore', 'ignore', 'ignore'] };
    }
    return { ...base, ...(role === 'endpoint' ? { netns: NETNS } : {}), cwd: '/', argv: ['/usr/local/bin/node', '/opt/x.mjs'],
        anchored: [{ name: 'session', path: world.dir, fd: world.dirFd, dest: '/session', mode: 'rw' }],
        binds: [{ source: `${world.dir}/channels`, dest: '/run/robo-work/channels', mode: 'rw' }], stdio: ['pipe', 'pipe', 'pipe'], roleFds: role === 'endpoint' ? { 3: 'pipe', 4: 'pipe' } : { 3: 'pipe' } };
};

for (const role of ['workload', 'terminal', 'orchestration', 'endpoint']) {
    test(`launcher ${role}: the setpriv chain carries the marker only as stage.sh's positional after 'prep'; nothing on disk is named by it`, async () => {
        const world = launcherRig();
        try {
            const sandbox = await world.launcher.launch(specFor(world, role));
            const [record] = world.spawned;
            assert.equal(record.file, 'setpriv');
            assert.equal(onlyAfter(record.args, ['prep'], role), 1);
            const prep = record.args.indexOf('prep');
            assert.equal(record.args[prep - 2], '/bin/sh');
            assert.ok(!record.args[prep - 1].startsWith('-'), 'prep follows the script path');
            // the marker is not a path component, option value or env value anywhere else (buffers, prep spec, options)
            assert.ok(!JSON.stringify(record.options).includes(DASHED));
            assert.ok(!record.fdContents.args.toString('utf8').includes(DASHED), 'not in the --args buffer');
            assert.ok(!record.args[prep + 5].includes(DASHED), 'not in the prep spec');
            const stageDir = path.join(world.dir, 'stage');
            if (fs.existsSync(stageDir)) assert.deepEqual(fs.readdirSync(stageDir), [markerSlot(DASHED)]);
            assert.deepEqual(fs.readdirSync(path.join(world.dir, 'ctl')), [], 'descriptor files are unlinked');
            await sandbox.release();
        } finally { world.done(); }
    });
}

test('markerSlot: an opaque rw<16hex> name that never contains the marker', () => {
    assert.match(markerSlot(DASHED), /^rw[0-9a-f]{16}$/u);
    assert.notEqual(markerSlot(DASHED), markerSlot(DASHED + 'x'));
    assert.equal(markerSlot(DASHED), markerSlot(DASHED));
});

test('anchor process (executionSupervisor): the marker is the positional after the fixed `sh -c <script> rw-anchor`', async () => {
    const view = createFakeView();
    const spawned = [];
    const spawnImpl = (file, args, options) => {
        const child = new EventEmitter();
        child.pid = 6000;
        child.stdin = new PassThrough();
        child.kill = () => true;
        view.add({ pid: child.pid, ppid: SUPERVISOR_PID, cmdline: ['/bin/sh', '-c', 'script', 'rw-anchor', args.at(-1)] });
        spawned.push({ file, args, options });
        return child;
    };
    const supervisor = createExecutionSupervisor({
        launcher: { launch: async () => { throw new Error('no launch'); } }, view, spawnImpl, admission: { inventory: [], streamDirectory: '/stream' }, roles: { orchestration: {}, endpoint: {}, workload: {} },
        supervisorPid: SUPERVISOR_PID, limits: {}
    });
    await supervisor.create({ kind: 'keeper', resourceId: 'k1', marker: DASHED, locator: {} });
    const [{ file, args }] = spawned;
    assert.equal(file, 'setpriv');
    assert.equal(onlyAfter(args, ['rw-anchor'], 'anchor'), 1);
    const c = args.indexOf('-c');
    assert.deepEqual(args.slice(c - 2, c), ['--', '/bin/sh']);
    assert.ok(!args[c + 1].includes(DASHED), 'the script text is fixed');
    assert.equal(args[c + 2], 'rw-anchor');
});

test('stage.sh: every use of $marker is a positional (prep $2, node script argument, bash re-exec) or the value of --hostname', () => {
    const lines = fs.readFileSync(STAGE, 'utf8').split('\n').filter((line) => line.includes('$marker') || line.includes('marker=') );
    const uses = lines.filter((line) => !/^\s*(case \$marker in|\[ "\$\{#marker\}")/u.test(line) && !/marker=\$2/u.test(line));
    assert.equal(uses.length, 3, uses.join('\n'));
    assert.ok(uses.some((line) => /exec \/bin\/bash "\$0" prep "\$marker"/u.test(line)), 're-exec: after the script and the prep subcommand');
    assert.ok(uses.some((line) => /node "\$dir\/sandboxPrep\.mjs" "\$marker" "\$prepspec"/u.test(line)), 'node: after the script name');
    assert.ok(uses.some((line) => /--unshare-uts --hostname \\"\\\$marker\\" --args/u.test(line)), 'bwrap: only --hostname value');
});

test('stage.sh run with stub binaries and a dashed marker: node script and bwrap see it only as argv[1] and after --hostname; bash re-exec keeps it after prep', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-marker-stage-'));
    try {
        const stage = path.join(dir, 'stage.sh');
        fs.writeFileSync(stage, fs.readFileSync(STAGE, 'utf8').replace('/usr/bin/bwrap', path.join(dir, 'fake-bwrap')), { mode: 0o755 });
        fs.writeFileSync(path.join(dir, 'sandboxPrep.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(dir, 'prep.argv'))}, JSON.stringify(process.argv.slice(1)));`);
        fs.writeFileSync(path.join(dir, 'fake-bwrap'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
        for (const grants of ['', '3']) {
            const file = path.join(dir, 'f');
            fs.writeFileSync(file, 'x');
            const fd = fs.openSync(file, 'r');
            try {
                const r = spawnSync('/bin/sh', [stage, 'prep', DASHED, String(process.pid), grants, '4', '{"s":1}', '--', '/bin/cmd', '-x'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', ...(grants ? [fd] : [])] });
                assert.equal(r.status, 0, r.stderr);
                const nodeArgv = JSON.parse(fs.readFileSync(path.join(dir, 'prep.argv'), 'utf8'));
                assert.equal(nodeArgv[0], path.join(dir, 'sandboxPrep.mjs'));
                assert.equal(nodeArgv[1], DASHED, 'the first argument of the node script');
                const bwrapArgv = r.stdout.split('\n').filter(Boolean);
                assert.equal(onlyAfter(bwrapArgv, ['--hostname'], `bwrap (grants=${JSON.stringify(grants)})`), 1);
                assert.deepEqual(bwrapArgv.slice(0, 3), ['--unshare-uts', '--hostname', DASHED]);
            } finally { fs.closeSync(fd); }
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
