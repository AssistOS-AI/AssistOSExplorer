// SYNTHETIC tests of the worker-side source-protection client (server/sourceProtectionClient.mjs). The Router and the
// Ploinky interlock are replaced by an in-memory loopback fake that follows the T0 base section 6 and amendments
// A2-A6 closely enough to drive the controller through the client. The fake is not the Ploinky implementation; the
// Ploinky side is covered by its own tests (executionTargetSourceProtectionWiring.test.mjs).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { targetDigest } from '../../server/executionTarget/contract.mjs';
import { createWritableReservationController } from '../../server/executionTarget/sourceReservations.mjs';
import { createSourceProtectionClient } from '../../server/sourceProtectionClient.mjs';
import { WORKSPACE, makeTempDir, openStore, rawDb, readyRobot, syntheticContext } from '../helpers/synthetic.mjs';

const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const sid = (label) => crypto.createHash('sha256').update(`client-id:${label}`).digest().subarray(0, 16).toString('base64url');
const sdg = (label) => sha(`client-digest:${label}`);
const digest = (value) => targetDigest(value).value;
const WORKER = 'agent:SyntheticIDE/roboWork';
const fsId = (inode) => ({ filesystemId: 'synthetic-fs', mountId: '41', device: '2049', inode: String(inode), fileType: 'directory' });

// The Router side of the channel: derives the worker identity from its authentication (here a constant) and calls the
// interlock with the worker generation carried in the envelope.
function createLoopback({ storeId = sid('store-a'), epoch = 3 } = {}) {
    const s = { storeId, epoch, pointer: null, acknowledged: false, reservations: new Map(), receipts: new Map(), seen: [], mode: null };
    const ok = (value) => ({ ok: true, value: JSON.parse(JSON.stringify(value)) });
    const no = (code) => ({ ok: false, error: { code } });
    const record = () => ({
        version: 1, workspaceId: WORKSPACE, boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', sourceProtectionEpoch: s.epoch,
        sourceSelectionDigest: sdg('selection'), sourceClosureDigest: sdg('closure'), sourceAcceptanceIdentity: 'acceptance-1', sourceStoreIdentity: storeId,
        protectionStatus: 'protected', enforcementDigest: sdg('enforcement'), aliasCoverageDigest: sdg('alias'), acceptedAtMs: 1700000000000
    });
    function handle(envelope) {
        s.seen.push(envelope);
        const { op, workerGeneration, request } = envelope;
        if (op === 'describe') {
            return ok({ state: s.acknowledged ? 'ready' : 'awaiting-holder-ack', sourceStoreIdentity: storeId, holderAcknowledged: s.acknowledged, currentGeneration: s.pointer });
        }
        if (op === 'state') return ok({ version: 1, sourceStoreIdentity: storeId, record: record(), facts: null });
        if (op === 'advance') {
            if ((s.pointer ?? null) !== request.priorGeneration || workerGeneration !== request.nextGeneration) return no('stale_generation');
            s.pointer = request.nextGeneration;
            return ok({ version: 1, operationId: request.operationId, workerPrincipal: WORKER, priorGeneration: request.priorGeneration, currentGeneration: request.nextGeneration, requestDigest: digest(request) });
        }
        if (workerGeneration !== s.pointer) return no('stale_generation');
        if (op === 'acknowledge') {
            s.acknowledged = true;
            return ok({ version: 1, operationId: request.operationId, sourceStoreIdentity: storeId, workerPrincipal: WORKER, state: 'ready', requestDigest: digest(request) });
        }
        if (op === 'reserve') {
            if (request.expectedEpoch !== s.epoch) return no('stale_source_epoch');
            const reservation = {
                version: 1, reservationId: request.reservationId, operationId: request.operationId, workspaceId: request.workspaceId,
                boxIdentity: request.boxIdentity, boxGeneration: request.boxGeneration, workerPrincipal: WORKER,
                workerRuntimeInstanceId: 'worker-instance-1', workerEnableGeneration: 'worker-enable-1', workerGeneration,
                robotId: request.robotId, executionId: request.executionId, attemptId: request.attemptId, consumerKind: request.consumerKind,
                consumerId: request.consumerId, sourceProtectionEpoch: s.epoch, sourceSelectionDigest: sdg('selection'),
                sourceClosureDigest: sdg('closure'), sourceAcceptanceIdentity: 'acceptance-1', sourceStoreIdentity: storeId,
                resources: request.resources, requestDigest: digest(request), state: 'reserved', createdAtMs: 1700000005000, releaseEvidenceDigest: null
            };
            s.reservations.set(request.reservationId, reservation);
            return ok(reservation);
        }
        if (op === 'release') {
            const reservation = s.reservations.get(request.reservationId);
            if (!reservation) return no('not_found');
            s.reservations.delete(request.reservationId);
            return ok({ version: 1, operationId: request.operationId, reservationId: request.reservationId, state: 'released', requestDigest: digest(request), releaseEvidenceDigest: request.releaseEvidenceDigest, sourceStoreIdentity: storeId });
        }
        return no('invalid_request');
    }
    s.transport = async (bytes) => {
        if (s.mode === 'down') throw new Error('synthetic connection refused');
        if (s.mode === 'forbidden') return { status: 403, body: Buffer.from('{"ok":false,"error":"PRIVATE_CALLER_DENIED"}') };
        if (s.mode === 'hardware') return { status: 403, body: Buffer.from('{"ok":false,"error":"PRIVATE_CALLER_HARDWARE_UNAVAILABLE"}') };
        if (s.mode === 'bad-request') return { status: 400, body: Buffer.from('{"error":"invalid_request"}') };
        if (s.mode === 'garbled') return { status: 200, body: Buffer.from('<html>') };
        const envelope = JSON.parse(bytes.toString('utf8'));
        const result = handle(envelope);
        if (s.mode === 'lost-reply-once') { s.mode = null; throw new Error('synthetic lost reply after the interlock committed'); }
        return { status: 200, body: Buffer.from(JSON.stringify(result)) };
    };
    return s;
}

