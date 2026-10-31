import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutionEngine, createUnconfiguredEngine, workerModeSelected } from '../src/lib/execution/engineSelection.mjs';
import { createWorkerEngine } from '../src/lib/execution/workerEngine.mjs';
import { COORDINATOR_BASE_ENV } from '../../server/worker-coordinator/hop.mjs';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';

// The cutover seam (decision M-5): ROBOTEAM_WORKER_COORDINATOR_BASE selects the worker engine, and a
// worker failure is an explicit error with no fallback to a local ALA run.
const BASE = '/base-agent-additional-server/robo-work/7311';
const read = (relative) => fs.readFile(new URL(relative, import.meta.url), 'utf8');

test('the base variable selects the worker engine; without it every turn and model call is refused with worker_not_configured and nothing is constructed', async () => {
    assert.equal(workerModeSelected({}), false);
    assert.equal(workerModeSelected({ [COORDINATOR_BASE_ENV]: '  ' }), false);
    assert.equal(workerModeSelected({ [COORDINATOR_BASE_ENV]: BASE }), true);
    const created = [];
    const worker = (options) => { created.push(options); return { which: 'worker' }; };
    const robotStore = { get: async () => ({ id: 'robo' }) };
    const workerOptions = { workingDir: '/w', robotStore, robotId: 'robo', execution: { robotId: 'robo' } };
    assert.equal(createExecutionEngine({ env: { [COORDINATOR_BASE_ENV]: BASE }, workerOptions, hop: { call: async () => ({}) }, createWorker: worker }).which, 'worker');
    assert.equal(created.length, 1);
    for (const name of ['client', 'provisioner', 'getRobot']) assert.ok(created[0][name], name);
    assert.equal(Object.hasOwn(created[0], 'robotStore'), false);
    // Unset (or blank): no worker engine, no hop, and a clear configuration error on every call; no local engine exists to fall back to.
    created.length = 0;
    for (const env of [{}, { [COORDINATOR_BASE_ENV]: '   ' }]) {
        const engine = createExecutionEngine({ env, workerOptions, createWorker: worker });
        for (const call of [() => engine.executeTurn({ sessionId: 's', prompt: 'p' }), () => engine.getModel({ sessionId: 's' }),
            () => engine.setModel({ sessionId: 's' }), () => engine.listModels({})]) {
            await assert.rejects(call(), (error) => error.code === 'worker_not_configured' && error.statusCode === 409
                && /^worker_not_configured: .*ROBOTEAM_WORKER_COORDINATOR_BASE is not set/u.test(error.message));
        }
        assert.deepEqual(await engine.stopTurn({ turnId: 't' }), { delivered: false, code: 'not_running', message: 'Nothing is running to stop.' });
        await engine.close();
    }
    assert.deepEqual(created, [], 'the worker engine is not constructed either');
    assert.equal(typeof createUnconfiguredEngine().executeTurn, 'function');
    // No local engine module remains.
    await assert.rejects(fs.access(new URL('../src/lib/execution/alaEngine.mjs', import.meta.url)), { code: 'ENOENT' });
});

test('worker mode without the RoboTeam robot context is an error, not a local engine', () => {
    assert.throws(() => createExecutionEngine({ env: { [COORDINATOR_BASE_ENV]: BASE }, workerOptions: { workingDir: '/w' } }), /robot context/);
});

test('with the base set, a failing coordinator fails the turn explicitly and nothing is spawned', async (t) => {
    const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-selection-'));
    const oldRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = path.dirname(workingDir);
    t.after(async () => {
        if (oldRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = oldRoot;
        await fs.rm(workingDir, { recursive: true, force: true });
    });
    const store = new ConversationSessionStore({ workingDir });
    const session = await store.createSession();
    const calls = [];
    // Every coordinator operation is refused: the worker is unreachable.
    const hop = { call: async (operation, body) => { calls.push(operation); return { outcome: 'unsent' }; } };
    const engine = createExecutionEngine({
        env: { [COORDINATOR_BASE_ENV]: BASE }, hop,
        workerOptions: { workingDir, sessionStore: store, skillCatalog: { async refresh() { return { skills: [] }; } },
            settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' }, execution: { robotId: 'robo' },
            robotStore: { get: async () => ({ id: 'robo', name: 'default', codingAgents: ['codex'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } }) }, robotId: 'robo' },
    });
    t.after(() => engine.close());
    const binding = { bindingId: `flow_${'cd'.repeat(12)}`, originRequestId: 'BBBBBBBBBBBBBBBBBBBBBA' };
    const withBinding = createExecutionEngine({
        env: { [COORDINATOR_BASE_ENV]: BASE }, hop,
        workerOptions: { workingDir, sessionStore: store, skillCatalog: { async refresh() { return { skills: [] }; } },
            settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' }, execution: { robotId: 'robo', worker: binding },
            robotStore: { get: async () => ({ id: 'robo', name: 'default', codingAgents: ['codex'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } }) }, robotId: 'robo' },
    });
    t.after(() => withBinding.close());
    await assert.rejects(withBinding.executeTurn({ sessionId: session.sessionId, prompt: 'p' }),
        (error) => error.code === 'worker_unreachable' && error.status === 503);
    assert.deepEqual(calls, ['robots/get'], 'the worker was asked, and the failure ended the turn');
    // Without owner evidence the turn is refused before any worker call.
    calls.length = 0;
    await assert.rejects(engine.executeTurn({ sessionId: session.sessionId, prompt: 'p' }), (error) => error.code === 'owner_evidence_unavailable');
    assert.deepEqual(calls, []);
    assert.equal(typeof createWorkerEngine, 'function');
});

test('the runtime entry points use the seam: createCliRuntime builds the engine through it and resolves no local ALA', async () => {
    const index = await read('../src/index.mjs');
    assert.match(index, /createExecutionEngine\(\{/u);
    assert.doesNotMatch(index, /resolveAlaInstallation|createAlaEngine/u, 'no local ALA installation or engine in createCliRuntime');
    const listing = await read('../src/mcp/list-slash-commands.mjs');
    assert.match(listing, /worker \? \{ listModels/u, 'the slash-command catalog builds no local engine in worker mode');
    assert.doesNotMatch(listing, /createAlaEngine|resolveAlaInstallation/u);
});
