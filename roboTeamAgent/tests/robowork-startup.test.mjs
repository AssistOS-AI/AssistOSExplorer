import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';
import { RoboWorkClient } from '../server/run-client.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { createRoboTeamServer } from '../server/http-server.mjs';

const inactive = () => Object.assign(new Error('agent-to-agent target is inactive'), { statusCode: 503, code: 'TARGET_INACTIVE' });

test('RoboTeam waits for its direct RoboWork dependency while Explorer keeps the no-wait path', async () => {
    const team = JSON.parse(await fs.readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    const explorer = JSON.parse(await fs.readFile(new URL('../../explorer/manifest.json', import.meta.url), 'utf8'));
    assert.ok(team.enable.includes('roboWorkAgent global'));
    assert.equal(team.enable.some(entry => typeof entry === 'string' && entry.startsWith('roboWorkAgent ') && entry.includes('no-wait')), false);
    assert.ok(explorer.enable.includes('roboTeamAgent global no-wait'));
    assert.equal(explorer.enable.some(entry => typeof entry === 'string' && entry.split(' ')[0] === 'roboWorkAgent'), false);
    const main = await fs.readFile(new URL('../server/main.mjs', import.meta.url), 'utf8');
    assert.match(main, /new RoboWorkClient\(\{\s*startupRetry:\s*true/);
    assert.ok(main.indexOf('await runtimeManager.initialize()') < main.indexOf('await roboflow.initialize()'));
    assert.ok(main.indexOf('roboWork.finishStartup()') > main.indexOf('await runtimeManager.initialize()'));
    assert.ok(main.indexOf('roboWork.finishStartup()') < main.indexOf('await roboflow.initialize()'));
});

test('the same startup client recovers activation lag and typed connection failures, then disables startup retries', async () => {
    const waits = [], calls = [];
    let failures = [inactive(), new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })];
    const client = new RoboWorkClient({ startupRetry: true, wait: async ms => { waits.push(ms); },
        createClient: async () => ({ callTool: async (tool, input) => {
            calls.push({ tool, input });
            if (failures.length) throw failures.shift();
            return { robots: [] };
        } }) });
    assert.deepEqual(await client.call('robot_status', {}), { robots: [] });
    assert.equal(calls.length, 3);
    assert.ok(waits.every(ms => ms > 0));
    client.finishStartup();
    failures = [inactive()];
    await assert.rejects(client.call('run_list', {}), { code: 'ROBOWORK_UNAVAILABLE', statusCode: 503, retryable: true });
    assert.equal(calls.length, 4);
    assert.equal(waits.length, 2);
});

test('startup retries are bounded and exhaustion returns a clear retryable error', async () => {
    const waits = [];
    let calls = 0;
    const client = new RoboWorkClient({ startupRetry: true, wait: async ms => { waits.push(ms); },
        createClient: async () => ({ callTool: async () => { calls++; throw inactive(); } }) });
    await assert.rejects(client.call('run_list', {}), error => error.code === 'ROBOWORK_UNAVAILABLE'
        && error.retryable === true && error.statusCode === 503 && /retry/i.test(error.message));
    assert.ok(calls > 1 && calls <= 8);
    assert.equal(waits.length, calls - 1);
    assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 6000);
});

test('auth, tool and unrelated HTTP failures fail immediately without startup retries', async () => {
    for (const failure of [Object.assign(new Error('forbidden'), { statusCode: 403, code: 'TARGET_INACTIVE' }),
        Object.assign(new Error('other service failure'), { statusCode: 503, code: 'OTHER_ERROR' }),
        new Error('503 TARGET_INACTIVE'), Object.assign(new Error('invalid input'), { code: 'INVALID_INPUT' })]) {
        let calls = 0;
        const client = new RoboWorkClient({ startupRetry: true, wait: () => assert.fail('nonretryable error must not wait'),
            createClient: async () => ({ callTool: async () => { calls++; throw failure; } }) });
        await assert.rejects(client.call('robot_status', {}), error => error === failure);
        assert.equal(calls, 1);
    }
    let calls = 0;
    const client = new RoboWorkClient({ startupRetry: true, wait: () => assert.fail('tool error must not wait'),
        createClient: async () => ({ callTool: async () => { calls++; return { isError: true, code: 'INVALID_INPUT', message: 'bad input' }; } }) });
    await assert.rejects(client.call('robot_status', {}), { code: 'INVALID_INPUT' });
    assert.equal(calls, 1);
});

test('persisted flow interruption scan waits for the first successful run snapshot', async () => {
    let release, waiting;
    const gate = new Promise(resolve => { release = resolve; });
    const retrying = new Promise(resolve => { waiting = resolve; });
    let runCalls = 0, scans = 0;
    const flow = { id: 'flow-one', status: 'running', instances: [{ id: 'phase-one', robotId: 'robot-abc', runtimeTaskId: 'task-one', state: 'running' }] };
    const client = new RoboWorkClient({ startupRetry: true, wait: async () => { waiting(); await gate; },
        createClient: async () => ({ callTool: async tool => {
            if (tool === 'robot_status') return { robots: [] };
            assert.equal(tool, 'run_list');
            if (++runCalls === 1) throw inactive();
            return [{ runId: 'run-one', robotId: 'robot-abc', state: 'running', tag: { kind: 'task', taskId: 'task-one', type: 'simple',
                request: { cwd: os.tmpdir(), workflowRunId: flow.id, workflowInstanceId: 'phase-one' } } }];
        } }) });
    const runtime = new RuntimeManager({ workspaceRoot: os.tmpdir(), roboWork: client, robotStore: { get: async () => ({ id: 'robot-abc', name: 'A' }) } });
    const service = Object.create(RoboFlowService.prototype);
    Object.assign(service, { presets: [], bindings: new Map(), runtimeManager: runtime,
        registry: { initialize: async () => {} }, scheduler: { initialize() {} }, _loadPresets: async () => {},
        store: { initialize: async () => {}, list: async () => { scans++; return [flow]; }, update: async (_id, update) => { update(flow); } } });
    const startup = runtime.initialize().then(() => service.initialize());
    await retrying;
    assert.equal(scans, 0);
    assert.equal(flow.status, 'running');
    release();
    await startup;
    assert.equal(runCalls, 2);
    assert.ok(scans > 0);
    assert.equal(flow.status, 'running');
    assert.equal(runtime.recoveredTask('task-one').attachRun, 'run-one');
    assert.equal(service.bindings.get('task-one').flowId, flow.id);
});

test('an HTTP request needing an unavailable RoboWork receives a clear retryable 503', async t => {
    const client = new RoboWorkClient({ createClient: async () => ({ callTool: async () => { throw inactive(); } }) });
    const server = createRoboTeamServer({ robotStore: { list: async () => [] },
        runtimeManager: { workspaceRoot: os.tmpdir(), roboWork: client }, skillsets: {}, internalToken: 'test-token' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/robots`, {
        headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-listing-origin': 'agent' },
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'ROBOWORK_UNAVAILABLE');
    assert.equal(body.retryable, true);
    assert.match(body.error, /RoboWork.*retry/i);
});
