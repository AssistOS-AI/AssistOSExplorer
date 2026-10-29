// SYNTHETIC worker reservation-controller tests (sourceReservations.mjs). The S1 store is a real temporary store from
// tests/helpers/synthetic.mjs; the remote source-protection interlock is an in-memory SYNTHETIC fake that follows the
// T0 base §6 and amendments A1.2/A1.5/A2.2/A2.3/A3/A4 rules closely enough to drive the worker side. The fake is not
// the Ploinky implementation and proves nothing about it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { targetDigest } from '../../server/executionTarget/contract.mjs';
import { RESERVATION_ERROR_CODES, checkWritableSourceConflict, createWritableReservationController } from '../../server/executionTarget/sourceReservations.mjs';
import { openWorkerState } from '../../server/workerState.mjs';
import {
    LIMITS, PROVIDER, WORKSPACE, admitRequest, endAttempt, makeTempDir, openStore, rawDb, readyRobot, syntheticContext, syntheticRuntime
} from '../helpers/synthetic.mjs';

const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const sid = (label) => crypto.createHash('sha256').update(`synthetic-id:${label}`).digest().subarray(0, 16).toString('base64url');
const sdg = (label) => sha(`synthetic-digest:${label}`);
const clone = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => targetDigest(value).value;
const KIND = 'source-reservation';
const WORKER = 'agent:SyntheticIDE/roboWork';
const OTHER = 'agent:SyntheticIDE/otherProvider';

const fsId = (inode, mountId = '41') => ({ filesystemId: 'synthetic-fs', mountId, device: '2049', inode: String(inode), fileType: 'directory' });

function resources(labels = ['home', 'project']) {
    return labels.map((label, index) => ({
        resourceId: sid(`res-${label}`), kind: label === 'home' ? 'home' : label === 'project' ? 'project' : label,
        rootIdentity: fsId(7000 + index * 3 + label.length), bindingChainDigest: sdg(`chain-${label}`), access: 'write', aliasCoverageDigest: sdg(`alias-${label}`)
    })).sort((l, r) => (l.resourceId < r.resourceId ? -1 : 1));
}

// ---- Synthetic interlock -------------------------------------------------------------------------------------------

function createFakeInterlock({ storeId = sid('store-a'), expectedHolders = [WORKER], holders = [WORKER, OTHER], boxGeneration = 'box-gen-1' } = {}) {
    const s = {
        storeId, available: true, expected: new Set(expectedHolders), acknowledged: new Set(), predicate: new Set(holders),
        epoch: 3, boxGeneration, pointers: new Map(), superseded: new Map(), reservations: new Map(), receipts: new Map(),
        capacity: 4096, faults: [], calls: [], hooks: {}
    };
    const ok = (value) => ({ ok: true, value: clone(value) });
    const no = (code) => ({ ok: false, error: { code } });
    function storeState() {
        return [...s.expected].every((principal) => s.acknowledged.has(principal)) ? 'ready' : 'awaiting-holder-ack';
    }
    function record() {
        return {
            version: 1, workspaceId: WORKSPACE, boxIdentity: 'box-synthetic', boxGeneration: s.boxGeneration, sourceProtectionEpoch: s.epoch,
            sourceSelectionDigest: sdg(`selection-${s.epoch}`), sourceClosureDigest: sdg(`closure-${s.epoch}`), sourceAcceptanceIdentity: `acceptance-${s.epoch}`,
            sourceStoreIdentity: s.storeId, protectionStatus: 'protected', enforcementDigest: sdg('enforcement'), aliasCoverageDigest: sdg('alias'), acceptedAtMs: 1700000000000
        };
    }
    function fault(op) {
        const index = s.faults.findIndex((entry) => entry.op === op);
        if (index < 0) return null;
        return s.faults.splice(index, 1)[0].kind;
    }
    function current(principal) {
        return s.pointers.get(principal)?.currentGeneration ?? null;
    }
    function tombstoneOf(reservation) {
        return {
            version: 1, reservationId: reservation.reservationId, operationId: reservation.operationId, requestDigest: reservation.requestDigest,
            workerPrincipal: reservation.workerPrincipal, workerGeneration: reservation.workerGeneration, state: 'released',
            releaseEvidenceDigest: reservation.releaseEvidenceDigest, sourceStoreIdentity: reservation.sourceStoreIdentity
        };
    }
    function call(op, run) {
        s.calls.push(op);
        if (!s.available) return no('source_unavailable');
        const kind = fault(op);
        if (kind === 'crash-before') throw new Error('synthetic transport loss before the interlock committed');
        const result = run();
        if (kind === 'lost-reply') throw new Error('synthetic lost reply after the interlock committed');
        return result;
    }
    const api = {
        async describeStore() {
            s.calls.push('describe');
            if (!s.available) return ok({ state: 'unavailable', sourceStoreIdentity: null, holderAcknowledged: false, currentGeneration: null });
            return ok({ state: storeState(), sourceStoreIdentity: s.storeId, holderAcknowledged: s.acknowledged.has(api.lastPrincipal ?? WORKER), currentGeneration: current(api.lastPrincipal ?? WORKER) });
        },
        async advanceWorkerGeneration(ctx, request) {
            return call('advance', () => {
                const pointer = s.pointers.get(ctx.principal);
                const digestValue = digest(request);
                const prior = s.receipts.get(`advance:${request.operationId}`);
                if (prior) return prior.requestDigest === digestValue ? ok(prior.result) : no('operation_conflict');
                const superseded = s.superseded.get(ctx.principal) ?? new Set();
                if (superseded.has(request.nextGeneration)) return no('stale_generation');
                if ((pointer?.currentGeneration ?? null) !== request.priorGeneration) return no('stale_generation');
                if (pointer) superseded.add(pointer.currentGeneration);
                s.superseded.set(ctx.principal, superseded);
                s.pointers.set(ctx.principal, { currentGeneration: request.nextGeneration, priorGeneration: request.priorGeneration });
                const result = { version: 1, operationId: request.operationId, workerPrincipal: ctx.principal, priorGeneration: request.priorGeneration, currentGeneration: request.nextGeneration, requestDigest: digestValue };
                s.receipts.set(`advance:${request.operationId}`, { requestDigest: digestValue, result });
                return ok(result);
            });
        },
        async acknowledgeSourceStore(ctx, request) {
            return call('acknowledge', () => {
                if (!s.expected.has(ctx.principal) && !s.predicate.has(ctx.principal)) return no('forbidden');
                if (request.workerGeneration !== current(ctx.principal)) return no('stale_generation');
                if (request.sourceStoreIdentity !== s.storeId) return no('source_unavailable');
                const digestValue = digest(request);
                const prior = s.receipts.get(`ack:${request.operationId}`);
                if (prior) return prior.requestDigest === digestValue ? ok(prior.result) : no('operation_conflict');
                s.acknowledged.add(ctx.principal);
                const result = { version: 1, operationId: request.operationId, sourceStoreIdentity: s.storeId, workerPrincipal: ctx.principal, state: storeState(), requestDigest: digestValue };
                s.receipts.set(`ack:${request.operationId}`, { requestDigest: digestValue, result });
                return ok(result);
            });
        },
        async reserveWritableResources(ctx, request) {
            return call('reserve', () => {
                if (s.hooks.beforeReserve) s.hooks.beforeReserve();
                if (request.workspaceId !== WORKSPACE || request.boxIdentity !== 'box-synthetic') return no('forbidden');
                // A6.2: the operation is looked up first; an identical body gets its recorded result even from a
                // generation that is no longer current or after the epoch advanced.
                const digestValue = digest(request);
                const prior = s.receipts.get(`reserve:${request.operationId}`);
                if (prior) {
                    if (prior.requestDigest !== digestValue) return no('operation_conflict');
                    const reservation = s.reservations.get(prior.reservationId);
                    return ok(reservation.state === 'released' ? tombstoneOf(reservation) : reservation);
                }
                if (!s.predicate.has(ctx.principal)) return no('forbidden');
                if (request.workerGeneration !== current(ctx.principal)) return no('stale_generation');
                if (!s.acknowledged.has(ctx.principal)) return no('source_unavailable');
                if (request.boxGeneration !== s.boxGeneration) return no('stale_generation');
                if (request.expectedEpoch !== s.epoch) return no('stale_source_epoch');
                if ([...s.reservations.values()].filter((entry) => entry.state === 'reserved').length >= s.capacity) return no('capacity_exceeded');
                const r = record();
                const reservation = {
                    version: 1, reservationId: request.reservationId, operationId: request.operationId, workspaceId: request.workspaceId,
                    boxIdentity: request.boxIdentity, boxGeneration: request.boxGeneration, workerPrincipal: ctx.principal,
                    workerRuntimeInstanceId: ctx.runtimeInstanceId, workerEnableGeneration: ctx.enableGeneration, workerGeneration: request.workerGeneration,
                    robotId: request.robotId, executionId: request.executionId, attemptId: request.attemptId, consumerKind: request.consumerKind,
                    consumerId: request.consumerId, sourceProtectionEpoch: s.epoch, sourceSelectionDigest: r.sourceSelectionDigest,
                    sourceClosureDigest: r.sourceClosureDigest, sourceAcceptanceIdentity: r.sourceAcceptanceIdentity, sourceStoreIdentity: s.storeId,
                    resources: request.resources, requestDigest: digestValue, state: 'reserved', createdAtMs: 1700000005000, releaseEvidenceDigest: null
                };
                s.reservations.set(request.reservationId, reservation);
                s.receipts.set(`reserve:${request.operationId}`, { requestDigest: digestValue, reservationId: request.reservationId, generation: request.workerGeneration, principal: ctx.principal });
                return ok(reservation);
            });
        },
        async releaseWritableReservation(ctx, request) {
            return call('release', () => {
                const digestValue = digest(request);
                const prior = s.receipts.get(`release:${request.operationId}`);
                // A3.3: the operation receipt is looked up first and returned for an identical body.
                if (prior) return prior.requestDigest === digestValue ? ok(prior.result) : no('operation_conflict');
                const reservation = s.reservations.get(request.reservationId);
                if (!reservation) return no('not_found');
                if (!ctx.operator && ctx.principal !== reservation.workerPrincipal) return no('forbidden');
                if (!ctx.operator && ctx.workerGeneration !== current(ctx.principal)) return no('stale_generation');
                if (request.owningWorkerGeneration !== reservation.workerGeneration) return no('operation_conflict');
                if (request.reservationRequestDigest !== reservation.requestDigest || request.resourcesDigest !== digest(reservation.resources)) return no('operation_conflict');
                if (reservation.state === 'released') return no('operation_conflict');
                reservation.state = 'released';
                reservation.releaseEvidenceDigest = request.releaseEvidenceDigest;
                const result = { version: 1, operationId: request.operationId, reservationId: request.reservationId, state: 'released', requestDigest: digestValue, releaseEvidenceDigest: request.releaseEvidenceDigest, sourceStoreIdentity: s.storeId };
                s.receipts.set(`release:${request.operationId}`, { requestDigest: digestValue, result, generation: ctx.workerGeneration, principal: ctx.principal });
                return ok(result);
            });
        },
        // Not called by the worker controller: the lifecycle-side transition, for interleaving schedules.
        transition({ boxGeneration = s.boxGeneration } = {}) {
            if (storeState() !== 'ready') return no('source_unavailable');
            if ([...s.reservations.values()].some((entry) => entry.state === 'reserved')) return no('source_transition_blocked');
            s.epoch += 1;
            s.boxGeneration = boxGeneration;
            return ok({ epoch: s.epoch });
        },
        // A2.3 compaction: tombstones and receipts of non-current generations only; never unreleased reservations.
        compact() {
            const currentGenerations = new Set([...s.pointers.values()].map((pointer) => pointer.currentGeneration));
            for (const [key, receipt] of s.receipts) {
                if (receipt.generation === undefined || currentGenerations.has(receipt.generation)) continue;
                if (receipt.reservationId && s.reservations.get(receipt.reservationId)?.state === 'reserved') continue;
                s.receipts.delete(key);
            }
            for (const [id, reservation] of s.reservations) {
                if (reservation.state === 'released' && !currentGenerations.has(reservation.workerGeneration)) s.reservations.delete(id);
            }
        },
        // Deletes witness and store and creates a new one (A1.3/A2.2): nothing of the old store survives.
        recreate(nextStoreId, holdersExpected = [WORKER]) {
            Object.assign(s, { storeId: nextStoreId, expected: new Set(holdersExpected), acknowledged: new Set(), pointers: new Map(), superseded: new Map(), reservations: new Map(), receipts: new Map(), epoch: 1 });
        },
        snapshot: () => structuredClone(s),
        restore(snapshot) { Object.assign(s, structuredClone(snapshot)); s.faults = []; s.hooks = {}; },
        state: s,
        reservedCount: () => [...s.reservations.values()].filter((entry) => entry.state === 'reserved').length
    };
    return api;
}

