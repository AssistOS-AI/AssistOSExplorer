// SYNTHETIC journal-oracle tests (journalModel.mjs, receipts.mjs). The model is deterministic and in memory; it is the
// semantic oracle for a later native helper, not that helper.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JOURNAL_ERROR_CODES, createTargetJournalModel } from '../../server/executionTarget/journalModel.mjs';
import { RECEIPT_ERROR_CODES, classifyTargetStartOutcome, reconcileTargetReceipt } from '../../server/executionTarget/receipts.mjs';
import { targetDigest, validateStartOutcome } from '../../server/executionTarget/contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (input) => crypto.createHash('sha256').update(input).digest('hex');
const sid = (label) => crypto.createHash('sha256').update(`synthetic-id:${label}`).digest().subarray(0, 16).toString('base64url');
const sdg = (label) => sha(`synthetic-digest:${label}`);
const JOURNAL = sid('journal-a');
const HELPER = sid('helper-1');
const DAY = 24 * 60 * 60 * 1000;

function key(label = 'start') {
    return { workspaceId: 'ws-synthetic', workerGeneration: sid('worker-gen'), executionId: sid('exec'), attemptId: sid('attempt'), operationId: sid(`op-${label}`) };
}

function prepareRequest(label = 'start', overrides = {}) {
    return {
        key: key(label), targetBindingDigest: sdg('binding'), reservationId: sid('reservation'), requestDigest: sdg(`request-${label}`),
        leaseId: sid(`lease-${label}`), journalStoreIdentity: JOURNAL,
        resources: [
            { resourceId: sid(`${label}-tree`), kind: 'process-tree', locatorDigest: sdg(`${label}-tree`) },
            { resourceId: sid(`${label}-gate`), kind: 'gate', locatorDigest: sdg(`${label}-gate`) }
        ],
        workerCommitDigest: sdg(`commit-${label}`), ...overrides
    };
}

function model(options = {}) {
    let clock = 1000;
    const instance = createTargetJournalModel({ journalStoreIdentity: JOURNAL, helperIncarnation: HELPER, now: () => clock, ...options });
    return { journal: instance, advance(ms) { clock += ms; } };
}

function commitFor(request, receipt) {
    return {
        key: request.key, targetBindingDigest: request.targetBindingDigest, reservationId: request.reservationId,
        preparedReceiptSequence: receipt.receiptSequence, preparedResourcesDigest: targetDigest(receipt.resources, { maxBytes: 1 << 20 }).value,
        workerCommitDigest: request.workerCommitDigest
    };
}

function count(journal, type) {
    return journal.effects().filter((entry) => entry.type === type).length;
}

function refused(result, code, label) {
    assert.deepEqual(result, { ok: false, error: { code } }, label);
    assert.ok(JOURNAL_ERROR_CODES.includes(code) || RECEIPT_ERROR_CODES.includes(code), `${code} enumerated`);
}

function expectedOf(request, lastReceiptSequence = 0) {
    return {
        key: request.key, targetBindingDigest: request.targetBindingDigest, reservationId: request.reservationId, requestDigest: request.requestDigest,
        journalStoreIdentity: request.journalStoreIdentity, leaseId: request.leaseId, lastReceiptSequence
    };
}

function exitAndEvidence(journal, request, kind = 'verified-absent') {
    journal.stop({ key: request.key });
    journal.observeExit({ key: request.key });
    return {
        key: request.key,
        evidence: { resources: request.resources.map((resource) => ({ resourceId: resource.resourceId, kind, evidenceDigest: sdg(`absent-${resource.resourceId}`) })) }
    };
}

test('prepare persists the key before one gated create; commit journals one gate release; receipts validate', () => {
    const { journal } = model();
    const request = prepareRequest();
    const prepared = journal.prepare(request);
    assert.equal(prepared.ok, true);
    assert.equal(prepared.value.state, 'prepared');
    assert.equal(prepared.value.gateReleased, false);
    assert.ok(prepared.value.resources.every((entry) => entry.state === 'committed' && entry.identityDigest !== null));
    const committed = journal.commit(commitFor(request, prepared.value));
    assert.equal(committed.ok, true);
    assert.equal(committed.value.state, 'running');
    assert.equal(committed.value.gateReleased, true);
    assert.deepEqual(journal.effects().map((entry) => entry.type), ['create', 'gate-release']);
    const looked = journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest });
    assert.equal(looked.value.state, 'running');
    const reconciled = reconcileTargetReceipt(expectedOf(request), looked.value);
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.value.settled, false);
    assert.ok(Object.isFrozen(JOURNAL_ERROR_CODES) && Object.isFrozen(RECEIPT_ERROR_CODES));
});

