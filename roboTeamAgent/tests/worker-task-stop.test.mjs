import test from 'node:test';
import '../copilot/tests/helpers/isolated-ala-home.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { STOP_NOT_CONFIRMED_EXIT, stopReasonFromRecord, taskExitCode } from '../server/worker-coordinator/task-exit.mjs';
import { taskOriginId } from '../server/worker-coordinator/flow-origins.mjs';
import { createWorkerEngine } from '../copilot/src/lib/execution/workerEngine.mjs';
import { ConversationSessionStore } from '../copilot/src/lib/storage/conversationSessionStore.mjs';

// A user's stop of an `/api/control` task, end to end (decisions M-12 (b), M-21): the stop request's own grant leaves
// RuntimeManager.stopTask, travels in the stop record over the child's stdin, is turned into the abort reason exactly as
// robot-task does, and reaches the worker as the `stop` control. Only the process boundary is replaced by a PassThrough.
const ROBOT = 'AAAAAAAAAAAAAAAAAAAAAA';
const REFERENCE = 'r'.repeat(22);
const grantOf = (mark) => `h.${Buffer.from(JSON.stringify({ sub: 'user:alice', exp: Math.floor(Date.now() / 1000) + 300, mark })).toString('base64url')}.s`;
const tick = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));
const toolCache = {
    root: '/cache',
    prepareShellTools: async (names = ['codex']) => ({ root: '/cache', path: '/cache/g', binPath: '/cache/g/bin', agents: Object.fromEntries(names.map((name) => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin` }])) }),
    prepareMode: async (mode) => ({ path: `/cache/${mode}`, versions: {} }),
    prepareCodex: async () => ({ path: '/cache/codex', binPath: '/cache/codex/bin', versions: {} }),
    prepareCodingAgents: async (names = ['codex']) => Object.fromEntries(names.map((name) => [name, { path: `/cache/${name}`, binPath: `/cache/${name}/bin`, versions: {} }])),
};

async function chain(t, { stopGrant }) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-stop-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const dataDir = path.join(root, 'data');
    const robot = { id: 'stopper-a1b2c3', name: 'Stopper' };
    await Promise.all([fs.mkdir(path.join(dataDir, 'robots', robot.id, 'home'), { recursive: true }), fs.mkdir(workspace, { recursive: true })]);
    const oldRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    t.after(() => { if (oldRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = oldRoot; });

    // The parent: a running worker-mode task whose child's stdin we hold.
    const stdin = new PassThrough();
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; child.stdin = stdin;
        return child;
    };
    const manager = new RuntimeManager({ dataDir, workspaceRoot: root, spawnImpl, workerMode: true, toolCache, execFileImpl: async () => ({ stdout: '[]', stderr: '' }) });
    t.after(() => manager.stopAll());
    const admissionGrant = grantOf('admission');
    const accepted = manager.startTask(robot, 'simple', { cwd: workspace, task: 'Do work', ca: 'codex', ownerPrincipal: 'user:alice', ownerGrant: admissionGrant });
    while (manager.taskStatus(robot.id, accepted.taskId)?.state !== 'running') await tick(5);

    // The child: reads its stdin records the way robot-task does and runs the worker engine with the admission grant.
    const store = new ConversationSessionStore({ workingDir: workspace });
    const session = await store.createSession();
    const calls = { admit: [], control: [] };
    const rows = [{ seq: 1, kind: 'state', state: 'running' }];
    const client = {
        async admit(body, auth) { calls.admit.push({ body, auth }); return { referenceId: REFERENCE, state: 'queued', originRequestId: body.originRequestId }; },
        async subscribe(reference, { after }, auth, { signal } = {}) {
            return (async function* held() {
                let cursor = after;
                for (;;) {
                    const next = rows.find((row) => row.seq > cursor);
                    if (next) { cursor = next.seq; yield next; continue; }
                    if (signal?.aborted) throw Object.assign(new Error('dropped'), { code: 'worker_stream_dropped', status: 503 });
                    await tick();
                }
            }());
        },
        async control(reference, body, auth) { calls.control.push({ reference, body, auth }); if (body.op === 'stop') rows.push({ seq: 2, kind: 'state', state: 'cancelled' }); return {}; },
        async read() { return { state: 'cancelled', result: { status: 'cancelled', outputText: '' } }; },
        async lookup() { return null; },
        async getRobot() { return { configuration: { backend: 'codex', settings: { codingAgents: ['codex'] } } }; },
    };
    const engine = createWorkerEngine({ workingDir: workspace, sessionStore: store, client,
        skillCatalog: { async refresh() { return { skills: [], taskRepositories: [] }; } },
        provisioner: { ensureReady: async () => ({ robotId: ROBOT, configRevision: 1, configuration: { backend: 'codex', settings: { codingAgents: ['codex'] } } }), desiredConfiguration: () => ({}) },
        getRobot: async () => ({ id: 'robo', worker: { robotId: ROBOT } }),
        settings: { readAchillesSettings: () => ({}), getPermissionMode: () => 'full-access' }, interactions: { cancelTurn() {}, resolve() {}, request: async () => null },
        execution: { robotId: 'robo', cwdExplicit: true, worker: { originRequestId: taskOriginId(accepted.taskId) } }, sleep: tick, pollMinMs: 1, pollMaxMs: 2, stopWaitMs: 200 });
    t.after(() => engine.close());
    const controller = new AbortController();
    const input = readline.createInterface({ input: stdin });
    input.on('line', (line) => { const message = JSON.parse(line); if (message.type === 'stop') controller.abort(stopReasonFromRecord(message)); });
    t.after(() => input.close());
    const run = engine.executeTurn({ sessionId: session.sessionId, prompt: 'Do work', signal: controller.signal, owner: { evidence: { ok: true, grant: admissionGrant } } })
        .then((result) => ({ result }), (error) => ({ error }));
    while (!calls.admit.length) await tick(5);
    await tick(20);
    manager.stopTask(robot, 'simple', accepted.taskId, stopGrant === undefined ? undefined : { ownerGrant: stopGrant });
    return { outcome: await run, calls, manager, robot, accepted };
}

test('the stop request\'s own grant reaches the worker as the stop control', async (t) => {
    const stopGrant = grantOf('stop-request');
    const { outcome, calls } = await chain(t, { stopGrant });
    assert.equal(calls.control.length, 1);
    assert.equal(calls.control[0].body.op, 'stop');
    assert.deepEqual(calls.control[0].auth, { grant: stopGrant }, 'the stop request\'s grant, not the admission grant');
    assert.deepEqual(calls.admit[0].auth.grant === stopGrant, false);
    assert.equal(outcome.error.name, 'AbortError', 'the worker confirmed the stop by ending the execution');
    assert.equal(taskExitCode(outcome.error, true), 130);
});

test('a stop with no grant is not delivered, and the child reports it as not confirmed', async (t) => {
    const { outcome, calls, manager, robot, accepted } = await chain(t, { stopGrant: undefined });
    assert.equal(calls.control.length, 0, 'nothing is sent under the admission grant or any other credential');
    assert.equal(outcome.error.code, 'worker_stop_not_authorized');
    assert.equal(outcome.error.execution, 'may_still_run');
    assert.equal(taskExitCode(outcome.error, true), STOP_NOT_CONFIRMED_EXIT);
    assert.equal(taskExitCode(new Error('x'), true), 130);
    assert.equal(taskExitCode(new Error('x'), false), 1);
    assert.equal(manager.taskStatus(robot.id, accepted.taskId).state, 'pausing', 'the manager does not call it paused before the child exits');
});
