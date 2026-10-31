// A worker admission that carries an Environment selection is refused with 400 `environment_unavailable` (existing-agent
// environments are not available yet). RoboTeam maps it as a plain 400 with a fixed message for the user.
import assert from 'node:assert/strict';
import test from 'node:test';
import { STATUS, PLAIN_MESSAGES, mapHopOutcome, refusal } from '../server/worker-coordinator/errors.mjs';
import { createWorkerClient } from '../server/worker-coordinator/worker-client.mjs';
import { runtimeManagerInternals } from '../server/runtime-manager.mjs';

const MESSAGE = 'Existing-agent environments are not available.';
const ORIGIN = 'a'.repeat(32);

test('environment_unavailable is a plain 400 with its message, and other 400 codes carry no message', () => {
    assert.equal(STATUS.environment_unavailable, 400);
    assert.equal(PLAIN_MESSAGES.environment_unavailable, MESSAGE);
    assert.deepEqual(refusal('environment_unavailable'), { status: 400, body: { error: 'environment_unavailable', message: MESSAGE } });
    assert.deepEqual(mapHopOutcome({ outcome: 'response', status: 400, json: { error: 'environment_unavailable' } }),
        { status: 400, body: { error: 'environment_unavailable', message: MESSAGE } });
    assert.deepEqual(mapHopOutcome({ outcome: 'response', status: 400, json: { error: 'invalid_request' } }), { status: 400, body: { error: 'invalid_request' } });
});

test('the worker client raises the refusal with a readable message and the stable code, and the task error shows it plainly', async () => {
    const client = createWorkerClient({ hop: { call: async () => ({ outcome: 'response', status: 400, json: { error: 'environment_unavailable' } }) } });
    await assert.rejects(client.admit({ originRequestId: ORIGIN }, {}), (error) => error.code === 'environment_unavailable' && error.status === 400
        && error.message === `environment_unavailable: ${MESSAGE}`);
    const line = `environment_unavailable: ${MESSAGE}`;
    assert.equal(runtimeManagerInternals.alaFailureMessage(1, `noise\n${line}\n`), line);
});