test('JRN-01 concurrent identical prepare/commit with lost replies: one tree, at most one release, the same stored receipt (every schedule)', () => {
    const faults = [null, 'lost-reply', 'crash-before-durable', 'crash-after-persist', 'crash-after-intent'];
    let schedules = 0;
    for (let mask = 0; mask < 256; mask += 1) {
        for (const fault of faults) {
            for (let faultStep = 0; faultStep < (fault ? 4 : 1); faultStep += 1) {
                schedules += 1;
                const { journal } = model();
                const request = prepareRequest();
                const clients = [{ phase: 'prepare', receipt: null }, { phase: 'prepare', receipt: null }];
                let step = 0;
                const run = (client) => {
                    if (client.phase === 'done') return;
                    if (fault && step === faultStep) journal.inject(fault);
                    step += 1;
                    const result = client.phase === 'prepare' ? journal.prepare(request) : journal.commit(commitFor(request, client.receipt));
                    if (!result.ok) {
                        assert.equal(result.error.code, 'outcome_unknown', `mask ${mask} ${fault}`);
                        return;
                    }
                    client.receipt = result.value;
                    client.phase = result.value.gateReleased || client.phase === 'commit' ? 'done' : 'commit';
                };
                for (let bit = 0; bit < 8; bit += 1) run(clients[(mask >> bit) & 1]);
                for (let guard = 0; guard < 8 && clients.some((client) => client.phase !== 'done'); guard += 1) clients.forEach(run);
                assert.ok(clients.every((client) => client.phase === 'done'), `schedule ${mask} ${fault} completes`);
                assert.equal(count(journal, 'create'), 1, `one tree: ${mask} ${fault}@${faultStep}`);
                const releases = count(journal, 'gate-release');
                assert.ok(releases <= 1, 'never a second gate release');
                if (fault !== 'crash-after-intent') assert.equal(releases, 1, `one release: ${mask} ${fault}@${faultStep}`);
                assert.deepEqual(clients[0].receipt, clients[1].receipt, 'the same stored receipt');
                assert.equal(clients[0].receipt.state, 'running');
            }
        }
    }
    assert.ok(schedules > 1000);
});

test('JRN-01-b recreating the helper never makes an old key new: one create and at most one gate release', () => {
    for (const recreateAfter of ['prepare', 'commit', 'lost-commit']) {
        const { journal } = model();
        const request = prepareRequest(recreateAfter);
        const prepared = journal.prepare(request).value;
        if (recreateAfter !== 'prepare') {
            if (recreateAfter === 'lost-commit') journal.inject('lost-reply');
            journal.commit(commitFor(request, prepared));
        }
        journal.recreateHelper(sid(`helper-${recreateAfter}`));
        const retried = journal.startExecution(request);
        assert.equal(retried.ok, true, recreateAfter);
        assert.equal(retried.value.outcome, 'committed-or-reconciled', recreateAfter);
        assert.equal(retried.value.receipt.helperIncarnation, HELPER, `${recreateAfter}: the record keeps its creating incarnation`);
        assert.equal(journal.prepare(request).value.receiptSequence, retried.value.receipt.receiptSequence, 'identical retry, same record');
        assert.equal(count(journal, 'create'), 1, `${recreateAfter}: one create`);
        assert.ok(count(journal, 'gate-release') <= 1, `${recreateAfter}: at most one gate release`);
        assert.equal(count(journal, 'gate-release'), 1, `${recreateAfter}: the start completes once`);
        assert.equal(journal.size(), 1);
    }
});

