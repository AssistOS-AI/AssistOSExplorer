import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';
import { RoboWorkClient, STARTUP_RETRY_WINDOW_MS } from '../server/run-client.mjs';
import { RuntimeManager } from '../server/runtime-manager.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import path from 'node:path';
import { RobotPaths } from '../../roboWorkAgent/server/robot-paths.mjs';
import { RobotManager } from '../../roboWorkAgent/server/robot-manager.mjs';

const inactive = () => Object.assign(new Error('agent-to-agent target is inactive'), { statusCode: 503, code: 'TARGET_INACTIVE' });
// What the agent client returns when a RoboWork tool fails: RoboWork's stderr report inside the MCP error text.
const refusal = (code, error) => ({ isError: true,
    content: [{ type: 'text', text: `MCP error -32603: ${JSON.stringify({ code, error, statusCode: 503 })}\n` }] });
const migrating = () => refusal('OPENCODE_MIGRATING', 'Robot homes are being upgraded to OpenCode V2. Retry shortly.');
const migrationFailed = () => refusal('OPENCODE_MIGRATION_FAILED',
    'OpenCode migration requires attention. Original state is preserved in the migration backup.');

async function startupStore(t, answer) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-migration-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const calls = [], waits = [], log = [];
    const roboWork = new RoboWorkClient({ startupRetry: true, wait: async ms => { waits.push(ms); }, log: message => log.push(message),
        createClient: async () => ({ callTool: async (tool, input) => { calls.push({ tool, input }); return answer(calls.length); } }) });
    return { store: new RobotStore({ dataDir, roboWork }), roboWork, calls, waits, log };
}

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

// What Ploinky's AgentMcpClient throws when the Router answers a draining route with 401 not_authenticated.
const draining = () => Object.assign(new Error('agent-to-agent call failed'), { statusCode: 401 });
// What RoboWork's AgentServer returns while RoboWork's own service is not listening yet.
const serviceStarting = () => ({ isError: true, content: [{ type: 'text',
    text: 'MCP error -32603: {"code":"SERVICE_UNAVAILABLE","error":"RoboWork service is unavailable","statusCode":503}\n' }] });

function fakeClock() {
    const clock = { ms: 0, waits: [], now: () => clock.ms, wait: async ms => { clock.waits.push(ms); clock.ms += ms; } };
    return clock;
}

test('a RoboWork restart while RoboTeam starts delays startup until RoboWork answers, and every robot is still prepared', async () => {
    const clock = fakeClock(), lines = [], log = [], ensured = [];
    const robots = ['robot-one', 'robot-two', 'robot-three', 'robot-four'].map(id => ({ id, name: id }));
    // The restart begins while the third robot is prepared: the route drains (401), the successor activates (503),
    // then AgentServer answers before the service listens. A second restart catches the resident snapshot.
    const outages = new Map([
        ['robot_ensure:robot-three', [draining, draining, draining, inactive, inactive, serviceStarting, serviceStarting]],
        ['robot_status', [draining, draining, inactive]],
        ['run_list', [serviceStarting]],
    ]);
    const roboWork = new RoboWorkClient({ startupRetry: true, now: clock.now, wait: clock.wait, log: line => lines.push(line),
        createClient: async () => ({ callTool: async (tool, input) => {
            const failure = outages.get(tool === 'robot_ensure' ? `${tool}:${input.robotId}` : tool)?.shift();
            if (failure) { const outcome = failure(); if (outcome instanceof Error) throw outcome; return outcome; }
            if (tool === 'robot_ensure') { ensured.push(input); return { ok: true }; }
            if (tool === 'robot_status') return { robots: [] };
            assert.equal(tool, 'run_list');
            return [{ runId: 'run-one', robotId: 'robot-two', state: 'running', tag: { kind: 'task', taskId: 'task-one', type: 'simple',
                request: { cwd: os.tmpdir() } } }];
        } }) });
    const store = { list: async () => robots, get: async id => robots.find(robot => robot.id === id) };
    const runtime = new RuntimeManager({ workspaceRoot: os.tmpdir(), roboWork, robotStore: store });
    await startupPreparation(store, runtime, roboWork, log);
    assert.deepEqual(log, [], 'no robot was skipped and startup did not fail');
    assert.deepEqual(ensured.map(input => [input.robotId, input.seed]), robots.map(robot => [robot.id, false]));
    assert.equal(runtime.recoveredTask('task-one').attachRun, 'run-one');
    assert.equal(roboWork.startupRetry, false, 'startup finished');
    assert.equal(lines.filter(line => /unavailable during startup/.test(line)).length, 3);
    assert.equal(lines.filter(line => /answered .* again/.test(line)).length, 3);
    assert.ok(clock.waits.length === 11 && clock.waits.every(ms => ms > 0 && ms <= 5000));
});