// ---- Worker wiring ---------------------------------------------------------------------------------------------------

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

function identityOf(principal = WORKER, boxGeneration = 'box-gen-1') {
    return { workspaceId: WORKSPACE, boxIdentity: 'box-synthetic', boxGeneration, workerPrincipal: principal, workerRuntimeInstanceId: 'worker-instance-1', workerEnableGeneration: 'worker-enable-1' };
}

function worker(dir, fake, { store, principal = WORKER, boxGeneration = 'box-gen-1', generationChain, operator = false } = {}) {
    const handle = store ?? openStore(dir);
    const managementContext = Object.freeze({ principal, runtimeInstanceId: 'worker-instance-1', enableGeneration: 'worker-enable-1', workerGeneration: handle.generationId, operator });
    fake.lastPrincipal = principal;
    const controller = createWritableReservationController({
        workerState: handle, interlock: fake, managementContext, identity: identityOf(principal, boxGeneration), generationChain: generationChain ?? generationChainOf(dir)
    });
    return { handle, controller, managementContext };
}

let opCounter = 0;
const op = (label = 'op') => sid(`${label}-${opCounter += 1}`);

async function makeReady(controller) {
    assert.equal((await controller.syncStore()).ok, true);
    const registered = await controller.registerGeneration({ operationId: op('advance') });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const acknowledged = await controller.acknowledgeStore({ operationId: op('ack') });
    assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged));
    assert.deepEqual(controller.readiness(), { ready: true, code: null });
}

function intent(robotId, overrides = {}) {
    return { operationId: op('reserve'), robotId, executionId: null, attemptId: null, consumerKind: 'terminal', consumerId: sid(`consumer-${opCounter}`), expectedEpoch: 3, resources: resources(), ...overrides };
}

function evidenceFor(reservation, overrides = {}) {
    return {
        complete: true, fresh: true, sealed: true, openHandles: 0, digest: sdg(`absence-${reservation.reservationId}`),
        resources: reservation.resources.map((resource) => ({ resourceId: resource.resourceId, state: 'absent' })), ...overrides
    };
}

// Absence evidence for exactly the resources recorded in an intent (A6.4).
function orphanEvidence(intentEntry, overrides = {}) {
    return {
        complete: true, fresh: true, sealed: true, openHandles: 0, digest: sdg(`orphan-absence-${intentEntry.resourceId}`),
        resources: intentEntry.resources.map((resource) => ({ resourceId: resource.resourceId, state: 'absent' })), ...overrides
    };
}

function blockers(handle) {
    return handle.listUnsettledResources().filter((blocker) => blocker.kind === KIND);
}

function refused(result, code, label) {
    assert.deepEqual(result, { ok: false, error: { code } }, label);
    assert.ok(RESERVATION_ERROR_CODES.includes(code), `${code} enumerated`);
}

async function setup(t, fakeOptions) {
    const dir = makeTempDir(t);
    const fake = createFakeInterlock(fakeOptions);
    const w = worker(dir, fake);
    const robotId = readyRobot(w.handle, syntheticContext());
    await makeReady(w.controller);
    return { dir, fake, robotId, ...w };
}

// ---- Tests -------------------------------------------------------------------------------------------------------------

test('reserve then release: S1 intent, remote reservation, S1 commit, verified release, S1 settlement', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    const request = intent(robotId);
    const reserved = await controller.reserve(request);
    assert.equal(reserved.ok, true, JSON.stringify(reserved));
    const reservation = reserved.value;
    assert.ok(Object.isFrozen(reservation));
    assert.equal(reservation.state, 'reserved');
    assert.equal(reservation.sourceStoreIdentity, fake.state.storeId);
    const [blocker] = blockers(handle);
    assert.equal(blocker.resourceId, reservation.reservationId, 'the S1 resource ID is the reservation ID');
    // A6.1: the locator records the complete reserve body (minus the reservation ID, which is the blocker's own ID).
    const { reservationId: _ignored, version: _v, ...bodyFields } = { ...blocker.locator.request };
    assert.deepEqual(Object.keys(blocker.locator).sort(), ['markerId', 'operationId', 'request', 'sourceStoreIdentity']);
    // A7.2: the body-independent operation marker exists, is settled once the intent exists, and is never reused.
    const marker = handle.getResource({ resourceId: blocker.locator.markerId });
    assert.equal(marker.kind, 'source-reservation-op');
    assert.deepEqual(marker.locator, { operationId: request.operationId, sourceStoreIdentity: fake.state.storeId });
    assert.equal(marker.state, 'released');
    assert.equal(blocker.locator.operationId, request.operationId);
    assert.equal(blocker.locator.sourceStoreIdentity, fake.state.storeId);
    assert.equal(blocker.locator.request.workerGeneration, handle.generationId);
    assert.equal(blocker.locator.request.expectedEpoch, 3);
    assert.deepEqual(bodyFields.resources, request.resources);
    assert.equal(digest({ ...blocker.locator.request, reservationId: blocker.resourceId }), reservation.requestDigest);
    assert.equal(blocker.state, 'committed');
    assert.equal(blocker.identity.requestDigest, reservation.requestDigest);
    const released = await controller.release({ operationId: op('release'), reservation, evidence: evidenceFor(reservation) });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(blockers(handle).length, 0);
    assert.equal(handle.getResource({ resourceId: reservation.reservationId }).state, 'released');
    assert.equal(fake.reservedCount(), 0);
    assert.ok(Object.isFrozen(RESERVATION_ERROR_CODES));
});

