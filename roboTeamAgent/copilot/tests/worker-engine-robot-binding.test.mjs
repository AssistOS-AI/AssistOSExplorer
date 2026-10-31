import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkerEngine } from '../src/lib/execution/workerEngine.mjs';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';

// A conversation is bound to the robot that started it: a turn for another robot is refused before anything reaches the worker.
const freshGrant = () => `h.${Buffer.from(JSON.stringify({ sub: 'user:alice', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.s`;

async function fixture(t, boundRobot) {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-engine-binding-'));
    const oldRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = path.dirname(workingDir);
    const store = new ConversationSessionStore({ workingDir });
    const { sessionId } = await store.createSession();
    await store.bindEngine(sessionId, { home: workingDir, cwd: workingDir, robotId: boundRobot });
    const reached = [];
    const trap = (name) => async () => { reached.push(name); throw new Error(`${name} must not be reached`); };
    const engine = createWorkerEngine({ workingDir, sessionStore: store, skillCatalog: { async refresh() { return { skills: [], taskRepositories: [] }; } },
        client: { getRobot: trap('client.getRobot') }, provisioner: { ensureReady: trap('provisioner.ensureReady'), desiredConfiguration: () => ({}) },
        getRobot: async () => ({ id: 'robo', name: 'default', codingAgents: ['codex'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } }),
        settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' },
        interactions: { cancelTurn() {}, resolve() {}, request: async () => null },
        execution: { robotId: 'robo' }, evidenceWaitMs: 0 });
    t.after(async () => {
        await engine.close();
        if (oldRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = oldRoot;
        await fs.rm(workingDir, { recursive: true, force: true });
    });
    const owner = { coordinator: { admitTurn: trap('coordinator.admitTurn') }, evidence: { ok: true, principal: 'user:alice', grant: freshGrant() }, freshest: null };
    return { engine, store, sessionId, owner, reached };
}

test('executeTurn on a conversation bound to another robot throws and reaches neither the worker nor the coordinator', async (t) => {
    const f = await fixture(t, 'someone-else');
    await assert.rejects(f.engine.executeTurn({ sessionId: f.sessionId, prompt: 'hi', owner: f.owner }), /another robot/i);
    assert.deepEqual(f.reached, []);
    assert.equal(f.store.loadSession(f.sessionId).engine.robotId, 'someone-else', 'the binding is unchanged');
});

test('the same conversation bound to this robot passes the robot guard (it fails later, at the worker)', async (t) => {
    const f = await fixture(t, 'robo');
    await assert.rejects(f.engine.executeTurn({ sessionId: f.sessionId, prompt: 'hi', owner: f.owner }), (error) => !/another robot/i.test(error.message));
    assert.ok(f.reached.length > 0, 'the turn went past the guard');
});
