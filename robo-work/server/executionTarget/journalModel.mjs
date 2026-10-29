import {
    canonicalText, deepFreeze, digestOf, failure, isDigest, isId, isOperationId, isOpaqueIdentity, isU64Text, sha256Hex, success,
    validateTargetReceipt, RESOURCE_KINDS
} from './contract.mjs';
import { TARGET_LIMITS_V1, TARGET_POLICY_V1 } from './limits.mjs';
import { classifyTargetStartOutcome, reconcileTargetReceipt } from './receipts.mjs';

// Deterministic target-operation journal model (T0 base §9): the semantic oracle for the later native helper. It is
// synchronous and in memory; "concurrency" is an explicit interleaving of calls, and every injected fault is one-shot.
//
// The durable unique key is {workspaceId, workerGeneration, executionId, attemptId, operationId}, never only the helper
// incarnation: replacing the helper or its journal cannot make an old key new. Gated creates and the gate release are
// recorded in `effects()`, so tests can count them.
//
// Faults (model.inject(name), consumed by the next mutating call):
//   'lost-reply'         the operation is performed durably, the reply is lost: outcome_unknown
//   'crash-before-durable' nothing is recorded: outcome_unknown
//   'crash-after-persist' prepare: the key is persisted, the gated create does not happen: outcome_unknown
//   'crash-after-intent'  commit: the release intent is journaled, the gate release itself is uncertain: outcome_unknown
//
// The worker side (`startExecution`, `requestStop`, `reconcileStart`) classifies start outcomes with receipts.mjs and
// keeps a stop that arrives during a start pending. An unknown start never settles that stop: only a same-key lookup
// that returns a receipt (stop is then sent) or authenticated absence (nothing to stop) does. There is deliberately no
// equivalent of the local endpoint's "nothing was started" exception branch.

export const JOURNAL_ERROR_CODES = Object.freeze([
    'invalid_request', 'journal_unavailable', 'operation_conflict', 'binding_mismatch', 'not_found', 'capacity_exceeded',
    'outcome_unknown', 'absence_unverified', 'delivery_unknown', 'lease_retired', 'state_corrupt'
]);

const FAULTS = new Set(['lost-reply', 'crash-before-durable', 'crash-after-persist', 'crash-after-intent']);
const ABSENCE_KINDS = new Set(['verified-absent', 'quarantine']);

class Refusal {
    constructor(code) { this.code = code; }
}

