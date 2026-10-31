import assert from 'node:assert/strict';
import os from 'node:os';
// Tests explicitly provision the workspace normally supplied by Ploinky.
process.env.PLOINKY_WORKSPACE_ROOT ||= os.tmpdir();
import test from 'node:test';
import { LiveSessionsRegistry } from '../server/live-sessions/registry.mjs';
import { RuntimeLiveSource, composeTaskObservers } from '../server/live-sessions/runtime-source.mjs';
import { rowViolation } from '../server/live-sessions/contract.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';

const ALICE = { principal: 'user:alice', canAdmin: false };
const ADMIN = { principal: 'user:root', canAdmin: true };
const ROBOT = { id: 'robot-abc', name: 'Builder' };
const FLOW = `flow_${'a'.repeat(24)}`;
const INSTANCE = `inv_${'b'.repeat(24)}`;

function fixture(overrides = {}) {
    const calls = { messages: [], stops: [], pauses: [], phaseMessages: [], transcripts: [] };
    const registry = new LiveSessionsRegistry({ log: () => {}, urlBase: '/base-agent-additional-server/roboTeamAgent/3001', ...overrides.registry });
    const runtimeManager = {
        workspaceRoot: '/workspace',
        sendTaskMessage: async (robot, taskId, text) => { calls.messages.push({ robot, taskId, text }); return overrides.delivery || { delivery: 'delivered', messageId: 'm' }; },
        stopTask: (robot, type, taskId) => { calls.stops.push({ robot: robot.id, type, taskId }); return { taskId: 'stop-op' }; },
        taskTranscriptRef: (robotId, taskId) => overrides.transcriptRef?.(robotId, taskId) ?? null,
    };
    const roboflow = {
        store: { getSync: (id) => (id === FLOW ? { workflowName: 'Release' } : null) },
        messageInstance: async (flowId, instanceId, text) => { calls.phaseMessages.push({ flowId, instanceId, text }); if (overrides.phaseError) throw overrides.phaseError; return { delivery: 'queued', flow: {} }; },
        pauseInstance: async (flowId, instanceId) => { calls.pauses.push({ flowId, instanceId }); },
        getInvocationLog: async (flowId, instanceId) => `phase log ${flowId} ${instanceId}`,
    };
    const robotStore = { get: async (id) => (id === ROBOT.id ? ROBOT : null) };
    const logs = [];
    const source = new RuntimeLiveSource({ registry, runtimeManager, robotStore, roboflow, workspaceRoot: '/workspace', log: (line) => logs.push(line),
        readTranscript: async (ref) => { calls.transcripts.push(ref); return 'turn transcript'; } });
    return { registry, source, calls, logs };
}

const admitted = (fields = {}) => ({ kind: 'admitted', robotId: ROBOT.id, robotName: ROBOT.name, taskId: 'task-1', type: 'simple', state: 'queued',
    cwd: '/workspace/project/app', ownerPrincipal: 'user:alice', workflowRunId: null, workflowInstanceId: null, ...fields });

test('admitted tasks become rows with the signed owner; unsigned owners are system rows', () => {
    const { registry, source } = fixture();
    source.onRuntimeTaskEvent(admitted());
    source.onRuntimeTaskEvent(admitted({ taskId: 'task-2', ownerPrincipal: null }));
    source.onRuntimeTaskEvent(admitted({ taskId: 'task-3', ownerPrincipal: 'alice' }));
    const [own] = registry.list(ALICE);
    assert.equal(own.kind, 'robot-task');
    assert.equal(own.title, 'Robot task · Builder');
    assert.equal(own.detail, 'CLI task');
    assert.equal(own.cwdDisplay, 'project/app');
    assert.equal(own.ownerState, 'verified');
    assert.equal(own.access, 'rw');
    assert.deepEqual(own.capabilities, { watch: true, input: false, stop: true, message: true });
    const rows = registry.list(ADMIN);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.ownerState).sort(), ['system', 'system', 'verified']);
    for (const row of rows) assert.equal(rowViolation(row, 'roboTeamAgent'), null);
});

