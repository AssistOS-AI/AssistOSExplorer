import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';
import { RoboWorkClient } from '../server/run-client.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { createRoboTeamServer } from '../server/http-server.mjs';
import path from 'node:path';
import { RobotPaths } from '../../roboWorkAgent/server/robot-paths.mjs';
import { RobotManager } from '../../roboWorkAgent/server/robot-manager.mjs';

const inactive = () => Object.assign(new Error('agent-to-agent target is inactive'), { statusCode: 503, code: 'TARGET_INACTIVE' });

async function startupPreparation(robotStore, runtimeManager, roboWork, log) {
    const main = await fs.readFile(new URL('../server/main.mjs', import.meta.url), 'utf8');
    const start = main.indexOf('// Shell and socket only:');
    const endMarker = 'roboWork.finishStartup();';
    const end = main.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('robotStore', 'runtimeManager', 'roboWork', 'console', main.slice(start, end + endMarker.length))(
        robotStore, runtimeManager, roboWork, { error: (...args) => log.push(args) });
}

test('startup isolates per-robot preparation failures and logs only the robot identity and error code', async () => {
    const calls = [], log = [];
    let initialized = false, finished = false;
    await startupPreparation({ list: async () => [{ id: 'robot-good' }, { id: 'robot-bad' }, { id: 'robot-next' }] }, {
        prepareOpenCode: async (id, options) => {
            calls.push({ id, options });
            if (id === 'robot-bad') throw Object.assign(new Error('private diagnostic must not be logged'), { code: 'UNSAFE_STORAGE' });
        }, initialize: async () => { initialized = true; },
    }, { finishStartup: () => { finished = true; } }, log);
    assert.deepEqual(calls, ['robot-good', 'robot-bad', 'robot-next'].map(id => ({ id, options: { seed: false } })));
    assert.equal(initialized, true); assert.equal(finished, true);
    assert.equal(log.length, 1);
    assert.deepEqual(log[0].slice(1), ['robot-bad', 'UNSAFE_STORAGE']);
    assert.doesNotMatch(JSON.stringify(log), /private diagnostic/u);
});

test('startup still fails when resident initialization cannot reach RoboWork', async () => {
    const log = [];
    let finished = false, snapshots = 0;
    const unavailable = Object.assign(new Error('RoboWork is unavailable; retry'), { code: 'ROBOWORK_UNAVAILABLE', retryable: true });
    const runtime = new RuntimeManager({ workspaceRoot: os.tmpdir(), roboWork: { call: async () => {
        snapshots++; throw unavailable;
    } }, robotStore: { list: async () => [] } });
    runtime.prepareOpenCode = async () => { throw Object.assign(new Error('individual failure'), { code: 'UNSAFE_STORAGE' }); };
    await assert.rejects(startupPreparation({ list: async () => [{ id: 'robot-bad' }] }, runtime,
        { finishStartup: () => { finished = true; } }, log), error => error === unavailable);
    assert.ok(snapshots > 0);
    assert.equal(finished, false);
});

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

test('a refused tool call keeps its code and reason through the MCP error wrapper', async () => {
    const report = { code: 'CWD_REFUSED', error: 'The workspace root is not available to a robot' };
    for (const text of [`MCP error -32603: ${JSON.stringify(report)}\n`, JSON.stringify(report)]) {
        const client = new RoboWorkClient({ createClient: async () => ({ callTool: async () => ({ content: [{ type: 'text', text }], isError: true }) }) });
        await assert.rejects(client.call('run_start', {}), { code: 'CWD_REFUSED', message: report.error });
    }
    const client = new RoboWorkClient({ createClient: async () => ({ callTool: async () => ({ content: [{ type: 'text', text: 'MCP error -32603: plain failure' }], isError: true }) }) });
    await assert.rejects(client.call('run_start', {}), { code: 'ROBOWORK_FAILED', message: 'RoboWork request failed' });
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

test('the robot list survives one robot RoboWork does not know, and a store refusal reaches the delete caller', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'list-unknown-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const paths = new RobotPaths({ dataDir: path.join(root, 'data'), workspaceRoot: root });
    await fs.mkdir(paths.robot('robot-known'), { recursive: true });
    await fs.writeFile(path.join(paths.robot('robot-known'), 'label'), JSON.stringify({ id: 'robot-known', name: 'known', codingAgents: [] }));
    const roboWorkRobots = new RobotManager({ paths, readStatus: async () => ({ activeAgent: 'codex' }) });
    const robots = ['robot-known', 'robot-gone'].map(id => ({ id, name: id, createdAt: 'x', updatedAt: 'x' }));
    const stopped = { state: 'stopped', mode: null };
    const busy = Object.assign(new Error('close the robot chat and stop its CLI tasks before deleting it'), { code: 'ROBOT_BUSY', statusCode: 409 });
    const server = createRoboTeamServer({ robotStore: { list: async () => robots, get: async id => robots.find(robot => robot.id === id), delete: async () => { throw busy; } },
        runtimeManager: { workspaceRoot: root, status: () => stopped, deleteRobot: async () => { throw busy; }, roboWork: { call: (tool, input) => roboWorkRobots.status(input) } }, skillsets: {}, internalToken: 'test-token' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const headers = { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-listing-origin': 'agent', 'content-type': 'application/json' };
    const listing = await fetch(`http://127.0.0.1:${server.address().port}/api/robots`, { headers });
    assert.equal(listing.status, 200);
    const views = (await listing.json()).robots;
    assert.deepEqual(views.map(view => [view.id, view.codingAgent]), [['robot-known', 'codex'], ['robot-gone', null]]);
    const deleted = await fetch(`http://127.0.0.1:${server.address().port}/api/control`, { method: 'POST', headers: { ...headers, 'x-roboteam-user-id': 'admin', 'x-roboteam-user-roles': '["admin"]' }, body: JSON.stringify({ operation: 'robot-delete', robotId: 'robot-gone' }) });
    assert.equal(deleted.status, 409);
    assert.deepEqual(await deleted.json(), { ok: false, error: busy.message, code: 'ROBOT_BUSY' });
});

test('a RoboWork refusal or bad cwd reaches the HTTP caller with its code and reason', async t => {
    for (const [error, status, body] of [
        [Object.assign(new Error('The workspace root is not available to a robot'), { code: 'CWD_REFUSED', statusCode: 400 }), 400, { ok: false, error: 'The workspace root is not available to a robot', code: 'CWD_REFUSED' }],
        [new Error('cwd must stay inside the enabled Ploinky workspace'), 400, { ok: false, error: 'cwd must stay inside the enabled Ploinky workspace' }],
        [new Error('private detail'), 500, { ok: false, error: 'request failed' }],
    ]) {
        const robot = { id: 'robot-abc', name: 'analyst' };
        const server = createRoboTeamServer({ robotStore: { list: async () => [robot], getByName: async () => robot, get: async () => robot },
            runtimeManager: { workspaceRoot: os.tmpdir(), roboWork: {}, openDesktop: async () => { throw error; } }, skillsets: {}, internalToken: 'test-token' });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/control`, { method: 'POST',
            headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-listing-origin': 'agent', 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'open-desktop', robotName: 'analyst', cwd: '/' }) });
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), body);
    }
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
