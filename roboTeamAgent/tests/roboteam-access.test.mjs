import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';

// Family gate: every RoboTeam route on the service port, except internal-token
// calls, GET /status, the AgentServer passthrough and GET /api/robots, needs a
// Router-signed, Explorer-entitled user. This file is self-contained: it mints
// with the sibling Ploinky checkout's real HTTP-route minter, verifies with its
// real Agent helper, and compares against literal message strings.
const PLOINKY_ROOT = fileURLToPath(new URL('../../../ploinky/', import.meta.url));
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);
process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
const { buildHttpRouteAuthInfoHeader } = await import(new URL('cli/server/routerHandlers.js', `file://${PLOINKY_ROOT}`).href);
const { deriveAgentRequestSecret } = await import(new URL('cli/utils/security/masterKey.js', `file://${PLOINKY_ROOT}`).href);
const { sha256RawBodyHash } = await import(new URL('Agent/lib/requestHash.mjs', `file://${PLOINKY_ROOT}`).href);

const AGENT_ID = 'agent:AchillesCLI/roboTeamAgent';
const DEFINITION = { includeAuthInfo: true, issueInvocation: true, routeKey: 'roboTeamAgent', route: { repo: 'AchillesCLI', agent: 'roboTeamAgent' } };
const PREFIX = '/base-agent-additional-server/roboTeamAgent/3001';
const ENV_KEYS = ['PLOINKY_AGENT_RUNTIME_ROOT', 'PLOINKY_AGENT_ID', 'PLOINKY_AGENT_SECRET'];
const ROBOTEAM = 'Explorer access permission is required to use RoboTeam';
const ROBOFLOW = 'Explorer access permission is required to use RoboFlow';
const LISTING = 'Explorer access is required to list robots';
const AUTH = 'authenticated Ploinky user is required';
const UNAVAILABLE = 'request verification is unavailable';
const ADMIN_ONLY = 'administrator role is required';
const TOKEN = 'access-token';
const ABSENT = 'absent-robot-000';
const UUID_A = '00000000-0000-4000-8000-000000000000';
const UUID_B = '00000000-0000-4000-8000-000000000001';
const FLOW_ABSENT = `flow_${'0'.repeat(24)}`;
const INV_ABSENT = `inv_${'0'.repeat(24)}`;
const CRON_ABSENT = `cron_${'0'.repeat(24)}`;
const GRAPH = { id: 'example', name: 'Example', entryTaskId: 'one', tasks: [{ id: 'one', name: 'One', prompt: 'Execute objective', skillsets: [], executionType: 'terminal' }], edges: [] };

const PRINCIPALS = {
    selfRegistered: { id: 'self-1', username: 'self', email: 'self@example.test', roles: ['selfRegistered'], capabilities: ['selfregistered.dashboard.access'] },
    userA: { id: 'member-a', username: 'member-a', email: 'a@example.test', roles: ['user'], capabilities: ['explorer.access'] },
    userB: { id: 'member-b', username: 'member-b', email: 'b@example.test', roles: ['user'], capabilities: ['explorer.access'] },
    admin: { id: 'owner-1', username: 'owner', email: 'owner@example.test', roles: ['admin'], capabilities: [] },
    adminGuest: { id: 'owner-2', username: 'owner2', email: '', roles: ['admin', 'guest'], capabilities: ['explorer.access'] },
    upperGuest: { id: 'guest-1', username: 'guest', email: '', roles: ['GUEST'], capabilities: ['explorer.access'] },
    roleLess: { id: 'bare-1', username: 'bare', email: '', roles: [], capabilities: [] },
};

