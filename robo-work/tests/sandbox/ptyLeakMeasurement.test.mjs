import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createObservationLog, heldRoleArgv, measureFixture, validateHeld } from './live/ptyLeakMeasurement.mjs';
import { createSampler, nodePtyPreload, validateWatchFinish } from './live/ptyleak.mjs';

const identity = (pid, startTime = '1') => ({ pid, startTime, state: 'S', threads: 1 });

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
