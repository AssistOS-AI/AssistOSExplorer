import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createObservationLog, processKey, proveExitTeardown, provePriorCleanSample, readIdentity } from './live/ptyLeakMeasurement.mjs';

const python = process.env.ROBO_WORK_TEST_PYTHON ?? 'python3';
const linuxOnly = { skip: process.platform !== 'linux' && 'requires Linux procfs', timeout: 15000 };
const postExecMarker = 'rw-exec-window-postexec';
const prerequisiteMessage = 'execWindow.test.mjs requires CPython 3.8+ with ctypes, threading and system pthread_exit; install the platform Python 3 package or set ROBO_WORK_TEST_PYTHON; see robo-work/dependencies.md';
const helper = String.raw`
import ctypes
import os
import signal
import sys
import threading

signal.alarm(8)
os.set_inheritable(40, False)
libc = ctypes.CDLL(None)
libc.pthread_exit.argtypes = [ctypes.c_void_p]
libc.pthread_exit.restype = None
released = threading.Event()

def sibling():
    released.wait()
    command = os.read(0, 1)
    if command == b'E':
        program = "import os, time; os.write(1, b'EXEC_READY\\n'); time.sleep(10)"
        os.execve(sys.executable, [sys.executable, '-I', '-S', '-c', program, 'rw-exec-window-postexec'], {})
    elif command == b'D':
        os._exit(0)
    else:
        os._exit(5)

threading.Thread(target=sibling).start()
print('READY', flush=True)
if os.read(0, 1) != b'Z':
    os._exit(4)
released.set()
if sys.argv[1] == 'no-z':
    threading.Event().wait(10)
else:
    libc.pthread_exit(None)
os._exit(6)
`;