function configureAgentEnv(overrides = {}) {
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const next = {
        PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'),
        PLOINKY_AGENT_ID: AGENT_ID,
        PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(AGENT_ID),
        ...overrides,
    };
    for (const key of ENV_KEYS) {
        if (next[key] === undefined) delete process.env[key];
        else process.env[key] = next[key];
    }
    return () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

// Mint exactly as the Router does for the agent-port route: the signed path is
// the part after the port, the query is the external query, and the body hash
// covers the exact body bytes (omitted for an upgrade, which defaults to empty).
function mint(user, method, target, body = '', { routePath, externalTarget, bodyHash } = {}) {
    const external = `${PREFIX}${externalTarget ?? target}`;
    const req = { method, url: external, headers: {}, user };
    return buildHttpRouteAuthInfoHeader(req, new URL(`http://127.0.0.1:8080${external}`), DEFINITION, {
        bodyHash: bodyHash ?? sha256RawBodyHash(Buffer.from(body)),
        routePath: routePath ?? new URL(`http://127.0.0.1:8080${target}`).pathname,
    });
}

function plainHeader(user) {
    return { 'x-ploinky-auth-info': JSON.stringify({ user: { id: user.id, username: user.username, roles: user.roles }, capabilities: user.capabilities }) };
}

function internalHeaders(roles = ['user'], id = 'tool') {
    return { 'x-roboteam-internal-token': TOKEN, 'x-roboteam-user-id': id, 'x-roboteam-user-roles': JSON.stringify(roles) };
}

async function startFixture(t, { withRoboFlow = true } = {}) {
    const restoreEnv = configureAgentEnv();
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-access-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, 'project'), { recursive: true });
    const robotStore = new RobotStore({ dataDir: path.join(root, 'data') });
    await robotStore.initialize();
    const robot = await robotStore.create({ name: 'Access Robot' });
    const calls = { startTask: [], messages: [], start: [], stop: [] };
    const ports = new Map();
    const runtimeManager = {
        workspaceRoot,
        status: () => ({ state: 'stopped', task: { taskId: 'task-1', state: 'completed', cwd: path.join(workspaceRoot, 'project') } }),
        resolveCwd: async () => workspaceRoot,
        startTask(current, type, request) { calls.startTask.push({ type, request }); return { taskId: request.runtimeTaskId, state: 'queued' }; },
        stopTask() { return {}; },
        sendTaskMessage(current, taskId, prompt) { calls.messages.push(prompt); return { delivery: 'sent' }; },
        resumeTask(current, taskId, prompt, options = {}) { return { taskId: options.runtimeTaskId, state: 'queued' }; },
        taskStatus: () => null,
        start: async (current, mode) => { calls.start.push(mode); return { state: 'running', mode }; },
        stop: async () => { calls.stop.push(true); return { state: 'stopped' }; },
        logs: async () => 'log line',
        activePort: (id) => ports.get(id) || null,
        hasUnfinishedTasks: () => false,
    };
    let roboflow = null;
    if (withRoboFlow) {
        roboflow = new RoboFlowService({
            robotStore, runtimeManager,
            skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (current, input, enqueue) => enqueue(current) },
            databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        });
        await roboflow.initialize();
        await roboflow.createWorkflow(GRAPH);
    }
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow, internalToken: TOKEN, publicBasePath: '/rt/', mcpPort: 65534 });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const fixture = {
        root, workspaceRoot, robotStore, robot, roboflow, runtimeManager, calls, ports, port, baseUrl,
        // One request. A user is signed over this exact method, target and body.
        async call(method, target, { user, body, headers = {}, raw } = {}) {
            const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
            const signed = user ? mint(user, method, target, payload ?? '') : {};
            const response = await fetch(`${baseUrl}${target}`, {
                method,
                headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...signed, ...headers },
                body: payload,
            });
            const text = await response.text();
            let json = null;
            try { json = JSON.parse(text); } catch { json = null; }
            return { status: response.status, text, json, headers: response.headers };
        },
        async robotCount() { return (await robotStore.list()).length; },
        async flowCount() { return roboflow ? (await roboflow.listFlows()).length : 0; },
        close: async () => {
            await new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
            await roboflow?.close();
            restoreEnv();
            await fs.rm(root, { recursive: true, force: true });
        },
    };
    t.after(fixture.close);
    return fixture;
}

// Everything a refused request must leave untouched.
async function snapshotEffects(fixture) {
    return JSON.stringify({
        robots: await fixture.robotCount(), flows: await fixture.flowCount(),
        startTask: fixture.calls.startTask.length, messages: fixture.calls.messages.length,
        start: fixture.calls.start.length, stop: fixture.calls.stop.length,
    });
}

function refusal(response, error, label) {
    assert.equal(response.status, 403, `${label}: ${response.text.slice(0, 200)}`);
    assert.deepEqual(response.json, { ok: false, error }, label);
}

