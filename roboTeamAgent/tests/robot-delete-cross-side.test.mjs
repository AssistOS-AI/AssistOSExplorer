import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RobotStore } from '../server/robot-store.mjs';
import { deleteRobotEverywhere } from '../server/robot-delete.mjs';
import { removeRobotOnWorker } from '../server/worker-coordinator/grant-actions.mjs';
import { createRobotProvisioner } from '../server/worker-coordinator/robot-provisioning.mjs';
import { createWorkerClient } from '../server/worker-coordinator/worker-client.mjs';
import { COORDINATOR_ADMISSION_TOOL, computeRchHttp, createReplayCache, createVerifierConfig, rawBodyHash } from '../../robo-work/server/coordinatorAuth.mjs';
import { createCoordinatorAdapter } from '../../robo-work/server/coordinatorAdapter.mjs';
import { mapRefusal } from '../../robo-work/server/providerHttp.mjs';
import { S6_LIMITS, WORKSPACE, admitRequest, makeTempDir, openStore, rawDb, readyRobot, syntheticContext } from '../../robo-work/tests/helpers/synthetic.mjs';

// Scenario G, cross-side (decision M-49): a robot the worker still holds unsettled work for is refused by the real worker store
// (`robot_busy`) through the real coordinator adapter, and RoboTeam keeps its record and its home and answers 409 with the busy
// message. The RoboTeam side is the real HTTP route, `removeRobotOnWorker`, the robot provisioner and the worker client; only the hop
// is replaced by one that builds the Router-signed hop request the real hop would and gives the adapter's refusal the status the
// worker's HTTP provider gives it (`mapRefusal`).
const PROVIDER = 'agent:RoboRepo/robo-work';
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const BASE = '/v1/coordinator';
const ROBOTS = `workspace:${WORKSPACE}`;
const ADMIN = { id: 'admin-v', roles: ['admin'] };
const BUSY_MESSAGE = 'the robot has running or unsettled work; stop it first';
const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const sign = (payload, secret) => { const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`; return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`; };
const adminClaims = () => ({
    usr: { id: ADMIN.id, username: ADMIN.id, email: '', roles: ['admin'] },
    delegation: { jti: crypto.randomBytes(8).toString('hex'), scope: ['execution:owner'], sourceAgentId: COORDINATOR },
});
function hopRequest(secret, bodyValue, pathname, claims = {}) {
    const body = Buffer.from(JSON.stringify(bodyValue));
    const iat = Math.floor(Date.now() / 1000);
    const payload = { typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER, sub: COORDINATOR,
        actor: { kind: 'agent', id: COORDINATOR, roles: [] }, caller: { kind: 'agent', id: COORDINATOR, roles: ['agent'] },
        method: 'POST', path: pathname, tool: COORDINATOR_ADMISSION_TOOL, rch: computeRchHttp({ method: 'POST', path: pathname, query: '', bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30, ...claims };
    return { authInfo: JSON.stringify({ invocationToken: sign(payload, secret), invocationBody: {} }), method: 'POST', path: pathname, query: '', body };
}

async function rig(t) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: S6_LIMITS });
    t.after(() => store.close());
    const secret = crypto.randomBytes(32);
    const verifier = createVerifierConfig({ secret, audience: PROVIDER, coordinators: [COORDINATOR], replayCache: createReplayCache() });
    const adapter = createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier });
    const context = syntheticContext({ robotOwnerId: ROBOTS, scope: 'scope-robots' });
    const workerRobotId = readyRobot(store, context);
    const calls = [];
    // The operations RoboTeam's robot provisioner uses to delete: a read, then the delete with the request's grant.
    const hop = {
        async call(operation, body, { grant } = {}) {
            calls.push({ operation, grant: Boolean(grant) });
            try {
                const request = hopRequest(secret, body, `${BASE}/${operation}`, grant ? adminClaims() : {});
                const json = operation === 'robots/get' ? adapter.getRobot(request) : operation === 'robots/delete' ? adapter.delete(request) : assert.fail(`unexpected operation ${operation}`);
                return { outcome: 'response', status: 200, json, refusal: null };
            } catch (error) {
                const mapped = mapRefusal(error);
                return { outcome: 'response', status: mapped.status, json: mapped.body, refusal: null };
            }
        },
    };
    return { dir, store, context, workerRobotId, hop, calls };
}

// RoboTeam's side: a real robot store with a robot bound to the worker robot, and the same deletion functions the HTTP route calls.
async function roboTeamStore(t, r) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'robot-delete-cross-')));
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    t.after(async () => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT; else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        await fs.rm(root, { recursive: true, force: true });
    });
    const robotStore = new RobotStore({ dataDir: path.join(root, 'private') });
    await robotStore.initialize();
    const created = await robotStore.create({ name: 'busy-robot', codingAgents: ['opencode'] });
    await robotStore.withRobot(created.id, async (current, save) => { await save({ ...current, worker: { robotId: r.workerRobotId } }); });
    const robot = await robotStore.get(created.id);
    const runtimeManager = { workspaceRoot, status: () => ({ state: 'stopped' }), activePort: () => null, hasUnfinishedTasks: () => false, logs: async () => '', assertDeletable() {} };
    const provisioner = createRobotProvisioner({ client: createWorkerClient({ hop: r.hop }), robotStore });
    // What the route does for an administrator's request that carries a grant.
    const deleteRobot = () => deleteRobotEverywhere({ robot, runtimeManager, robotStore,
        removeOnWorker: (target) => removeRobotOnWorker({ provisioner, robot: target, grant: 'administrator-grant' }) });
    return { root, robot, robotStore, runtimeManager, workspaceRoot, deleteRobot };
}