test('RSV-01 identical reserve replayed after a lost reply returns the same reservation with no second blocker', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    const request = intent(robotId);
    fake.state.faults.push({ op: 'reserve', kind: 'lost-reply' });
    refused(await controller.reserve(request), 'outcome_unknown', 'lost reply');
    assert.equal(blockers(handle).length, 1, 'the intent blocker is retained');
    assert.equal(blockers(handle)[0].state, 'reserved', 'not exposed: not committed');
    assert.equal(fake.reservedCount(), 1);
    const retried = await controller.reserve(request);
    assert.equal(retried.ok, true);
    assert.equal(blockers(handle).length, 1, 'no second blocker');
    assert.equal(blockers(handle)[0].resourceId, retried.value.reservationId);
    assert.equal(blockers(handle)[0].state, 'committed');
    assert.equal(fake.reservedCount(), 1, 'no second remote reservation');
    const again = await controller.reserve(request);
    assert.deepEqual(again.value, retried.value, 'idempotent');
});

test('RSV-02 the same operation with altered resources is operation_conflict, before and after commit, without a second blocker', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    const request = intent(robotId);
    fake.state.faults.push({ op: 'reserve', kind: 'lost-reply' });
    await controller.reserve(request);
    const altered = { ...request, resources: resources(['home']) };
    const uncommittedCalls = fake.state.calls.length;
    refused(await controller.reserve(altered), 'operation_conflict', 'uncommitted: local conflict against the recorded body');
    assert.equal(fake.state.calls.length, uncommittedCalls, 'no remote call before commit either');
    assert.equal(blockers(handle).length, 1);
    assert.equal(blockers(handle)[0].state, 'reserved', 'the blocker is kept for same-ID reconciliation');
    assert.equal((await controller.reserve(request)).ok, true);
    const calls = fake.state.calls.length;
    refused(await controller.reserve(altered), 'operation_conflict', 'committed: local conflict');
    assert.equal(fake.state.calls.length, calls, 'no remote call after commit');
    assert.equal(blockers(handle).length, 1);
    assert.equal(fake.reservedCount(), 1);
});

test('RSV-03 releasing an unknown reservation ID is not_found with no remote call', async (t) => {
    const { fake, robotId, controller } = await setup(t);
    const reserved = await controller.reserve(intent(robotId));
    const unknown = { ...clone(reserved.value), reservationId: sid('never-reserved') };
    const calls = fake.state.calls.length;
    refused(await controller.release({ operationId: op(), reservation: unknown, evidence: evidenceFor(unknown) }), 'not_found');
    assert.equal(fake.state.calls.length, calls);
});

test('RSV-04 and RSV-05 incomplete, stale or quarantined evidence never releases and changes nothing', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    const reservation = (await controller.reserve(intent(robotId))).value;
    const calls = fake.state.calls.length;
    const cases = [
        ['open handle', { openHandles: 1 }, 'release_unverified'],
        ['view not sealed', { sealed: false }, 'release_unverified'],
        ['stale evidence', { fresh: false }, 'release_unverified'],
        ['incomplete', { complete: false }, 'release_unverified'],
        ['omits a child', { resources: [{ resourceId: reservation.resources[0].resourceId, state: 'absent' }] }, 'release_unverified'],
        ['extra unknown child', { resources: [...reservation.resources.map((r) => ({ resourceId: r.resourceId, state: 'absent' })), { resourceId: sid('x'), state: 'absent' }] }, 'release_unverified'],
        ['still present', { resources: reservation.resources.map((r, i) => ({ resourceId: r.resourceId, state: i === 0 ? 'present' : 'absent' })) }, 'release_unverified'],
        ['unknown presence', { resources: reservation.resources.map((r) => ({ resourceId: r.resourceId, state: 'unknown' })) }, 'release_unverified'],
        ['no digest', { digest: 'not-a-digest' }, 'release_unverified'],
        ['RSV-05 quarantine presented as release', { resources: reservation.resources.map((r, i) => ({ resourceId: r.resourceId, state: i === 0 ? 'quarantined' : 'absent' })) }, 'resource_quarantined']
    ];
    for (const [label, change, code] of cases) {
        refused(await controller.release({ operationId: op(), reservation, evidence: evidenceFor(reservation, change) }), code, label);
    }
    assert.equal(fake.state.calls.length, calls, 'no remote call');
    assert.equal(fake.reservedCount(), 1);
    assert.equal(blockers(handle)[0].state, 'committed');
});

test('RSV-06 reserve against transition in both commit orders: exactly one wins against the original epoch, no exposure under stale source', async (t) => {
    // Schedule A: transition commits first.
    {
        const { fake, robotId, handle, controller } = await setup(t);
        assert.equal(fake.transition().ok, true);
        refused(await controller.reserve(intent(robotId)), 'stale_source_epoch', 'transition first');
        assert.equal(blockers(handle).length, 0, 'the fresh intent is settled: nothing was reserved or exposed');
        assert.equal(fake.reservedCount(), 0);
    }
    // Schedule B: reserve commits first.
    {
        const { fake, robotId, controller } = await setup(t);
        assert.equal((await controller.reserve(intent(robotId))).ok, true);
        assert.deepEqual(fake.transition(), { ok: false, error: { code: 'source_transition_blocked' } });
        assert.equal(fake.state.epoch, 3, 'epoch unchanged');
    }
    // Schedule C: the S1 intent is recorded, then the transition commits, then the remote reserve is evaluated.
    {
        const { fake, robotId, handle, controller } = await setup(t);
        let transitioned = null;
        fake.state.hooks.beforeReserve = () => { transitioned = fake.transition(); fake.state.hooks.beforeReserve = null; };
        refused(await controller.reserve(intent(robotId)), 'stale_source_epoch', 'interleaved');
        assert.equal(transitioned.ok, true);
        assert.equal(blockers(handle).length, 0);
        assert.equal(fake.reservedCount(), 0);
    }
});

test('RSV-07 pending, retained, unknown and quarantined reservations keep transitions blocked, also after both stores reopen', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    const pending = (await controller.reserve(intent(robotId, { resources: resources(['pending-create']) }))).value;
    const retained = (await controller.reserve(intent(robotId, { consumerKind: 'retained-gui', resources: resources(['retained-gui']) }))).value;
    fake.state.faults.push({ op: 'reserve', kind: 'lost-reply' });
    refused(await controller.reserve(intent(robotId, { resources: resources(['target-state']) })), 'outcome_unknown');
    refused(await controller.release({ operationId: op(), reservation: pending, evidence: evidenceFor(pending, { resources: pending.resources.map((r) => ({ resourceId: r.resourceId, state: 'quarantined' })) }) }), 'resource_quarantined');
    assert.ok(retained.state === 'reserved');
    assert.deepEqual(fake.transition(), { ok: false, error: { code: 'source_transition_blocked' } });
    const snapshot = fake.snapshot();
    handle.close();
    const reopenedFake = createFakeInterlock();
    reopenedFake.restore(snapshot);
    const reopened = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, runtime: syntheticRuntime() });
    t.after(() => reopened.close());
    assert.equal(blockers(reopened).length, 3, 'every intent is still unsettled after reopen');
    assert.deepEqual(reopenedFake.transition(), { ok: false, error: { code: 'source_transition_blocked' } });
    // A prior-generation blocker still blocks after the S1 generation rolls.
    reopened.beginGenerationRecovery(reopened.generationId);
    assert.equal(blockers(reopened).filter((blocker) => !blocker.current).length, 3);
    assert.deepEqual(reopenedFake.transition(), { ok: false, error: { code: 'source_transition_blocked' } });
});

