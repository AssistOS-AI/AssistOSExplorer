import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoboTeamServer } from '../server/http-server.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import { authInfoOf, decodeJwtPayload, routedHeaders } from './helpers/router-worker.mjs';
import { authHeader, routerFetch } from './helpers/router-signed.mjs';

// Every user-initiated worker control reaches the worker with the requesting user's own grant (decisions M-12 (b), M-13, M-40).
// With the worker configured, a path that mints no grant is refused before anything changes; the exact minting paths pass the grant
// down. Requests are Router-signed by the sibling Ploinky checkout over RoboTeam's real manifest.
const ADMIN = { id: 'admin-v', roles: ['admin'] };
const FLOW = `flow_${'ab'.repeat(12)}`;
const INSTANCE = `inv_${'cd'.repeat(12)}`;

async function server(t, { workerMode = true, robotModels = undefined } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'worker-controls-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    const robot = await robotStore.ensureDefaultRobot();
    const seen = [];
    const record = (name, refuse = false) => async (...args) => { seen.push({ name, args }); if (refuse) throw Object.assign(new Error('Stop not delivered: the worker needs your fresh authorization. The task may still be running; press stop again.'), { statusCode: 409 }); return name === 'messageInstance' ? { delivery: 'delivered' } : { id: FLOW, status: 'paused' }; };
    const roboflow = { pauseFlowBySystem: record('pauseFlowBySystem'), pauseFlow: record('pauseFlow'), terminateFlow: record('terminateFlow'), pauseInstance: record('pauseInstance', true), messageInstance: record('messageInstance'),
        resumeFlow: record('resumeFlow'), resumeInstance: record('resumeInstance'),
        refreshCoverage: async () => {} };
    const runtimeManager = {
        workspaceRoot, status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false, logs: async () => '',
        stopTask(...args) { seen.push({ name: 'stopTask', args }); return { taskId: 'stop-1', state: 'completed' }; },
        takeControl(...args) { seen.push({ name: 'takeControl', args }); return { taskId: 'stop-2', state: 'completed' }; },
        sendTaskMessage(...args) { seen.push({ name: 'sendTaskMessage', args }); return { delivery: 'delivered' }; },
    };
    const live = { stop: [], message: [] };
    const liveSessions = {
        authorize: () => ({ ok: true }),
        async stop(id, viewer, options) { live.stop.push({ id, options }); return { ok: true }; },
        async message(id, viewer, text, options) { live.message.push({ id, text, options }); return { ok: true, outcome: 'delivered' }; },
    };
    const http = createRoboTeamServer({ robotStore, runtimeManager, roboflow, liveSessions, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534,
        robotModels, workerCoordinator: { hop: { call: async () => ({ outcome: 'response', status: 200, json: {}, refusal: null }) } }, workerMode });
    await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => http.close(resolve));
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${http.address().port}`;
    // `plain`: a request the Router signed without minting a grant (a path outside the minting declarations).
    const post = async (pathname, body, { plain = false } = {}) => {
        const text = JSON.stringify(body ?? {});
        const response = plain
            ? await routerFetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ploinky-auth-info': authHeader('admin-v', ['admin']) }, body: text })
            : await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', ...routedHeaders(ADMIN, 'POST', pathname, text) }, body: text });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    // The grant the Router minted for this principal on this path.
    const grantFor = (pathname, text = '{}') => authInfoOf(routedHeaders(ADMIN, 'POST', pathname, text)).delegations?.providerAdmission?.token;
    // Any routed request of the administrator (the Router signs it over the exact method, path and body).
    const send = async (method, pathname, body) => {
        const text = body === undefined ? '' : JSON.stringify(body);
        const response = await fetch(`${base}${pathname}`, { method, headers: { ...(text ? { 'content-type': 'application/json' } : {}), ...routedHeaders(ADMIN, method, pathname, text) }, ...(text ? { body: text } : {}) });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    return { post, send, seen, live, robot, robotStore, grantFor, base };
}
const subjectOf = (token) => decodeJwtPayload(token).sub;

test('the exact RoboFlow control path passes the request\'s own grant to a pause, terminate, phase pause and phase message', async (t) => {
    const f = await server(t);
    for (const [action, name] of [['pause', 'pauseFlow'], ['terminate', 'terminateFlow']]) {
        const result = await f.post('/api/roboflow/control', { flowId: FLOW, action });
        assert.equal(result.status, 200, action);
        const call = f.seen.find((entry) => entry.name === name);
        assert.equal(call.args[0], FLOW);
        assert.equal(typeof call.args[1].grant, 'string', 'the user\'s own grant');
        assert.equal(subjectOf(call.args[1].grant), 'user:admin-v');
        assert.equal(call.args[1].principal, 'user:admin-v', 'who asks is passed down for the owner-or-administrator check');
        assert.equal(call.args[1].admin, true);
    }
    const phase = await f.post('/api/roboflow/control', { flowId: FLOW, action: 'pause-instance', instanceId: INSTANCE });
    assert.equal(phase.status, 409, 'a stop the worker did not accept answers 409 with the notice');
    assert.match(phase.body.error, /^Stop not delivered: the worker needs your fresh authorization\. The task may still be running; press stop again\.$/);
    const pauseInstance = f.seen.find((entry) => entry.name === 'pauseInstance');
    assert.deepEqual(pauseInstance.args.slice(0, 2), [FLOW, INSTANCE]);
    assert.equal(typeof pauseInstance.args[2].grant, 'string');
    const message = await f.post('/api/roboflow/control', { flowId: FLOW, action: 'message-instance', instanceId: INSTANCE, prompt: 'continue' });
    assert.equal(message.status, 200);
    const sent = f.seen.find((entry) => entry.name === 'messageInstance');
    assert.deepEqual(sent.args.slice(0, 3), [FLOW, INSTANCE, 'continue']);
    assert.equal(typeof sent.args[3].grant, 'string');
    // Validation precedes any change.
    assert.equal((await f.post('/api/roboflow/control', { flowId: 'x', action: 'pause' })).status, 400);
    assert.equal((await f.post('/api/roboflow/control', { flowId: FLOW, action: 'resume' })).status, 400);
    assert.equal((await f.post('/api/roboflow/control', { flowId: FLOW, action: 'pause-instance' })).status, 400);
});

test('with the worker configured, the per-flow paths mint no grant and a user stop through them is refused before anything changes, naming POST /api/roboflow/control', async (t) => {
    const f = await server(t);
    // R-2 (decision M-49): the 403 names the replacement and the action; the flow and phase ids are the caller's own.
    for (const [suffix, action] of [['/pause', 'pause'], ['/terminate', 'terminate'], [`/instances/${INSTANCE}/pause`, 'pause-instance']]) {
        const result = await f.post(`/api/roboflow/flows/${FLOW}${suffix}`, {}, { plain: true });
        assert.equal(result.status, 403, suffix);
        assert.match(result.body.error, /^owner_evidence_unavailable: .*POST \/api\/roboflow\/control/u, suffix);
        assert.ok(result.body.error.includes(`"action": "${action}"`), `${suffix} names its action`);
        assert.deepEqual(result.body.replacement, { method: 'POST', path: '/api/roboflow/control', action }, suffix);
    }
    // The rendered text is the exact request body the caller can send: the JSON example is closed.
    const pause = await f.post(`/api/roboflow/flows/${FLOW}/pause`, {}, { plain: true });
    assert.equal(pause.body.error, 'owner_evidence_unavailable: this path carries no authorization for the worker; use POST /api/roboflow/control with {"flowId": "<flow id>", "action": "pause"}.');
    const pauseInstance = await f.post(`/api/roboflow/flows/${FLOW}/instances/${INSTANCE}/pause`, {}, { plain: true });
    assert.equal(pauseInstance.body.error, 'owner_evidence_unavailable: this path carries no authorization for the worker; use POST /api/roboflow/control with {"flowId": "<flow id>", "action": "pause-instance", "instanceId": "<phase id>"}.');
    const message = await f.post(`/api/roboflow/flows/${FLOW}/instances/${INSTANCE}/message`, { prompt: 'x' }, { plain: true });
    assert.equal(message.status, 403);
    assert.deepEqual(message.body.replacement, { method: 'POST', path: '/api/roboflow/control', action: 'message-instance' });
    assert.match(message.body.error, /"instanceId"/u);
    assert.deepEqual(f.seen.filter((entry) => /Flow|Instance/.test(entry.name)), [], 'nothing was paused, terminated or messaged');
    // The exact path without a minted grant (an old Router) is refused without naming a replacement: it already is the replacement.
    const bare = await f.post('/api/roboflow/control', { flowId: FLOW, action: 'pause' }, { plain: true });
    assert.equal(bare.status, 403);
    assert.equal(bare.body.error, 'owner_evidence_unavailable');
    assert.equal(bare.body.replacement, undefined);
});

test('M-55 (a): the launch task child\'s internal-token pause is a system pause for the user it forwards; a user-less request without the token stays refused', async (t) => {
    const f = await server(t);
    const internal = (userHeaders) => fetch(`${f.base}/api/roboflow/flows/${FLOW}/pause`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-roboteam-internal-token': 'test-token', ...userHeaders }, body: '{}' });
    const flowCalls = () => f.seen.filter((entry) => /Flow|Instance/.test(entry.name)).map((entry) => [entry.name, entry.args]);
    assert.equal((await internal({ 'x-roboteam-user-id': 'admin-v' })).status, 200);
    assert.deepEqual(flowCalls(), [['pauseFlowBySystem', [FLOW, 'admin-v']]], 'the forwarded user is who the service checks as the flow owner');
    f.seen.length = 0;
    // No forwarded user (or an empty one): refused before the service is asked.
    for (const headers of [{}, { 'x-roboteam-user-id': '' }, { 'x-roboteam-user-id': '   ' }]) {
        const refused = await internal(headers);
        assert.equal(refused.status, 403, JSON.stringify(headers));
    }
    assert.deepEqual(flowCalls(), []);
    const plain = await f.post(`/api/roboflow/flows/${FLOW}/pause`, {}, { plain: true });
    assert.equal(plain.status, 403, 'a signed request with no grant is still refused');
    assert.deepEqual(flowCalls(), []);
});

test('per-flow resume and phase resume stay as they are: they dispatch with no grant and no user argument', async (t) => {
    const f = await server(t);
    // Resume dispatches through the flow binding (decision M-49), so a request the Router signed without a grant still passes.
    const resumed = await f.post(`/api/roboflow/flows/${FLOW}/resume`, {}, { plain: true });
    assert.equal(resumed.status, 200);
    const phase = await f.post(`/api/roboflow/flows/${FLOW}/instances/${INSTANCE}/resume`, { prompt: 'go on' }, { plain: true });
    assert.equal(phase.status, 200);
    assert.deepEqual(f.seen.map((entry) => [entry.name, entry.args]), [['resumeFlow', [FLOW]], ['resumeInstance', [FLOW, INSTANCE, 'go on']]]);
});

test('without the worker the same paths keep working with no grant', async (t) => {
    const f = await server(t, { workerMode: false });
    assert.equal((await f.post(`/api/roboflow/flows/${FLOW}/pause`, {})).status, 200);
    assert.equal((await f.post('/api/roboflow/control', { flowId: FLOW, action: 'terminate' })).status, 200);
    assert.deepEqual(f.seen.map((entry) => [entry.name, entry.args[1] ?? null]), [['pauseFlow', null], ['terminateFlow', null]]);
});

test('a stop, take-control or message through /api/control is marked user-initiated and carries the request\'s grant', async (t) => {
    const f = await server(t);
    const stop = await f.post('/api/control', { operation: 'stop-simple-task', robotId: f.robot.id, taskId: 't-1' });
    assert.equal(stop.status, 202);
    const stopCall = f.seen.find((entry) => entry.name === 'stopTask');
    assert.equal(stopCall.args[3].userInitiated, true);
    assert.equal(subjectOf(stopCall.args[3].ownerGrant), 'user:admin-v');
    await f.post('/api/control', { operation: 'take-control', robotId: f.robot.id, taskId: 't-1' });
    assert.equal(f.seen.find((entry) => entry.name === 'takeControl').args[2].userInitiated, true);
    await f.post('/api/control', { operation: 'message-task', robotId: f.robot.id, taskId: 't-1', prompt: 'more' });
    assert.equal(subjectOf(f.seen.find((entry) => entry.name === 'sendTaskMessage').args[3].ownerGrant), 'user:admin-v');
});

test('a Live Sessions stop and message carry the request\'s grant and who asks; an unrouted request is refused', async (t) => {
    const f = await server(t);
    const id = 'run_abcdef012345';
    const stop = await f.post(`/api/live-sessions/${id}/stop`, {});
    assert.equal(stop.status, 200);
    assert.equal(f.live.stop[0].options.user.principal, 'user:admin-v');
    assert.equal(subjectOf(f.live.stop[0].options.user.grant), 'user:admin-v');
    const message = await f.post(`/api/live-sessions/${id}/messages`, { message: 'hello' });
    assert.equal(message.status, 200);
    assert.equal(subjectOf(f.live.message[0].options.user.grant), 'user:admin-v');
    // No grant (a Router that does not mint for the path): refused, nothing reached the registry.
    const bare = await f.post(`/api/live-sessions/${id}/stop`, {}, { plain: true });
    assert.equal(bare.status, 403);
    assert.equal(bare.body.error, 'owner_evidence_unavailable');
    assert.equal((await f.post(`/api/live-sessions/${id}/messages`, { message: 'x' }, { plain: true })).status, 403);
    assert.equal(f.live.stop.length, 1);
    assert.equal(f.live.message.length, 1);
});

// Decision M-56 (monitor condition): the robot settings dialog loads and saves with the worker configured. Only an operation that
// truly needs the model list is refused (409 model_listing_unavailable), never the whole save.
test('with the worker configured, the robot settings load and a selection without a model list saves', async (t) => {
    const f = await server(t);
    const path = `/api/robots/${f.robot.id}/coding-agents`;
    const loaded = await f.send('GET', path);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.codingAgent, f.robot.codingAgents[0]);
    const saved = await f.send('PATCH', path, { codingAgents: ['claude'] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.ok(saved.body.worker, 'worker mode ran the worker provisioning step');
    assert.notEqual(saved.body.worker.error, 'owner_evidence_unavailable', 'the PATCH route carries the administrator\'s grant to the worker step');
    assert.deepEqual((await f.send('GET', path)).body.codingAgent, 'claude');
    const withModel = await f.send('PATCH', path, { codingAgents: ['claude'], model: 'sonnet' });
    assert.equal(withModel.status, 200);
    assert.deepEqual((await f.send('GET', path)).body.models, { claude: 'sonnet' });
});

test('with the worker configured, a valid static effort saves, an unknown or malformed one is 400, an unlisted backend\'s new effort is 409', async (t) => {
    const f = await server(t);
    const path = `/api/robots/${f.robot.id}/coding-agents`;
    const claude = { codingAgents: ['claude'], model: 'sonnet' };
    assert.equal((await f.send('PATCH', path, { ...claude, effort: 'xhigh' })).status, 200);
    assert.deepEqual((await f.send('GET', path)).body.efforts, { claude: 'xhigh' });
    assert.equal((await f.send('PATCH', path, { ...claude, effort: 'turbo' })).status, 400, 'not a Claude Code effort');
    assert.equal((await f.send('PATCH', path, { ...claude, effort: 'bad effort' })).status, 400, 'not a native effort name');
    assert.deepEqual((await f.send('GET', path)).body.efforts, { claude: 'xhigh' }, 'a refused save changes nothing');
    assert.equal((await f.send('PATCH', path, { codingAgents: ['pi'], model: 'p/m', effort: 'minimal' })).status, 200);
    const opencode = { codingAgents: ['opencode'], model: 'provider/model' };
    const refused = await f.send('PATCH', path, { ...opencode, effort: 'high' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'model_listing_unavailable');
    assert.equal((await f.send('PATCH', path, opencode)).status, 200, 'the model alone needs no list');
});

test('with the worker configured, saving through the configured-only picker keeps the saved effort', async (t) => {
    const f = await server(t);
    const path = `/api/robots/${f.robot.id}/coding-agents`;
    const opencode = { codingAgents: ['opencode'], model: 'provider/model' };
    await f.robotStore.setCodingAgents(f.robot.id, ['opencode'], { ...opencode, effort: 'high' });
    // The dialog sends the agent alone, or the configured model with the saved effort: neither drops the effort.
    assert.equal((await f.send('PATCH', path, { codingAgents: ['opencode'] })).status, 200);
    assert.deepEqual((await f.send('GET', path)).body.efforts, { opencode: 'high' });
    assert.equal((await f.send('PATCH', path, { ...opencode, effort: 'high' })).status, 200, 'the saved effort needs no list');
    assert.deepEqual((await f.send('GET', path)).body.efforts, { opencode: 'high' });
    assert.equal((await f.send('PATCH', path, opencode)).status, 200, 'the same model without an effort field omits it');
    assert.deepEqual((await f.send('GET', path)).body.efforts, { opencode: 'high' });
    assert.equal((await f.send('PATCH', path, { ...opencode, effort: null })).status, 200, 'null clears it explicitly');
    assert.deepEqual((await f.send('GET', path)).body.efforts, {});
});

test('worker model unavailability preserves HTTP 503 without exposing backend error details', async (t) => {
    const f = await server(t, { robotModels: { list: async () => {
        throw Object.assign(new Error('unpublished backend detail'), { statusCode: 503, publicCode: 'runtime_unavailable' });
    } } });
    const result = await f.send('GET', `/api/robots/${f.robot.id}/models?agent=opencode`);
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'request failed');
    assert.equal(JSON.stringify(result.body).includes('unpublished'), false);
});