function need(condition, code = 'invalid_request') {
    if (!condition) throw new Refusal(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function keyText(key) {
    need(isPlainObject(key) && Object.keys(key).length === 5);
    need(isOpaqueIdentity(key.workspaceId) && isId(key.workerGeneration) && isId(key.executionId) && isId(key.attemptId) && isOperationId(key.operationId));
    return canonicalText(key);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function createTargetJournalModel({ journalStoreIdentity, helperIncarnation, now = () => 0, limits = {} } = {}) {
    if (!isId(journalStoreIdentity) || !isId(helperIncarnation) || typeof now !== 'function') throw new TypeError('invalid journal model options');
    const bounds = {
        journalEntries: limits.journalEntries ?? TARGET_LIMITS_V1.journalEntries,
        resourcesPerOperation: limits.resourcesPerOperation ?? TARGET_LIMITS_V1.resourcesPerOperation,
        retentionMs: limits.settledReceiptRetentionMs ?? TARGET_POLICY_V1.settledReceiptRetentionMs
    };
    if (bounds.retentionMs < TARGET_POLICY_V1.settledReceiptRetentionMs) throw new TypeError('retention below the policy floor');
    const journal = { storeIdentity: journalStoreIdentity, available: true, revision: 0, records: new Map(), tombstones: new Map() };
    const effects = [];
    const workerEntries = new Map();
    let pendingFault = null;
    let incarnation = helperIncarnation;

    function takeFault() {
        const fault = pendingFault;
        pendingFault = null;
        return fault;
    }

    function receiptOf(record) {
        const receipt = {
            version: 1, key: record.key, targetBindingDigest: record.targetBindingDigest, reservationId: record.reservationId,
            requestDigest: record.requestDigest, journalStoreIdentity: journal.storeIdentity, helperIncarnation: record.helperIncarnation,
            leaseId: record.leaseId, state: record.state, receiptSequence: record.receiptSequence, gateReleased: record.gateReleased,
            resources: record.resources.map((entry) => ({ ...entry })),
            inputCursors: [...record.cursors.entries()].sort(([left], [right]) => (left < right ? -1 : 1))
                .map(([connectionId, cursor]) => ({ connectionId, acceptedThrough: cursor.acceptedThrough, delivery: cursor.delivery })),
            observedAtMs: now()
        };
        const checked = validateTargetReceipt(receipt);
        need(checked.ok, 'state_corrupt');
        return checked.value;
    }

    function bump(record) {
        record.receiptSequence += 1;
        record.updatedAtMs = now();
        journal.revision += 1;
    }

    function mutate(work) {
        try {
            need(journal.available, 'journal_unavailable');
            const fault = takeFault();
            if (fault === 'crash-before-durable') return failure('outcome_unknown');
            const value = work(fault);
            if (fault === 'lost-reply' || value === LOST) return failure('outcome_unknown');
            return success(value);
        } catch (error) {
            return failure(error instanceof Refusal ? error.code : 'state_corrupt');
        }
    }

    function read(work) {
        try {
            need(journal.available, 'journal_unavailable');
            return success(work());
        } catch (error) {
            return failure(error instanceof Refusal ? error.code : 'state_corrupt');
        }
    }

    function recordFor(request) {
        const text = keyText(request.key);
        if (journal.tombstones.has(text)) return { text, tombstone: journal.tombstones.get(text) };
        return { text, record: journal.records.get(text) };
    }

    function sameRequest(stored, request) {
        return stored.targetBindingDigest === request.targetBindingDigest && stored.reservationId === request.reservationId
            && stored.requestDigest === request.requestDigest && stored.leaseId === request.leaseId;
    }

    function create(record) {
        if (record.created) return;
        // The gated create: exactly once per key, after the key and exact request are durable.
        record.created = true;
        effects.push({ type: 'create', key: record.text });
        record.resources = record.resources.map((entry) => ({ ...entry, state: 'committed', identityDigest: sha256Hex(`synthetic-identity:${entry.resourceId}`) }));
        record.state = 'prepared';
        bump(record);
        record.preparedReceiptSequence = record.receiptSequence;
        record.preparedResourcesDigest = digestOf(record.resources, 1 << 20);
    }

    function prepare(request) {
        return mutate((fault) => {
            need(isPlainObject(request));
            need(isDigest(request.targetBindingDigest) && isId(request.reservationId) && isDigest(request.requestDigest) && isId(request.leaseId));
            // A binding naming another (replaced or recreated) journal store has no journal here.
            need(request.journalStoreIdentity === journal.storeIdentity, 'journal_unavailable');
            need(Array.isArray(request.resources), 'invalid_request');
            const found = recordFor(request);
            if (found.tombstone) {
                need(sameRequest(found.tombstone, request), 'operation_conflict');
                return found.tombstone.receipt;
            }
            if (found.record) {
                need(sameRequest(found.record, request), 'operation_conflict');
                if (fault === 'crash-after-persist') return LOST;
                create(found.record);
                return receiptOf(found.record);
            }
            need(request.resources.length <= bounds.resourcesPerOperation, 'capacity_exceeded');
            for (const entry of request.resources) {
                need(isPlainObject(entry) && isId(entry.resourceId) && RESOURCE_KINDS.includes(entry.kind) && isDigest(entry.locatorDigest));
            }
            need(new Set(request.resources.map((entry) => entry.resourceId)).size === request.resources.length);
            need(journal.records.size + journal.tombstones.size < bounds.journalEntries, 'capacity_exceeded');
            const record = {
                text: found.text, key: clone(request.key), targetBindingDigest: request.targetBindingDigest, reservationId: request.reservationId,
                requestDigest: request.requestDigest, leaseId: request.leaseId, helperIncarnation: incarnation, state: 'reserved',
                receiptSequence: 1, gateReleased: false, created: false, workerCommitDigest: null, cursors: new Map(),
                resources: [...request.resources].sort((left, right) => (left.resourceId < right.resourceId ? -1 : 1))
                    .map((entry) => ({ resourceId: entry.resourceId, kind: entry.kind, locatorDigest: entry.locatorDigest, identityDigest: null, state: 'reserved', absenceEvidenceDigest: null })),
                createdAtMs: now(), updatedAtMs: now(), settledAtMs: null, stopped: false
            };
            journal.records.set(found.text, record);
            journal.revision += 1;
            if (fault === 'crash-after-persist') return LOST;
            create(record);
            return receiptOf(record);
        });
    }

    function commit(request) {
        return mutate((fault) => {
            need(isPlainObject(request));
            const found = recordFor(request);
            if (found.tombstone) return found.tombstone.receipt;
            need(found.record !== undefined, 'not_found');
            const record = found.record;
            // Revalidate the complete binding and reservation; a mismatch keeps the gate closed.
            need(request.targetBindingDigest === record.targetBindingDigest && request.reservationId === record.reservationId, 'binding_mismatch');
            need(isDigest(request.workerCommitDigest));
            if (record.workerCommitDigest !== null) {
                // The release intent is journaled at most once; an uncertain release is never replayed.
                need(request.workerCommitDigest === record.workerCommitDigest, 'operation_conflict');
                return receiptOf(record);
            }
            need(record.created && record.state === 'prepared', 'operation_conflict');
            need(request.preparedReceiptSequence === record.preparedReceiptSequence && request.preparedResourcesDigest === record.preparedResourcesDigest, 'operation_conflict');
            record.workerCommitDigest = request.workerCommitDigest;
            record.gateReleased = true;
            record.state = 'running';
            bump(record);
            if (fault === 'crash-after-intent') return LOST;
            effects.push({ type: 'gate-release', key: record.text });
            return receiptOf(record);
        });
    }

    function lookup(request) {
        return read(() => {
            need(isPlainObject(request) && isDigest(request.targetBindingDigest));
            const found = recordFor(request);
            if (found.tombstone) return { state: found.tombstone.receipt.state, receipt: found.tombstone.receipt };
            if (found.record) {
                const receipt = receiptOf(found.record);
                // The lookup is the reconciliation of any unknown input delivery.
                for (const cursor of found.record.cursors.values()) cursor.delivery = 'acknowledged';
                return { state: receipt.state, receipt };
            }
            return {
                state: 'absent-with-proof', key: clone(request.key), targetBindingDigest: request.targetBindingDigest,
                journalStoreIdentity: journal.storeIdentity, journalRevision: String(journal.revision),
                absenceEvidenceDigest: digestOf({ version: 1, journalStoreIdentity: journal.storeIdentity, journalRevision: String(journal.revision), key: request.key })
            };
        });
    }

    function input(request) {
        return mutate((fault) => {
            need(isPlainObject(request));
            const found = recordFor(request);
            need(found.record !== undefined, found.tombstone ? 'lease_retired' : 'not_found');
            const record = found.record;
            need(record.state === 'running', 'lease_retired');
            need(isId(request.connectionId) && isU64Text(request.offset) && isDigest(request.bytesDigest));
            need(Number.isSafeInteger(request.byteLength) && request.byteLength > 0 && request.byteLength <= TARGET_LIMITS_V1.dataBytesPerFrame, 'capacity_exceeded');
            let cursor = record.cursors.get(request.connectionId);
            if (!cursor) {
                need(record.cursors.size < TARGET_LIMITS_V1.connectionsPerExecution, 'capacity_exceeded');
                cursor = { acceptedThrough: '0', delivery: 'acknowledged', chunks: new Map() };
                record.cursors.set(request.connectionId, cursor);
            }
            // A lost acknowledgement is unknown; nothing is resent until a lookup reconciles the cursor.
            need(cursor.delivery !== 'unknown', 'delivery_unknown');
            const offset = BigInt(request.offset);
            const through = BigInt(cursor.acceptedThrough);
            if (offset < through) {
                const chunk = cursor.chunks.get(request.offset);
                need(chunk !== undefined && chunk.bytesDigest === request.bytesDigest && chunk.byteLength === request.byteLength, 'operation_conflict');
                return { connectionId: request.connectionId, acceptedThrough: cursor.acceptedThrough };
            }
            need(offset === through, 'invalid_request');
            cursor.chunks.set(request.offset, { bytesDigest: request.bytesDigest, byteLength: request.byteLength });
            cursor.acceptedThrough = String(through + BigInt(request.byteLength));
            bump(record);
            if (fault === 'lost-reply') {
                cursor.delivery = 'unknown';
                return LOST;
            }
            return { connectionId: request.connectionId, acceptedThrough: cursor.acceptedThrough };
        });
    }

    function stop(request) {
        return mutate(() => {
            const found = recordFor(request);
            if (found.tombstone) return found.tombstone.receipt;
            need(found.record !== undefined, 'not_found');
            const record = found.record;
            if (['reserved', 'prepared', 'running'].includes(record.state)) {
                // Exact-tree cancellation, once; unrelated services, the helper and other executions are untouched.
                if (!record.stopped) {
                    record.stopped = true;
                    if (record.created) effects.push({ type: 'stop', key: record.text });
                }
                record.state = 'stopping';
                bump(record);
            }
            return receiptOf(record);
        });
    }

    function observeExit(request) {
        return mutate(() => {
            const found = recordFor(request);
            need(found.record !== undefined, 'not_found');
            const record = found.record;
            if (['running', 'stopping', 'prepared', 'reserved'].includes(record.state)) {
                record.state = 'exited';
                bump(record);
            }
            return receiptOf(record);
        });
    }

    // Every recorded resource is verified absent (released) or quarantined. Name, PID or inspect-404 evidence is not
    // absence: the whole release refuses with absence_unverified and nothing changes.
    function release(request) {
        return mutate(() => {
            need(isPlainObject(request) && isPlainObject(request.evidence) && Array.isArray(request.evidence.resources));
            const found = recordFor(request);
            if (found.tombstone) return found.tombstone.receipt;
            need(found.record !== undefined, 'not_found');
            const record = found.record;
            need(record.state === 'exited' || record.state === 'stopping' || record.state === 'quarantined', 'operation_conflict');
            const byId = new Map(request.evidence.resources.map((entry) => [entry.resourceId, entry]));
            need(byId.size === record.resources.length && record.resources.every((entry) => byId.has(entry.resourceId)), 'absence_unverified');
            for (const entry of record.resources) {
                const evidence = byId.get(entry.resourceId);
                need(ABSENCE_KINDS.has(evidence.kind), 'absence_unverified');
                if (evidence.kind === 'verified-absent') need(isDigest(evidence.evidenceDigest), 'absence_unverified');
            }
            let quarantined = false;
            record.resources = record.resources.map((entry) => {
                if (entry.state === 'released' || entry.state === 'quarantined') return entry;
                const evidence = byId.get(entry.resourceId);
                if (evidence.kind === 'quarantine') {
                    quarantined = true;
                    return { ...entry, state: 'quarantined' };
                }
                effects.push({ type: 'release', key: record.text, resourceId: entry.resourceId });
                return { ...entry, state: 'released', absenceEvidenceDigest: evidence.evidenceDigest };
            });
            record.state = quarantined || record.resources.some((entry) => entry.state === 'quarantined') ? 'quarantined' : 'exited';
            record.settledAtMs = now();
            bump(record);
            return receiptOf(record);
        });
    }

    // After the settled-receipt retention, and only when no worker recovery obligation references the details, the record
    // becomes a compact tombstone that keeps the key forever (within the entry cap).
    function retire(request) {
        return mutate(() => {
            need(isPlainObject(request) && typeof request.referenced === 'boolean');
            const found = recordFor(request);
            if (found.tombstone) return found.tombstone.receipt;
            need(found.record !== undefined, 'not_found');
            const record = found.record;
            need(record.settledAtMs !== null && record.resources.every((entry) => entry.state === 'released' || entry.state === 'quarantined'), 'operation_conflict');
            need(now() - record.settledAtMs >= bounds.retentionMs && request.referenced === false, 'operation_conflict');
            bump(record);
            const receipt = receiptOf(record);
            journal.records.delete(found.text);
            journal.tombstones.set(found.text, {
                targetBindingDigest: record.targetBindingDigest, reservationId: record.reservationId, requestDigest: record.requestDigest,
                leaseId: record.leaseId, receipt
            });
            return receipt;
        });
    }

    // ---- Worker side ------------------------------------------------------------------------------------------------

    function expectedOf(request, lastReceiptSequence = 0) {
        return {
            key: request.key, targetBindingDigest: request.targetBindingDigest, reservationId: request.reservationId,
            requestDigest: request.requestDigest, journalStoreIdentity: request.journalStoreIdentity, leaseId: request.leaseId, lastReceiptSequence
        };
    }

    function classify(entry, reply) {
        const outcome = classifyTargetStartOutcome({ expected: expectedOf(entry.request, entry.lastReceiptSequence), reply });
        if (!outcome.ok) return outcome;
        entry.outcome = outcome.value.outcome;
        if (outcome.value.outcome === 'committed-or-reconciled') {
            entry.state = outcome.value.receipt.state === 'running' ? 'running' : outcome.value.receipt.state;
            entry.lastReceiptSequence = outcome.value.receipt.receiptSequence;
        } else if (outcome.value.outcome === 'refused-before-create') {
            entry.state = 'not-created';
        } else {
            entry.state = 'unknown';
        }
        return outcome;
    }

    function startFailure(entry, code) {
        if (code === 'outcome_unknown' || code === 'journal_unavailable') return classify(entry, { kind: code });
        // A refusal only proves no create with journal absence evidence for this exact key, binding and journal store:
        // the lookup goes through the same reconciliation as any other receipt.
        const looked = lookup({ key: entry.request.key, targetBindingDigest: entry.request.targetBindingDigest });
        if (!looked.ok) return classify(entry, { kind: 'lookup-failed' });
        const reconciled = reconcileTargetReceipt(expectedOf(entry.request, entry.lastReceiptSequence), looked.value);
        if (!reconciled.ok) {
            if (reconciled.error.code === 'journal_unavailable' || reconciled.error.code === 'absence_unverified') return classify(entry, { kind: 'lookup-failed' });
            return reconciled;
        }
        if (reconciled.value.kind === 'absent') {
            return classify(entry, { kind: 'refused', code, absenceEvidenceDigest: reconciled.value.absenceEvidenceDigest });
        }
        return classify(entry, { kind: 'lookup', result: looked.value });
    }

    // prepare + commit as one worker start. `request` is the prepare request plus `workerCommitDigest`.
    function startExecution(request) {
        const text = keyText(request.key);
        const entry = workerEntries.get(text) ?? { request, state: 'starting', pendingStop: false, stopSettled: false, outcome: null, lastReceiptSequence: 0 };
        workerEntries.set(text, entry);
        entry.state = 'starting';
        const prepared = prepare(request);
        if (!prepared.ok) return startFailure(entry, prepared.error.code);
        entry.lastReceiptSequence = prepared.value.receiptSequence;
        if (prepared.value.gateReleased || entry.pendingStop) {
            // Already released by an earlier attempt whose reply was lost, or a stop is pending: classify the recorded
            // receipt, never release the gate for a stopped start, and deliver the pending stop exactly as a first start.
            const outcome = classify(entry, { kind: 'receipt', receipt: prepared.value });
            if (outcome.ok && entry.pendingStop) sendStop(entry);
            return outcome;
        }
        const committed = commit({
            key: request.key, targetBindingDigest: request.targetBindingDigest, reservationId: request.reservationId,
            preparedReceiptSequence: prepared.value.receiptSequence, preparedResourcesDigest: digestOf(prepared.value.resources, 1 << 20),
            workerCommitDigest: request.workerCommitDigest
        });
        if (!committed.ok) return startFailure(entry, committed.error.code);
        const outcome = classify(entry, { kind: 'receipt', receipt: committed.value });
        if (outcome.ok && entry.pendingStop) sendStop(entry);
        return outcome;
    }

    function sendStop(entry) {
        const stopped = stop({ key: entry.request.key });
        if (stopped.ok) {
            entry.pendingStop = false;
            entry.stopSettled = true;
            entry.state = 'stopping';
            return { stop: 'sent' };
        }
        return { stop: 'pending' };
    }

    // A stop for a start that is still starting or whose outcome is unknown stays pending; it is never answered as
    // "nothing started".
    function requestStop(key) {
        const entry = workerEntries.get(keyText(key));
        if (!entry) return deepFreeze({ stop: 'not_found' });
        if (entry.stopSettled) return deepFreeze({ stop: entry.state === 'not-created' ? 'nothing-to-stop' : 'sent' });
        if (entry.state === 'starting' || entry.state === 'unknown') {
            entry.pendingStop = true;
            return deepFreeze({ stop: 'pending' });
        }
        if (entry.state === 'not-created') {
            entry.stopSettled = true;
            return deepFreeze({ stop: 'nothing-to-stop' });
        }
        return deepFreeze(sendStop(entry));
    }

    // Same-key reconciliation after an unknown start.
    function reconcileStart(key) {
        const entry = workerEntries.get(keyText(key));
        if (!entry) return failure('not_found');
        const looked = lookup({ key: entry.request.key, targetBindingDigest: entry.request.targetBindingDigest });
        if (!looked.ok) return failure(looked.error.code);
        const reconciled = reconcileTargetReceipt(expectedOf(entry.request, entry.lastReceiptSequence), looked.value);
        if (!reconciled.ok) return reconciled;
        if (reconciled.value.kind === 'absent') {
            entry.state = 'not-created';
            if (entry.pendingStop) {
                entry.pendingStop = false;
                entry.stopSettled = true;
            }
            return success({ state: 'not-created', stop: entry.stopSettled ? 'nothing-to-stop' : 'none' });
        }
        entry.lastReceiptSequence = reconciled.value.receipt.receiptSequence;
        entry.state = reconciled.value.state;
        let stopResult = 'none';
        if (entry.pendingStop) stopResult = sendStop(entry).stop;
        return success({ state: entry.state, stop: stopResult });
    }

    function workerEntry(key) {
        const entry = workerEntries.get(keyText(key));
        return entry ? deepFreeze({ state: entry.state, pendingStop: entry.pendingStop, stopSettled: entry.stopSettled, outcome: entry.outcome }) : null;
    }

    return Object.freeze({
        prepare, commit, lookup, input, stop, observeExit, release, retire,
        startExecution, requestStop, reconcileStart, workerEntry,
        inject(fault) {
            if (!FAULTS.has(fault)) throw new TypeError('unknown fault');
            pendingFault = fault;
        },
        // The journal is lost (unreachable, deleted): every operation is journal_unavailable, never absence.
        loseJournal() { journal.available = false; },
        // A new journal store after helper/container recreation: old keys are not found here and old bindings name the
        // old store identity, so nothing is launched against them.
        replaceJournal(nextIdentity) {
            if (!isId(nextIdentity)) throw new TypeError('invalid journal identity');
            journal.storeIdentity = nextIdentity;
            journal.available = true;
            journal.records = new Map();
            journal.tombstones = new Map();
            journal.revision = 0;
        },
        recreateHelper(nextIncarnation) {
            if (!isId(nextIncarnation)) throw new TypeError('invalid helper incarnation');
            incarnation = nextIncarnation;
        },
        effects: () => deepFreeze(effects.map((entry) => ({ ...entry }))),
        size: () => journal.records.size + journal.tombstones.size,
        get journalStoreIdentity() { return journal.storeIdentity; }
    });
}

const LOST = Symbol('lost-reply');