test('SRC-01..SRC-04, SRC-08 and RSV-08 worker-side conflict checks refuse before anything is recorded', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    const record = {
        version: 1, workspaceId: WORKSPACE, boxIdentity: 'box-synthetic', boxGeneration: 'box-gen-1', sourceProtectionEpoch: 3,
        sourceSelectionDigest: sdg('s'), sourceClosureDigest: sdg('c'), sourceAcceptanceIdentity: 'acceptance-3', sourceStoreIdentity: sid('store-a'),
        protectionStatus: 'protected', enforcementDigest: sdg('e'), aliasCoverageDigest: sdg('a'), acceptedAtMs: 1
    };
    const workspaceRoot = fsId(100);
    const protectedRoots = [
        { sourceKind: 'workspace', chain: [workspaceRoot, fsId(110), fsId(111)] },
        { sourceKind: 'managed', chain: [workspaceRoot, fsId(120), fsId(121)] },
        { sourceKind: 'link-install', chain: [workspaceRoot, fsId(130)] }
    ];
    const resource = resources(['project'])[0];
    const goodChain = [workspaceRoot, fsId(200), resource.rootIdentity];
    const protection = { record, expectedEpoch: 3, protectedRoots, protectedIdentities: [fsId(555)] };
    const evidence = (chain, extra = {}) => [{ resourceId: resource.resourceId, chain, aliasCoverage: 'complete', mountIdentity: 'known', hardLinks: 'none', ...extra }];
    const withRoot = (chain) => ({ ...resource, rootIdentity: chain[chain.length - 1] });
    assert.equal(checkWritableSourceConflict({ resources: [resource], protection, evidence: evidence(goodChain) }).ok, true, 'unrelated project');
    const overlaps = [
        ['SRC-02 writable workspace source', [workspaceRoot, fsId(110), fsId(111)]],
        ['SRC-02 writable managed source', [workspaceRoot, fsId(120), fsId(121)]],
        ['SRC-02 writable link-install source', [workspaceRoot, fsId(130)]],
        ['SRC-02 ancestor of a protected source', [workspaceRoot, fsId(110)]],
        ['SRC-02 descendant of a protected source', [workspaceRoot, fsId(120), fsId(121), fsId(122)]],
        ['SRC-02 the workspace root itself', [workspaceRoot]],
        ['SRC-03 bind alias of a protected root under another mount', [fsId(300), { ...fsId(111), mountId: '99' }]],
        ['SRC-03 hard-link alias of a protected inode', [workspaceRoot, fsId(200), fsId(555)]]
    ];
    for (const [label, chain] of overlaps) {
        refused(checkWritableSourceConflict({ resources: [withRoot(chain)], protection, evidence: [{ ...evidence(chain)[0] }] }), 'protected_source_overlap', label);
    }
    const unproven = [
        ['SRC-04 unknown hard links', { hardLinks: 'unknown' }],
        ['SRC-04 unknown bind coverage', { aliasCoverage: 'unknown' }],
        ['SRC-04 unknown mount identity', { mountIdentity: 'unknown' }]
    ];
    for (const [label, extra] of unproven) refused(checkWritableSourceConflict({ resources: [resource], protection, evidence: evidence(goodChain, extra) }), 'source_alias_unproven', label);
    refused(checkWritableSourceConflict({ resources: [resource], protection, evidence: [] }), 'source_alias_unproven', 'SRC-04 no evidence');
    refused(checkWritableSourceConflict({ resources: [resource], protection, evidence: evidence([workspaceRoot, fsId(200), fsId(201)]) }), 'source_alias_unproven', 'chain does not end at the resource');
    refused(checkWritableSourceConflict({ resources: [resource], protection: { ...protection, expectedEpoch: 2 }, evidence: evidence(goodChain) }), 'stale_source_epoch', 'SRC-01');
    refused(checkWritableSourceConflict({ resources: [resource], protection: { ...protection, record: { ...record, protectionStatus: 'unavailable', enforcementDigest: null, aliasCoverageDigest: null } }, evidence: evidence(goodChain) }), 'source_unprotected', 'SRC-08 unavailable protection');
    refused(checkWritableSourceConflict({ resources: [resource], protection: { ...protection, record: null }, evidence: evidence(goodChain) }), 'source_unavailable', 'no record');
    // RSV-08: a broker child must stay beneath its parent grant and off protected sources.
    const parent = { chain: [workspaceRoot, fsId(200)] };
    assert.equal(checkWritableSourceConflict({ resources: [resource], protection, evidence: evidence(goodChain), parent }).ok, true, 'child beneath parent');
    const wider = [workspaceRoot, fsId(210)];
    refused(checkWritableSourceConflict({ resources: [withRoot(wider)], protection, evidence: evidence(wider), parent }), 'forbidden', 'RSV-08 different grant');
    refused(checkWritableSourceConflict({ resources: [withRoot([workspaceRoot])], protection, evidence: evidence([workspaceRoot]), parent }), 'protected_source_overlap', 'RSV-08 wider grant');
    // Through the controller: refused before the S1 intent and the remote call.
    const calls = fake.state.calls.length;
    const bad = [workspaceRoot, fsId(110), fsId(111)];
    refused(await controller.reserve(intent(robotId, { resources: [withRoot(bad)], conflict: { protection, evidence: evidence(bad) } })), 'protected_source_overlap', 'controller');
    assert.equal(blockers(handle).length, 0);
    assert.equal(fake.state.calls.length, calls);
    assert.equal((await controller.reserve(intent(robotId, { resources: [resource], conflict: { protection, evidence: evidence(goodChain) } }))).ok, true);
});

test('RSV-09 RSV-10 RSV-11 RSV-12 release across generations, instances and principals', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    const reservation = (await controller.reserve(intent(robotId))).value;
    const second = (await controller.reserve(intent(robotId, { resources: resources(['target-state']) }))).value;
    const oldGeneration = handle.generationId;
    // The successor handle rolls the S1 generation (a worker restart) and registers it remotely.
    const successorHandle = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, runtime: syntheticRuntime() });
    t.after(() => successorHandle.close());
    successorHandle.beginGenerationRecovery(successorHandle.generationId);
    const successor = worker(dir, fake, { store: successorHandle });
    await makeReady(successor.controller);
    assert.equal(fake.state.pointers.get(WORKER).priorGeneration, oldGeneration);
    // RSV-10: the superseded writer cannot release (local S1 currency check, no remote call).
    let calls = fake.state.calls.length;
    refused(await controller.release({ operationId: op(), reservation, evidence: evidenceFor(reservation) }), 'stale_generation', 'RSV-10 superseded writer');
    assert.equal(fake.state.calls.length, calls);
    // RSV-11: another principal.
    const other = worker(dir, fake, { store: successorHandle, principal: OTHER });
    calls = fake.state.calls.length;
    refused(await other.controller.release({ operationId: op(), reservation, evidence: evidenceFor(reservation) }), 'forbidden', 'RSV-11 other principal');
    assert.equal(fake.state.calls.length, calls);
    // RSV-12: owningWorkerGeneration differing from the record.
    const tampered = { ...clone(reservation), workerGeneration: successorHandle.generationId };
    refused(await successor.controller.release({ operationId: op(), reservation: tampered, evidence: evidenceFor(tampered) }), 'operation_conflict', 'RSV-12 wrong owning generation');
    assert.equal(fake.reservedCount(), 2, 'nothing released so far');
    // RSV-09: the successor releases the prior-generation reservation with exact evidence; S1 settles it with its owning generation.
    const released = await successor.controller.release({ operationId: op(), reservation, evidence: evidenceFor(reservation) });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(successorHandle.getResource({ resourceId: reservation.reservationId }).state, 'released');
    assert.equal(successorHandle.getResource({ resourceId: reservation.reservationId }).generationId, oldGeneration);
    assert.equal(fake.reservedCount(), 1);
    assert.equal((await successor.controller.release({ operationId: op(), reservation: second, evidence: evidenceFor(second) })).ok, true);
    assert.equal(fake.reservedCount(), 0);
});

test('RSV-13 Box recreation: transition blocked until the successor releases old-Box reservations, then a new epoch is accepted', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    const reservation = (await controller.reserve(intent(robotId))).value;
    assert.equal(reservation.boxGeneration, 'box-gen-1');
    assert.deepEqual(fake.transition({ boxGeneration: 'box-gen-2' }), { ok: false, error: { code: 'source_transition_blocked' } });
    handle.close();
    const successorHandle = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, runtime: syntheticRuntime() });
    t.after(() => successorHandle.close());
    successorHandle.beginGenerationRecovery(successorHandle.generationId);
    const successor = worker(dir, fake, { store: successorHandle, boxGeneration: 'box-gen-2' });
    await makeReady(successor.controller);
    refused(await successor.controller.reserve(intent(robotId)), 'stale_generation', 'new Box generation not accepted yet');
    const rel13 = await successor.controller.release({ operationId: op(), reservation, evidence: evidenceFor(reservation) });
    assert.equal(rel13.ok, true, JSON.stringify(rel13));
    const accepted = fake.transition({ boxGeneration: 'box-gen-2' });
    assert.deepEqual(accepted, { ok: true, value: { epoch: 4 } });
    const fresh = await successor.controller.reserve(intent(robotId, { expectedEpoch: 4 }));
    assert.equal(fresh.ok, true);
    assert.equal(fresh.value.boxGeneration, 'box-gen-2');
    assert.equal(fresh.value.sourceProtectionEpoch, 4);
});

test('RSV-14 a delayed duplicate reserve after release is reservation_released (unsettled intent) or operation_retired, never a new reservation', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    // Release whose reply was lost: S1 is not yet settled; the duplicate reserve returns the tombstone and settles S1.
    const request = intent(robotId);
    const reservation = (await controller.reserve(request)).value;
    fake.state.faults.push({ op: 'release', kind: 'lost-reply' });
    refused(await controller.release({ operationId: op(), reservation, evidence: evidenceFor(reservation) }), 'outcome_unknown');
    assert.equal(blockers(handle).length, 1, 'blocker retained after the lost reply');
    // The interlock answers with the tombstone: the worker settles S1 and refuses, so no caller can mistake it for an
    // exposable reservation.
    refused(await controller.reserve(request), 'reservation_released', 'tombstone');
    assert.equal(blockers(handle).length, 0, 'settled released');
    assert.equal(fake.reservedCount(), 0);
    assert.equal(fake.state.reservations.size, 1, 'no new reservation');
    // After a completed release the operation is retired (A7.2, A8.1): a duplicate is refused locally with no remote call.
    const calls = fake.state.calls.length;
    refused(await controller.reserve(request), 'operation_retired', 'retired operation');
    assert.equal(fake.state.calls.length, calls);
    assert.equal(blockers(handle).length, 0);
    assert.equal(fake.state.reservations.size, 1);
});