// [method, target, body, entitled user, admin, internal "user" caller]. An
// absent third value repeats the entitled-user status; null skips that actor.
// Statuses are the handler's own answer once the gate has passed.
function gatedRows(robotId) {
    const run = `/api/robots/${ABSENT}/run`;
    return [
        ['GET', `/api/robots/${robotId}/session/x`, undefined, 409],
        ['GET', '/', undefined, 200],
        ['GET', '/config.js', undefined, 200],
        ['GET', '/styles.css', undefined, 200],
        ['GET', '/InterVariable.woff2', undefined, 200],
        ['GET', '/app.js', undefined, 200],
        ['GET', '/summary', undefined, 200],
        ['GET', `/api/summary?session=${UUID_A}`, undefined, 404],
        ['GET', '/api/summary', undefined, 400],
        ['GET', '/api/required-skills', undefined, null],
        ['GET', '/conversation-skills', undefined, 200],
        ['GET', `/api/robots/${ABSENT}/conversations/${UUID_A}/skills`, undefined, 404, 404, 403],
        ['PATCH', `/api/robots/${ABSENT}/conversations/${UUID_A}/skills`, {}, 404, 404, 403],
        ['GET', `/webchat-logs/${UUID_A}/${UUID_B}`, undefined, 200],
        ['GET', `/api/webchat/logs/${UUID_A}/${UUID_B}`, undefined, 404],
        ['POST', `/api/robots/${ABSENT}/terminal`, undefined, 403, 404, 403],
        ['POST', '/api/robots', { name: 'Refused Robot' }, 403, null, 403],
        ['GET', `/api/robots/${ABSENT}/models`, undefined, 403, 404, 403],
        ['GET', `/api/robots/${ABSENT}/coding-agents`, undefined, 403, 404, 403],
        ['PATCH', `/api/robots/${ABSENT}/coding-agents`, { codingAgents: ['pi'] }, 403, 404, 403],
        ['POST', `/api/robots/${ABSENT}/skillsets`, { name: 'docs' }, 403, null, 403],
        ['DELETE', `/api/robots/${ABSENT}/skillsets?name=docs`, undefined, 403, null, 403],
        ['PATCH', `/api/robots/${ABSENT}/skillsets`, { name: 'docs' }, 403, null, 403],
        ['POST', '/api/control', { robotName: ABSENT, operation: 'start-simple-task', task: 'authorization probe, never run' }, 404],
        ['POST', '/api/control', { robotName: ABSENT, operation: 'robot-delete' }, 404],
        ['GET', run, undefined, 404],
        ['POST', run, { mode: 'browser' }, 404],
        ['DELETE', run, undefined, 404],
        ['GET', `/robots/${ABSENT}/logs`, undefined, 404],
        ['GET', `/api/robots/${ABSENT}/logs`, undefined, 404],
        ['GET', '/flows', undefined, 200],
        ['GET', '/flow-types', undefined, 200],
        ['GET', '/flow-types/new', undefined, 200],
        ['GET', '/flow-types/generate-new', undefined, 200],
        ['GET', '/api/nope', undefined, 404],
        ['GET', '/status/', undefined, 404],
        ['POST', '/status', {}, 404],
        ['GET', '/api/robots/', undefined, 404],
    ];
}

function roboflowRows() {
    const flow = `/api/roboflow/flows/${FLOW_ABSENT}`;
    return [
        ['GET', '/api/roboflow/creator-skill', undefined, 200],
        ['GET', '/api/roboflow/skillsets', undefined, 200],
        ['POST', '/api/roboflow/validate', GRAPH, 403, 200, 403],
        ['POST', '/api/roboflow/generate', { description: 'Generate' }, 403, null, 403],
        ['POST', '/api/roboflow/generations', { description: 'Generate' }, 403, null, 403],
        ['GET', `/api/roboflow/generations/${UUID_A}`, undefined, 404],
        ['DELETE', `/api/roboflow/generations/${UUID_A}`, undefined, 403, 404, 403],
        ['GET', '/api/roboflow/schedule-folders', undefined, 403, 200, 403],
        ['POST', '/api/roboflow/schedule-folders', { name: 'Reports' }, 403, null, 403],
        ['GET', '/api/roboflow/schedules', undefined, 200],
        ['POST', '/api/roboflow/schedules', { name: 'x' }, 403, null, 403],
        ['PUT', `/api/roboflow/schedules/${CRON_ABSENT}`, { revision: 1 }, 403, null, 403],
        ['DELETE', `/api/roboflow/schedules/${CRON_ABSENT}`, undefined, 403, 404, 403],
        ['POST', `/api/roboflow/schedules/${CRON_ABSENT}/run-now`, { revision: 1 }, 403, null, 403],
        ['GET', '/api/roboflow/workflows', undefined, 200],
        ['POST', '/api/roboflow/workflows', { id: 'x' }, 403, null, 403],
        ['PUT', '/api/roboflow/workflows/absent-workflow-1', { id: 'x' }, 403, null, 403],
        ['DELETE', '/api/roboflow/workflows/absent-workflow-1', undefined, 403, null, 403],
        ['GET', '/api/roboflow/flows', undefined, 200],
        ['POST', '/api/roboflow/flows', { workflowTypeId: 'example', objective: 'Probe objective' }, 201, 201, 201],
        ['GET', flow, undefined, 404],
        ['GET', `${flow}/logs/${INV_ABSENT}`, undefined, 400],
        ['POST', `${flow}/human-input/answer`, { requestId: 'x', option: 0 }, 404],
        ['POST', `${flow}/pause`, undefined, 404],
        ['POST', `${flow}/terminate`, undefined, 404],
        ['POST', `${flow}/resume`, undefined, 404],
        ['POST', `${flow}/instances/${INV_ABSENT}/pause`, {}, 404],
        ['POST', `${flow}/instances/${INV_ABSENT}/message`, { prompt: 'x' }, 404],
        ['POST', `${flow}/instances/${INV_ABSENT}/resume`, { prompt: 'x' }, 404],
        ['GET', '/api/roboflow/nope', undefined, 404],
    ];
}

