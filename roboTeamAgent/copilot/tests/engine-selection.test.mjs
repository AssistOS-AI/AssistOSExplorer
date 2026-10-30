import test from 'node:test';
import './helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutionEngine, workerModeSelected } from '../src/lib/execution/engineSelection.mjs';
import { createWorkerEngine } from '../src/lib/execution/workerEngine.mjs';
import { COORDINATOR_BASE_ENV } from '../../server/worker-coordinator/hop.mjs';
import { ConversationSessionStore } from '../src/lib/storage/conversationSessionStore.mjs';

// The cutover seam (decision M-5): ROBOTEAM_WORKER_COORDINATOR_BASE selects the worker engine, and a
// worker failure is an explicit error with no fallback to a local ALA run.
const BASE = '/base-agent-additional-server/robo-work/7311';
const read = (relative) => fs.readFile(new URL(relative, import.meta.url), 'utf8');

test('the base variable selects the worker engine and never constructs the local one', () => {
    assert.equal(workerModeSelected({}), false);
    assert.equal(workerModeSelected({ [COORDINATOR_BASE_ENV]: '  ' }), false);
    assert.equal(workerModeSelected({ [COORDINATOR_BASE_ENV]: BASE }), true);
    const created = [];
    const local = (options) => { created.push(['local', options]); return { which: 'local' }; };
    const worker = (options) => { created.push(['worker', options]); return { which: 'worker' }; };
    const robotStore = { get: async () => ({ id: 'robo' }) };
    const workerOptions = { workingDir: '/w', robotStore, robotId: 'robo', execution: { robotId: 'robo' } };
    assert.equal(createExecutionEngine({ env: { [COORDINATOR_BASE_ENV]: BASE }, localOptions: { x: 1 }, workerOptions, hop: { call: async () => ({}) },
        createLocal: local, createWorker: worker }).which, 'worker');
    assert.deepEqual(created.map(([kind]) => kind), ['worker'], 'no local engine in worker mode');
    const options = created[0][1];
    for (const name of ['client', 'provisioner', 'getRobot']) assert.ok(options[name], name);
    assert.equal(Object.hasOwn(options, 'robotStore'), false);
    created.length = 0;
    assert.equal(createExecutionEngine({ env: {}, localOptions: { x: 1 }, workerOptions, createLocal: local, createWorker: worker }).which, 'local');
    assert.deepEqual(created, [['local', { x: 1 }]], 'unset keeps the local ALA path');
});

test('worker mode without the RoboTeam robot context is an error, not a local engine', () => {
    const create = () => assert.fail('the local engine must not be created');
    assert.throws(() => createExecutionEngine({ env: { [COORDINATOR_BASE_ENV]: BASE }, localOptions: {}, workerOptions: { workingDir: '/w' },
        createLocal: create }), /robot context/);
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
    let localCreated = 0;
    const engine = createExecutionEngine({
        env: { [COORDINATOR_BASE_ENV]: BASE }, hop,
        createLocal: () => { localCreated += 1; return {}; },
        workerOptions: { workingDir, sessionStore: store, skillCatalog: { async refresh() { return { skills: [] }; } },
            settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' }, execution: { robotId: 'robo' },
            robotStore: { get: async () => ({ id: 'robo', name: 'default', codingAgents: ['codex'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } }) }, robotId: 'robo' },
    });
    t.after(() => engine.close());
    const binding = { bindingId: `flow_${'cd'.repeat(12)}`, originRequestId: 'BBBBBBBBBBBBBBBBBBBBBA' };
    const withBinding = createExecutionEngine({
        env: { [COORDINATOR_BASE_ENV]: BASE }, hop, createLocal: () => { localCreated += 1; return {}; },
        workerOptions: { workingDir, sessionStore: store, skillCatalog: { async refresh() { return { skills: [] }; } },
            settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' }, execution: { robotId: 'robo', worker: binding },
            robotStore: { get: async () => ({ id: 'robo', name: 'default', codingAgents: ['codex'], worker: { robotId: 'AAAAAAAAAAAAAAAAAAAAAA' } }) }, robotId: 'robo' },
    });
    t.after(() => withBinding.close());
    await assert.rejects(withBinding.executeTurn({ sessionId: session.sessionId, prompt: 'p' }),
        (error) => error.code === 'worker_unreachable' && error.status === 503);
    assert.deepEqual(calls, ['robots/get'], 'the worker was asked, and the failure ended the turn');
    assert.equal(localCreated, 0);
    // Without owner evidence the turn is refused before any worker call.
    calls.length = 0;
    await assert.rejects(engine.executeTurn({ sessionId: session.sessionId, prompt: 'p' }), (error) => error.code === 'owner_evidence_unavailable');
    assert.deepEqual(calls, []);
    assert.equal(typeof createWorkerEngine, 'function');
});

test('the runtime entry points use the seam: createCliRuntime builds the engine through it and resolves no local ALA in worker mode', async () => {
    const index = await read('../src/index.mjs');
    assert.match(index, /createExecutionEngine\(\{/u);
    assert.match(index, /workerModeSelected\(\) \? null : await resolveAlaInstallation\(\)/u);
    assert.doesNotMatch(index, /createAlaEngine\(/u, 'no direct local engine construction in createCliRuntime');
    const listing = await read('../src/mcp/list-slash-commands.mjs');
    assert.match(listing, /worker \? \{ listModels/u, 'the slash-command catalog builds no local engine in worker mode');
});
