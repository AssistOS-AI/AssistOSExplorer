import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureRobotWithGrant, registerRootFlowBinding, workerGrantFor } from '../server/worker-coordinator/grant-actions.mjs';
import { bindOperationId } from '../server/worker-coordinator/identities.mjs';
import { WorkerError } from '../server/worker-coordinator/worker-client.mjs';

// What the few grant-minting API requests do with their own grant (decision M-13).
const grantOf = (sub) => `h.${Buffer.from(JSON.stringify({ typ: 'user-delegation', sub })).toString('base64url')}.s`;
const request = (sub) => ({ headers: { 'x-ploinky-auth-info': JSON.stringify({ delegations: { providerAdmission: { token: grantOf(sub) } } }) } });
const FLOW = `flow_${'ab'.repeat(12)}`;
const response = (status, json) => ({ outcome: 'response', status, refusal: null, json });

test('the request grant is read for the verified principal only; an internal caller has none', () => {
    assert.equal(workerGrantFor(request('user:alice'), { internal: false, principal: 'user:alice' }), grantOf('user:alice'));
    assert.equal(workerGrantFor(request('user:mallory'), { internal: false, principal: 'user:alice' }), null, 'a grant for another user is not evidence');
    assert.equal(workerGrantFor(request('user:alice'), { internal: true, principal: 'user:alice' }), null);
    assert.equal(workerGrantFor({ headers: {} }, { internal: false, principal: 'user:alice' }), null);
});

test('a root flow binding is registered with the starting request\'s grant under its deterministic operation', async () => {
    const calls = [];
    const hop = { call: async (operation, body, options) => { calls.push({ operation, body, options }); return response(200, { bindingId: FLOW, status: 'registered' }); } };
    const grant = grantOf('user:alice');
    const receipt = await registerRootFlowBinding({ hop, flow: { id: FLOW }, grant });
    assert.deepEqual(receipt, { bindingId: FLOW, status: 'registered' });
    assert.deepEqual(calls, [{ operation: 'bindings', body: { operationId: bindOperationId(FLOW), bindingId: FLOW }, options: { grant } }]);
    // A child flow derives from its parent; the coordinator registers it alone.
    assert.equal(await registerRootFlowBinding({ hop, flow: { id: FLOW, parentFlowId: `flow_${'cd'.repeat(12)}` }, grant }), null);
    assert.equal(calls.length, 1);
});

test('a missing grant or a worker refusal stops the flow start with a status', async () => {
    const hop = { call: async () => response(403, { error: 'forbidden' }) };
    await assert.rejects(registerRootFlowBinding({ hop, flow: { id: FLOW }, grant: null }), (error) => error.statusCode === 403 && error.message === 'owner_evidence_unavailable');
    await assert.rejects(registerRootFlowBinding({ hop, flow: { id: FLOW }, grant: grantOf('user:alice') }), (error) => error.statusCode === 403 && error.message === 'forbidden');
    await assert.rejects(registerRootFlowBinding({ hop: null, flow: { id: FLOW }, grant: grantOf('user:alice') }), (error) => error.statusCode === 503);
    const lost = { call: async () => ({ outcome: 'unknown' }) };
    await assert.rejects(registerRootFlowBinding({ hop: lost, flow: { id: FLOW }, grant: grantOf('user:alice') }), (error) => error.message === 'worker_reply_unknown');
});

test('robot create and update provision with the request grant; a failure is reported and does not undo the change', async () => {
    const seen = [];
    const provisioner = { ensureReady: async (robot, auth) => { seen.push({ robot, auth }); } };
    const grant = grantOf('user:admin');
    assert.deepEqual(await ensureRobotWithGrant({ provisioner, robot: { id: 'r' }, grant }), { ready: true });
    assert.deepEqual(seen, [{ robot: { id: 'r' }, auth: { grant } }]);
    const failing = { ensureReady: async () => { throw new WorkerError('worker_robot_not_ready', 503); } };
    assert.deepEqual(await ensureRobotWithGrant({ provisioner: failing, robot: { id: 'r' }, grant }), { ready: false, error: 'worker_robot_not_ready' });
    assert.deepEqual(await ensureRobotWithGrant({ provisioner, robot: { id: 'r' }, grant: null }), { ready: false, error: 'owner_evidence_unavailable' });
    assert.equal(seen.length, 1);
});
