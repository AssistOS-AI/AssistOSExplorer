// SYNTHETIC tests of the worker-side source-protection client (server/sourceProtectionClient.mjs): exact request envelopes
// and the mapping of transport results. The controller tests that drove it through the reservation controller were removed
// with the executionTarget library (r10 Q1 = A); Ploinky's side is covered by its own tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceProtectionClient } from '../server/sourceProtectionClient.mjs';

test('the client sends exact envelopes: generation from the context, advance names its own, describe and state carry none', async () => {
    const calls = [];
    const client = createSourceProtectionClient({ transport: async (bytes) => { calls.push(JSON.parse(bytes.toString('utf8'))); return { status: 200, body: Buffer.from('{"ok":true,"value":{}}') }; } });
    const context = { workerGeneration: 'gen-current' };
    await client.describeStore(context);
    await client.readSourceState(context);
    await client.advanceWorkerGeneration(context, { version: 1, operationId: 'o1', priorGeneration: null, nextGeneration: 'gen-next' });
    await client.acknowledgeSourceStore(context, { version: 1, operationId: 'o2' });
    await client.reserveWritableResources(context, { version: 1, operationId: 'o3' });
    await client.releaseWritableReservation(context, { version: 1, operationId: 'o4' });
    assert.deepEqual(calls.map((call) => [call.op, call.workerGeneration, Object.hasOwn(call, 'request')]), [
        ['describe', null, false], ['state', null, false], ['advance', 'gen-next', true],
        ['acknowledge', 'gen-current', true], ['reserve', 'gen-current', true], ['release', 'gen-current', true]
    ]);
    for (const call of calls) assert.deepEqual(Object.keys(call).filter((key) => !['version', 'op', 'workerGeneration', 'request'].includes(key)), []);
});

test('the client passes common results through and throws on every transport-level problem', async () => {
    const answers = [];
    const client = createSourceProtectionClient({ transport: async () => answers.shift() });
    const context = { workerGeneration: 'g' };
    answers.push({ status: 200, body: Buffer.from('{"ok":false,"error":{"code":"stale_generation"}}') });
    assert.deepEqual(await client.reserveWritableResources(context, {}), { ok: false, error: { code: 'stale_generation' } });
    for (const bad of [{ status: 403, body: Buffer.from('{"error":"x"}') }, { status: 503, body: Buffer.alloc(0) }, { status: 200, body: Buffer.from('nope') },
        { status: 200, body: Buffer.from('{"value":1}') }, { status: 200, body: Buffer.from('[]') }, null, { status: 200, body: Buffer.alloc(1024 * 1024 + 1, 0x20) }]) {
        answers.push(bad);
        await assert.rejects(() => client.releaseWritableReservation(context, {}));
    }
    await assert.rejects(() => client.reserveWritableResources({}, {}), /generation_unavailable/);
    await assert.rejects(() => client.advanceWorkerGeneration(context, {}), /request_invalid/);
    assert.throws(() => createSourceProtectionClient({}), TypeError);
});
