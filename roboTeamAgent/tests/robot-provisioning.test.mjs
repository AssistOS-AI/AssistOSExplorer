import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerError } from '../server/worker-coordinator/worker-client.mjs';
import { configurationDigest, createRobotProvisioner, desiredConfiguration, lifecycleOperationId } from '../server/worker-coordinator/robot-provisioning.mjs';
import { isOperationId } from '../server/worker-coordinator/identities.mjs';

// The robot provisioning client against a fake worker client: the worker mints the robot ID, every
// lifecycle call has a deterministic operation ID, and readiness is polled within a bound.
const WORKER_ROBOT = 'AAAAAAAAAAAAAAAAAAAAAA';
const robot = (extra = {}) => ({ id: 'default-ab12cd', name: 'default', codingAgents: ['codex'], ...extra });

function fixture({ views = [], robotRecord = robot(), provisionError = null } = {}) {
    const calls = [];
    const saved = [];
    let record = robotRecord;
    const queue = [...views];
    const client = {
        async provision(body, auth) {
            calls.push(['provision', body, auth]);
            if (provisionError && provisionError.count-- > 0) throw provisionError.error;
            return { operationId: body.operationId, type: 'provision', robotId: WORKER_ROBOT, status: 'accepted' };
        },
        async configure(body, auth) { calls.push(['configure', body, auth]); return { status: 'accepted' }; },
        async getRobot(robotId, auth) {
            calls.push(['getRobot', robotId, auth]);
            const view = queue.length > 1 ? queue.shift() : queue[0];
            if (view instanceof Error) throw view;
            return view;
        },
    };
    const robotStore = { async withRobot(id, operation) { assert.equal(id, record.id); return operation(record, async (next) => { saved.push(next); record = next; }); } };
    let clock = 0;
    const provisioner = createRobotProvisioner({ client, robotStore, sleep: async () => { clock += 1000; }, now: () => clock, readyTimeoutMs: 5000 });
    return { provisioner, calls, saved, current: () => record };
}

const ready = (configuration, revision = 1) => ({ robotId: WORKER_ROBOT, lifecycle: 'ready', revision, configuration, preparing: false, ready: true });

test('the desired worker configuration is derived from the RoboTeam robot, never from a request', () => {
    assert.deepEqual(desiredConfiguration(robot()), { backend: 'codex', settings: { codingAgents: ['codex'] } });
    assert.deepEqual(desiredConfiguration(robot({ codingAgents: ['codex', 'claude'] })), { backend: 'auto', settings: { codingAgents: ['codex', 'claude'] } });
    assert.deepEqual(desiredConfiguration(robot({ selection: { model: 'm1', effort: 'high' } })),
        { backend: 'codex', settings: { codingAgents: ['codex'], model: 'm1', effort: 'high' } });
    assert.deepEqual(desiredConfiguration(robot({ codingAgents: ['codex', 'pi'], selection: { model: 'm1' } })).settings, { codingAgents: ['codex', 'pi'] },
        'a model applies to a one-agent robot only');
});

test('a robot without a worker record is provisioned by an administrator and its worker ID is recorded at once', async () => {
    const configuration = desiredConfiguration(robot());
    const f = fixture({ views: [{ ...ready(null, 0), lifecycle: 'provisioning', preparing: true, ready: false }, ready(configuration)] });
    const result = await f.provisioner.ensureReady(robot(), { grant: 'g' });
    assert.deepEqual(result, { robotId: WORKER_ROBOT, configRevision: 1, configuration });
    const [name, body, auth] = f.calls[0];
    assert.equal(name, 'provision');
    assert.deepEqual(auth, { grant: 'g' });
    assert.equal(body.name, 'default');
    assert.deepEqual(body.configuration, configuration);
    assert.equal(body.operationId, lifecycleOperationId('provision', 'default-ab12cd', configurationDigest(configuration)));
    assert.equal(isOperationId(body.operationId), true);
    assert.deepEqual(f.saved.map((record) => record.worker), [{ robotId: WORKER_ROBOT }]);
    assert.equal(f.calls.filter(([call]) => call === 'configure').length, 0);
    assert.ok(f.calls.filter(([call]) => call === 'getRobot').length >= 2, 'readiness was polled');
});

