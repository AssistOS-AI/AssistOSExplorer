import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RoboFlowService } from '../server/roboflow/roboflow-service.mjs';
import { phaseOriginId } from '../server/worker-coordinator/flow-origins.mjs';
import { COORDINATOR_ADMISSION_TOOL, computeRchHttp, createReplayCache, createVerifierConfig, rawBodyHash } from '../../robo-work/server/coordinatorAuth.mjs';
import { createCoordinatorAdapter } from '../../robo-work/server/coordinatorAdapter.mjs';
import { S6_LIMITS, WORKSPACE, makeTempDir, newId, openStore, rawDb, readyRobot, syntheticContext } from '../../robo-work/tests/helpers/synthetic.mjs';

// A user's pause of a RoboFlow phase against the real robo-work store and coordinator adapter (cross-side, decision M-12 (b)): the
// worker records the phase origin under the flow binding, so only the binding finds it; the owner or an administrator then stops
// it with their own grant; another user is refused. The RoboTeam side talks to the adapter through a client that builds the same
// Router-signed hop requests the real hop would (the owner row from a grant, the background row from a binding).
const PROVIDER = 'agent:RoboRepo/robo-work';
const COORDINATOR = 'agent:RoboRepo/roboTeamAgent';
const BASE = '/v1/coordinator';
const b64 = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const sign = (payload, secret) => { const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`; return `${input}.${crypto.createHmac('sha256', secret).update(input).digest('base64url')}`; };
const ownerClaims = (userId, roles = ['user']) => ({
    usr: { id: userId, username: userId, email: '', roles },
    delegation: { jti: crypto.randomBytes(8).toString('hex'), scope: ['execution:owner'], sourceAgentId: COORDINATOR },
});
function hop(secret, bodyValue, pathname, claims = {}) {
    const body = Buffer.from(JSON.stringify(bodyValue));
    const iat = Math.floor(Date.now() / 1000);
    const payload = { typ: 'router-request', iss: 'ploinky-router', aud: PROVIDER, sub: COORDINATOR,
        actor: { kind: 'agent', id: COORDINATOR, roles: [] }, caller: { kind: 'agent', id: COORDINATOR, roles: ['agent'] },
        method: 'POST', path: pathname, tool: COORDINATOR_ADMISSION_TOOL, rch: computeRchHttp({ method: 'POST', path: pathname, query: '', bodyHash: rawBodyHash(body) }),
        jti: crypto.randomBytes(16).toString('base64url'), iat, exp: iat + 30, ...claims };
    return { authInfo: JSON.stringify({ invocationToken: sign(payload, secret), invocationBody: {} }), method: 'POST', path: pathname, query: '', body };
}
const task = (id) => ({ id, name: id, prompt: `Execute ${id}`, executionType: 'terminal', skillsets: [] });

async function rig(t) {
    const dir = makeTempDir(t);
    const store = openStore(dir, { limits: S6_LIMITS });
    t.after(() => store.close());
    const secret = crypto.randomBytes(32);
    const verifier = createVerifierConfig({ secret, audience: PROVIDER, coordinators: [COORDINATOR], replayCache: createReplayCache() });
    const adapter = createCoordinatorAdapter({ store, workspaceId: WORKSPACE, verifier });
    const robotId = readyRobot(store, syntheticContext({ robotOwnerId: `workspace:${WORKSPACE}`, scope: 'scope-robots' }));
    // The auth RoboTeam passes: `{grant}` is a user ('alice' | 'root' as admin | 'victor'), `{bindingId}` the coordinator alone.
    const claimsOf = (auth) => (auth.grant ? ownerClaims(auth.grant, auth.grant === 'root' ? ['admin'] : ['user']) : {});
    const bodyOf = (body, auth) => (auth.bindingId ? { ...body, bindingId: auth.bindingId } : body);
    const calls = { lookup: [], control: [] };
    const client = {
        async lookup(origin, auth) {
            calls.lookup.push(auth);
            try {
                const found = adapter.lookup(hop(secret, bodyOf({ originRequestId: origin }, auth), `${BASE}/lookup`, claimsOf(auth)));
                return { referenceId: found.taskRef?.id ?? found.reference?.id };
            } catch (error) {
                if (error.code === 'not_found') return null;
                throw Object.assign(new Error(error.code), { code: error.code });
            }
        },
        async control(referenceId, body, auth) {
            calls.control.push({ auth, op: body.op });
            try {
                return adapter.controlReference(hop(secret, bodyOf(body, auth), `${BASE}/references/${referenceId}/control`, claimsOf(auth)));
            } catch (error) {
                throw Object.assign(new Error(error.code), { code: error.code === 'not_found' ? 'forbidden' : error.code });
            }
        },
    };
    return { dir, store, secret, adapter, robotId, client, calls };
}

async function flowFixture(t, r) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cross-stop-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const robots = [{ id: 'default-id', name: 'default', codingAgents: ['codex'] }];
    const runtimeManager = { resolveCwd: async (value) => value, guiBusy: () => false, stopTask() { return { state: 'completed' }; },
        startTask(robot, type, request) { return { taskId: request.runtimeTaskId, state: 'queued' }; } };
    const service = new RoboFlowService({ robotStore: { list: async () => robots, getByName: async (name) => robots.find((robot) => robot.name === name), get: async (id) => robots.find((robot) => robot.id === id) },
        runtimeManager, databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), random: () => 0.99,
        discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }),
        skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) },
        workerMode: true, workerClient: r.client, workerSleep: (ms) => new Promise((resolve) => { if (ms === 0) parked.push(resolve); else setTimeout(resolve, 1); }) });
    const parked = [];
    await service.initialize();
    await service.presetReady;
    t.after(async () => { parked.splice(0).forEach((resolve) => resolve()); await service.close(); });
    await service.createWorkflow({ id: 'stopping', name: 'Stopping', description: 'one phase', entryTaskId: 'a', tasks: [task('a')], edges: [] });
    const flow = await service.startFlow({ workflowTypeId: 'stopping', folder: root, objective: 'Work', ownerPrincipal: 'user:alice' });
    const instance = (await service.getFlow(flow.id)).instances[0];
    // The worker side: alice's root binding for this flow, and the phase admitted under it with the phase's deterministic origin.
    r.adapter.bind(hop(r.secret, { operationId: newId(), bindingId: flow.id }, `${BASE}/bindings`, ownerClaims('alice')));
    const origin = phaseOriginId({ flowId: flow.id, instanceId: instance.id, runtimeTaskId: instance.runtimeTaskId });
    const admitted = r.adapter.admit(hop(r.secret, { originRequestId: origin, robotId: r.robotId, configRevision: 1, kind: 'task', specification: { prompt: 'phase' }, bindingId: flow.id }, `${BASE}/admissions`));
    const db = rawDb(r.dir, { readOnly: true });
    const attempt = db.prepare('SELECT execution_id AS executionId, attempt_id AS attemptId FROM reference WHERE id = ?').get(admitted.taskRef.id);
    db.close();
    r.store.transitionAttempt({ ...attempt, expectedState: 'queued', nextState: 'running' });
    await service.store.update(flow.id, (current) => { current.instances[0].startedAt = new Date().toISOString(); });
    return { service, flow, referenceId: admitted.taskRef.id, origin };
}

test('the owner\'s pause finds the binding-recorded phase by its binding and the real worker accepts the owner\'s own-grant stop', async (t) => {
    const r = await rig(t);
    const f = await flowFixture(t, r);
    // Why the lookup must use the binding: the owner row never finds a binding-keyed origin.
    assert.equal(await r.client.lookup(f.origin, { grant: 'alice' }), null);
    r.calls.lookup.length = 0;
    const user = { grant: 'alice', principal: 'user:alice', admin: false, undelivered: [] };
    const paused = await f.service.pauseFlow(f.flow.id, user);
    assert.deepEqual(user.undelivered, []);
    assert.deepEqual(r.calls.lookup, [{ bindingId: f.flow.id }]);
    assert.deepEqual(r.calls.control, [{ auth: { grant: 'alice' }, op: 'stop' }]);
    assert.equal(paused.status, 'paused');
    const db = rawDb(r.dir, { readOnly: true });
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM reference_control').get().n, 1, 'the worker recorded the stop'); } finally { db.close(); }
});

test('an administrator\'s pause is accepted by the worker; a stranger is refused by RoboTeam and a foreign grant by the worker', async (t) => {
    const admin = await rig(t);
    const a = await flowFixture(t, admin);
    const adminUser = { grant: 'root', principal: 'user:root', admin: true, undelivered: [] };
    await a.service.pauseFlow(a.flow.id, adminUser);
    assert.deepEqual(adminUser.undelivered, []);
    assert.equal(admin.calls.control.length, 1);

    const other = await rig(t);
    const b = await flowFixture(t, other);
    // RoboTeam refuses a stranger before the worker is asked; and a grant that is not the owner's, whoever claims it, is refused by the
    // worker itself and leaves the flow untouched.
    await assert.rejects(b.service.pauseFlow(b.flow.id, { grant: 'victor', principal: 'user:victor', admin: false, undelivered: [] }), (error) => error.statusCode === 403);
    assert.equal(other.calls.control.length, 0);
    const mismatched = { grant: 'victor', principal: 'user:alice', admin: false, undelivered: [] };
    await assert.rejects(b.service.pauseFlow(b.flow.id, mismatched), (error) => error.statusCode === 409);
    assert.deepEqual(mismatched.undelivered.map((entry) => entry.code), ['forbidden'], 'the worker refused a grant that is neither the owner\'s nor an administrator\'s');
    assert.notEqual((await b.service.getFlow(b.flow.id)).status, 'paused');
});