// The gate refuses every row with the same message and no handler runs.
async function runRows(fixture, rows, actor, expectedRefusal, actorLabel) {
    for (const [method, target, body] of rows) {
        const label = `${actorLabel} ${method} ${target}`;
        const before = await snapshotEffects(fixture);
        const response = await fixture.call(method, target, { user: PRINCIPALS[actor], body });
        refusal(response, expectedRefusal(target), label);
        assert.equal(await snapshotEffects(fixture), before, `${label}: no handler effect`);
    }
}

test('selfRegistered is refused on every gated family route', async (t) => {
    const fixture = await startFixture(t);
    await runRows(fixture, gatedRows(fixture.robot.id), 'selfRegistered', () => ROBOTEAM, 'selfRegistered');
});

test('selfRegistered is refused on every /api/roboflow route', async (t) => {
    const fixture = await startFixture(t);
    await runRows(fixture, roboflowRows(), 'selfRegistered', () => ROBOFLOW, 'selfRegistered');
});

test('guests and role-less users are refused like selfRegistered, with the RoboFlow wording under /api/roboflow', async (t) => {
    const fixture = await startFixture(t);
    for (const actor of ['adminGuest', 'upperGuest', 'roleLess']) {
        refusal(await fixture.call('GET', '/', { user: PRINCIPALS[actor] }), ROBOTEAM, `${actor} /`);
        refusal(await fixture.call('GET', '/api/roboflow/workflows', { user: PRINCIPALS[actor] }), ROBOFLOW, `${actor} workflows`);
        refusal(await fixture.call('POST', '/api/control', { user: PRINCIPALS[actor], body: { robotName: ABSENT, operation: 'task-status' } }), ROBOTEAM, `${actor} control`);
    }
});

test('entitled users, administrators and internal callers reach the handler answer on every probed route', async (t) => {
    const fixture = await startFixture(t);
    const rows = [...gatedRows(fixture.robot.id), ...roboflowRows()];
    const reached = [];
    const mismatches = [];
    for (const [method, target, body, userStatus, adminStatus = userStatus, internalStatus = userStatus] of rows) {
        const actors = [
            ['userA', { user: PRINCIPALS.userA }, userStatus],
            ['userB', { user: PRINCIPALS.userB }, userStatus],
            ['admin', { user: PRINCIPALS.admin }, adminStatus],
            ['internal', { headers: internalHeaders(['user']) }, internalStatus],
        ];
        for (const [name, options, expected] of actors) {
            if (expected === null) continue;
            if (method === 'POST' && target === '/api/roboflow/flows' && name !== 'userA') continue;
            const response = await fixture.call(method, target, { ...options, body });
            if (response.status !== expected || [ROBOTEAM, ROBOFLOW].includes(response.json?.error)) {
                mismatches.push(`${name} ${method} ${target}: ${response.status} (expected ${expected}) ${response.text.slice(0, 120)}`);
            }
            reached.push(`${name} ${method} ${target}`);
        }
    }
    assert.deepEqual(mismatches, []);
    assert.ok(reached.length > 150, `probed ${reached.length} entitled requests`);
});

test('unsigned headers are 401', async (t) => {
    const fixture = await startFixture(t);
    const claims = plainHeader({ ...PRINCIPALS.adminGuest, roles: ['admin'], capabilities: ['explorer.access'] });
    const before = await snapshotEffects(fixture);
    for (const [method, target, body] of [
        ['GET', '/', undefined], ['GET', '/config.js', undefined], ['GET', '/styles.css', undefined], ['GET', '/api/summary', undefined],
        ['POST', '/api/control', { robotName: ABSENT, operation: 'task-status' }], ['POST', '/api/robots', { name: 'Forged Robot' }],
        ['GET', '/api/roboflow/workflows', undefined], ['GET', `/api/robots/${ABSENT}/run`, undefined],
    ]) {
        for (const [name, headers] of [['no header', {}], ['plain header claiming admin and the capability', claims], ['garbage header', { 'x-ploinky-auth-info': '{not json' }]]) {
            const response = await fixture.call(method, target, { body, headers });
            assert.equal(response.status, 401, `${name}: ${method} ${target}`);
            assert.deepEqual(response.json, { ok: false, error: AUTH }, `${name}: ${method} ${target}`);
        }
    }
    assert.equal(await snapshotEffects(fixture), before, 'no robot was created and no handler ran');
    assert.equal((await fixture.call('GET', '/', { headers: { 'x-roboteam-internal-token': 'wrong-token' } })).status, 401, 'wrong internal token');
});