test('RSV-15..RSV-18 and RSV-19: generation pointer, superseded generations and an unregistered crash generation', async (t) => {
    const dir = makeTempDir(t);
    const fake = createFakeInterlock();
    const g1 = worker(dir, fake);
    const robotId = readyRobot(g1.handle, syntheticContext());
    await makeReady(g1.controller);
    const first = intent(robotId);
    assert.equal((await g1.controller.reserve(first)).ok, true);
    const g1Id = g1.handle.generationId;
    // RSV-19: S1 rolls G1 -> G2, and the worker crashes before the store advance.
    const h2 = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, runtime: syntheticRuntime() });
    h2.beginGenerationRecovery(h2.generationId);
    const g2 = worker(dir, fake, { store: h2 });
    assert.equal((await g2.controller.syncStore()).ok, true);
    // Next start: G2 -> G3. The worker advances from the registered ancestor G1 straight to G3.
    const h3 = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, runtime: syntheticRuntime() });
    t.after(() => { h2.close(); h3.close(); });
    h3.beginGenerationRecovery(h3.generationId);
    const g3 = worker(dir, fake, { store: h3 });
    await makeReady(g3.controller);
    assert.deepEqual(fake.state.pointers.get(WORKER), { currentGeneration: h3.generationId, priorGeneration: g1Id }, 'RSV-19 advanced with prior G1, next G3');
    // G2 is refused for reserve, acknowledge and advance.
    for (const [label, call] of [
        ['advance', () => g2.controller.registerGeneration({ operationId: op() })],
        ['acknowledge', () => g2.controller.acknowledgeStore({ operationId: op() })],
        ['reserve', () => g2.controller.reserve(intent(robotId))]
    ]) {
        refused(await call(), 'stale_generation', `RSV-19 G2 ${label}`);
    }
    assert.deepEqual(g2.controller.readiness(), { ready: false, code: 'stale_generation' });
    const calls = fake.state.calls.length;
    refused(await g2.controller.registerGeneration({ operationId: op() }), 'stale_generation', 'RSV-18 a superseded generation is never re-advanced');
    refused(await g1.controller.registerGeneration({ operationId: op() }), 'stale_generation', 'RSV-18 G1');
    // RSV-15: a delayed duplicate reserve from a superseded generation is stale_generation (tombstone or not).
    refused(await g1.controller.reserve(first), 'stale_generation', 'RSV-15');
    assert.equal(fake.state.calls.length, calls, 'refused locally, no remote call');
    assert.equal(blockers(h3).length, 1, 'no new blocker');
    // RSV-17: the remote pointer moved (another instance advanced); this worker's advance with the old prior is refused.
    const dir2 = makeTempDir(t);
    const fake2 = createFakeInterlock();
    const w = worker(dir2, fake2);
    assert.equal((await w.controller.syncStore()).ok, true);
    fake2.state.pointers.set(WORKER, { currentGeneration: sid('elsewhere'), priorGeneration: null });
    refused(await w.controller.registerGeneration({ operationId: op() }), 'stale_generation', 'RSV-17 pointer is not an ancestor');
    assert.equal(w.controller.readiness().ready, false);
    fake2.state.pointers.delete(WORKER);
    fake2.state.hooks = {};
    const moved = await w.controller.syncStore();
    assert.equal(moved.ok, true);
    fake2.state.pointers.set(WORKER, { currentGeneration: sid('raced'), priorGeneration: null });
    refused(await w.controller.registerGeneration({ operationId: op() }), 'stale_generation', 'RSV-17 wrong prior at the interlock (raced advance)');
    assert.deepEqual(w.controller.readiness(), { ready: false, code: 'generation_unregistered' });
});

test('RSV-16 compaction keeps current-generation tombstones and unreleased reservations; a release retry after compaction returns its receipt', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    const kept = (await controller.reserve(intent(robotId))).value;
    const done = (await controller.reserve(intent(robotId, { resources: resources(['target-state']) }))).value;
    assert.equal((await controller.release({ operationId: op(), reservation: done, evidence: evidenceFor(done) })).ok, true);
    handle.close();
    const h2 = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, runtime: syntheticRuntime() });
    t.after(() => h2.close());
    h2.beginGenerationRecovery(h2.generationId);
    const successor = worker(dir, fake, { store: h2 });
    await makeReady(successor.controller);
    fake.compact();
    assert.equal(fake.state.reservations.has(kept.reservationId), true, 'unreleased reservation survives compaction');
    assert.equal(fake.state.reservations.has(done.reservationId), false, 'non-current released tombstone compacted');
    const releaseOp = op('release');
    fake.state.faults.push({ op: 'release', kind: 'lost-reply' });
    refused(await successor.controller.release({ operationId: releaseOp, reservation: kept, evidence: evidenceFor(kept) }), 'outcome_unknown');
    fake.compact();
    const retried = await successor.controller.release({ operationId: releaseOp, reservation: kept, evidence: evidenceFor(kept) });
    assert.equal(retried.ok, true, 'A3.3: the current-generation receipt is returned for the identical retry');
    assert.equal(blockers(h2).length, 0);
});

test('A4 the complete S1 prior_id chain is walked; a missing or cyclic chain is state_corrupt and withdraws readiness', async (t) => {
    const dir = makeTempDir(t);
    const fake = createFakeInterlock();
    const first = worker(dir, fake);
    await makeReady(first.controller);
    const registered = first.handle.generationId;
    for (let index = 0; index < 70; index += 1) first.handle.beginGenerationRecovery(first.handle.generationId);
    const long = worker(dir, fake, { store: first.handle });
    await makeReady(long.controller);
    assert.equal(fake.state.pointers.get(WORKER).priorGeneration, registered, 'walked 70 links, no 64-link cap');
    first.handle.beginGenerationRecovery(first.handle.generationId);
    const rows = generationChainOf(dir)();
    const current = first.handle.generationId;
    const missing = worker(dir, fake, { store: first.handle, generationChain: () => rows.filter((row) => row.id !== rows.find((r) => r.id === current).priorId) });
    assert.equal((await missing.controller.syncStore()).ok, true);
    refused(await missing.controller.registerGeneration({ operationId: op() }), 'state_corrupt', 'missing link');
    assert.deepEqual(missing.controller.readiness(), { ready: false, code: 'state_corrupt' });
    refused(await missing.controller.reserve(intent(sid('robot'))), 'state_corrupt', 'no reserve while corrupt');
    const cyclic = worker(dir, fake, { store: first.handle, generationChain: () => rows.map((row) => (row.priorId === null ? { ...row, priorId: current } : row)) });
    fake.state.pointers.set(WORKER, { currentGeneration: sid('not-in-chain'), priorGeneration: null });
    assert.equal((await cyclic.controller.syncStore()).ok, true);
    refused(await cyclic.controller.registerGeneration({ operationId: op() }), 'state_corrupt', 'cycle');
});

test('SRC-13 a worker holding reservations under store A that observes store B reserves nothing and is not ready until settlement', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    const storeA = fake.state.storeId;
    const reservation = (await controller.reserve(intent(robotId))).value;
    fake.state.faults.push({ op: 'reserve', kind: 'lost-reply' });
    refused(await controller.reserve(intent(robotId, { resources: resources(['target-state']) })), 'outcome_unknown');
    fake.recreate(sid('store-b'));
    assert.equal((await controller.syncStore()).ok, true);
    assert.deepEqual(controller.readiness(), { ready: false, code: 'source_store_changed' });
    const calls = fake.state.calls.length;
    refused(await controller.reserve(intent(robotId)), 'source_store_changed', 'no reserve under B');
    refused(await controller.acknowledgeStore({ operationId: op() }), 'source_store_changed', 'no acknowledgement of B');
    assert.equal(fake.state.calls.length, calls, 'no remote call');
    assert.equal(blockers(handle).length, 2);
    // A missing reservation in B is never evidence of release: releasing through B is not_found and settles nothing.
    assert.equal((await controller.registerGeneration({ operationId: op() })).ok, true);
    refused(await controller.release({ operationId: op(), reservation, evidence: evidenceFor(reservation) }), 'not_found', 'store B has no record');
    assert.equal(blockers(handle).length, 2);
    const intents = controller.listIntents().value;
    assert.ok(intents.every((entry) => entry.orphaned && entry.sourceStoreIdentity === storeA));
    // Quarantine keeps the blocker and readiness withdrawn.
    refused(await controller.settleOrphanedReservation({ resourceId: intents[0].resourceId, evidence: orphanEvidence(intents[0], { resources: intents[0].resources.map((r) => ({ resourceId: r.resourceId, state: 'quarantined' })) }) }), 'resource_quarantined');
    refused(await controller.settleOrphanedReservation({ resourceId: intents[0].resourceId, evidence: orphanEvidence(intents[0], { complete: false }) }), 'release_unverified');
    assert.equal(blockers(handle).length, 2);
    assert.equal(controller.readiness().ready, false);
    for (const entry of intents) {
        const settled = await controller.settleOrphanedReservation({ resourceId: entry.resourceId, evidence: orphanEvidence(entry) });
        assert.equal(settled.ok, true);
    }
    assert.equal(blockers(handle).length, 0);
    const acknowledged = await controller.acknowledgeStore({ operationId: op() });
    assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged));
    assert.deepEqual(acknowledged.value.sourceStoreIdentity, fake.state.storeId);
    assert.deepEqual(controller.readiness(), { ready: true, code: null });
    const ackRequestPriors = fake.state.calls.includes('acknowledge');
    assert.ok(ackRequestPriors);
    const fresh = await controller.reserve(intent(robotId, { expectedEpoch: 1 }));
    assert.equal(fresh.ok, true);
    assert.equal(fresh.value.sourceStoreIdentity, sid('store-b'));
});

