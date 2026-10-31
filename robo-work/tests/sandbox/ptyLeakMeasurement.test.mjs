import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { captureOpacityDiagnostic, createObservationLog, heldRoleArgv, measureFixture, readIdentityObservation, validateHeld } from './live/ptyLeakMeasurement.mjs';
import { createSampler, nodePtyPreload, validateWatchFinish } from './live/ptyleak.mjs';

const identity = (pid, startTime = '1') => ({ pid, startTime, state: 'S', threads: 1 });

test('opacity access context retains only ownership, credentials and user namespace evidence within existing budgets', () => {
    let operations = 0;
    const io = {
        readFileSync: (file) => {
            operations += 1;
            if (file.endsWith('_map')) return '         0       1000          1\n';
            return file === '/proc/self/status'
                ? 'Name:\tprivate command\nCapEff:\t00000000802415fb\nNoNewPrivs:\t0\nPrivate:\tcredential\n'
                : 'Uid:\t1000\t1001\t1002\t1003\nNoNewPrivs:\t1\nPrivate:\tcredential\n';
        },
        readlinkSync: (file) => { operations += 1; return file === '/proc/self/ns/user' ? 'user:[4026533179]' : 'user:[4026533180]'; },
        statSync: () => { operations += 1; return { uid: 1000, gid: 1001, mode: 0o40500 }; },
        opendirSync: () => { operations += 1; return { readSync: () => { operations += 1; return null; }, closeSync() {} }; },
    };
    const options = { pid: 20, sampleTime: 1n, before: identity(20), after: identity(20), scanIdentity: identity(20),
        failure: { syscall: 'readdir', relativePath: '20/fd', errno: 'EACCES' }, io, now: () => 1n };
    const context = captureOpacityDiagnostic(options).accessContext;
    assert.equal(context.probe.uid, process.getuid());
    assert.equal(context.probe.euid, process.geteuid());
    assert.deepEqual(context.probe.status, { ok: true, CapEff: '00000000802415fb', NoNewPrivs: 0 });
    assert.deepEqual(context.target.status, { ok: true, Uid: [1000, 1001, 1002, 1003], NoNewPrivs: 1 });
    assert.deepEqual(context.target.processDirectory, { ok: true, uid: 1000, gid: 1001, mode: '0500' });
    assert.deepEqual(context.target.fdDirectory, context.target.processDirectory);
    assert.deepEqual(context.probe.userNamespace, { ok: true, inode: '4026533179' });
    assert.deepEqual(context.target.userNamespace, { ok: true, inode: '4026533180' });
    assert.equal(context.sameUserNamespace, false);
    assert.deepEqual(context.probe.uidMap, { ok: true, complete: true, ranges: [[0, 1000, 1]] });
    assert.deepEqual(context.target.gidMap, context.probe.uidMap);
    assert.doesNotMatch(JSON.stringify(context), /private command|credential|Private/u);
    operations = 0;
    const bounded = captureOpacityDiagnostic({ ...options, limits: { reads: 2 } });
    assert.equal(operations, 2);
    assert.equal(bounded.reads, 2);
    assert.equal(bounded.incomplete, true);
    assert.ok(bounded.truncated.includes('read-limit'));
    assert.deepEqual(bounded.accessContext.target.fdDirectory, { ok: false, syscall: 'stat', relativePath: '20/fd', incomplete: true });
    const denied = captureOpacityDiagnostic({ ...options, io: { ...io,
        statSync: () => { throw Object.assign(new Error('private detail'), { code: 'EACCES' }); },
        readlinkSync: () => '/private/credential',
        readFileSync: () => 'Uid:\t0\t0\t0\t0\nNoNewPrivs:\t2\nCapEff:\tinvalid\n',
    } });
    assert.equal(denied.incomplete, true);
    assert.deepEqual(denied.accessContext.target.fdDirectory, { ok: false, syscall: 'stat', relativePath: '20/fd', errno: 'EACCES' });
    assert.equal(denied.accessContext.sameUserNamespace, null);
    assert.equal(denied.accessContext.target.status.reason, 'invalid-status');
    assert.equal(denied.accessContext.probe.userNamespace.reason, 'invalid-user-namespace');
    assert.doesNotMatch(JSON.stringify(denied), /private detail|credential|\/private\//u);
    const manyRanges = captureOpacityDiagnostic({ ...options, io: { ...io,
        readFileSync: (file) => file.endsWith('_map') ? '0 1000 1\n'.repeat(9) : io.readFileSync(file),
    } });
    assert.equal(manyRanges.accessContext.target.uidMap.ranges.length, 8);
    assert.equal(manyRanges.accessContext.target.uidMap.complete, false);
    assert.ok(manyRanges.truncated.includes('id-map-line-limit'));
});

test('first opacity diagnostics retain bounded thread identity and fd outcomes without private paths or file contents', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-opacity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stat = (tid, state) => {
        const fields = [state, ...Array(16).fill('0'), '2', '0', '123'];
        fields[6] = '4194368';
        return `${tid} (${tid === 21 ? 'iou-wrk-21' : 'private command'}) ${fields.join(' ')}\n`;
    };
    for (const [tid, state] of [[20, 'Z'], [21, 'S']]) {
        const dir = path.join(root, '20/task', String(tid));
        fs.mkdirSync(path.join(dir, 'fd'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'stat'), stat(tid, state));
        fs.writeFileSync(path.join(dir, 'status'), 'Name:\tprivate command\nFDSize:\t64\nTgid:\t20\nUid:\t1000\t1000\t1000\t1000\nPrivate:\tcredential\n');
        fs.symlinkSync('/private/credential-path', path.join(dir, 'fd/3'));
        fs.symlinkSync('/dev/pts/ptmx', path.join(dir, 'fd/4'));
    }
    const options = { pid: 20, sampleTime: 77n, before: identity(20), after: identity(20), scanIdentity: identity(20),
        failure: { syscall: 'readdir', relativePath: '20/fd', errno: 'EACCES' }, procRoot: root, now: () => 100n };
    const diagnostic = captureOpacityDiagnostic(options);
    assert.equal(diagnostic.sampleTimeNs, '77');
    assert.deepEqual(diagnostic.failure, options.failure);
    assert.deepEqual(diagnostic.tids.map((entry) => entry.before.identity.state).sort(), ['S', 'Z']);
    assert.ok(diagnostic.tids.every((entry) => entry.before.identity.startTime === '123' && entry.after.identity.threads === 2));
    assert.ok(diagnostic.tids.every((entry) => entry.before.flags === 4194368 && entry.after.flags === 4194368));
    assert.deepEqual(diagnostic.tids.map((entry) => [entry.tid, entry.before.ioWorkerComm]).sort(), [[20, false], [21, true]]);
    assert.ok(diagnostic.tids.every((entry) => JSON.stringify(entry.statusBefore) === JSON.stringify({ ok: true, FDSize: 64, Tgid: 20, Uid: [1000, 1000, 1000, 1000] })
        && JSON.stringify(entry.statusBefore) === JSON.stringify(entry.statusAfter)));
    assert.ok(diagnostic.tids.every((entry) => entry.fdRead.complete && entry.fds.length === 2));
    assert.equal(diagnostic.tids[0].fds.find((entry) => entry.fd === 3).link.ptyMaster, false);
    assert.ok(diagnostic.tids[0].fds.find((entry) => entry.fd === 4).ptyIdentity);
    assert.doesNotMatch(JSON.stringify(diagnostic), /credential|private command|\/private\//u);
    const limited = captureOpacityDiagnostic({ ...options, limits: { tids: 1, fds: 1 } });
    assert.equal(limited.incomplete, true);
    assert.ok(limited.truncated.includes('tid-limit'));
    assert.ok(limited.truncated.includes('fd-limit'));
    assert.equal(limited.tids.length, 1);
    assert.equal(limited.tids[0].fds.length, 1);
    const readBound = captureOpacityDiagnostic({ ...options, limits: { reads: 2 } });
    assert.equal(readBound.reads, 2);
    assert.ok(readBound.truncated.includes('read-limit'));
    let tick = 0n;
    const timed = captureOpacityDiagnostic({ ...options, now: () => tick++, limits: { elapsedNs: 1 } });
    assert.equal(timed.reads, 0);
    assert.ok(timed.truncated.includes('cooperative-time-limit'));
    const vanished = captureOpacityDiagnostic({ ...options, pid: 999 });
    assert.deepEqual(vanished.taskRead, { ok: false, syscall: 'opendir', relativePath: '999/task', errno: 'ENOENT' });
    assert.equal(vanished.incomplete, true);
});

test('sampler captures opacity once per identity without giving readable diagnostic threads coverage or clearing failures', () => {
    let table = null;
    let current = { ...identity(21), state: 'Z', threads: 2 };
    let captures = 0;
    const inputs = [];
    let pidIdentityReads = 0;
    const sampler = createSampler({ supervisorPid: 10, masters: [], readers: {
        listPids: () => [10, 20, 21], ppidOf: (pid) => pid === 21 ? 20 : 10,
        cmdlineOf: (pid) => pid === 20 ? ['bwrap', '--unsetenv', 'reservation0001', '--', 'role-orchestration'] : ['node'],
        pidNsOf: () => 'diagnostic-fixture-namespace',
        identity: (pid) => { if (pid === 21) pidIdentityReads += 1; return pid === 21 ? current : identity(pid); },
        fdsOf: (pid) => pid === 21 ? table : [], fdError: () => current === null ? 'ENOENT' : 'EACCES', diagnosticNow: () => 123n,
        fdFailure: () => ({ syscall: 'readdir', relativePath: '21/fd', errno: 'EACCES' }),
        captureOpacityDiagnostic: (input) => {
            captures += 1;
            inputs.push(input);
            return { ...input, sampleTime: String(input.sampleTime), tids: [{ fdRead: { ok: true } }] };
        },
    } });
    sampler.sample();
    assert.equal(inputs[0].before.state, 'Z');
    assert.equal(inputs[0].after.threads, 2);
    assert.equal(inputs[0].sampleTime, 123n);
    assert.ok(inputs[0].ancestry.some((entry) => entry.marker === 'reservation0001' && entry.identity.pid === 20));
    assert.equal(pidIdentityReads, 3, 'scan identity plus immediate diagnostic bracket');
    assert.equal(sampler.seen.orchestration.has('21:1'), false, 'readable threads are diagnostic only');
    sampler.sample();
    assert.equal(captures, 1);
    const first = sampler.opacityDiagnostics.get('21:1');
    table = []; sampler.sample();
    current = null; table = null; sampler.sample();
    current = identity(21, '2'); table = []; sampler.sample();
    assert.equal(sampler.lastUnreadable.has('21:1'), true);
    assert.equal(sampler.opacityDiagnostics.get('21:1'), first);
    assert.equal(captures, 1);
    table = null;
    sampler.sample();
    assert.equal(captures, 2);
    assert.equal(sampler.lastUnreadable.size, 2);
});

test('diagnostic collector errors and identity cap cannot remove failures or add coverage', () => {
    let startTime = 0;
    let captures = 0;
    const sampler = createSampler({ supervisorPid: 10, masters: [], readers: {
        listPids: () => [10, 20], ppidOf: () => 10, cmdlineOf: () => ['node', 'sandboxPrep.mjs'],
        pidNsOf: () => 'diagnostic-fixture-namespace', identity: (pid) => identity(pid, String(startTime)),
        fdsOf: () => null, fdError: () => 'EACCES',
        captureOpacityDiagnostic: () => { captures += 1; throw Object.assign(new Error('private failure detail'), { code: 'EIO' }); },
    } });
    for (startTime = 1; startTime <= 25; startTime += 1) sampler.sample();
    assert.equal(sampler.lastUnreadable.size, 25);
    assert.equal(sampler.opacityDiagnostics.size, 20);
    assert.equal(captures, 20);
    assert.ok(Object.values(sampler.seen).every((seen) => seen.size === 0));
    assert.deepEqual([...sampler.opacityDiagnostics.values()].map((entry) => entry.reason), Array(20).fill('diagnostic-collection-failed'));
    assert.doesNotMatch(JSON.stringify([...sampler.opacityDiagnostics.values()]), /private failure detail/u);
});

test('actual node-pty data-URL preload loads an absolute CommonJS package and invokes its spawn', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rw-pty-loader ' "));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
    fs.writeFileSync(path.join(root, 'dependency.cjs'), "module.exports = 'fixture-loaded';\n");
    fs.writeFileSync(path.join(root, 'index.cjs'), "exports.spawn = (command, args, options) => ({ command, args, options, marker: require('./dependency.cjs') });\n");
    const result = spawnSync(process.execPath, ['--import', nodePtyPreload(root), '--input-type=module', '-e',
        'console.log(JSON.stringify(globalThis.__ptyleakA));'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const loaded = JSON.parse(result.stdout);
    assert.equal(loaded.marker, 'fixture-loaded');
    assert.equal(loaded.command, '/bin/sh');
    assert.deepEqual(loaded.args, ['-c', 'sleep 3600']);
    assert.deepEqual(loaded.options, { name: 'xterm', cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' } });
});

test('measurement begins before launch, validates held identities, freezes sampling before teardown, then awaits cleanup', async () => {
    const events = [];
    const ready = Promise.resolve({ held: [identity(20)] });
    await measureFixture({
        sample: () => events.push('sample'), ready,
        start: () => events.push('launch'),
        validate: () => { events.push('validate'); return []; },
        finish: (validated) => { assert.equal(validated, true); events.push('teardown-ack'); },
        cleanup: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); events.push('cleanup-complete'); },
        intervalMs: 1,
    });
    assert.equal(events[0], 'sample');
    assert.equal(events[1], 'launch');
    assert.deepEqual(events.slice(-4), ['sample', 'validate', 'teardown-ack', 'cleanup-complete']);
});

test('readiness deadline fails and still grants teardown and awaits cleanup', async () => {
    const events = [];
    await assert.rejects(measureFixture({
        sample: () => events.push('sample'), ready: new Promise(() => {}), start: () => {},
        validate: () => assert.fail('must not validate missing readiness'),
        finish: (validated) => { assert.equal(validated, false); events.push('finish'); }, cleanup: async () => events.push('cleanup'), deadlineMs: 10,
    }), /readiness deadline/u);
    assert.deepEqual(events.slice(-2), ['finish', 'cleanup']);
});

test('early fixture failure and cleanup failure cannot turn into a measurement success', async () => {
    let cleaned = false;
    await assert.rejects(measureFixture({ sample() {}, start() {}, ready: Promise.reject(new Error('early exit')),
        validate: () => [], finish() {}, cleanup: async () => { cleaned = true; } }), /early exit/u);
    assert.equal(cleaned, true);
    await assert.rejects(measureFixture({ sample() {}, start() {}, ready: Promise.resolve({}),
        validate: () => [], finish() {}, cleanup: async () => { throw new Error('cleanup remains'); } }), /cleanup remains/u);
});

test('live opaque evidence stays latched after readable samples, later death and PID reuse', () => {
    const log = createObservationLog();
    log.record({ before: identity(20), after: identity(20), kind: 'workload', table: null, errno: 'EACCES' });
    log.record({ before: identity(20), after: identity(20), kind: 'workload', table: [] });
    log.record({ before: identity(20), after: null, kind: 'workload', table: null, errno: 'ENOENT' });
    log.record({ before: identity(20, '2'), after: identity(20, '2'), kind: 'workload', table: [] });
    assert.equal(log.failures.size, 1);
    assert.equal(log.failures.get('20:1').errno, 'EACCES');
    const zombie = { ...identity(21), state: 'Z', threads: 2 };
    log.record({ before: zombie, after: zombie, kind: 'endpoint', table: null, errno: 'EACCES' });
    assert.equal(log.failures.size, 2, 'a zombie leader with another thread remains opaque');
});

test('identity change during the descriptor read fails; an already vanished process supplies no clean coverage', () => {
    const log = createObservationLog();
    assert.equal(log.record({ before: identity(20), after: identity(20, '2'), kind: 'prep', table: [] }), false);
    assert.equal(log.failures.size, 1);
    assert.equal(log.readable.size, 0);
    const vanished = createObservationLog();
    assert.equal(vanished.record({ before: null, after: null, kind: 'prep', table: null, errno: 'ENOENT' }), false);
    assert.equal(vanished.failures.size, 0);
    assert.equal(vanished.readable.size, 0);
});

test('finish rejects dead, unreadable, missing and reused held identities', () => {
    const held = [identity(20)];
    assert.deepEqual(validateHeld(held, { identity: (pid) => identity(pid), descriptors: () => [] }), []);
    for (const current of [null, identity(20, '2'), { ...identity(20), state: 'Z' }]) {
        assert.equal(validateHeld(held, { identity: () => current, descriptors: () => [] }).length, 1);
    }
    assert.equal(validateHeld(held, { identity: (pid) => identity(pid), descriptors: () => null }).length, 1);
    assert.equal(validateHeld([], { identity, descriptors: () => [] }).length, 1);
});

test('actual sampler latches an inherited master and an unknown-identity master, and never clears opacity', () => {
    const selfNs = fs.readlinkSync('/proc/self/ns/pid');
    let table = null;
    let startTime = '1';
    const sampler = createSampler({ supervisorPid: 10, masters: [{ dev: '1', ino: '2' }], readers: {
        listPids: () => [10, 20, 21], ppidOf: (pid) => pid === 21 ? 20 : 10,
        cmdlineOf: (pid) => pid === 20 ? ['/usr/bin/bwrap', '--unsetenv', 'reservation0001', '--', 'role-orchestration'] : ['node'],
        pidNsOf: (pid) => pid === 21 ? 'sandbox' : selfNs,
        identity: (pid) => identity(pid, pid === 21 ? startTime : '1'),
        fdsOf: (pid) => pid === 21 ? table : [], fdError: () => 'EACCES',
    } });
    sampler.sample();
    assert.equal(sampler.seen.orchestration.size, 0, 'unread tables do not provide coverage');
    assert.equal(sampler.lastUnreadable.size, 1);
    table = [{ fd: 40, target: '/dev/pts/ptmx', dev: '1', ino: '2' }, { fd: 41, target: '/dev/pts/ptmx', dev: null, ino: null }];
    sampler.sample();
    assert.deepEqual(sampler.violations[0].fds, [40]);
    assert.deepEqual(sampler.violations[0].suspectFds, [{ fd: 41, target: '/dev/pts/ptmx' }]);
    table = []; startTime = '2'; sampler.sample();
    assert.equal(sampler.lastUnreadable.size, 1);
    assert.equal(sampler.violations.length, 1);
});

test('controlled real watch requires exact ledger monitor identities plus every live role', () => {
    const marker = 'reservation0001';
    const entries = ['bwrap', 'orchestration', 'endpoint', 'workload'].map((kind, index) => ({ ...identity(20 + index), kind, marker }));
    entries.push({ ...identity(30), kind: 'bwrap', marker: 'terminalmarkerA' }, { ...identity(31), kind: 'terminal', marker: 'terminalmarkerA' },
        { ...identity(40), kind: 'bwrap', marker: 'terminalmarkerB' }, { ...identity(41), kind: 'terminal', marker: 'terminalmarkerB' });
    const sampler = { members: new Map(entries.map((entry) => [String(entry.pid), entry])) };
    const readers = { identity: (pid) => identity(pid), descriptors: () => [] };
    const monitors = [{ ...identity(20), marker, group: 'ai' }, { ...identity(30), marker: 'terminalmarkerA', group: 'terminal-a' },
        { ...identity(40), marker: 'terminalmarkerB', group: 'terminal-b' }];
    assert.deepEqual(validateWatchFinish(sampler, monitors, readers).failures, []);
    assert.ok(validateWatchFinish(sampler, [{ ...monitors[0], startTime: '2' }, ...monitors.slice(1)], readers).failures.length > 0);
    sampler.members.delete('23');
    assert.ok(validateWatchFinish(sampler, monitors, readers).failures.some((entry) => entry.kind === 'workload'));
    sampler.members.set('23', { ...identity(23), kind: 'workload', marker: 'backgroundutility' });
    assert.ok(validateWatchFinish(sampler, monitors, readers).failures.some((entry) => entry.group === 'ai' && entry.kind === 'workload'), 'another robot or utility cannot supply B coverage');
    assert.ok(validateWatchFinish(sampler, [], readers).failures.length > 0);
});

function historicalFinishFixture() {
    const entries = ['bwrap', 'orchestration', 'endpoint', 'workload'].map((kind, index) => ({ ...identity(20 + index), kind, marker: 'reservation0001' }));
    entries.push({ ...identity(30), kind: 'bwrap', marker: 'terminalmarkerA' }, { ...identity(31), kind: 'terminal', marker: 'terminalmarkerA' },
        { ...identity(40), kind: 'bwrap', marker: 'terminalmarkerB' }, { ...identity(41), kind: 'terminal', marker: 'terminalmarkerB' },
        { ...identity(50), kind: 'bwrap', marker: 'historicalmarker' }, { ...identity(52), kind: 'workload', marker: 'historicalmarker' });
    const historical = { ...identity(50), init: identity(51), marker: 'historicalmarker', group: 'ai', resourceKind: 'process-tree', retirementEligible: true };
    const monitors = [{ ...identity(20), marker: 'reservation0001', group: 'ai', resourceKind: 'endpoint', retirementEligible: false },
        { ...identity(30), marker: 'terminalmarkerA', group: 'terminal-a' }, { ...identity(40), marker: 'terminalmarkerB', group: 'terminal-b' }, historical];
    const sampler = { members: new Map(entries.map((entry) => [String(entry.pid), entry])), lastUnreadable: new Map(), violations: [], seen: { workload: new Set(['23:1', '52:1']) } };
    const readers = { identity: (pid) => pid >= 50 ? null : identity(pid), descriptors: () => [],
        identityObservation: () => ({ outcome: 'absent', errno: 'ENOENT' }) };
    return { sampler, monitors, readers, historical };
}

test('finish retires only positively bracketed eligible AI history while requiring every current live group', () => {
    const { sampler, monitors, readers, historical } = historicalFinishFixture();
    const verdict = validateWatchFinish(sampler, monitors, readers);
    assert.deepEqual(verdict.failures, []);
    assert.equal(verdict.retired.length, 1);
    assert.equal(verdict.retired[0].monitor, historical);
    assert.deepEqual(verdict.retired[0].before.map((entry) => entry.expected.pid), [50, 51, 50, 52]);
    assert.ok([...verdict.retired[0].before, ...verdict.retired[0].after].every((entry) => entry.outcome === 'absent' && entry.errno === 'ENOENT'));
    const reused = validateWatchFinish(sampler, monitors, { ...readers,
        identityObservation: (pid) => ({ outcome: 'present', identity: identity(pid, '2') }) });
    assert.deepEqual(reused.failures, []);
    assert.ok(reused.retired[0].after.every((entry) => entry.identity.startTime === '2'));
    const liveTree = { ...monitors[0], resourceKind: 'process-tree', retirementEligible: true, init: identity(21) };
    const mixed = validateWatchFinish(sampler, [...monitors, liveTree], { ...readers,
        identityObservation: (pid) => pid < 50 ? { outcome: 'present', identity: identity(pid) } : readers.identityObservation() });
    assert.deepEqual(mixed.failures, []);
    assert.equal(mixed.retired.length, 1, 'a current eligible process tree stays subject to strict held checks');
    assert.ok(validateWatchFinish(sampler, monitors, { ...readers, descriptors: (pid) => pid === 21 ? null : [] }).failures.length > 0);
    assert.ok(validateWatchFinish(sampler, [historical], readers).failures.some((entry) => entry.kind === 'endpoint'));
    sampler.members.delete('23');
    assert.ok(validateWatchFinish(sampler, monitors, readers).failures.some((entry) => entry.group === 'ai' && entry.kind === 'workload'));
    sampler.members.delete('31');
    assert.ok(validateWatchFinish(sampler, monitors, readers).failures.some((entry) => entry.group === 'terminal-a'));
});

test('historical retirement refuses unknown metadata, partial death, unproved PID reuse and endpoint or terminal eligibility', () => {
    const { sampler, monitors, readers, historical } = historicalFinishFixture();
    const refuse = (candidate, proof = readers.identityObservation) => {
        const verdict = validateWatchFinish(sampler, candidate, { ...readers, identityObservation: proof });
        assert.ok(verdict.failures.length > 0);
        assert.equal(verdict.retired?.length ?? 0, 0);
    };
    for (const outcome of [null, { outcome: 'unknown', errno: 'EACCES' }, { outcome: 'absent' },
        { outcome: 'absent', errno: 'EACCES' }, { outcome: 'present', identity: { pid: 50 } }]) refuse(monitors, () => outcome);
    for (const alive of [50, 51, 52]) refuse(monitors, (pid) => pid === alive ? { outcome: 'present', identity: identity(pid) } : readers.identityObservation());
    let reads = 0;
    refuse(monitors, (pid) => ++reads <= 4 ? { outcome: 'present', identity: identity(pid, '2') } : { outcome: 'unknown' });
    for (const changed of [{ retirementEligible: false }, { init: null }, { init: { pid: 51 } }, { resourceKind: 'endpoint' },
        { group: 'terminal-a' }, { retirementEligible: 'true' }]) refuse([...monitors.slice(0, -1), { ...historical, ...changed }]);
    for (const errno of ['ENOENT', 'ESRCH', 'EACCES', 'EIO']) {
        const observed = readIdentityObservation(50, '/fake', { readFileSync: () => { throw Object.assign(new Error('private'), { code: errno }); } });
        assert.equal(observed.outcome, ['ENOENT', 'ESRCH'].includes(errno) ? 'absent' : 'unknown');
        assert.doesNotMatch(JSON.stringify(observed), /private/u);
    }
    assert.equal(readIdentityObservation(50, '/fake', { readFileSync: () => 'malformed' }).outcome, 'unknown');
    const stat = `50 (private) ${['S', ...Array(18).fill('0'), '2'].join(' ')}`;
    assert.equal(readIdentityObservation(50, '/fake', { readFileSync: () => stat }).identity.startTime, '2');
    for (const kind of ['orchestration', 'endpoint']) {
        sampler.members.set('53', { ...identity(53), kind, marker: historical.marker });
        refuse(monitors);
    }
    sampler.members.delete('53');
    sampler.members.set('52', { ...identity(52), kind: 'sandboxOther', marker: historical.marker });
    refuse(monitors);
    sampler.members.delete('52');
    refuse(monitors);
    const oversized = new Map(Array.from({ length: 513 }, (_, index) => [String(index), { ...identity(100 + index), marker: historical.marker }]));
    sampler.members = oversized;
    assert.ok(validateWatchFinish(sampler, monitors, readers).failures.some((entry) => /bound/u.test(entry.reason)));
});

test('historical receipts cannot clear opaque evidence, leaks, sampled members or clean coverage', () => {
    const { sampler, monitors, readers } = historicalFinishFixture();
    sampler.lastUnreadable.set('52:1', { ...identity(52), kind: 'workload', errno: 'EACCES' });
    sampler.violations.push({ pid: 52, kind: 'workload', fds: [40] });
    const before = JSON.stringify({ members: [...sampler.members], failures: [...sampler.lastUnreadable], violations: sampler.violations, seen: [...sampler.seen.workload] });
    const verdict = validateWatchFinish(sampler, monitors, readers);
    assert.deepEqual(verdict.failures, [], 'only finish liveness passes');
    assert.equal(verdict.retired.length, 1);
    assert.equal(JSON.stringify({ members: [...sampler.members], failures: [...sampler.lastUnreadable], violations: sampler.violations, seen: [...sampler.seen.workload] }), before);
    assert.equal(sampler.lastUnreadable.size, 1);
    assert.deepEqual(sampler.violations[0].fds, [40]);
});

test('real inherited-master positive control still detects fd40', () => {
    const probe = fileURLToPath(new URL('./live/ptyleak.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [probe, '--detector-self-test'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout);
    assert.deepEqual(evidence.errors, []);
    assert.deepEqual(evidence.checks['C positive control: a child that inherited the master is detected'].fds, [40]);
});

test('real fixture refuses a missing start grant without creating or launching resources', () => {
    const fixture = fileURLToPath(new URL('./live/ptyLeakFixture.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [fixture], { input: 'abort\n', encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1, result.stderr);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.ok, false);
    assert.match(evidence.errors[0], /aborted during start/u);
    assert.deepEqual(evidence.cleanup, {});
    assert.equal(evidence.retainedFixture, undefined);
});

test('actual held workload/orchestration argv executes its program and produces a parseable ready line before exit', async () => {
    const fdTrim = fileURLToPath(new URL('../../server/sandbox/fdTrim.mjs', import.meta.url));
    for (const role of ['workload', 'orchestration']) {
        const argv = heldRoleArgv(role, { node: process.execPath, fdTrim });
        const child = spawn(argv[0], argv.slice(1), { env: role === 'workload' ? {} : { RW_FD_ALLOW: '0,1,2,3' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        let exited = false;
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const closed = new Promise((resolve) => child.once('close', () => { exited = true; resolve(); }));
        const until = Date.now() + 3000;
        try {
            while (!stdout.includes('\n') && !exited && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
            assert.equal(exited, false, stderr);
            assert.ok(stdout.includes('\n'), `${role} generated body must frame readiness with a newline: ${stderr}`);
            const snapshot = JSON.parse(stdout.split('\n')[0]);
            assert.equal(snapshot.role, `role-${role}`);
            assert.ok(Array.isArray(snapshot.fds) && snapshot.fds.some((entry) => entry.startsWith('1->')));
        } finally { child.kill('SIGKILL'); await closed; }
    }
});

test('controlled watch deadline without an explicit finish cannot report success', async (t) => {
    const master = fs.openSync('/dev/ptmx', 'r+');
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: ['ignore', 'ignore', 'ignore', ...Array(37).fill('ignore'), master] });
    fs.closeSync(master);
    const workerClosed = new Promise((resolve) => worker.once('close', resolve));
    t.after(async () => { worker.kill('SIGKILL'); await workerClosed; });
    const probe = fileURLToPath(new URL('./live/ptyleak.mjs', import.meta.url));
    const watcher = spawn(process.execPath, [probe, '--watch', '1', '--controlled', '--worker-pid', String(worker.pid)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const watcherClosed = new Promise((resolve) => watcher.once('close', (code) => resolve(code)));
    const deadline = setTimeout(() => watcher.kill('SIGKILL'), 5000);
    let stdout = ''; let stderr = '';
    watcher.stdout.on('data', (chunk) => { stdout += chunk; });
    watcher.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await watcherClosed;
    clearTimeout(deadline);
    watcher.stdin.destroy();
    assert.equal(code, 1, stderr);
    assert.match(stderr, /MEASUREMENT_READY/u);
    const evidence = JSON.parse(stdout);
    assert.equal(evidence.checks['C explicit finish before watch deadline'].ok, false);
    assert.ok(evidence.errors.includes('C explicit finish before watch deadline'));
});
