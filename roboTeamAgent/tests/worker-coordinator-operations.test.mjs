import assert from 'node:assert/strict';
import test from 'node:test';
import { COORDINATOR_BASE_ENV, createWorkerCoordinatorHop } from '../server/worker-coordinator/hop.mjs';
import { WorkerCoordinatorError } from '../server/worker-coordinator/errors.mjs';

// The operation allowlist of the coordinator hop (RoboWork r10 decision M-6). The check runs
// before any I/O, so these tests need no Router, Agent library or identity: an allowed operation
// passes it and then meets the missing base (`worker_coordinator_unavailable`); a refused one
// stops at `invalid_request` and never reaches the request function.
const REFERENCE = 'a'.repeat(22);

function probe() {
    const calls = [];
    const hop = createWorkerCoordinatorHop({ env: { [COORDINATOR_BASE_ENV]: '' }, request: (...args) => { calls.push(args); throw new Error('no I/O expected'); } });
    return { hop, calls };
}

test('the robot and operation operations pass the allowlist', async () => {
    const { hop, calls } = probe();
    for (const operation of ['robots/provision', 'robots/configure', 'robots/get', 'robots/delete', 'operations/get',
        'admissions', 'lookup', 'bindings', `references/${REFERENCE}/read`, `references/${REFERENCE}/events`, `references/${REFERENCE}/control`]) {
        await assert.rejects(hop.call(operation, {}), (error) => error instanceof WorkerCoordinatorError
            && error.code === 'worker_coordinator_unavailable', operation);
    }
    assert.equal(calls.length, 0);
});

test('every other robots/* or unknown operation is refused before any I/O', async () => {
    const { hop, calls } = probe();
    const refused = ['robots/list', 'robots/delete/', 'robots/delete/extra', 'robots/Delete', 'robots/remove', 'robots', 'robots/', 'robots/get/extra', 'robots/provision/', 'robots/Get', 'robots/../admissions',
        'robots/get?x=1', 'robots/get#x', '/robots/get', 'operations', 'operations/list', 'operations/get/x', 'operations/delete',
        'obligations', 'obligations/list', `obligations/${REFERENCE}/accept`, `obligations/${REFERENCE}/outbox`, 'terminals', 'admin/robots/get',
        `references/${REFERENCE}/delete`, `references/${REFERENCE}`, 'references/short/read', '', ' lookup', 'lookup ', 'lookup\n', 'robots/get\n',
        '../lookup', 'LOOKUP', undefined, null, 7, {}];
    for (const operation of refused) {
        await assert.rejects(hop.call(operation, {}), (error) => error instanceof WorkerCoordinatorError
            && error.code === 'invalid_request' && error.status === 400, String(operation));
    }
    assert.equal(calls.length, 0);
});