test('tampered body is 401', async (t) => {
    const fixture = await startFixture(t);
    const flow = await fixture.roboflow.startFlow({ workflowTypeId: 'example', objective: 'Tamper target' });
    const before = await snapshotEffects(fixture);
    const control = JSON.stringify({ robotName: ABSENT, operation: 'task-status' });
    const tampered = JSON.stringify({ robotName: ABSENT, operation: 'start-simple-task', task: 'tampered' });
    for (const [target, signedBody, sentBody] of [
        ['/api/control', control, tampered],
        [`/api/roboflow/flows/${flow.id}/instances/${flow.instances[0].id}/message`, JSON.stringify({ prompt: 'signed' }), JSON.stringify({ prompt: 'tampered' })],
    ]) {
        const response = await fixture.call('POST', target, { raw: sentBody, headers: mint(PRINCIPALS.userA, 'POST', target, signedBody) });
        assert.equal(response.status, 401, target);
        assert.deepEqual(response.json, { ok: false, error: AUTH }, target);
    }
    assert.equal(await snapshotEffects(fixture), before, 'tampered requests have no handler effect');
});

test('replay is 401', async (t) => {
    const fixture = await startFixture(t);
    const created = JSON.stringify({ workflowTypeId: 'example', objective: 'Replay once' });
    const headers = mint(PRINCIPALS.userA, 'POST', '/api/roboflow/flows', created);
    const first = await fixture.call('POST', '/api/roboflow/flows', { raw: created, headers });
    assert.equal(first.status, 201, first.text);
    const second = await fixture.call('POST', '/api/roboflow/flows', { raw: created, headers });
    assert.equal(second.status, 401);
    assert.equal(await fixture.flowCount(), 1, 'exactly one flow was created');
    const asset = mint(PRINCIPALS.userA, 'GET', '/styles.css');
    assert.equal((await fixture.call('GET', '/styles.css', { headers: asset })).status, 200);
    assert.equal((await fixture.call('GET', '/styles.css', { headers: asset })).status, 401);
});

test('query and path binding: a token signs the exact query and path', async (t) => {
    const fixture = await startFixture(t);
    const bare = mint(PRINCIPALS.userA, 'GET', '/api/summary');
    assert.equal((await fixture.call('GET', `/api/summary?session=${UUID_A}`, { headers: bare })).status, 401, 'query added after signing');
    const root = mint(PRINCIPALS.userA, 'GET', '/');
    assert.equal((await fixture.call('GET', '/config.js', { headers: root })).status, 401, 'path changed after signing');
    const post = mint(PRINCIPALS.userA, 'GET', '/config.js');
    assert.equal((await fixture.call('POST', '/config.js', { headers: post })).status, 401, 'method changed after signing');
    await fs.mkdir(path.join(fixture.workspaceRoot, 'Daily reports'));
    const encoded = await fixture.call('GET', '/api/roboflow/schedule-folders?path=Daily%20reports', { user: PRINCIPALS.admin });
    assert.equal(encoded.status, 200, encoded.text);
    const missing = await fixture.call('GET', `/api/summary?session=${UUID_A}`, { user: PRINCIPALS.userA });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'Summary source not found');
});

test('a valid selfRegistered token cannot borrow privileges from its unsigned user fields', async (t) => {
    const fixture = await startFixture(t);
    const before = await snapshotEffects(fixture);
    const body = JSON.stringify({ name: 'Widened Robot' });
    const lesser = JSON.parse(mint(PRINCIPALS.selfRegistered, 'POST', '/api/robots', body)['x-ploinky-auth-info']);
    lesser.user = { ...lesser.user, roles: ['admin'], capabilities: ['explorer.access'] };
    const response = await fixture.call('POST', '/api/robots', { raw: body, headers: { 'x-ploinky-auth-info': JSON.stringify(lesser) } });
    refusal(response, ROBOTEAM, 'unsigned widening');
    assert.equal(await snapshotEffects(fixture), before, 'no robot was created');
});

test('refusal precedes body parsing, size limits apply first, and an empty body reaches the handler', async (t) => {
    const fixture = await startFixture(t);
    refusal(await fixture.call('POST', '/api/control', { user: PRINCIPALS.selfRegistered, raw: '{oops' }), ROBOTEAM, 'malformed JSON from selfRegistered');
    const entitledMalformed = await fixture.call('POST', '/api/control', { user: PRINCIPALS.userA, raw: '{oops' });
    assert.equal(entitledMalformed.status, 400, 'malformed JSON from an entitled user is a 400');
    const oversize = await fixture.call('POST', '/api/control', { user: PRINCIPALS.userA, raw: JSON.stringify({ filler: 'x'.repeat(64 * 1024) }) });
    assert.equal(oversize.status, 400);
    assert.equal(oversize.json.error, 'request body is too large');
    const empty = await fixture.call('POST', `/api/roboflow/flows/${FLOW_ABSENT}/pause`, { user: PRINCIPALS.userA });
    assert.equal(empty.status, 404);
    assert.equal(empty.json.error, 'workflow run not found');
});

