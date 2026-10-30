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

async function server(t, { workerMode = true } = {}) {
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
    const roboflow = { pauseFlow: record('pauseFlow'), terminateFlow: record('terminateFlow'), pauseInstance: record('pauseInstance', true), messageInstance: record('messageInstance'),
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
        workerCoordinator: { hop: { call: async () => ({ outcome: 'response', status: 200, json: {}, refusal: null }) } }, workerMode });
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
    return { post, seen, live, robot, grantFor };
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

test('with the worker configured, the per-flow paths mint no grant and a user stop through them is refused before anything changes', async (t) => {
    const f = await server(t);
    for (const suffix of ['/pause', '/terminate', `/instances/${INSTANCE}/pause`]) {
        const result = await f.post(`/api/roboflow/flows/${FLOW}${suffix}`, {}, { plain: true });
        assert.equal(result.status, 403, suffix);
        assert.equal(result.body.error, 'owner_evidence_unavailable');
    }
    assert.equal((await f.post(`/api/roboflow/flows/${FLOW}/instances/${INSTANCE}/message`, { prompt: 'x' }, { plain: true })).status, 403);
    assert.deepEqual(f.seen.filter((entry) => /Flow|Instance/.test(entry.name)), [], 'nothing was paused, terminated or messaged');
    // The exact path without a minted grant (an old Router) is refused the same way.
    assert.equal((await f.post('/api/roboflow/control', { flowId: FLOW, action: 'pause' }, { plain: true })).status, 403);
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