test('progress, state and terminal events drive the row; terminal states map to ended statuses', () => {
    const { registry, source } = fixture();
    const cases = [
        [{ state: 'completed', result: 'ok', error: null }, 'finished', { reason: 'completed' }],
        [{ state: 'failed', error: 'ALA exited with 1: boom\nmore' }, 'failed', { reason: 'ALA exited with 1: boom' }],
        [{ state: 'paused', error: null }, 'stopped', { reason: 'stopped' }],
        [{ state: 'failed', forcedFailure: true, error: 'Blocked.' }, 'failed', { reason: 'Blocked.' }],
        [{ state: 'completed', error: 'Final response exceeds the 1 MiB limit' }, 'failed', { reason: 'Final response exceeds the 1 MiB limit' }],
    ];
    for (const [index, [terminal, status, exit]] of cases.entries()) {
        const taskId = `task-${index}`;
        source.onRuntimeTaskEvent(admitted({ taskId }));
        source.onRuntimeTaskEvent({ kind: 'state', taskId, state: 'running' });
        source.onRuntimeTaskEvent({ kind: 'progress', taskId, chunk: 'hello', outputKind: 'assistant' });
        source.onRuntimeTaskEvent({ kind: 'terminal', taskId, ...terminal });
        source.onRuntimeTaskEvent({ kind: 'terminal', taskId, state: 'failed', error: 'second terminal ignored' });
        const row = registry.list(ADMIN).find((item) => registry.runs.get(item.id) && item.status === status && JSON.stringify(item.exit) === JSON.stringify(exit));
        assert.ok(row, `${terminal.state} → ${status}`);
    }
    assert.equal(registry.list(ADMIN).length, cases.length);
    assert.ok(registry.list(ADMIN).every((row) => row.endedAt));
});

test('workflow phases capture their association at admission and keep it after RoboFlow forgets the binding', async () => {
    const { registry, source, calls } = fixture();
    source.onRuntimeTaskEvent(admitted({ workflowRunId: FLOW, workflowInstanceId: INSTANCE, type: 'browser' }));
    const [row] = registry.list(ALICE);
    assert.equal(row.kind, 'workflow-phase');
    assert.equal(row.title, 'Workflow phase · Release');
    assert.match(row.detail, /pauses the whole workflow/u);
    assert.deepEqual(await registry.message(row.id, ALICE, 'more'), { ok: true, outcome: 'queued' });
    assert.deepEqual(calls.phaseMessages, [{ flowId: FLOW, instanceId: INSTANCE, text: 'more' }]);
    assert.deepEqual(await registry.stop(row.id, ADMIN), { ok: true });
    assert.deepEqual(calls.pauses, [{ flowId: FLOW, instanceId: INSTANCE }]);
    assert.deepEqual(calls.stops, [], 'a phase stop never stops the task directly');
    assert.deepEqual(await registry.transcript(row.id, ALICE), { ok: true, text: `phase log ${FLOW} ${INSTANCE}` });
    source.onRuntimeTaskEvent({ kind: 'terminal', taskId: 'task-1', state: 'completed', result: 'done', error: null });
    assert.equal(registry.list(ALICE)[0].status, 'finished');
});

test('robot task controls use the runtime and map typed outcomes', async () => {
    const { registry, source, calls } = fixture();
    source.onRuntimeTaskEvent(admitted({ type: 'desktop' }));
    const [row] = registry.list(ALICE);
    assert.deepEqual(await registry.message(row.id, ALICE, 'hi'), { ok: true, outcome: 'delivered' });
    assert.deepEqual(calls.messages.map((call) => [call.robot.id, call.taskId, call.text]), [[ROBOT.id, 'task-1', 'hi']]);
    assert.deepEqual(await registry.stop(row.id, ALICE), { ok: true });
    assert.deepEqual(calls.stops, [{ robot: ROBOT.id, type: 'desktop', taskId: 'task-1' }]);
    // Typed runtime failures pass through; an unconfirmed delivery is unknown.
    for (const [delivery, outcome] of [[{ delivery: 'queued' }, 'queued'], [{ delivery: 'sent' }, 'unknown'], [{}, 'unknown']]) {
        const local = fixture({ delivery });
        local.source.onRuntimeTaskEvent(admitted());
        const [item] = local.registry.list(ALICE);
        assert.equal((await local.registry.message(item.id, ALICE, 'x')).outcome, outcome, JSON.stringify(delivery));
    }
    const failing = fixture();
    failing.source.onRuntimeTaskEvent(admitted());
    const [item] = failing.registry.list(ALICE);
    failing.source.runtimeManager.sendTaskMessage = async () => { throw Object.assign(new Error('Busy.'), { liveOutcome: 'rejected' }); };
    assert.deepEqual(await failing.registry.message(item.id, ALICE, 'x'), { ok: true, outcome: 'rejected', detail: 'Busy.' });
    // RoboFlow refusals: a phase that is no longer running is run_ended (typed by
    // RoboFlow), a missing run is run_ended, other request errors are rejected.
    for (const [error, outcome] of [[{ statusCode: 400, liveOutcome: 'run_ended' }, 'run_ended'], [{ statusCode: 404 }, 'run_ended'],
        [{ statusCode: 400 }, 'rejected'], [{}, 'unknown']]) {
        const phase = fixture({ phaseError: Object.assign(new Error('refused'), error) });
        phase.source.onRuntimeTaskEvent(admitted({ workflowRunId: FLOW, workflowInstanceId: INSTANCE }));
        const [phaseRow] = phase.registry.list(ALICE);
        assert.equal((await phase.registry.message(phaseRow.id, ALICE, 'x')).outcome, outcome);
    }
});