test('verifier missing is 503', async (t) => {
    const fixture = await startFixture(t);
    const overrides = [
        { PLOINKY_AGENT_RUNTIME_ROOT: path.join(os.tmpdir(), 'roboteam-no-agent-runtime') },
        { PLOINKY_AGENT_SECRET: undefined },
        { PLOINKY_AGENT_ID: undefined },
    ];
    for (const override of overrides) {
        const restore = configureAgentEnv(override);
        try {
            for (const actor of ['userA', 'admin']) {
                for (const [method, target] of [['GET', '/'], ['GET', `/api/robots/${fixture.robot.id}/run`], ['GET', '/api/roboflow/schedules']]) {
                    const response = await fixture.call(method, target, { user: PRINCIPALS[actor] });
                    assert.equal(response.status, 503, `${JSON.stringify(Object.keys(override))} ${actor} ${method} ${target}`);
                    assert.deepEqual(response.json, { ok: false, error: UNAVAILABLE });
                }
            }
            const internal = await fixture.call('GET', '/api/roboflow/workflows', { headers: internalHeaders(['user']) });
            assert.equal(internal.status, 200, 'the internal token path does not need the verifier');
            assert.equal((await fixture.call('GET', '/', { headers: {} })).status, 401, 'no header stays 401');
        } finally { restore(); }
    }
});

test('throwing verifier is 503', async (t) => {
    const fixture = await startFixture(t);
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-throwing-runtime-'));
    t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
    await fs.mkdir(path.join(runtimeRoot, 'lib'));
    await fs.writeFile(path.join(runtimeRoot, 'lib', 'invocationAuth.mjs'), [
        'export function readAgentSecret() { return "secret"; }',
        'export function expectedAudienceForSelf() { return "audience"; }',
        'export function verifyHttpRouteAuthInfoFromHeaders() { throw new Error("invalid required token"); }',
        '',
    ].join('\n'));
    const restore = configureAgentEnv({ PLOINKY_AGENT_RUNTIME_ROOT: runtimeRoot });
    try {
        const response = await fixture.call('POST', '/api/control', { user: PRINCIPALS.userA, body: { robotName: ABSENT, operation: 'task-status' } });
        assert.equal(response.status, 503);
        assert.deepEqual(response.json, { ok: false, error: UNAVAILABLE });
        assert.equal(response.text.includes('invalid required token'), false, 'the helper message is not echoed');
    } finally { restore(); }
});

test('single verification: the body is read once and the admin projection comes from the gate', async (t) => {
    const fixture = await startFixture(t);
    const started = await fixture.call('POST', '/api/roboflow/flows', { user: PRINCIPALS.userA, body: { workflowTypeId: 'example', objective: 'Work X' } });
    assert.equal(started.status, 201, started.text);
    assert.equal(started.json.flow.objective, 'Work X', 'the cached body bytes reach the handler');
    const unicode = await fixture.call('POST', '/api/roboflow/flows', { user: PRINCIPALS.userA, body: { workflowTypeId: 'example', objective: 'răspuns ✓' } });
    assert.equal(unicode.status, 201, unicode.text);
    assert.equal(unicode.json.flow.objective, 'răspuns ✓');
    const created = await fixture.call('POST', '/api/robots', { user: PRINCIPALS.admin, body: { name: 'Admin Created' } });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.robot.run.task.cwd, path.join(fixture.workspaceRoot, 'project'), 'a verified administrator receives the privileged projection');
    const run = await fixture.call('GET', `/api/robots/${fixture.robot.id}/run`, { user: PRINCIPALS.userA });
    assert.equal(run.status, 200);
    assert.equal(run.json.robot.run.task.cwd, 'project', 'an entitled non-administrator receives the restricted projection');
    const forbidden = await fixture.call('POST', '/api/robots', { user: PRINCIPALS.userA, body: { name: 'User Robot' } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error, ADMIN_ONLY);
});