test('startup still fails when RoboWork stays unreachable past the startup window', async () => {
    const clock = fakeClock(), log = [];
    let calls = 0;
    const roboWork = new RoboWorkClient({ startupRetry: true, startupRetryWindowMs: 60_000, now: clock.now, wait: clock.wait, log: () => {},
        createClient: async () => ({ callTool: async () => { calls++; throw draining(); } }) });
    const runtime = new RuntimeManager({ workspaceRoot: os.tmpdir(), roboWork, robotStore: { list: async () => [], get: async () => null } });
    // The 401 outlasting the window surfaces unchanged, so a real authorization fault is not disguised as an outage.
    await assert.rejects(startupPreparation({ list: async () => [{ id: 'robot-one' }, { id: 'robot-two' }] }, runtime, roboWork, log),
        { statusCode: 401, message: 'agent-to-agent call failed' });
    assert.equal(roboWork.startupRetry, true, 'startup did not finish');
    assert.deepEqual(log.map(entry => entry.slice(1)), [['robot-one', 'PREPARATION_FAILED'], ['robot-two', 'PREPARATION_FAILED']]);
    // One window for the whole startup: once spent, later calls fail at once instead of waiting it out again.
    assert.equal(clock.ms, 60_000);
    assert.equal(calls, clock.waits.length + 3);
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
    // The default robot's migration wait exists only while the startup client still retries.
    assert.ok(main.indexOf('await robotStore.ensureDefaultRobot()') > main.indexOf('new RoboWorkClient({ startupRetry: true'));
    assert.ok(main.indexOf('await robotStore.ensureDefaultRobot()') < main.indexOf('roboWork.finishStartup()'));
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

test('startup retries are bounded by the startup window and exhaustion returns a clear retryable error', async () => {
    const clock = fakeClock();
    let calls = 0;
    const client = new RoboWorkClient({ startupRetry: true, now: clock.now, wait: clock.wait, log: () => {},
        createClient: async () => ({ callTool: async () => { calls++; throw inactive(); } }) });
    await assert.rejects(client.call('run_list', {}), error => error.code === 'ROBOWORK_UNAVAILABLE'
        && error.retryable === true && error.statusCode === 503 && /retry/i.test(error.message));
    assert.equal(waits(clock), STARTUP_RETRY_WINDOW_MS);
    assert.ok(clock.waits.every(ms => ms > 0 && ms <= 5000));
    assert.equal(calls, clock.waits.length + 1);
    // The window covers RoboWork's restart, which took about 12 seconds on bizanso.com, many times over.
    assert.ok(STARTUP_RETRY_WINDOW_MS >= 120_000 && STARTUP_RETRY_WINDOW_MS < 600_000);
});

function waits(clock) { return clock.waits.reduce((sum, ms) => sum + ms, 0); }

test('a 401 is retried only during startup and surfaces at once afterwards', async () => {
    const clock = fakeClock();
    let failures = 2, calls = 0;
    const client = new RoboWorkClient({ startupRetry: true, now: clock.now, wait: clock.wait, log: () => {},
        createClient: async () => ({ callTool: async () => { calls++; if (failures-- > 0) throw draining(); return { robots: [] }; } }) });
    assert.deepEqual(await client.call('robot_status', {}), { robots: [] });
    assert.equal(calls, 3);
    client.finishStartup();
    failures = 1;
    await assert.rejects(client.call('robot_status', {}), { statusCode: 401, message: 'agent-to-agent call failed' });
    assert.equal(calls, 4);
    assert.equal(clock.waits.length, 2);
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

test('a replaced RoboWork\'s gateway answers and starting service are retried during startup', async () => {
    for (const failure of [() => Object.assign(new Error('other service failure'), { statusCode: 503, code: 'OTHER_ERROR' }),
        () => Object.assign(new Error('bad gateway'), { statusCode: 502 }), () => Object.assign(new Error('gateway timeout'), { status: 504 }),
        draining, serviceStarting]) {
        const clock = fakeClock();
        let first = true;
        const client = new RoboWorkClient({ startupRetry: true, now: clock.now, wait: clock.wait, log: () => {},
            createClient: async () => ({ callTool: async () => {
                if (!first) return { robots: [] };
                first = false;
                const outcome = failure(); if (outcome instanceof Error) throw outcome; return outcome;
            } }) });
        assert.deepEqual(await client.call('robot_status', {}), { robots: [] });
        assert.equal(clock.waits.length, 1);
    }
});

test('auth, tool and unrelated HTTP failures fail immediately without startup retries', async () => {
    for (const failure of [Object.assign(new Error('forbidden'), { statusCode: 403, code: 'TARGET_INACTIVE' }),
        Object.assign(new Error('not found'), { statusCode: 404 }), Object.assign(new Error('server error'), { statusCode: 500 }),
        new Error('503 TARGET_INACTIVE'), Object.assign(new Error('invalid input'), { code: 'INVALID_INPUT' })]) {
        let calls = 0;
        const client = new RoboWorkClient({ startupRetry: true, wait: () => assert.fail('nonretryable error must not wait'),
            createClient: async () => ({ callTool: async () => { calls++; throw failure; } }) });
        await assert.rejects(client.call('robot_status', {}), error => error === failure);
        assert.equal(calls, 1);
    }
    // Only a tool reporting that RoboWork's service is not listening is transient; any other refusal is RoboWork's answer.
    for (const refusal of [{ isError: true, code: 'INVALID_INPUT', message: 'bad input' },
        { isError: true, code: 'ROBOT_BUSY', statusCode: 503, message: 'busy' }, { isError: true, message: 'no code' }]) {
        let calls = 0;
        const client = new RoboWorkClient({ startupRetry: true, wait: () => assert.fail('tool error must not wait'),
            createClient: async () => ({ callTool: async () => { calls++; return refusal; } }) });
        await assert.rejects(client.call('robot_status', {}), { code: refusal.code || 'ROBOWORK_FAILED' });
        assert.equal(calls, 1);
    }
});

test('startup creation of the default robot waits while RoboWork migrates OpenCode homes, then succeeds', async t => {
    const { store, calls, waits, log } = await startupStore(t, call => call <= 2 ? migrating() : {});
    const robot = await store.ensureDefaultRobot();
    assert.equal(robot.name, 'default');
    assert.deepEqual(calls.map(call => call.tool), ['robot_ensure', 'robot_ensure', 'robot_ensure']);
    assert.ok(calls.every(call => call.input.robotId === robot.id && call.input.seed === false));
    assert.deepEqual(waits, [1000, 2000]);
    assert.deepEqual(await store.getDefault(), robot);
    assert.deepEqual(log, ['[roboTeamAgent] robot_ensure waits while RoboWork upgrades robot homes to OpenCode V2',
        '[roboTeamAgent] robot_ensure succeeded after RoboWork\'s OpenCode V2 migration']);
});

test('a migration that never finishes fails startup once, after one bounded wait every startup call shares', async t => {
    const { store, roboWork, calls, waits, log } = await startupStore(t, () => migrating());
    t.after(() => assert.equal(log.length, 1));
    await assert.rejects(store.ensureDefaultRobot(), error => error.code === 'OPENCODE_MIGRATING' && error.statusCode === 503
        && /still upgrading robot homes to OpenCode V2.*waited 300 seconds during startup/u.test(error.message));
    assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 300000);
    assert.ok(waits.every(ms => ms > 0 && ms <= 5000));
    assert.equal(calls.length, waits.length + 1);
    // The budget is spent: a later startup call that may wait asks once and fails without waiting again.
    await assert.rejects(roboWork.call('robot_ensure', { robotId: 'robot-next' }, { waitForMigration: true }), { code: 'OPENCODE_MIGRATING' });
    assert.equal(calls.length, waits.length + 2);
    assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 300000);
});

test('a failed OpenCode migration is never retried', async t => {
    const { store, calls, waits } = await startupStore(t, () => migrationFailed());
    await assert.rejects(store.ensureDefaultRobot(), { code: 'OPENCODE_MIGRATION_FAILED', statusCode: 503,
        message: 'OpenCode migration requires attention. Original state is preserved in the migration backup.' });
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
});

test('only startup creation of the default robot waits for the migration', async t => {
    const { store, roboWork, calls, waits, log } = await startupStore(t, () => migrating());
    t.after(() => assert.deepEqual(log, []));
    const original = { code: 'OPENCODE_MIGRATING', statusCode: 503, message: 'Robot homes are being upgraded to OpenCode V2. Retry shortly.' };
    // RoboWork repeats preparation after its migration for every robot it knows, so per-robot preparation fails at once as before.
    await assert.rejects(roboWork.call('robot_ensure', { robotId: 'robot-a', seed: false }), original);
    await assert.rejects(store.create({ name: 'Analyst' }), original);
    assert.equal(calls.length, 2);
    roboWork.finishStartup();
    await assert.rejects(roboWork.call('robot_ensure', { robotId: 'robot-b' }, { waitForMigration: true }), original);
    await assert.rejects(store.ensureDefaultRobot(), original);
    assert.equal(calls.length, 4);
    assert.deepEqual(waits, []);
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
    const paths = new RobotPaths({ dataDir: path.join(root, 'data'), robotsDir: path.join(root, 'robots'), workspaceRoot: root });
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
        const server = createRoboTeamServer({ robotStore: { list: async () => [robot], get: async () => robot },
            runtimeManager: { workspaceRoot: os.tmpdir(), roboWork: {}, openDesktop: async () => { throw error; } }, skillsets: {}, internalToken: 'test-token' });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/control`, { method: 'POST',
            headers: { 'x-roboteam-internal-token': 'test-token', 'x-roboteam-listing-origin': 'agent', 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'open-desktop', robotId: 'robot-abc', cwd: '/' }) });
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
