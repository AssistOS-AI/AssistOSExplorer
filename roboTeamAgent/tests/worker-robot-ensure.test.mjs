import assert from 'node:assert/strict';
import test from 'node:test';
import { ROBOT_ENSURE_PATH, handleWorkerRoutes } from '../server/worker-coordinator/browser-routes.mjs';
import { WorkerError } from '../server/worker-coordinator/worker-client.mjs';
import { RobotStore } from '../server/robot-store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The administrator endpoint that provisions or configures one robot on the worker (decision M-6),
// under the existing grant-bearing /api/worker/* route.
const grant = (sub) => `h.${Buffer.from(JSON.stringify({ typ: 'user-delegation', sub })).toString('base64url')}.s`;
const request = (principal) => ({ method: 'POST', headers: { 'x-ploinky-auth-info': JSON.stringify({ delegations: { providerAdmission: { token: grant(principal) } } }) } });

async function call({ access, body, provisioning, hop = {} , principal = 'user:admin' }) {
    let sent;
    await handleWorkerRoutes({ req: request(principal), res: {}, pathname: ROBOT_ENSURE_PATH, access, rawBody: Buffer.from(JSON.stringify(body)), hop, provisioning,
        sendJson: (res, status, payload) => { sent = { status, payload }; } });
    return sent;
}

const admin = { ok: true, internal: false, canAdmin: true, principal: 'user:admin' };

test('an administrator provisions one robot by its RoboTeam id with the request grant', async () => {
    const seen = [];
    const provisioning = { ensureRobot: async (robotId, auth) => { seen.push({ robotId, auth }); return { configRevision: 2, robotId: 'secret-worker-id' }; } };
    const result = await call({ access: admin, body: { robotId: 'default-ab12cd' }, provisioning });
    assert.deepEqual(result, { status: 200, payload: { ok: true, ready: true, configRevision: 2 } }, 'the worker robot id is not returned');
    assert.deepEqual(seen, [{ robotId: 'default-ab12cd', auth: { grant: grant('user:admin') } }]);
});

test('the page cannot choose a configuration, and only an administrator may ask', async () => {
    const provisioning = { ensureRobot: async () => assert.fail('must not run') };
    for (const body of [{ robotId: 'default-ab12cd', configuration: { backend: 'x' } }, {}, { robotId: '../x' }, { robotId: 7 }]) {
        assert.equal((await call({ access: admin, body, provisioning })).payload.error, 'invalid_request');
    }
    const user = { ok: true, internal: false, canAdmin: false, principal: 'user:alice' };
    const refused = await call({ access: user, body: { robotId: 'default-ab12cd' }, provisioning, principal: 'user:alice' });
    assert.deepEqual(refused, { status: 403, payload: { error: 'forbidden' } });
    const internal = await call({ access: { ok: true, internal: true, canAdmin: true }, body: { robotId: 'default-ab12cd' }, provisioning });
    assert.equal(internal.payload.error, 'owner_evidence_unavailable');
    // A grant naming another user is not evidence for this principal.
    const wrong = await call({ access: admin, body: { robotId: 'default-ab12cd' }, provisioning, principal: 'user:mallory' });
    assert.equal(wrong.payload.error, 'owner_evidence_unavailable');
});

test('worker failures keep their fixed code and status', async () => {
    const provisioning = { ensureRobot: async () => { throw new WorkerError('worker_robot_not_ready', 503); } };
    assert.deepEqual(await call({ access: admin, body: { robotId: 'default-ab12cd' }, provisioning }), { status: 503, payload: { error: 'worker_robot_not_ready' } });
    assert.equal((await call({ access: admin, body: { robotId: 'default-ab12cd' }, provisioning: null })).payload.error, 'worker_coordinator_unavailable');
});

test('the model chosen for a one-agent robot is kept as desired state for the worker', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'robot-selection-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const store = new RobotStore({ dataDir });
    const created = await store.create({ name: 'solo', codingAgents: ['codex'] });
    const robotHome = path.join(store.robotPath(created.id), 'home');
    await fs.rm(path.join(robotHome, '.ala'), { recursive: true, force: true });
    const updated = await store.setCodingAgents(created.id, ['codex'], { model: 'gpt-x', effort: 'high' });
    assert.deepEqual(updated.selection, { model: 'gpt-x', effort: 'high' });
    assert.deepEqual((await store.get(created.id)).selection, { model: 'gpt-x', effort: 'high' });
    const kept = await store.setCodingAgents(created.id, ['codex']);
    assert.deepEqual(kept.selection, { model: 'gpt-x', effort: 'high' }, 'an unchanged agent set keeps the selection');
    const changed = await store.setCodingAgents(created.id, ['claude']);
    assert.equal(Object.hasOwn(changed, 'selection'), false, 'another agent drops the old agent\'s model');
});