test('without an administrator grant a missing worker robot is refused, never created', async () => {
    const f = fixture({ views: [ready(desiredConfiguration(robot()))] });
    await assert.rejects(f.provisioner.ensureReady(robot(), {}), (error) => error instanceof WorkerError && error.code === 'worker_robot_not_provisioned');
    await assert.rejects(f.provisioner.ensureReady(robot(), { bindingId: 'flow_x' }), (error) => error.code === 'worker_robot_not_provisioned');
    assert.deepEqual(f.calls, []);
});

test('a ready robot with the desired configuration is read only; a stale one is configured with the CAS revision', async () => {
    const desired = desiredConfiguration(robot({ selection: { model: 'm2' } }));
    const same = fixture({ views: [ready(desiredConfiguration(robot()), 4)] });
    const result = await same.provisioner.ensureReady(robot({ worker: { robotId: WORKER_ROBOT } }), {});
    assert.equal(result.configRevision, 4);
    assert.deepEqual(same.calls.map(([call]) => call), ['getRobot', 'getRobot']);

    const stale = fixture({ views: [ready(desiredConfiguration(robot()), 4), ready(desired, 5)] });
    const configured = await stale.provisioner.ensureReady(robot({ selection: { model: 'm2' }, worker: { robotId: WORKER_ROBOT } }), { grant: 'g' });
    assert.equal(configured.configRevision, 5);
    const configure = stale.calls.find(([call]) => call === 'configure');
    assert.equal(configure[1].expectedRevision, 4);
    assert.equal(configure[1].robotId, WORKER_ROBOT);
    assert.deepEqual(configure[1].configuration, desired);
    assert.equal(configure[1].operationId, lifecycleOperationId('configure', 'default-ab12cd', WORKER_ROBOT, 4, configurationDigest(desired)));
    assert.equal(stale.calls.some(([call]) => call === 'provision'), false);

    // Stale with no administrator grant: refused, not configured.
    const noGrant = fixture({ views: [ready(desiredConfiguration(robot()), 4)] });
    await assert.rejects(noGrant.provisioner.ensureReady(robot({ selection: { model: 'm2' }, worker: { robotId: WORKER_ROBOT } }), {}),
        (error) => error.code === 'worker_robot_stale');
    assert.equal(noGrant.calls.some(([call]) => call === 'configure'), false);
});

test('a lost lifecycle reply is retried once with the same operation ID', async () => {
    const configuration = desiredConfiguration(robot());
    const f = fixture({ views: [ready(configuration)], provisionError: { count: 1, error: new WorkerError('worker_reply_unknown', 503) } });
    await f.provisioner.ensureReady(robot(), { grant: 'g' });
    const provisions = f.calls.filter(([call]) => call === 'provision');
    assert.equal(provisions.length, 2);
    assert.equal(provisions[0][1].operationId, provisions[1][1].operationId);
    const failing = fixture({ views: [ready(configuration)], provisionError: { count: 5, error: new WorkerError('worker_reply_unknown', 503) } });
    await assert.rejects(failing.provisioner.ensureReady(robot(), { grant: 'g' }), (error) => error.code === 'worker_reply_unknown');
    assert.equal(failing.calls.filter(([call]) => call === 'provision').length, 2, 'bounded');
});

test('failure, a vanished robot and a slow preparation end explicitly', async () => {
    const configuration = desiredConfiguration(robot());
    const failed = fixture({ views: [{ ...ready(configuration), lifecycle: 'failed', ready: false, reason: 'resource_quarantined' }] });
    await assert.rejects(failed.provisioner.ensureReady(robot({ worker: { robotId: WORKER_ROBOT } }), {}), (error) => error.code === 'worker_robot_failed' && error.reason === 'resource_quarantined');
    const missing = fixture({ views: [new WorkerError('not_found', 404)] });
    await assert.rejects(missing.provisioner.ensureReady(robot({ worker: { robotId: WORKER_ROBOT } }), { grant: 'g' }), (error) => error.code === 'worker_robot_missing');
    assert.equal(missing.calls.some(([call]) => call === 'provision'), false, 'never a second worker robot for one RoboTeam robot');
    const slow = fixture({ views: [{ ...ready(configuration), preparing: true, ready: false }] });
    await assert.rejects(slow.provisioner.ensureReady(robot({ worker: { robotId: WORKER_ROBOT } }), {}), (error) => error.code === 'worker_robot_not_ready');
});