test('OUT-01-b a retried start with a pending stop never releases the gate and delivers the stop like a first start', () => {
    // The prepare reply is lost; a stop arrives; the start is retried and prepare reports the prepared receipt.
    const first = model();
    const request = prepareRequest('pending');
    first.journal.inject('lost-reply');
    assert.equal(first.journal.startExecution(request).value.outcome, 'outcome-unknown');
    assert.deepEqual(first.journal.requestStop(request.key), { stop: 'pending' });
    const retried = first.journal.startExecution(request);
    assert.equal(retried.value.outcome, 'committed-or-reconciled');
    assert.equal(count(first.journal, 'gate-release'), 0, 'no gate release for a stopped start');
    assert.equal(count(first.journal, 'stop'), 1, 'the pending stop is delivered');
    assert.deepEqual(first.journal.workerEntry(request.key), { state: 'stopping', pendingStop: false, stopSettled: true, outcome: 'committed-or-reconciled' });
    // The commit reply is lost (the gate was released); a stop arrives; a retried start reports gateReleased.
    const second = model();
    const other = prepareRequest('released');
    const prepared = second.journal.prepare(other).value;
    second.journal.inject('lost-reply');
    second.journal.commit(commitFor(other, prepared));
    second.journal.inject('lost-reply');
    assert.equal(second.journal.startExecution(other).value.outcome, 'outcome-unknown');
    assert.deepEqual(second.journal.requestStop(other.key), { stop: 'pending' });
    const again = second.journal.startExecution(other);
    assert.equal(again.value.receipt.gateReleased, true);
    assert.equal(count(second.journal, 'gate-release'), 1);
    assert.equal(count(second.journal, 'stop'), 1, 'the pending stop is delivered after a gateReleased prepare');
    assert.equal(second.journal.workerEntry(other.key).pendingStop, false);
});

test('JRN-02 the same key with a changed request, binding, reservation or lease is operation_conflict with zero additional create', () => {
    const { journal } = model();
    const request = prepareRequest();
    journal.prepare(request);
    for (const [label, change] of [['request', { requestDigest: sdg('other') }], ['binding', { targetBindingDigest: sdg('other-binding') }], ['reservation', { reservationId: sid('other-res') }], ['lease', { leaseId: sid('other-lease') }]]) {
        refused(journal.prepare({ ...request, ...change }), 'operation_conflict', label);
    }
    assert.equal(count(journal, 'create'), 1);
    assert.equal(journal.size(), 1);
});

test('BND-02 a binding change between queued dispatch and final release keeps the gate closed', () => {
    const { journal } = model();
    const request = prepareRequest();
    const prepared = journal.prepare(request).value;
    refused(journal.commit({ ...commitFor(request, prepared), targetBindingDigest: sdg('changed-binding') }), 'binding_mismatch', 'binding');
    refused(journal.commit({ ...commitFor(request, prepared), reservationId: sid('changed-reservation') }), 'binding_mismatch', 'reservation');
    refused(journal.commit({ ...commitFor(request, prepared), preparedReceiptSequence: prepared.receiptSequence + 1 }), 'operation_conflict', 'prepared sequence');
    assert.equal(count(journal, 'gate-release'), 0);
    assert.equal(journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest }).value.state, 'prepared');
    const committed = journal.commit(commitFor(request, prepared));
    assert.equal(committed.ok, true);
    refused(journal.commit({ ...commitFor(request, prepared), workerCommitDigest: sdg('another-commit') }), 'operation_conflict', 'second distinct commit');
    assert.equal(count(journal, 'gate-release'), 1);
});

test('JRN-03 a missing or replaced journal is journal_unavailable and never launches or proves absence', () => {
    const { journal } = model();
    const request = prepareRequest();
    journal.prepare(request);
    journal.replaceJournal(sid('journal-b'));
    refused(journal.prepare(request), 'journal_unavailable', 'binding names the old journal store');
    assert.equal(count(journal, 'create'), 1, 'no new create after recreation');
    const lookedUp = journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest });
    assert.equal(lookedUp.value.state, 'absent-with-proof', 'the new journal has no such key');
    refused(reconcileTargetReceipt(expectedOf(request), lookedUp.value), 'journal_unavailable', 'absence from another journal store is not absence');
    journal.loseJournal();
    for (const [label, call] of [
        ['prepare', () => journal.prepare(request)],
        ['lookup', () => journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest })],
        ['stop', () => journal.stop({ key: request.key })],
        ['release', () => journal.release({ key: request.key, evidence: { resources: [] } })]
    ]) refused(call(), 'journal_unavailable', label);
    const started = journal.startExecution(prepareRequest('lost'));
    assert.equal(started.ok, true);
    assert.equal(started.value.outcome, 'outcome-unknown', 'a lost journal is never refused-before-create');
});

