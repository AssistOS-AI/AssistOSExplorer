import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from '../../server/runtime-manager.mjs';
import { acquireExecutionLease } from '../../copilot/src/lib/storage/workspaceStateLock.mjs';

// Provider-free control, run explicitly on Linux rather than skipped in portable tests.
assert.equal(process.platform, 'linux', 'This control requires actual Linux process and boot identity.');

if (process.argv[2] === '--producer') {
    const [, , , cwd, sessionId] = process.argv;
    const release = await acquireExecutionLease(cwd, `session:${sessionId}`);
    const released = once(process, 'message');
    process.send({ type: 'acquired' });
    const [message] = await released;
    assert.equal(message.type, 'release');
    await release();
    process.send({ type: 'released' });
    process.disconnect();
} else {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-linux-lease-'));
    const robot = { id: 'lease-control-a1b2c3', name: 'Lease control', codingAgents: ['codex'] };
    const children = [], acquisitions = [], terminals = new Map();
    let preparations = 0, admitted = 0;
    const manager = new RuntimeManager({ workspaceRoot: root, dataDir: root,
        roboWork: { call: async () => ({}) },
        spawnImpl: (_command, args) => {
            if (children.length) assert.equal(children[0].closed, true, 'replacement starts only after actual producer close');
            const session = args[args.indexOf('--session-id') + 1];
            const child = fork(fileURLToPath(import.meta.url), ['--producer', root, session], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
            child.closed = false;
            child.once('close', () => { child.closed = true; });
            acquisitions.push(once(child, 'message').then(([message]) => {
                assert.equal(message.type, 'acquired');
                return child;
            }));
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
        if (children.every(child => child.closed)) await fs.rm(root, { recursive: true, force: true });
        else console.error(`Preserved Linux lease control fixture with unclosed producer: ${root}`);
    }
}