test('a robot task transcript appears only after its turn started and reads only that bound turn', async () => {
    let ref = null;
    const { registry, source, calls } = fixture({ transcriptRef: (robotId, taskId) => (robotId === ROBOT.id && taskId === 'task-1' ? ref : null) });
    source.onRuntimeTaskEvent(admitted());
    const [row] = registry.list(ALICE);
    assert.equal(row.transcriptUrl, `/base-agent-additional-server/roboTeamAgent/3001/api/live-sessions/${row.id}/transcript`);
    assert.deepEqual(await registry.transcript(row.id, ALICE), { ok: true, text: null }, 'unavailable before the turn starts');
    assert.deepEqual(calls.transcripts, []);
    ref = { cwd: '/workspace/project', sessionId: 's', assistantMessageId: 'm' };
    assert.deepEqual(await registry.transcript(row.id, ALICE), { ok: true, text: 'turn transcript' });
    assert.deepEqual(calls.transcripts, [ref]);
});

test('a full registry leaves the task unlisted without failing observation', () => {
    const { registry, source, logs } = fixture({ registry: { maxLive: 1 } });
    source.onRuntimeTaskEvent(admitted());
    source.onRuntimeTaskEvent(admitted({ taskId: 'task-2' }));
    source.onRuntimeTaskEvent({ kind: 'progress', taskId: 'task-2', chunk: 'x' });
    source.onRuntimeTaskEvent({ kind: 'terminal', taskId: 'task-2', state: 'completed' });
    assert.equal(registry.list(ADMIN).length, 1);
    assert.deepEqual(logs, ['[live-sessions] task task-2 is not listed: registry is full']);
});

test('composed observers run RoboFlow first, isolate Live Sessions and keep RoboFlow error reporting', () => {
    const order = [];
    const logs = [];
    const observer = composeTaskObservers((event) => { order.push(`roboflow:${event.n}`); if (event.n === 2) throw new Error('roboflow failed'); },
        [(event) => { order.push(`live:${event.n}`); if (event.n === 1) throw new Error('live failed'); }], (line) => logs.push(line));
    observer({ n: 1 });
    assert.throws(() => observer({ n: 2 }), /roboflow failed/);
    observer({ n: 3 });
    assert.deepEqual(order, ['roboflow:1', 'live:1', 'roboflow:2', 'live:2', 'roboflow:3', 'live:3']);
    assert.deepEqual(logs, ['[live-sessions] task observer failed: live failed']);
});

test('with the real runtime, a queued GUI task cancelled before it runs ends its row once as stopped', async () => {
    const registry = new LiveSessionsRegistry({ log: () => {} });
    const manager = new RuntimeManager({ workerMode: true, toolCache: { root: '/cache' } });
    const source = new RuntimeLiveSource({ registry, runtimeManager: manager, robotStore: { get: async () => ROBOT }, workspaceRoot: '/workspace' });
    const ends = [];
    const end = registry.end.bind(registry);
    registry.end = (...args) => { ends.push(args[0]); return end(...args); };
    manager.setTaskObserver(composeTaskObservers(() => {}, [(event) => source.onRuntimeTaskEvent(event)]));
    const active = manager._newTask(ROBOT, 'browser', { cwd: '/workspace' });
    active.state = 'running';
    active.child = { kill() {} };
    manager.activeTasks.set(ROBOT.id, active.taskId);
    const waiting = manager.startTask(ROBOT, 'browser', { cwd: '/workspace/app', task: 'Later', ownerPrincipal: 'user:alice' });
    const [row] = registry.list(ALICE);
    assert.equal(row.status, 'waiting', 'a queued task is waiting');
    assert.deepEqual(await registry.stop(row.id, ALICE), { ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    manager.activeTasks.delete(ROBOT.id);
    await manager._drainTaskQueue(ROBOT);
    assert.equal(manager.taskStatus(ROBOT.id, waiting.taskId).state, 'paused');
    assert.equal(registry.list(ALICE)[0].status, 'stopped');
    assert.equal(ends.length, 1);
    manager.shuttingDown = true;
});

test('a queued task is waiting until its running state event', () => {
    const { registry, source } = fixture();
    source.onRuntimeTaskEvent(admitted());
    assert.equal(registry.list(ALICE)[0].status, 'waiting');
    source.onRuntimeTaskEvent({ kind: 'state', taskId: 'task-1', state: 'starting' });
    assert.equal(registry.list(ALICE)[0].status, 'waiting');
    source.onRuntimeTaskEvent({ kind: 'state', taskId: 'task-1', state: 'running' });
    assert.equal(registry.list(ALICE)[0].status, 'running');
});

test('a workflow phase without any recorded output has no transcript yet', async () => {
    const { registry, source } = fixture();
    source.roboflow.getInvocationLog = async () => '';
    source.onRuntimeTaskEvent(admitted({ workflowRunId: FLOW, workflowInstanceId: INSTANCE }));
    const [row] = registry.list(ALICE);
    assert.deepEqual(await registry.transcript(row.id, ALICE), { ok: true, text: null });
});