test('internal callers keep the token path and their forwarded roles', async (t) => {
    const fixture = await startFixture(t);
    const status = await fixture.call('POST', '/api/control', { headers: internalHeaders(['user']), body: { robotName: ABSENT, operation: 'task-status' } });
    assert.equal(status.status, 404, 'a user-role internal call reaches the handler');
    const create = await fixture.call('POST', '/api/robots', { headers: internalHeaders(['user']), body: { name: 'Internal Robot' } });
    assert.equal(create.status, 403);
    assert.equal(create.json.error, ADMIN_ONLY);
    const admin = await fixture.call('POST', '/api/robots', { headers: internalHeaders(['admin']), body: { name: 'Internal Admin Robot' } });
    assert.equal(admin.status, 201, admin.text);
    assert.equal(admin.json.robot.run.task.cwd, 'project', 'internal callers always receive the restricted projection');
    assert.equal((await fixture.call('GET', '/', { headers: { 'x-roboteam-internal-token': 'wrong-token' } })).status, 401, 'wrong token');
    assert.equal((await fixture.call('GET', '/api/roboflow/workflows', { headers: { 'x-roboteam-user-id': 'tool', 'x-roboteam-user-roles': '["admin"]' } })).status, 401, 'forwarded roles without the token');
});

test('exemptions: /status, the AgentServer passthrough and GET /api/robots are not decided by the family gate', async (t) => {
    const fixture = await startFixture(t);
    const status = await fixture.call('GET', '/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.service, 'RoboTeamAgent');
    for (const target of ['/health', '/mcp', '/task', '/getTaskStatus']) {
        const response = await fixture.call('GET', target);
        assert.equal(response.status, 502, `${target} is proxied to the AgentServer port, not refused by the gate`);
        assert.equal(response.json.error, 'MCP runtime is unavailable');
    }
    assert.equal((await fixture.call('GET', '/mcp/')).status, 401, 'a path variant of the passthrough is gated');
    assert.equal((await fixture.call('POST', '/status')).status, 401, 'only GET /status is exempt');
    const listing = await fixture.call('GET', '/api/robots', { user: PRINCIPALS.selfRegistered });
    refusal(listing, LISTING, 'listing keeps its own message');
    assert.equal((await fixture.call('GET', '/api/robots', { user: PRINCIPALS.userA })).status, 200);
    assert.equal((await fixture.call('GET', '/api/robots')).status, 401);
});

test('the session proxy forwards the verified request once to the running robot', async (t) => {
    const fixture = await startFixture(t);
    const seen = [];
    const upstream = http.createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, auth: req.headers['x-ploinky-auth-info'] });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('stub session body');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { upstream.closeAllConnections?.(); upstream.close(resolve); }));
    fixture.ports.set(fixture.robot.id, upstream.address().port);
    const target = `/api/robots/${fixture.robot.id}/session/x?a=1`;
    const response = await fixture.call('GET', target, { user: PRINCIPALS.userA });
    assert.equal(response.status, 200);
    assert.equal(response.text, 'stub session body');
    assert.equal(seen.length, 1, 'exactly one upstream request');
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, `/rt/api/robots/${fixture.robot.id}/session/x?a=1`);
    assert.equal(seen[0].auth, undefined, 'the signed header is not forwarded to the robot session');
    refusal(await fixture.call('GET', target, { user: PRINCIPALS.selfRegistered }), ROBOTEAM, 'selfRegistered session');
    assert.equal(seen.length, 1, 'a refused request never reaches the robot');
});

async function upgrade(fixture, target, headers) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1', port: fixture.port, method: 'GET', path: target,
            headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', ...headers },
        });
        request.once('upgrade', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode, upgraded: true, text: '' }); });
        request.once('response', (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, upgraded: false, text: Buffer.concat(chunks).toString('utf8') }));
        });
        request.once('error', reject);
        request.end();
    });
}

// The Router mints an upgrade over the signed path and an empty body hash.
const mintUpgrade = (user, target) => mint(user, 'GET', target, '', { bodyHash: '' });

test('upgrade refuses selfRegistered', async (t) => {
    const fixture = await startFixture(t);
    const target = `/api/robots/${fixture.robot.id}/session/`;
    const refused = await upgrade(fixture, target, mintUpgrade(PRINCIPALS.selfRegistered, target));
    assert.equal(refused.status, 403);
    assert.deepEqual(JSON.parse(refused.text), { ok: false, error: ROBOTEAM });
    const other = await upgrade(fixture, '/api/nope', mintUpgrade(PRINCIPALS.selfRegistered, '/api/nope'));
    assert.equal(other.status, 403, 'a non-session upgrade path is gated before it is matched');
    for (const actor of ['adminGuest', 'upperGuest', 'roleLess']) {
        assert.equal((await upgrade(fixture, target, mintUpgrade(PRINCIPALS[actor], target))).status, 403, actor);
    }
});