test('SRC-14 a recreated store refuses transitions until the holder, after settling store-A intents, acknowledges', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    assert.equal((await controller.reserve(intent(robotId))).ok, true);
    fake.recreate(sid('store-b'), [WORKER]);
    assert.deepEqual(fake.transition(), { ok: false, error: { code: 'source_unavailable' } }, 'awaiting holder acknowledgement');
    await controller.syncStore();
    await controller.registerGeneration({ operationId: op() });
    refused(await controller.acknowledgeStore({ operationId: op() }), 'source_store_changed', 'unsettled store-A intent');
    assert.deepEqual(fake.transition(), { ok: false, error: { code: 'source_unavailable' } });
    const [orphan] = controller.listIntents().value;
    assert.equal((await controller.settleOrphanedReservation({ resourceId: orphan.resourceId, evidence: orphanEvidence(orphan) })).ok, true);
    const acknowledged = await controller.acknowledgeStore({ operationId: op() });
    assert.equal(acknowledged.ok, true, JSON.stringify(acknowledged));
    assert.equal(acknowledged.value.state, 'ready');
    assert.equal(fake.reservedCount(), 0);
    assert.deepEqual(fake.transition(), { ok: true, value: { epoch: 2 } }, 'transition succeeds with zero reservations');
    assert.equal(blockers(handle).length, 0);
});

test('SRC-15 and SRC-16 an unacknowledged or non-holder principal never reserves, and forbidden is not retried in a loop', async (t) => {
    const dir = makeTempDir(t);
    const fake = createFakeInterlock({ expectedHolders: [WORKER], holders: [WORKER] });
    // SRC-15: a later-added holder that has not acknowledged.
    const later = worker(dir, fake, { principal: OTHER });
    fake.state.predicate.add(OTHER);
    await later.controller.syncStore();
    await later.controller.registerGeneration({ operationId: op() });
    assert.deepEqual(later.controller.readiness(), { ready: false, code: 'store_unacknowledged' });
    const robotId = readyRobot(later.handle, syntheticContext());
    let calls = fake.state.calls.length;
    refused(await later.controller.reserve(intent(robotId)), 'store_unacknowledged', 'SRC-15 local refusal');
    assert.equal(fake.state.calls.length, calls);
    assert.equal(blockers(later.handle).length, 0);
    // SRC-16: the predicate no longer holds for a principal of the expected set: acknowledge allowed (A4), reserve forbidden.
    fake.state.predicate.delete(OTHER);
    fake.state.expected.add(OTHER);
    assert.equal((await later.controller.acknowledgeStore({ operationId: op() })).ok, true, 'A4 expected holder may acknowledge');
    assert.equal(later.controller.readiness().ready, true);
    refused(await later.controller.reserve(intent(robotId)), 'forbidden', 'SRC-16 reserve without the declaration');
    assert.equal(blockers(later.handle).length, 0, 'fresh intent settled');
    assert.deepEqual(later.controller.readiness(), { ready: false, code: 'forbidden' });
    calls = fake.state.calls.length;
    refused(await later.controller.reserve(intent(robotId)), 'forbidden', 'no retry loop');
    assert.equal(fake.state.calls.length, calls, 'refused locally after forbidden');
    // A principal outside the expected set without the predicate cannot acknowledge.
    const stranger = worker(dir, fake, { store: later.handle, principal: 'agent:SyntheticIDE/stranger' });
    await stranger.controller.syncStore();
    await stranger.controller.registerGeneration({ operationId: op() });
    refused(await stranger.controller.acknowledgeStore({ operationId: op() }), 'forbidden', 'non-holder acknowledge');
    assert.deepEqual(stranger.controller.readiness(), { ready: false, code: 'forbidden' });
    // Only an explicit trusted resync clears the forbidden state.
    await later.controller.syncStore();
    assert.equal(later.controller.readiness().code, null);
});

test('CAP-02 a full reservation store still reconciles identical retries and releases; new work refuses without exposure', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    fake.state.capacity = 1;
    const request = intent(robotId);
    fake.state.faults.push({ op: 'reserve', kind: 'lost-reply' });
    refused(await controller.reserve(request), 'outcome_unknown');
    refused(await controller.reserve(intent(robotId, { resources: resources(['target-state']) })), 'capacity_exceeded', 'new work');
    assert.equal(blockers(handle).length, 1, 'the refused fresh intent is settled');
    const retried = await controller.reserve(request);
    assert.equal(retried.ok, true, 'identical retry reconciles without allocation');
    assert.equal((await controller.release({ operationId: op(), reservation: retried.value, evidence: evidenceFor(retried.value) })).ok, true);
    assert.equal(blockers(handle).length, 0);
});

test('ERR-01 failures before and after durable commits are recoverable with no duplicate effect or claimed absence', async (t) => {
    const dir = makeTempDir(t);
    const fake = createFakeInterlock();
    let failNext = null;
    const store = openStore(dir, { faults: { beforeCommit(label) { if (failNext === `before:${label}`) { failNext = null; throw new Error('synthetic crash before commit'); } }, afterCommit(label) { if (failNext === `after:${label}`) { failNext = null; throw new Error('synthetic crash after commit, before reply'); } } } });
    const w = worker(dir, fake, { store });
    const robotId = readyRobot(store, syntheticContext());
    await makeReady(w.controller);
    // Remote loss before the interlock commits: unknown, blocker kept; the retry reserves exactly once.
    const request = intent(robotId);
    fake.state.faults.push({ op: 'reserve', kind: 'crash-before' });
    refused(await w.controller.reserve(request), 'outcome_unknown');
    assert.equal(fake.state.reservations.size, 0);
    assert.equal(blockers(store).length, 1);
    // S1 commit fails before COMMIT: nothing exposed; the retry commits the same blocker.
    failNext = 'before:commitResource';
    refused(await w.controller.reserve(request), 'state_corrupt');
    assert.equal(blockers(store)[0].state, 'reserved');
    assert.equal(fake.state.reservations.size, 1);
    const ok = await w.controller.reserve(request);
    assert.equal(ok.ok, true);
    assert.equal(blockers(store)[0].state, 'committed');
    // S1 settlement crashes after its durable commit, before the reply: the release retry is idempotent.
    const releaseOp = op('release');
    failNext = 'after:settleResource';
    refused(await w.controller.release({ operationId: releaseOp, reservation: ok.value, evidence: evidenceFor(ok.value) }), 'state_corrupt');
    assert.equal(store.getResource({ resourceId: ok.value.reservationId }).state, 'released', 'the settlement was durable');
    assert.equal((await w.controller.release({ operationId: releaseOp, reservation: ok.value, evidence: evidenceFor(ok.value) })).ok, true);
    assert.equal(fake.state.reservations.size, 1, 'no duplicate reservation');
    assert.equal(store.listUnsettledResources().length, 0);
});

// A worker restart: every in-memory controller object is discarded, the S1 store is reopened from disk and, when `roll`
// is set, the S1 generation is rolled (beginGenerationRecovery) exactly as a restarted worker does. The new controller
// knows only what S1 and the interlock hold.
async function restart(t, dir, fake, { roll = true, ready = true } = {}) {
    const handle = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, runtime: syntheticRuntime() });
    let closed = false;
    const close = () => { if (!closed) { closed = true; handle.close(); } };
    t.after(close);
    const prior = handle.generationId;
    if (roll) handle.beginGenerationRecovery(handle.generationId);
    const w = worker(dir, fake, { store: handle });
    if (ready) await makeReady(w.controller);
    else {
        assert.equal((await w.controller.syncStore()).ok, true);
        assert.equal((await w.controller.registerGeneration({ operationId: op('advance') })).ok, true);
    }
    return { ...w, close, priorGeneration: prior };
}

function assertRecovered(handle, label) {
    assert.deepEqual(handle.completeGenerationRecovery(handle.generationId), { generationId: handle.generationId, recovered: true }, label);
    assert.equal(handle.getWorkerStatus().recoveryPending, false, `${label}: admission is not left recovery_pending`);
}

