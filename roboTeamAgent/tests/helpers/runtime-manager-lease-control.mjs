import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from '../../server/runtime-manager.mjs';
import { requireWorkspaceRoot } from '../../server/workspace-root.mjs';
import { acquireExecutionLease } from '../../copilot/src/lib/storage/workspaceStateLock.mjs';

export async function createLeaseControlFixture(env = process.env) {
    const workspaceRoot = requireWorkspaceRoot(env);
    const root = await fs.mkdtemp(path.join(workspaceRoot, 'runtime-linux-lease-'));
    const identity = await fs.lstat(root);
    assert.equal(await fs.realpath(root), root);
    assert.equal(identity.isDirectory() && !identity.isSymbolicLink(), true);
    assert.equal(identity.uid, process.getuid?.() ?? identity.uid);
    return { workspaceRoot, root, identity };
}

export async function removeLeaseControlFixture(fixture, children, env = process.env) {
    assert.equal(children.length, 2, 'both control producers must exist before cleanup');
    assert.equal(children.every(child => child.closed), true, 'both control producers must close before cleanup');
    assert.equal(requireWorkspaceRoot(env), fixture.workspaceRoot);
    assert.equal(path.dirname(fixture.root), fixture.workspaceRoot);
    assert.match(path.basename(fixture.root), /^runtime-linux-lease-[A-Za-z0-9]+$/u);
    assert.equal(await fs.realpath(fixture.root), fixture.root);
    const current = await fs.lstat(fixture.root);
    assert.equal(current.isDirectory() && !current.isSymbolicLink(), true);
    for (const key of ['dev', 'ino', 'uid']) assert.equal(current[key], fixture.identity[key]);
    await fs.rm(fixture.root, { recursive: true, force: true });
}

export function waitForLeaseAcquired(child) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            child.removeListener('message', onMessage);
            child.removeListener('error', onError);
            child.removeListener('close', onClose);
        };
        const fail = code => { cleanup(); reject(Object.assign(new Error(code), { code })); };
        const onError = () => fail('LINUX_LEASE_PRODUCER_STARTUP_ERROR');
        const onClose = () => fail('LINUX_LEASE_PRODUCER_CLOSED_BEFORE_ACQUIRED');
        const onMessage = message => {
            if (message?.type !== 'acquired') return fail('LINUX_LEASE_PRODUCER_STARTUP_FAILED');
            cleanup();
            resolve(child);
        };
        child.once('message', onMessage);
        child.once('error', onError);
        child.once('close', onClose);
    });
}

// Provider-free control, run explicitly on Linux rather than skipped in portable tests.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) assert.equal(process.platform, 'linux', 'This control requires actual Linux process and boot identity.');

if (isMain && process.argv[2] === '--producer') {
    const [, , , cwd, sessionId] = process.argv;
    let release;
    try { release = await acquireExecutionLease(cwd, `session:${sessionId}`); }
    catch {
        process.send({ type: 'startup-failed' });
        process.exitCode = 1;
        process.disconnect();
    }
    if (release) {
        const released = once(process, 'message');
        process.send({ type: 'acquired' });
        const [message] = await released;
        assert.equal(message.type, 'release');
        await release();
        process.send({ type: 'released' });
        process.disconnect();
    }
} else if (isMain) {
    const fixture = await createLeaseControlFixture();
    const { root, workspaceRoot } = fixture;
    const robot = { id: 'lease-control-a1b2c3', name: 'Lease control', codingAgents: ['codex'] };
    const children = [], acquisitions = [], terminals = new Map();
    let preparations = 0, admitted = 0;
    const manager = new RuntimeManager({ workspaceRoot, dataDir: root,
        roboWork: { call: async () => ({}) },
        spawnImpl: (_command, args) => {
            if (children.length) assert.equal(children[0].closed, true, 'replacement starts only after actual producer close');
            const session = args[args.indexOf('--session-id') + 1];
            const child = fork(fileURLToPath(import.meta.url), ['--producer', root, session], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
            child.closed = false;
            child.once('close', () => { child.closed = true; });
            const acquisition = waitForLeaseAcquired(child);
            acquisition.catch(() => {});
            acquisitions.push(acquisition);
            children.push(child);
            return child;
        },
    });
    manager.resolveCwd = async () => { preparations++; return root; };
    manager._saveTask = async () => {};
    manager.setTaskObserver(event => {
        if (event.kind === 'admitted') admitted++;
        if (event.kind === 'terminal') terminals.set(event.taskId, event);
    });
    const advance = () => new Promise(setImmediate);
    const until = async predicate => {
        for (let count = 0; count < 100 && !predicate(); count++) await advance();
        assert.ok(predicate(), 'expected controller event was reached');
    };
    const deadline = setTimeout(() => { throw new Error(`Linux lease control timed out; preserve fixture ${root}`); }, 15000);
    try {
        const old = manager.startTask(robot, 'simple', { cwd: root, task: 'provider-free lease holder', ca: 'codex' });
        await until(() => children.length === 1);
        await acquisitions[0];
        let competingRelease;
        await assert.rejects(async () => {
            competingRelease = await acquireExecutionLease(root, `session:${old.taskId}`);
        }, { code: 'WORKSPACE_STATE_BUSY' });
        assert.equal(competingRelease, undefined);
        manager.stopTask(robot, 'simple', old.taskId);
        await advance();
        assert.equal(manager.taskStatus(robot.id, old.taskId).state, 'paused');
        const next = await manager.resumeTask(robot, old.taskId, 'continue without a provider');
        assert.notEqual(next.taskId, old.taskId);
        assert.equal(admitted, 2);
        await advance();
        assert.equal(children.length, 1, 'no replacement producer or lease attempt before release');
        assert.equal(preparations, 1, 'no replacement preparation before release');
        const oldClosed = once(children[0], 'close');
        children[0].send({ type: 'release' });
        await oldClosed;
        await until(() => children.length === 2);
        const replacement = await acquisitions[1];
        assert.equal(manager.tasks.get(next.taskId).alaSessionId, old.taskId);
        const nextClosed = once(replacement, 'close');
        replacement.send({ type: 'release' });
        await nextClosed;
        await until(() => terminals.has(next.taskId));
        assert.equal(terminals.get(next.taskId).state, 'completed');
        assert.equal(preparations, 2);
        console.log('Linux lease control passed: competing lease busy; Continue waited; replacement acquired after producer close.');
    } finally {
        clearTimeout(deadline);
        if (children.length === 2 && children.every(child => child.closed)) await removeLeaseControlFixture(fixture, children);
        else console.error(`Preserved incomplete Linux lease control fixture: ${root}`);
    }
}