function requirePython(command) {
    const probe = spawnSync(command, ['-I', '-S', '-c', [
        'import ctypes, json, platform, signal, sys, threading',
        'assert sys.implementation.name == "cpython" and sys.version_info >= (3, 8)',
        'assert hasattr(ctypes.CDLL(None), "pthread_exit")',
        'print(json.dumps({"version": platform.python_version(), "executable": sys.executable, "libc": platform.libc_ver()}))',
    ].join('; ')], { encoding: 'utf8', timeout: 2000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    if (probe.error || probe.status !== 0) throw new Error(`${prerequisiteMessage} (${probe.error?.code ?? 'incompatible interpreter'})`);
    try { return JSON.parse(probe.stdout); }
    catch { throw new Error(`${prerequisiteMessage} (invalid prerequisite response)`); }
}

async function until(check, description, timeoutMs = 3000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const value = check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw Object.assign(new Error(`window not reproduced: ${description}`), { code: 'WINDOW_NOT_REPRODUCED' });
}

function fdTable(root) {
    try { return { entries: fs.readdirSync(`${root}/fd`), errno: null }; }
    catch (error) { return { entries: null, errno: error.code }; }
}

function descriptor(file) {
    const target = fs.readlinkSync(file);
    const stat = fs.statSync(file, { bigint: true });
    return { master: /(?:^|\/)ptmx$/u.test(target), dev: String(stat.dev), ino: String(stat.ino), characterDevice: stat.isCharacterDevice() };
}

// The main thread deliberately exits before its sibling execs. This holds the Z window without a timing race;
// it demonstrates a counterexample to clearing opacity, not the cause of any particular live measurement.
async function runFixture(mode, { opacityTimeoutMs = 3000 } = {}) {
    const prerequisite = requirePython(python); // Before opening a PTY or starting the fixture.
    const master = fs.openSync('/dev/ptmx', fs.constants.O_RDWR | fs.constants.O_NOCTTY);
    let child;
    let completed;
    let expected;
    let result;
    let output = '';
    try {
        child = spawn(prerequisite.executable, ['-I', '-S', '-u', '-c', helper, mode], {
            stdio: ['pipe', 'pipe', 'pipe', ...Array(37).fill('ignore'), master],
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        });
        completed = new Promise((resolve) => {
            child.once('exit', (code, signal) => resolve({ code, signal }));
            child.once('error', (error) => resolve({ error: error.code }));
        });
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.resume();
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        expected = await until(() => readIdentity(child.pid), 'owned child identity');
        await until(() => output.includes('READY'), 'helper readiness');
        const initial = readIdentity(child.pid);
        assert.equal(processKey(initial), processKey(expected));
        const inherited = descriptor(`/proc/${child.pid}/fd/40`);
        assert.equal(inherited.master, true, 'the child must inherit the original open PTY master');
        assert.equal(inherited.characterDevice, true);
        assert.deepEqual(inherited, descriptor(`/proc/self/fd/${master}`));
        const flags = /^flags:\s+(\d+)$/mu.exec(fs.readFileSync(`/proc/${child.pid}/fdinfo/40`, 'utf8'))?.[1];
        assert.ok(flags, 'read fd40 flags before main-thread exit');
        assert.notEqual(BigInt(`0o${flags}`) & 0o2000000n, 0n, 'the inherited master must be close-on-exec');
        const priorClean = provePriorCleanSample(initial, { masters: [inherited] });
        assert.equal(priorClean.ok, false, 'the real inherited master cannot establish clean history');
        assert.ok(priorClean.leaks.some((entry) => entry.fd === 40));
        child.stdin.write('Z');
        const before = await until(() => {
            const identity = readIdentity(child.pid);
            return identity?.state === 'Z' && identity.threads === 2 && identity;
        }, 'Z leader with a live sibling', opacityTimeoutMs);
        const table = fdTable(`/proc/${child.pid}`);
        const after = readIdentity(child.pid);
        assert.equal(processKey(before), processKey(expected));
        assert.deepEqual(after, before, 'the opaque read must be bracketed by the same held Z identity');
        assert.equal(table.entries, null, 'a readable leader does not reproduce opacity');
        assert.equal(table.errno, 'EACCES');
        const sibling = fs.readdirSync(`/proc/${child.pid}/task`).map(Number).filter((tid) => tid !== child.pid)
            .map((tid) => readIdentity(tid, `/proc/${child.pid}/task`)).find((identity) => identity && !['Z', 'X', 'x'].includes(identity.state));
        assert.ok(sibling, 'a live sibling must coexist with the zombie leader');
        assert.deepEqual(descriptor(`/proc/${child.pid}/task/${sibling.pid}/fd/40`), inherited,
            'the live sibling must still hold the original master during leader opacity');
        const observations = createObservationLog();
        const exitTeardown = proveExitTeardown(before);
        assert.equal(exitTeardown.ok, false, 'a live sibling with an mm must reject the teardown exception');
        assert.equal(observations.record({ before, after, kind: 'workload', table: null, errno: table.errno, exitTeardown }), false);
        const key = processKey(before);
        assert.equal(observations.failures.get(key)?.errno, 'EACCES');
        const releasedAt = performance.now();
        child.stdin.write(mode === 'exec' ? 'E' : 'D');
        let final;
        if (mode === 'exec') {
            await until(() => output.includes('EXEC_READY'), 'post-exec readiness');
            const cleanBefore = readIdentity(child.pid);
            const clean = fdTable(`/proc/${child.pid}`);
            const cleanAfter = readIdentity(child.pid);
            assert.equal(processKey(cleanBefore), key, 'exec must retain the original pid:startTime');
            assert.equal(processKey(cleanAfter), key);
            assert.equal(cleanBefore.threads, 1);
            assert.equal(cleanAfter.threads, 1);
            assert.ok(!['Z', 'X', 'x'].includes(cleanBefore.state));
            assert.ok(!['Z', 'X', 'x'].includes(cleanAfter.state));
            assert.ok(clean.entries, 'the post-exec table must be readable');
            assert.equal(clean.entries.includes('40'), false);
            assert.ok(clean.entries.every((fd) => !descriptor(`/proc/${child.pid}/fd/${fd}`).master));
            assert.equal(fs.readlinkSync(`/proc/${child.pid}/exe`), fs.realpathSync(prerequisite.executable));
            assert.equal(fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0').includes(postExecMarker), true,
                'the surviving sibling must actually exec the marked replacement');
            assert.equal(observations.record({ before: cleanBefore, after: cleanAfter, kind: 'workload', table: clean.entries }), true);
            assert.equal(observations.readable.has(key), true);
            final = { identity: cleanBefore, table: clean.entries };
        } else {
            const exit = await completed;
            assert.deepEqual(exit, { code: 0, signal: null });
            assert.equal(readIdentity(child.pid), null);
            const gone = fdTable(`/proc/${child.pid}`);
            assert.equal(gone.errno, 'ENOENT');
            observations.record({ before, after: null, kind: 'workload', table: null, errno: gone.errno });
            final = { identity: null, errno: gone.errno };
        }
        assert.equal(observations.failures.size, 1, 'later readability or death cannot erase opacity');
        assert.equal(observations.failures.get(key)?.errno, 'EACCES');
        result = { python: prerequisite.version, libc: prerequisite.libc, key, inherited, flags, opaque: before,
            sibling, exitTeardownReason: exitTeardown.reason, final, finalAfterReleaseMs: performance.now() - releasedAt, retainedFailures: observations.failures.size };
    } finally {
        try {
            child?.stdin?.destroy();
            const current = child && readIdentity(child.pid);
            if (expected && current && processKey(current) === processKey(expected)) child.kill('SIGKILL');
            if (completed) {
                const exit = await completed;
                assert.equal(readIdentity(child.pid), null, 'the exact owned child must be reaped');
                if (result) result.cleanup = exit;
            }
        } finally { fs.closeSync(master); }
    }
    return result;
}

test('exec-window prerequisite failure names Python and its remediation', () => {
    const missing = path.join(os.tmpdir(), `rw-missing-python-${process.pid}-${Date.now()}`);
    assert.equal(fs.existsSync(missing), false);
    assert.throws(() => requirePython(missing), /requires CPython 3\.8\+.*ROBO_WORK_TEST_PYTHON.*dependencies\.md \(ENOENT\)/u);
});

test('opaque Z leader retains its failure after sibling exec removes the inherited master', linuxOnly, async (t) => {
    t.diagnostic(JSON.stringify(await runFixture('exec')));
});

test('opaque Z leader retains its failure after its master-holding sibling exits', linuxOnly, async (t) => {
    t.diagnostic(JSON.stringify(await runFixture('death')));
});

test('a helper without a Z window cannot report reproduction', linuxOnly, async () => {
    await assert.rejects(runFixture('no-z', { opacityTimeoutMs: 150 }),
        (error) => error.code === 'WINDOW_NOT_REPRODUCED' && error.message === 'window not reproduced: Z leader with a live sibling');
});