test('ERR-01-b a lost reserve reply, then a restart that rolls the S1 generation: the recorded reservation is recovered and released', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    const request = intent(robotId);
    fake.state.faults.push({ op: 'reserve', kind: 'lost-reply' });
    refused(await controller.reserve(request), 'outcome_unknown');
    assert.equal(fake.reservedCount(), 1, 'the interlock recorded it');
    const g1 = handle.generationId;
    handle.close();
    // Restart 1: G1 -> G2. Recovery resends the exact G1 body and gets the recorded reservation back.
    const first = await restart(t, dir, fake);
    assert.throws(() => first.handle.completeGenerationRecovery(first.handle.generationId), (error) => error.code === 'recovery_pending', 'the G1 intent blocks recovery');
    const recovered = await first.controller.recoverIntents();
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.value.length, 1);
    const [entry] = recovered.value;
    assert.equal(entry.outcome, 'reserved');
    assert.equal(entry.exposable, false, 'a prior-generation reservation is never exposed');
    assert.equal(entry.reservation.workerGeneration, g1);
    assert.equal(fake.reservedCount(), 1, 'no second reservation from the new generation');
    assert.equal(blockers(first.handle)[0].state, 'reserved', 'S1 refuses to commit a prior-generation blocker; it stays unexposed');
    refused(await first.controller.reserve(request), 'stale_generation', 'the same operation is not exposable to G2');
    assert.equal(fake.reservedCount(), 1);
    first.close();
    // Restart 2 (same generation, all memory discarded): recover again and release by the A1.2 owner rule.
    const second = await restart(t, dir, fake, { roll: false });
    const again = (await second.controller.recoverIntents()).value;
    assert.deepEqual(again.map((e) => e.outcome), ['reserved']);
    const released = await second.controller.release({ operationId: op('release'), reservation: again[0].reservation, evidence: evidenceFor(again[0].reservation) });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(blockers(second.handle).length, 0);
    assert.equal(fake.reservedCount(), 0, 'no unreleasable remote reservation remains');
    assertRecovered(second.handle, 'ERR-01-b');
});

test('ERR-01-c a restart before the remote record: the intent is settled released and nothing remains remotely', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    fake.state.faults.push({ op: 'reserve', kind: 'crash-before' });
    refused(await controller.reserve(intent(robotId)), 'outcome_unknown');
    assert.equal(fake.state.reservations.size, 0);
    assert.equal(blockers(handle).length, 1);
    handle.close();
    const next = await restart(t, dir, fake);
    const recovered = (await next.controller.recoverIntents()).value;
    assert.deepEqual(recovered.map((e) => [e.outcome, e.code]), [['settled', 'stale_generation']], 'never recorded, and G1 can never record it');
    assert.equal(fake.state.reservations.size, 0, 'the G1 body created nothing');
    assert.equal(blockers(next.handle).length, 0);
    assertRecovered(next.handle, 'ERR-01-c');
    next.close();
    const after = await restart(t, dir, fake, { roll: false });
    assert.deepEqual((await after.controller.recoverIntents()).value, [], 'nothing left after another restart');
});

test('ERR-01-d a lost request, then a source transition: the old-epoch intent is settled released', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    fake.state.faults.push({ op: 'reserve', kind: 'crash-before' });
    refused(await controller.reserve(intent(robotId)), 'outcome_unknown');
    handle.close();
    assert.deepEqual(fake.transition(), { ok: true, value: { epoch: 4 } }, 'nothing recorded, so the transition is not blocked');
    const next = await restart(t, dir, fake, { roll: false });
    const recovered = (await next.controller.recoverIntents()).value;
    assert.deepEqual(recovered.map((e) => [e.outcome, e.code]), [['settled', 'stale_source_epoch']]);
    assert.equal(blockers(next.handle).length, 0);
    assert.equal(fake.state.reservations.size, 0);
    assertRecovered(next.handle, 'ERR-01-d');
    // A recorded reservation (lost reply after the record) instead blocks the transition until it is released.
    const fresh = await setup(t);
    fresh.fake.state.faults.push({ op: 'reserve', kind: 'lost-reply' });
    refused(await fresh.controller.reserve(intent(fresh.robotId)), 'outcome_unknown');
    assert.deepEqual(fresh.fake.transition(), { ok: false, error: { code: 'source_transition_blocked' } });
});

test('ERR-01-d-2 (review path C) a lost request, a transition, then an identical retry without restart: the recorded body is resent and the intent settled', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    const request = intent(robotId);
    fake.state.faults.push({ op: 'reserve', kind: 'crash-before' });
    refused(await controller.reserve(request), 'outcome_unknown');
    fake.transition();
    refused(await controller.reserve(request), 'stale_source_epoch', 'the recorded epoch-3 body is resent, not rebuilt');
    assert.equal(blockers(handle).length, 0, 'C path: the non-fresh intent is settled');
    handle.close();
    const next = await restart(t, dir, fake);
    assertRecovered(next.handle, 'no prior-generation blocker remains');
});

test('SRC-13-b orphan settlement requires absence of exactly the recorded resources, across restarts', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    const reservation = (await controller.reserve(intent(robotId))).value;
    handle.close();
    fake.recreate(sid('store-b'));
    const first = await restart(t, dir, fake, { ready: false });
    const [orphan] = first.controller.listIntents().value;
    assert.equal(orphan.orphaned, true);
    assert.deepEqual(orphan.resources, reservation.resources, 'the recorded resources come from S1, not memory');
    const unrelated = { complete: true, fresh: true, sealed: true, openHandles: 0, digest: sdg('unrelated'), resources: [{ resourceId: sid('gone'), state: 'absent' }] };
    refused(await first.controller.settleOrphanedReservation({ resourceId: orphan.resourceId, evidence: unrelated }), 'release_unverified', 'unrelated evidence');
    refused(await first.controller.settleOrphanedReservation({ resourceId: orphan.resourceId, evidence: orphanEvidence({ ...orphan, resources: orphan.resources.slice(0, 1) }) }), 'release_unverified', 'partial evidence');
    refused(await first.controller.settleOrphanedReservation({ resourceId: orphan.resourceId, evidence: orphanEvidence(orphan, { resources: [...orphanEvidence(orphan).resources, { resourceId: sid('extra'), state: 'absent' }] }) }), 'release_unverified', 'extra resource');
    assert.equal(blockers(first.handle).length, 1);
    assert.equal(first.controller.readiness().code, 'source_store_changed');
    first.close();
    const second = await restart(t, dir, fake, { roll: false, ready: false });
    const [again] = second.controller.listIntents().value;
    assert.equal((await second.controller.settleOrphanedReservation({ resourceId: again.resourceId, evidence: orphanEvidence(again) })).ok, true);
    assert.equal((await second.controller.acknowledgeStore({ operationId: op('ack') })).ok, true);
    assert.deepEqual(second.controller.readiness(), { ready: true, code: null });
    assertRecovered(second.handle, 'SRC-13-b');
});

test('RSV-14-b reserve, release, restart rolling the S1 generation, interlock compaction, retry: refused, nothing created or committed', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    const request = intent(robotId);
    const reservation = (await controller.reserve(request)).value;
    assert.equal((await controller.release({ operationId: op('release'), reservation, evidence: evidenceFor(reservation) })).ok, true);
    handle.close();
    const next = await restart(t, dir, fake);
    fake.compact();
    assert.equal(fake.state.receipts.has(`reserve:${request.operationId}`), false, 'the interlock no longer knows the operation');
    assert.equal(fake.state.reservations.size, 0);
    const reserveCalls = fake.state.calls.filter((call) => call === 'reserve').length;
    refused(await next.controller.reserve(request), 'operation_retired', 'retired across restart and compaction');
    refused(await next.controller.reserve({ ...request, expectedEpoch: 3, resources: resources(['home']) }), 'operation_retired', 'a different body cannot reuse the operation either');
    assert.equal(fake.state.calls.filter((call) => call === 'reserve').length, reserveCalls, 'no remote reserve call');
    assert.equal(fake.state.reservations.size, 0, 'nothing created remotely');
    assert.deepEqual(next.handle.listUnsettledResources(), [], 'no S1 blocker reserved or committed');
    assertRecovered(next.handle, 'RSV-14-b');
});

test('an oversized intent body is capacity_exceeded, not state_corrupt; the operation is then operation_retired', async (t) => {
    const { dir, fake, robotId, handle, controller } = await setup(t);
    const big = intent(robotId, { resources: resources(Array.from({ length: 20 }, (_, i) => `target-state-${String(i).padStart(2, '0')}`)).map((r) => ({ ...r, kind: 'target-state' })) });
    const calls = fake.state.calls.length;
    refused(await controller.reserve(big), 'capacity_exceeded', 'S1 requestBytes bound on the recorded body');
    assert.equal(fake.state.calls.length, calls, 'no remote call');
    assert.equal(blockers(handle).length, 0, 'no intent');
    assert.equal(handle.listUnsettledResources().filter((b) => b.kind === 'source-reservation-op').length, 0, 'the marker is settled at once');
    refused(await controller.reserve(big), 'operation_retired', 'A8.1: the operation is retired; allocate a new operation ID');
    assert.equal(fake.state.calls.length, calls, 'still no remote call');
    handle.close();
    const next = await restart(t, dir, fake);
    assert.deepEqual((await next.controller.recoverIntents()).value, [], 'nothing left to recover');
    assertRecovered(next.handle, 'no marker blocks recovery');
    refused(await next.controller.reserve({ ...big, resources: resources() }), 'operation_retired', 'the operation stays retired');
});