test('JRN-04 unknown lookup, inspect 404, name or PID absence are absence_unverified and blockers stay', () => {
    const { journal } = model();
    const request = prepareRequest();
    journal.commit(commitFor(request, journal.prepare(request).value));
    for (const kind of ['inspect-404', 'name-absent', 'pid-absent', 'unknown']) {
        const release = exitAndEvidence(journal, request, kind);
        const before = journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest }).value.receipt;
        refused(journal.release(release), 'absence_unverified', kind);
        const after = journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest }).value.receipt;
        assert.deepEqual(after.resources, before.resources, `${kind}: resources unchanged`);
    }
    const partial = exitAndEvidence(journal, request);
    partial.evidence.resources.pop();
    refused(journal.release(partial), 'absence_unverified', 'evidence omits a resource');
    assert.equal(count(journal, 'release'), 0);
    for (const observed of [null, undefined, { ok: false, error: { code: 'journal_unavailable' } }, { state: 'absent' }, { state: 'absent-with-proof' }]) {
        refused(reconcileTargetReceipt(expectedOf(request), observed), 'absence_unverified', JSON.stringify(observed));
    }
    // Quarantine is recorded but is not absence.
    const quarantine = exitAndEvidence(journal, request, 'quarantine');
    const quarantined = journal.release(quarantine);
    assert.equal(quarantined.value.state, 'quarantined');
    const reconciled = reconcileTargetReceipt(expectedOf(request), journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest }).value);
    assert.equal(reconciled.value.quarantined, true);
    assert.equal(reconciled.value.absent, false);
});

test('JRN-05 a retired key replays its retired receipt and is never created again', () => {
    const { journal, advance } = model();
    const request = prepareRequest();
    journal.commit(commitFor(request, journal.prepare(request).value));
    assert.equal(journal.release(exitAndEvidence(journal, request)).value.state, 'exited');
    refused(journal.retire({ key: request.key, referenced: false }), 'operation_conflict', 'before the retention boundary');
    advance(7 * DAY);
    refused(journal.retire({ key: request.key, referenced: true }), 'operation_conflict', 'still referenced by a recovery obligation');
    const retired = journal.retire({ key: request.key, referenced: false });
    assert.equal(retired.ok, true);
    const replay = journal.prepare(request);
    assert.deepEqual(replay.value, retired.value, 'the retired receipt');
    assert.deepEqual(journal.commit(commitFor(request, replay.value)).value, retired.value);
    refused(journal.prepare({ ...request, requestDigest: sdg('fresh') }), 'operation_conflict', 'changed body');
    assert.equal(count(journal, 'create'), 1);
    assert.equal(count(journal, 'gate-release'), 1);
    assert.equal(journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest }).value.state, 'exited');
    assert.throws(() => createTargetJournalModel({ journalStoreIdentity: JOURNAL, helperIncarnation: HELPER, limits: { settledReceiptRetentionMs: DAY } }), /retention/);
});

test('JRN-06 a lost input acknowledgement is unknown and is never retransmitted automatically', () => {
    const { journal } = model();
    const request = prepareRequest();
    journal.commit(commitFor(request, journal.prepare(request).value));
    const connectionId = sid('conn-1');
    const chunk = (offset, label, byteLength = 10) => ({ key: request.key, connectionId, offset, bytesDigest: sdg(label), byteLength });
    assert.deepEqual(journal.input(chunk('0', 'a')).value, { connectionId, acceptedThrough: '10' });
    journal.inject('lost-reply');
    refused(journal.input(chunk('10', 'b')), 'outcome_unknown', 'lost acknowledgement');
    refused(journal.input(chunk('10', 'b')), 'delivery_unknown', 'no automatic resend');
    refused(journal.input(chunk('20', 'c')), 'delivery_unknown', 'no further input before reconciliation');
    const looked = journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest }).value.receipt;
    assert.deepEqual(looked.inputCursors, [{ connectionId, acceptedThrough: '20', delivery: 'unknown' }]);
    assert.deepEqual(journal.input(chunk('10', 'b')).value, { connectionId, acceptedThrough: '20' }, 'identical bytes at an accepted offset after reconciliation');
    refused(journal.input(chunk('10', 'different')), 'operation_conflict', 'different bytes at an accepted offset');
    refused(journal.input(chunk('30', 'gap')), 'invalid_request', 'gap');
    refused(journal.input(chunk('20', 'big', 65537)), 'capacity_exceeded', 'CAP-01 data bytes per frame + 1');
    assert.equal(journal.input(chunk('20', 'max', 65536)).ok, true, 'CAP-01 data bytes per frame');
});