test('upgrade: unsigned, replayed and unverifiable requests are refused; entitled users pass the gate', async (t) => {
    const fixture = await startFixture(t);
    const target = `/api/robots/${fixture.robot.id}/session/`;
    const unsigned = await upgrade(fixture, target, plainHeader(PRINCIPALS.admin));
    assert.equal(unsigned.status, 401);
    assert.deepEqual(JSON.parse(unsigned.text), { ok: false, error: AUTH });
    assert.equal((await upgrade(fixture, target, {})).status, 401, 'no header');
    const once = mintUpgrade(PRINCIPALS.userA, target);
    const first = await upgrade(fixture, target, once);
    assert.equal(first.status, 409, 'entitled user with the robot stopped passes the gate and meets the robot check');
    assert.equal((await upgrade(fixture, target, once)).status, 401, 'replay');
    assert.equal((await upgrade(fixture, `${target}x`, mintUpgrade(PRINCIPALS.userA, target))).status, 401, 'path mismatch');
    assert.equal((await upgrade(fixture, target, mint(PRINCIPALS.userA, 'GET', target, 'body'))).status, 401, 'a non-empty signed body does not verify');
    assert.equal((await upgrade(fixture, `/api/robots/${ABSENT}/session/`, mintUpgrade(PRINCIPALS.userA, `/api/robots/${ABSENT}/session/`))).status, 404, 'absent robot');
    assert.equal((await upgrade(fixture, '/api/nope', mintUpgrade(PRINCIPALS.userA, '/api/nope'))).status, 404, 'non-session path');
    const restore = configureAgentEnv({ PLOINKY_AGENT_SECRET: undefined });
    try {
        const unavailable = await upgrade(fixture, target, mintUpgrade(PRINCIPALS.userA, target));
        assert.equal(unavailable.status, 503);
        assert.deepEqual(JSON.parse(unavailable.text), { ok: false, error: UNAVAILABLE });
    } finally { restore(); }
});

test('upgrade: an entitled user with a running robot is switched to the session, and the refusal log names only status and path', async (t) => {
    const fixture = await startFixture(t);
    const backend = net.createServer((socket) => {
        socket.once('data', () => socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'));
        socket.on('error', () => {});
    });
    await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { backend.close(resolve); }));
    fixture.ports.set(fixture.robot.id, backend.address().port);
    const target = `/api/robots/${fixture.robot.id}/session/`;
    const switched = await upgrade(fixture, target, mintUpgrade(PRINCIPALS.userA, target));
    assert.equal(switched.status, 101);
    assert.equal(switched.upgraded, true);
    const logged = [];
    const original = console.warn;
    console.warn = (...args) => { logged.push(args.join(' ')); };
    try {
        const query = '?token=SENTINEL-QUERY-SECRET';
        const headers = mint(PRINCIPALS.selfRegistered, 'GET', `${target}${query}`, '', { bodyHash: '' });
        const refused = await upgrade(fixture, `${target}${query}`, { ...headers, cookie: 'session=SENTINEL-COOKIE' });
        assert.equal(refused.status, 403);
    } finally { console.warn = original; }
    const line = logged.find((entry) => entry.includes('WebSocket upgrade'));
    assert.ok(line, 'the refusal is logged');
    assert.ok(line.includes(target) && line.includes('403'), line);
    assert.equal(/SENTINEL|invocationToken|x-ploinky/.test(line), false, 'no query, cookie or header value is logged');
});

test('twenty parallel signed requests succeed and at most one of ten replays does', async (t) => {
    const fixture = await startFixture(t);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => fixture.call('GET', '/styles.css', { user: index % 2 ? PRINCIPALS.userA : PRINCIPALS.userB })));
    assert.deepEqual(results.map((result) => result.status), Array(20).fill(200));
    const headers = mint(PRINCIPALS.userA, 'GET', '/app.js');
    const replays = await Promise.all(Array.from({ length: 10 }, () => fixture.call('GET', '/app.js', { headers })));
    const ok = replays.filter((result) => result.status === 200).length;
    assert.ok(ok <= 1, `at most one replay succeeds, saw ${ok}`);
    assert.equal(replays.filter((result) => result.status === 401).length, 10 - ok);
});

test('the bare route root without a trailing slash is signed as "/" and reaches the page', async (t) => {
    const fixture = await startFixture(t);
    // For `${PREFIX}` (no trailing slash) the Router's selector suffix is "/"
    // (parseSelector.js), so the signed path is "/" and equals the agent path.
    const bare = await fixture.call('GET', '/', { headers: mint(PRINCIPALS.userA, 'GET', '/', '', { externalTarget: '' }) });
    assert.equal(bare.status, 200, bare.text.slice(0, 200));
    // Were the signed path ever to fall back to the external path, the request
    // would not verify against the agent's "/": it fails closed with 401.
    const fallback = await fixture.call('GET', '/', { headers: mint(PRINCIPALS.userA, 'GET', '/', '', { externalTarget: '', routePath: PREFIX }) });
    assert.equal(fallback.status, 401);
});
