import assert from 'node:assert/strict';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';

function fixture({ state = 'running', remoteState = 'running', matched = true, human = false } = {}) {
    const instance = { id: 'phase-one', robotId: 'robot-abc', runtimeTaskId: 'task-one', state };
    const flow = { id: 'flow-one', status: human ? 'paused' : 'running', instances: [instance],
        ...(human ? { humanInput: { runtimeTaskId: 'task-one', instanceId: 'phase-one', status: 'pending', executionEnded: false } } : {}) };
    const output = [];
    const service = Object.create(RoboFlowService.prototype);
    const task = { taskId: 'task-one', robotId: 'robot-abc', remoteState,
        request: { workflowRunId: matched ? flow.id : 'other-flow', workflowInstanceId: instance.id } };
    Object.assign(service, { presets: [], bindings: new Map(), generations: new Map(),
        registry: { initialize: async () => {} }, scheduler: { initialize() {} },
        runtimeManager: { recoveredTask: () => task },
        _loadPresets: async () => {},
        _serialize: async (_id, action) => action(),
        store: { initialize: async () => {}, list: async () => [flow],
            update: async (_id, update) => { update(flow); return flow; }, get: async () => flow,
            writeOutput: async (...args) => { output.push(args); } },
    });
    return { service, flow, instance, output };
}

test('restart keeps only a matching live RoboWork phase running and restores its callback binding', async () => {
    const { service, flow, instance } = fixture();
    await service.initialize();
    assert.equal(flow.status, 'running');
    assert.equal(instance.state, 'running');
    assert.deepEqual(service.bindings.get('task-one'), { flowId: flow.id, instanceId: instance.id, manual: true });
    for (const options of [{ matched: false }, { remoteState: 'interrupted' }, { remoteState: 'exited' }]) {
        const stopped = fixture(options);
        await stopped.service.initialize();
        assert.equal(stopped.flow.status, 'paused');
        assert.equal(stopped.instance.state, 'paused');
        if (options.matched === false) assert.equal(stopped.service.bindings.size, 0);
    }
});

test('a pending human question remains attached only while its RoboWork run is live', async () => {
    const live = fixture({ human: true, state: 'paused' });
    await live.service.initialize();
    assert.equal(live.flow.status, 'paused');
    assert.equal(live.flow.humanInput.executionEnded, false);
    assert.equal(live.service.bindings.has('task-one'), true);
    const ended = fixture({ human: true, state: 'paused', remoteState: 'exited' });
    await ended.service.initialize();
    assert.equal(ended.flow.humanInput.executionEnded, true);
});

test('replayed phase progress rebuilds the engine without duplicating workflow output', async () => {
    const { service, output } = fixture();
    await service.initialize();
    service.onRuntimeTaskEvent({ kind: 'progress', taskId: 'task-one', chunk: 'old', replayed: true });
    service.onRuntimeTaskEvent({ kind: 'progress', taskId: 'task-one', chunk: 'new' });
    await new Promise(setImmediate);
    assert.equal(output.length, 1);
    assert.equal(output[0][2], 'new');
});
