// Linux-only tests of the keeper client and procView on the REAL /proc (keeper wire contract delta AC-15, NC-3b).
//
// This file is deliberately NOT named *.test.mjs, so the Mac set ('robo-work/tests/**/*.test.mjs') never selects it. A
// Linux run selects it explicitly (A-3 on S4 r8). Every test first asserts that it runs on Linux and FAILS otherwise:
// nothing here skips. The exact test count is in keeperClient.linux-proc.expected.json; the Linux acceptance checks
// `# tests` equal to it, `# pass` equal to `# tests`, and zero fail, skip, cancelled and todo. The Mac-side test 'the
// Linux-only test file declares its exact test count' keeps the two in step.
//
// Scope: the host kernel and Node that run the file. The Box (AppArmor stacking, the qualifying Node, devpts and
// namespaces) is G1 work.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createGate } from '../../server/execution/gateProtocol.mjs';
import { createExecutionKeeper } from '../../server/execution/keeperClient.mjs';
import { createProcView, parseStatLine } from '../../server/execution/procView.mjs';
import { createWalker } from '../../server/execution/recoveryWalk.mjs';
import { findPython } from './helpers/topology.mjs';

const scmKeeper = fileURLToPath(new URL('./fixtures/scmKeeper.py', import.meta.url));
const clock = { now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
const descriptorCount = () => fs.readdirSync('/proc/self/fd').length;
const newId = () => crypto.randomBytes(16).toString('base64url');

function assertLinux() {
    assert.equal(process.platform, 'linux', 'keeperClient.linux-proc.mjs runs only on Linux; it fails, never skips, elsewhere');
}

async function waitFor(condition, timeoutMs = 5000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) { if (condition()) return true; await clock.sleep(10); }
    return condition();
}

function sleeper(context, marker, extraStdio = []) {
    const child = spawn(findPython(), ['-I', '-c', 'import os, sys, time\nif len(sys.argv) > 3: os.read(3, 1)\ntime.sleep(60)', '--reservation', marker, ...(extraStdio.length ? ['gated'] : [])],
        { stdio: ['ignore', 'ignore', 'ignore', ...extraStdio] });
    context.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
    return child;
}

test('platform guard: procView reads the real /proc of this process with canonical types', () => {
    assertLinux();
    const view = createProcView();
    const self = view.process(process.pid);
    assert.equal(self.pid, process.pid);
    assert.equal(self.startTime, parseStatLine(fs.readFileSync('/proc/self/stat', 'utf8')).startTime);
    assert.match(self.startTime, /^[0-9]+$/u);
    assert.equal(typeof self.pidNs, 'string');
    assert.deepEqual(view.selfNamespaces().pidNs, self.pidNs);
    assert.ok(view.listMounts().length > 0);
});

test('real /proc identity round trip: a committed {pid, startTime} is present while the child lives and absent after', async (t) => {
    assertLinux();
    const marker = newId();
    const child = sleeper(t, marker);
    const view = createProcView();
    assert.equal(await waitFor(() => view.process(child.pid)?.cmdline.includes(marker)), true);
    const identity = view.processIdentity(child.pid);
    const walker = createWalker({ view, clock, releaseDeadlineMs: 2000, pollMs: 20, keeperRecord: () => null });
    const blocker = { kind: 'keeper', identity: { pid: child.pid, startTime: identity.startTime }, locator: { marker } };
    assert.equal(walker.prove(blocker).absent, false);
    assert.equal(walker.prove({ ...blocker, identity: { pid: child.pid, startTime: String(BigInt(identity.startTime) + 1n) } }).absent, true, 'another start time is another process');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(await waitFor(() => walker.prove(blocker).absent), true);
});

test('a real gated child is found by its marker before commit and is absent after its gate is closed', async (t) => {
    assertLinux();
    const marker = newId();
    const child = sleeper(t, marker, ['pipe']);
    const gate = createGate(child.stdio[3]);
    const view = createProcView();
    const walker = createWalker({ view, clock, releaseDeadlineMs: 2000, pollMs: 20, keeperRecord: () => null });
    const blocker = { kind: 'keeper', identity: null, locator: { marker } };
    assert.equal(await waitFor(() => !walker.prove(blocker).absent), true, 'present by marker while waiting at its gate');
    child.kill('SIGKILL');
    await gate.abort();
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(await waitFor(() => walker.prove(blocker).absent), true);
});

test('SCM_RIGHTS from the keeper are contained', async (t) => {
    assertLinux();
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rwscm-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // An absolute interpreter: the keeper is spawned with an empty environment (R1.7).
    const executable = path.join(dir, 'keeper');
    fs.writeFileSync(executable, `#!${findPython()} -I\nimport runpy\nrunpy.run_path(${JSON.stringify(scmKeeper)}, run_name='__main__')\n`, { mode: 0o755 });
    const losses = [];
    const view = createProcView();
    const baseline = descriptorCount();
    const client = createExecutionKeeper({
        executable, scope: 'terminal', runtimeRoot: dir, view, limits: { pingIntervalMs: 50, requestDeadlineMs: 2000, keeperExitWaitMs: 500 },
        onInfrastructureLoss: (reason) => losses.push(reason)
    });
    const marker = newId();
    const made = await client.create({ kind: 'keeper', resourceId: marker, marker, locator: {} });
    assert.equal(await made.gate.commit(), true, 'the frames carrying descriptors were still processed');
    // The count can see descriptors: the keeper's stderr and channel sockets are held while it lives.
    const grown = descriptorCount() - baseline;
    assert.ok(grown >= 2, `the supervisor holds the keeper's sockets while it runs (grew by ${grown})`);
    await clock.sleep(500);
    assert.equal(client.alive(), true);
    await client.exit();
    // The keeper's sockets close shortly after its exit; a descriptor installed by SCM_RIGHTS never would.
    await waitFor(() => descriptorCount() === baseline, 3000);
    const fdDelta = descriptorCount() - baseline;
    t.diagnostic(`supervisor descriptors: grew by ${grown} while the keeper ran; delta after the run ${fdDelta}`);
    assert.equal(fdDelta, 0);
    assert.deepEqual(losses, []);
});

test('the keeper is killed through its ChildProcess when the walk forces it', async (t) => {
    assertLinux();
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rwkil-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const executable = path.join(dir, 'keeper');
    fs.writeFileSync(executable, `#!${findPython()} -I\nimport runpy\nrunpy.run_path(${JSON.stringify(scmKeeper)}, run_name='__main__')\n`, { mode: 0o755 });
    const signals = [];
    const view = createProcView({ signal: (pid, name) => signals.push([pid, name]) });
    const client = createExecutionKeeper({ executable, scope: 'terminal', runtimeRoot: dir, view, limits: { requestDeadlineMs: 2000 } });
    const marker = newId();
    const made = await client.create({ kind: 'keeper', resourceId: marker, marker, locator: {} });
    assert.equal(await made.gate.commit(), true);
    assert.equal(view.kill(made.identity), true);
    assert.equal(await waitFor(() => view.process(made.identity.pid) === null || client.alive() === false), true);
    assert.deepEqual(signals, [], 'kill(2) was never used for the keeper');
});