function generationChainOf(dir) {
    return () => {
        const db = rawDb(dir, { readOnly: true });
        try {
            return db.prepare('SELECT id, prior_id FROM generation').all().map((row) => ({ id: row.id, priorId: row.prior_id }));
        } finally {
            db.close();
        }
    };
}

function wire(t, loopback) {
    const dir = makeTempDir(t);
    const handle = openStore(dir);
    const robotId = readyRobot(handle, syntheticContext());
    const client = createSourceProtectionClient({ transport: loopback.transport });
    // The management context is opaque to the client except for the worker's S1 generation.
    const managementContext = Object.freeze({ workerGeneration: handle.generationId });
    const controller = createWritableReservationController({
        workerState: handle,
        interlock: client,
        managementContext,
        identity: { workspaceId: WORKSPACE, boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', workerPrincipal: WORKER, workerRuntimeInstanceId: 'worker-instance-1', workerEnableGeneration: 'worker-enable-1' },
        generationChain: generationChainOf(dir)
    });
    return { handle, robotId, client, controller };
}

let counter = 0;
const op = (label) => sid(`${label}-${counter += 1}`);

async function ready(controller) {
    assert.equal((await controller.syncStore()).ok, true);
    assert.equal((await controller.registerGeneration({ operationId: op('advance') })).ok, true);
    assert.equal((await controller.acknowledgeStore({ operationId: op('ack') })).ok, true);
    assert.deepEqual(controller.readiness(), { ready: true, code: null });
}

const intent = (robotId, overrides = {}) => ({
    operationId: op('reserve'), robotId, executionId: null, attemptId: null, consumerKind: 'terminal', consumerId: sid(`consumer-${counter}`), expectedEpoch: 3,
    resources: [{ resourceId: sid('res-home'), kind: 'home', rootIdentity: fsId(7000), bindingChainDigest: sdg('chain-home'), access: 'write', aliasCoverageDigest: sdg('alias') }],
    ...overrides
});

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

test('the reservation controller runs reserve and release through the client', async (t) => {
    const loopback = createLoopback();
    const { robotId, controller } = wire(t, loopback);
    await ready(controller);
    const reserved = await controller.reserve(intent(robotId));
    assert.equal(reserved.ok, true, JSON.stringify(reserved));
    assert.equal(reserved.value.sourceStoreIdentity, loopback.storeId);
    assert.deepEqual(loopback.seen.map((envelope) => envelope.op), ['describe', 'advance', 'acknowledge', 'reserve']);
    assert.ok(loopback.seen.filter((envelope) => envelope.op !== 'describe').every((envelope) => typeof envelope.workerGeneration === 'string'));
    const reservation = reserved.value;
    const released = await controller.release({
        operationId: op('release'), reservation,
        evidence: { complete: true, fresh: true, sealed: true, openHandles: 0, digest: sdg('absence'), resources: reservation.resources.map((resource) => ({ resourceId: resource.resourceId, state: 'absent' })) }
    });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(loopback.seen.at(-1).op, 'release');
});

test('transient failures read as outcome_unknown; permanent Router refusals are terminal', async (t) => {
    const loopback = createLoopback();
    const { robotId, controller } = wire(t, loopback);
    await ready(controller);
    for (const mode of ['down', 'hardware', 'garbled']) {
        loopback.mode = mode;
        const result = await controller.reserve(intent(robotId));
        assert.equal(result.ok, false, mode);
        assert.equal(result.error.code, 'outcome_unknown', mode);
    }
    loopback.mode = 'bad-request';
    const malformed = await controller.reserve(intent(robotId));
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, 'invalid_request');
    loopback.mode = 'forbidden';
    const denied = await controller.reserve(intent(robotId));
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'forbidden');
    assert.equal(controller.readiness().ready, false, 'a permanent holder refusal withdraws readiness');
    assert.equal(loopback.reservations.size, 0);
});

test('a lost reply keeps the intent and the retry with the same operation reconciles it', async (t) => {
    const loopback = createLoopback();
    const { robotId, controller, handle } = wire(t, loopback);
    await ready(controller);
    const request = intent(robotId);
    loopback.mode = 'lost-reply-once';
    const first = await controller.reserve(request);
    assert.equal(first.ok, false);
    assert.equal(first.error.code, 'outcome_unknown');
    assert.equal(handle.listUnsettledResources().filter((blocker) => blocker.kind === 'source-reservation').length, 1, 'the S1 intent is kept');
    const second = await controller.reserve(request);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(loopback.reservations.size, 1, 'one reservation, not two');
});