// Crash injection on a real S1 store: the `nth` reserveResource commit of the armed reserve call is durable, then the
// "process dies": that commit throws and every later S1 write in the same process is rolled back.
async function setupCrashing(t) {
    const dir = makeTempDir(t);
    const fake = createFakeInterlock();
    const crash = { armedAt: null, count: 0, dead: false };
    const store = openStore(dir, {
        faults: {
            beforeCommit() { if (crash.dead) throw new Error('synthetic: the process is dead'); },
            afterCommit(label) {
                if (crash.armedAt === null || crash.dead || label !== 'reserveResource') return;
                crash.count += 1;
                if (crash.count === crash.armedAt) { crash.dead = true; throw new Error('synthetic crash after a durable commit'); }
            }
        }
    });
    const w = worker(dir, fake, { store });
    const robotId = readyRobot(store, syntheticContext());
    await makeReady(w.controller);
    return { dir, fake, robotId, crash, ...w };
}

const reserveCalls = (fake) => fake.state.calls.filter((call) => call === 'reserve').length;

// Window A: the marker is durable, the intent never written. Window B: marker and intent durable, the marker not settled.
async function crashIn(t, window) {
    const ctx = await setupCrashing(t);
    const request = intent(ctx.robotId);
    ctx.crash.armedAt = window === 'A' ? 1 : 2;
    refused(await ctx.controller.reserve(request), 'state_corrupt', `crash in window ${window}`);
    assert.equal(reserveCalls(ctx.fake), 0, 'the crash precedes the first remote call');
    const unsettled = ctx.handle.listUnsettledResources();
    assert.deepEqual(unsettled.map((b) => b.kind).sort(), window === 'A' ? ['source-reservation-op'] : ['source-reservation', 'source-reservation-op']);
    ctx.handle.close();
    return { ...ctx, request };
}

test('crash window A, retry before recoverIntents: operation_retired, zero remote reserves, recovery completes', async (t) => {
    const { dir, fake, request } = await crashIn(t, 'A');
    const next = await restart(t, dir, fake);
    refused(await next.controller.reserve(request), 'operation_retired', 'A before recovery');
    refused(await next.controller.reserve(request), 'operation_retired', 'and every later retry');
    assert.equal(reserveCalls(fake), 0);
    assert.equal(fake.state.reservations.size, 0);
    assert.deepEqual((await next.controller.recoverIntents()).value, [], 'the marker was already settled by the refusal');
    assertRecovered(next.handle, 'window A before recovery');
});

test('crash window A, retry after recoverIntents: the marker is retired by recovery, the retry is operation_retired', async (t) => {
    const { dir, fake, request } = await crashIn(t, 'A');
    const next = await restart(t, dir, fake);
    assert.deepEqual((await next.controller.recoverIntents()).value.map((e) => e.outcome), ['retired']);
    assertRecovered(next.handle, 'window A after recovery');
    refused(await next.controller.reserve(request), 'operation_retired', 'A after recovery');
    assert.equal(reserveCalls(fake), 0);
    assert.equal(fake.state.reservations.size, 0);
});

test('crash window B, retry before recoverIntents: the stale intent is reconciled (A6.3) once, then operation_retired', async (t) => {
    const { dir, fake, request } = await crashIn(t, 'B');
    const next = await restart(t, dir, fake);
    // The unsettled intent keeps A6.3: its recorded G1 body is resent once; nothing exists for it and G1 can never
    // record it, so it is settled and the first retry reports that reconciliation.
    refused(await next.controller.reserve(request), 'stale_generation', 'B first retry: A6.3 reconciliation of the stale intent');
    assert.equal(reserveCalls(fake), 1, 'exactly the one reconciliation resend');
    assert.equal(fake.state.reservations.size, 0, 'no remote reservation created');
    refused(await next.controller.reserve(request), 'operation_retired', 'B subsequent retries');
    refused(await next.controller.reserve(request), 'operation_retired', 'B subsequent retries (stable)');
    assert.equal(reserveCalls(fake), 1, 'no further remote reserve');
    assert.deepEqual(next.handle.listUnsettledResources(), []);
    assertRecovered(next.handle, 'window B before recovery');
});

test('crash window B, retry after recoverIntents: recovery settles intent and marker, the retry is operation_retired', async (t) => {
    const { dir, fake, request } = await crashIn(t, 'B');
    const next = await restart(t, dir, fake);
    const recovered = (await next.controller.recoverIntents()).value;
    assert.deepEqual(recovered.map((e) => [e.outcome, e.code]), [['settled', 'stale_generation']], 'the linked marker is settled silently');
    assert.equal(reserveCalls(fake), 1, 'the reconciliation resend');
    assertRecovered(next.handle, 'window B after recovery');
    refused(await next.controller.reserve(request), 'operation_retired', 'B after recovery');
    assert.equal(reserveCalls(fake), 1, 'zero remote reserves for the retry');
    assert.equal(fake.state.reservations.size, 0);
});

test('A8.2 a window-A marker is settled with the store unavailable; the generation is not left recovery_pending', async (t) => {
    const { dir, fake } = await crashIn(t, 'A');
    fake.state.available = false;
    const handle = openWorkerState({ dataDir: dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, runtime: syntheticRuntime() });
    t.after(() => handle.close());
    handle.beginGenerationRecovery(handle.generationId);
    const { controller } = worker(dir, fake, { store: handle });
    assert.deepEqual((await controller.syncStore()).value, { state: 'unavailable' });
    const callsBefore = fake.state.calls.length;
    const recovered = await controller.recoverIntents();
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.deepEqual(recovered.value.map((e) => e.outcome), ['retired']);
    assert.equal(fake.state.calls.length, callsBefore, 'no interlock contact');
    assertRecovered(handle, 'A8.2');
    // A window-B intent still needs the store (A6.3): it is reported kept and recovery stays pending until the store returns.
    const b = await crashIn(t, 'B');
    b.fake.state.available = false;
    const hb = openWorkerState({ dataDir: b.dir, workspaceId: WORKSPACE, provider: PROVIDER, limits: LIMITS, runtime: syntheticRuntime() });
    t.after(() => hb.close());
    hb.beginGenerationRecovery(hb.generationId);
    const wb = worker(b.dir, b.fake, { store: hb });
    await wb.controller.syncStore();
    assert.deepEqual((await wb.controller.recoverIntents()).value.map((e) => [e.outcome, e.code]), [['kept', 'source_unavailable']]);
    assert.equal(hb.listUnsettledResources().filter((x) => x.kind === 'source-reservation-op').length, 0, 'its marker is settled anyway');
    assert.throws(() => hb.completeGenerationRecovery(hb.generationId), (error) => error.code === 'recovery_pending');
});

test('recoverIntents reports a per-intent failure and continues with the other intents', async (t) => {
    const { fake, robotId, handle, controller } = await setup(t);
    const first = intent(robotId);
    const second = intent(robotId, { resources: resources(['target-state']) });
    fake.state.faults.push({ op: 'reserve', kind: 'lost-reply' }, { op: 'reserve', kind: 'lost-reply' });
    refused(await controller.reserve(first), 'outcome_unknown');
    refused(await controller.reserve(second), 'outcome_unknown');
    const broken = blockers(handle).find((b) => b.locator.operationId === first.operationId).resourceId;
    const original = fake.reserveWritableResources;
    fake.reserveWritableResources = async (ctx, request) => {
        const result = await original(ctx, request);
        return request.reservationId === broken && result.ok ? { ok: true, value: { ...result.value, consumerId: sid('tampered') } } : result;
    };
    const recovered = await controller.recoverIntents();
    assert.equal(recovered.ok, true);
    const byOp = Object.fromEntries(recovered.value.map((entry) => [entry.operationId, entry]));
    assert.deepEqual([byOp[first.operationId].outcome, byOp[first.operationId].code], ['error', 'state_corrupt']);
    assert.equal(byOp[second.operationId].outcome, 'reserved', 'the other intent is still reconciled');
    assert.equal(blockers(handle).find((b) => b.locator.operationId === second.operationId).state, 'committed');
    assert.equal(blockers(handle).find((b) => b.locator.operationId === first.operationId).state, 'reserved', 'the failing intent is kept unexposed');
});

test('an execution-scoped reservation keeps its S1 attempt from settling until the source reservation is released', async (t) => {
    const { robotId, handle, controller } = await setup(t);
    const context = syntheticContext();
    const admitted = handle.admit(context, admitRequest(robotId, {}, context));
    handle.transitionAttempt({ executionId: admitted.executionId, attemptId: admitted.attemptId, expectedState: 'queued', nextState: 'running' });
    const reservation = (await controller.reserve(intent(robotId, { executionId: admitted.executionId, attemptId: admitted.attemptId, consumerKind: 'execution' }))).value;
    endAttempt(handle, context, admitted, 'completed', { expectedState: 'running' });
    assert.equal(handle.getReference(context, { referenceId: admitted.reference.id }).state, 'stopping');
    assert.equal((await controller.release({ operationId: op(), reservation, evidence: evidenceFor(reservation) })).ok, true);
    const view = handle.getReference(context, { referenceId: admitted.reference.id });
    assert.equal(view.state, 'completed');
    assert.equal(view.result.cleanup, 'released');
});