// The same, through RoboTeam's HTTP route with a Router-signed administrator request (the signing fixtures come from the sibling
// Ploinky checkout; without it the test is skipped, and the function-level test above still runs).
async function roboTeamHttp(t, r, rt) {
    const { createRoboTeamServer } = await import('../server/http-server.mjs');
    const { routedHeaders } = await import('./helpers/router-worker.mjs');
    const http = createRoboTeamServer({ robotStore: rt.robotStore, runtimeManager: rt.runtimeManager, roboflow: { refreshCoverage: async () => {} }, internalToken: 'test-token', publicBasePath: '/rt/', mcpPort: 65534,
        workerCoordinator: { hop: r.hop }, workerMode: true });
    await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => http.close(resolve)));
    const base = `http://127.0.0.1:${http.address().port}`;
    return async () => {
        const text = JSON.stringify({ robotName: rt.robot.name, operation: 'robot-delete' });
        const response = await fetch(`${base}/api/control`, { method: 'POST', headers: { 'content-type': 'application/json', ...routedHeaders(ADMIN, 'POST', '/api/control', text) }, body: text });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    };
}

const workerRobot = (r) => { const db = rawDb(r.dir, { readOnly: true }); try { return db.prepare('SELECT lifecycle FROM robot WHERE id = ?').get(r.workerRobotId); } finally { db.close(); } };

const holdUnsettledWork = (r) => {
    // The worker holds an admitted, running execution for the robot and no RoboTeam holder exists (no workstation, no task, no chat).
    const admitted = r.store.admit(r.context, admitRequest(r.workerRobotId, {}, r.context));
    r.store.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    return admitted;
};
const endWork = (r, admitted) => r.store.beginAttemptEnd(r.context, { executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'running',
    outcome: { classification: 'completed', outputText: 'done', data: {} } });

test('the real worker refuses robots/delete with robot_busy while it holds unsettled work; RoboTeam keeps its record and home and refuses with 409', async (t) => {
    const r = await rig(t);
    const rt = await roboTeamStore(t, r);
    const admitted = holdUnsettledWork(r);

    await assert.rejects(rt.deleteRobot(), (error) => error.statusCode === 409 && error.code === 'robot_busy' && error.message === BUSY_MESSAGE);
    assert.deepEqual(r.calls.map((call) => call.operation), ['robots/get', 'robots/delete'], 'the worker was asked and refused');
    assert.ok(r.calls.every((call) => call.grant), 'with the administrator\'s own grant');
    assert.equal(workerRobot(r).lifecycle, 'ready', 'the worker robot is untouched');
    assert.ok(await rt.robotStore.get(rt.robot.id), 'RoboTeam keeps its record');
    assert.ok((await fs.lstat(path.join(rt.robotStore.robotPath(rt.robot.id), 'home'))).isDirectory(), 'and its home');

    // The same request is accepted once the worker's work has ended: it is the unsettled work that refused, nothing else.
    endWork(r, admitted);
    r.calls.length = 0;
    assert.deepEqual(await rt.deleteRobot(), { worker: true });
    assert.equal(workerRobot(r).lifecycle, 'deleting', 'the worker accepted the deletion');
    assert.equal(await rt.robotStore.get(rt.robot.id), null, 'RoboTeam removed its record only after the worker accepted');
});

test('through the HTTP route the worker\'s robot_busy is a 409 with the busy message, and the record and home stay', async (t) => {
    try { await import('./helpers/router-worker.mjs'); } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND') { t.skip(`Router-signed fixtures are unavailable: ${error.message.split('\n')[0]}`); return; }
        throw error;
    }
    const r = await rig(t);
    const rt = await roboTeamStore(t, r);
    const deleteOverHttp = await roboTeamHttp(t, r, rt);
    const admitted = holdUnsettledWork(r);

    const refused = await deleteOverHttp();
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, BUSY_MESSAGE, 'the busy message, not a generic failure');
    assert.deepEqual(r.calls.map((call) => call.operation), ['robots/get', 'robots/delete']);
    assert.equal(workerRobot(r).lifecycle, 'ready');
    assert.ok(await rt.robotStore.get(rt.robot.id), 'RoboTeam keeps its record');
    assert.ok((await fs.lstat(path.join(rt.robotStore.robotPath(rt.robot.id), 'home'))).isDirectory(), 'and its home');

    endWork(r, admitted);
    const accepted = await deleteOverHttp();
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(await rt.robotStore.get(rt.robot.id), null);
});