test('OUT-01 a start timeout followed by stop: outcome-unknown, the stop stays pending until reconciliation', () => {
    const { journal } = model();
    const request = prepareRequest();
    journal.inject('lost-reply');
    // The prepare is durable and the tree is created, but the worker never sees the reply.
    const started = journal.startExecution(request);
    assert.equal(started.value.outcome, 'outcome-unknown');
    assert.equal(validateStartOutcome(started.value).ok, true);
    assert.equal(started.value.reservationId, request.reservationId);
    assert.deepEqual(journal.requestStop(request.key), { stop: 'pending' });
    assert.deepEqual(journal.workerEntry(request.key), { state: 'unknown', pendingStop: true, stopSettled: false, outcome: 'outcome-unknown' });
    assert.equal(count(journal, 'stop'), 0);
    const looked = journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest }).value.receipt;
    assert.ok(looked.resources.every((entry) => entry.state === 'committed'), 'blockers retained');
    // Reconciliation finds the created tree: the pending stop is now sent, once.
    assert.deepEqual(journal.reconcileStart(request.key).value, { state: 'stopping', stop: 'sent' });
    assert.equal(count(journal, 'stop'), 1);
    assert.deepEqual(journal.requestStop(request.key), { stop: 'sent' });
    assert.equal(count(journal, 'stop'), 1, 'idempotent');
});

test('OUT-01 an unknown start with an unreachable journal keeps the stop pending; only authenticated absence settles it', () => {
    const { journal } = model();
    const request = prepareRequest('crash');
    journal.inject('crash-before-durable');
    assert.equal(journal.startExecution(request).value.outcome, 'outcome-unknown');
    assert.deepEqual(journal.requestStop(request.key), { stop: 'pending' });
    journal.loseJournal();
    refused(journal.reconcileStart(request.key), 'journal_unavailable', 'no reconciliation without a journal');
    assert.deepEqual(journal.workerEntry(request.key), { state: 'unknown', pendingStop: true, stopSettled: false, outcome: 'outcome-unknown' });
    const second = model();
    second.journal.inject('crash-before-durable');
    const other = prepareRequest('absent');
    second.journal.startExecution(other);
    second.journal.requestStop(other.key);
    assert.deepEqual(second.journal.reconcileStart(other.key).value, { state: 'not-created', stop: 'nothing-to-stop' });
    assert.equal(count(second.journal, 'create'), 0);
});

test('three start outcomes are classified exactly; only journal absence proves no create', () => {
    const request = prepareRequest();
    const expected = expectedOf(request);
    const unknownKinds = [{ kind: 'timeout' }, { kind: 'lost-reply' }, { kind: 'helper-gone' }, { kind: 'transport-error' }, { kind: 'refused', code: 'binding_mismatch' }, null, undefined];
    for (const reply of unknownKinds) {
        const outcome = classifyTargetStartOutcome({ expected, reply });
        assert.equal(outcome.value.outcome, 'outcome-unknown', JSON.stringify(reply));
        assert.deepEqual(Object.keys(outcome.value).sort(), ['key', 'lastReceiptSequence', 'outcome', 'requestDigest', 'reservationId', 'version']);
    }
    const refusedBefore = classifyTargetStartOutcome({ expected, reply: { kind: 'refused', code: 'capacity_exceeded', absenceEvidenceDigest: sdg('absent') } });
    assert.equal(refusedBefore.value.outcome, 'refused-before-create');
    const { journal } = model();
    const capacityLimited = createTargetJournalModel({ journalStoreIdentity: JOURNAL, helperIncarnation: HELPER, limits: { journalEntries: 1 } });
    capacityLimited.prepare(prepareRequest('first'));
    const full = capacityLimited.startExecution(prepareRequest('second'));
    assert.equal(full.value.outcome, 'refused-before-create', 'a capacity refusal with journal absence proof');
    assert.equal(full.value.code, 'capacity_exceeded');
    assert.deepEqual(capacityLimited.requestStop(prepareRequest('second').key), { stop: 'nothing-to-stop' });
    const committed = journal.startExecution(request);
    assert.equal(committed.value.outcome, 'committed-or-reconciled');
    assert.equal(committed.value.receipt.state, 'running');
    const receipt = committed.value.receipt;
    refused(classifyTargetStartOutcome({ expected: { ...expected, targetBindingDigest: sdg('x') }, reply: { kind: 'receipt', receipt } }), 'binding_mismatch', 'receipt of another binding');
    refused(classifyTargetStartOutcome({ expected: { ...expected, requestDigest: sdg('x') }, reply: { kind: 'receipt', receipt } }), 'operation_conflict', 'receipt of another request');
    refused(classifyTargetStartOutcome({ expected: { ...expected, journalStoreIdentity: sid('journal-b') }, reply: { kind: 'receipt', receipt } }), 'journal_unavailable', 'receipt of another journal');
    refused(reconcileTargetReceipt({ ...expected, lastReceiptSequence: receipt.receiptSequence + 1 }, { state: receipt.state, receipt }), 'receipt_regressed', 'regressed sequence');
});

test('CAP-01 and CAP-02 journal entry and resource bounds: existing identical work reconciles at full capacity, new work refuses', () => {
    const capped = createTargetJournalModel({ journalStoreIdentity: JOURNAL, helperIncarnation: HELPER, limits: { journalEntries: 2 } });
    const first = prepareRequest('one');
    const second = prepareRequest('two');
    assert.equal(capped.prepare(first).ok, true);
    assert.equal(capped.prepare(second).ok, true);
    refused(capped.prepare(prepareRequest('three')), 'capacity_exceeded', 'third key');
    assert.equal(capped.prepare(first).ok, true, 'identical retry at full capacity');
    assert.equal(capped.lookup({ key: first.key, targetBindingDigest: first.targetBindingDigest }).ok, true);
    capped.stop({ key: first.key });
    capped.observeExit({ key: first.key });
    assert.equal(capped.release({ key: first.key, evidence: { resources: first.resources.map((r) => ({ resourceId: r.resourceId, kind: 'verified-absent', evidenceDigest: sdg('a') })) } }).ok, true, 'release at full capacity');
    const bulk = (n) => Array.from({ length: n }, (_, i) => ({ resourceId: sid(`bulk-${i}`), kind: 'descriptor', locatorDigest: sdg(`bulk-${i}`) }));
    const { journal } = model();
    assert.equal(journal.prepare(prepareRequest('max', { resources: bulk(512) })).ok, true, '512 resources');
    refused(journal.prepare(prepareRequest('over', { resources: bulk(513) })), 'capacity_exceeded', '513 resources');
});

test('ERR-01 crashes before and after durable journal writes recover with exactly one create and no claimed absence', () => {
    const { journal } = model();
    const request = prepareRequest();
    journal.inject('crash-before-durable');
    refused(journal.prepare(request), 'outcome_unknown');
    assert.equal(journal.size(), 0);
    journal.inject('crash-after-persist');
    refused(journal.prepare(request), 'outcome_unknown');
    const persisted = journal.lookup({ key: request.key, targetBindingDigest: request.targetBindingDigest }).value;
    assert.equal(persisted.state, 'reserved', 'the persisted key is not absence');
    assert.equal(count(journal, 'create'), 0);
    const prepared = journal.prepare(request);
    assert.equal(prepared.value.state, 'prepared');
    journal.inject('crash-after-intent');
    refused(journal.commit(commitFor(request, prepared.value)), 'outcome_unknown');
    assert.equal(count(journal, 'gate-release'), 0, 'the uncertain release is not replayed');
    const retried = journal.commit(commitFor(request, prepared.value));
    assert.equal(retried.value.gateReleased, true);
    assert.equal(count(journal, 'gate-release'), 0);
    assert.equal(count(journal, 'create'), 1);
});

test('the oracle has no local "nothing started" branch and imports nothing from the local endpoint', () => {
    for (const file of ['journalModel.mjs', 'receipts.mjs']) {
        const source = fs.readFileSync(path.join(here, '..', '..', 'server', 'executionTarget', file), 'utf8');
        assert.doesNotMatch(source, /supervisorEndpointServer|providerEndpoint|setup_failed/);
        assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ''), /Nothing was started/i);
    }
});
