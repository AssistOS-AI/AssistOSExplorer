import {
    RECEIPT_BYTES, canonicalText, deepFreeze, failure, isCounter, isDigest, isId, isU64Text, success, validateStartOutcome, validateTargetReceipt
} from './contract.mjs';

// Exact target-receipt reconciliation and the three-way start classification (T0 base §9).
//
// Only `refused-before-create` proves that nothing was created, and only with journal absence evidence. A transport
// timeout, lost reply, helper disappearance, an unauthenticated refusal or an unknown/unreachable/missing journal is
// `outcome-unknown`: blockers stay, a pending stop stays pending, and nothing is retried as fresh work. A lookup error is
// never absence.

export const RECEIPT_ERROR_CODES = Object.freeze([
    'invalid_request', 'binding_mismatch', 'operation_conflict', 'journal_unavailable', 'receipt_regressed', 'absence_unverified',
    'state_corrupt'
]);

class Refusal {
    constructor(code) { this.code = code; }
}

function need(condition, code) {
    if (!condition) throw new Refusal(code);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function run(check) {
    try {
        return check();
    } catch (error) {
        return failure(error instanceof Refusal ? error.code : 'invalid_request');
    }
}

function sameKey(left, right) {
    try {
        return canonicalText(left) === canonicalText(right);
    } catch {
        return false;
    }
}

function checkExpected(expected) {
    need(isPlainObject(expected), 'invalid_request');
    need(isDigest(expected.targetBindingDigest) && isDigest(expected.requestDigest) && isId(expected.reservationId)
        && isId(expected.journalStoreIdentity) && isId(expected.leaseId) && isCounter(expected.lastReceiptSequence), 'invalid_request');
}

function checkReceipt(expected, raw) {
    const result = validateTargetReceipt(raw);
    need(result.ok, 'state_corrupt');
    const receipt = result.value;
    need(sameKey(receipt.key, expected.key), 'operation_conflict');
    need(receipt.requestDigest === expected.requestDigest && receipt.reservationId === expected.reservationId
        && receipt.leaseId === expected.leaseId, 'operation_conflict');
    need(receipt.targetBindingDigest === expected.targetBindingDigest, 'binding_mismatch');
    // A receipt from a replaced or recreated journal store is not this operation's journal.
    need(receipt.journalStoreIdentity === expected.journalStoreIdentity, 'journal_unavailable');
    need(receipt.receiptSequence >= expected.lastReceiptSequence, 'receipt_regressed');
    return receipt;
}

function summary(receipt) {
    const resourcesSettled = receipt.resources.every((entry) => entry.state === 'released' || entry.state === 'quarantined');
    const quarantined = receipt.state === 'quarantined' || receipt.resources.some((entry) => entry.state === 'quarantined');
    return {
        kind: 'receipt', state: receipt.state, receipt,
        settled: (receipt.state === 'exited' || receipt.state === 'quarantined') && resourcesSettled,
        quarantined,
        // Quarantine is not absence.
        absent: false
    };
}

// `expected`: {key, targetBindingDigest, reservationId, requestDigest, journalStoreIdentity, leaseId, lastReceiptSequence}.
// `observed`: a lookup success value ({state: 'absent-with-proof', ...} or {state, receipt}). Anything else, including
// an error, null or an unreachable journal, is absence_unverified: blockers are retained.
export function reconcileTargetReceipt(expected, observed) {
    return run(() => {
        checkExpected(expected);
        need(isPlainObject(observed) && typeof observed.state === 'string', 'absence_unverified');
        if (observed.state === 'absent-with-proof') {
            const keys = ['state', 'key', 'targetBindingDigest', 'journalStoreIdentity', 'journalRevision', 'absenceEvidenceDigest'];
            need(Object.keys(observed).length === keys.length && keys.every((key) => Object.hasOwn(observed, key)), 'absence_unverified');
            need(sameKey(observed.key, expected.key), 'operation_conflict');
            need(observed.targetBindingDigest === expected.targetBindingDigest, 'binding_mismatch');
            need(observed.journalStoreIdentity === expected.journalStoreIdentity, 'journal_unavailable');
            need(isU64Text(observed.journalRevision) && isDigest(observed.absenceEvidenceDigest), 'absence_unverified');
            return success({ kind: 'absent', absent: true, settled: true, quarantined: false, absenceEvidenceDigest: observed.absenceEvidenceDigest });
        }
        need(Object.keys(observed).length === 2 && Object.hasOwn(observed, 'receipt'), 'absence_unverified');
        const receipt = checkReceipt(expected, observed.receipt);
        need(receipt.state === observed.state, 'state_corrupt');
        return success(summary(receipt));
    });
}

// Three-way start classification. `reply` is what the worker actually observed:
//   {kind: 'refused', code, absenceEvidenceDigest}  an authenticated pre-create refusal with journal absence evidence
//   {kind: 'receipt', receipt}                      an authenticated receipt
//   {kind: 'lookup', result}                        a later same-key lookup success value
//   anything else (timeout, lost reply, helper gone, transport error, missing evidence) → outcome-unknown
export function classifyTargetStartOutcome({ expected, reply } = {}) {
    return run(() => {
        checkExpected(expected);
        const base = { version: 1, key: expected.key, requestDigest: expected.requestDigest };
        const unknown = () => ({ ...base, outcome: 'outcome-unknown', reservationId: expected.reservationId, lastReceiptSequence: expected.lastReceiptSequence });
        let outcome = unknown();
        if (isPlainObject(reply) && reply.kind === 'refused' && isDigest(reply.absenceEvidenceDigest) && typeof reply.code === 'string') {
            outcome = { ...base, outcome: 'refused-before-create', code: reply.code, absenceEvidenceDigest: reply.absenceEvidenceDigest };
        } else if (isPlainObject(reply) && reply.kind === 'receipt') {
            const receipt = checkReceipt(expected, reply.receipt);
            outcome = { ...base, outcome: 'committed-or-reconciled', receipt };
        } else if (isPlainObject(reply) && reply.kind === 'lookup') {
            const reconciled = reconcileTargetReceipt(expected, reply.result);
            if (reconciled.ok && reconciled.value.kind === 'absent') {
                outcome = { ...base, outcome: 'refused-before-create', code: 'not_created', absenceEvidenceDigest: reconciled.value.absenceEvidenceDigest };
            } else if (reconciled.ok) {
                outcome = { ...base, outcome: 'committed-or-reconciled', receipt: reconciled.value.receipt };
            } else if (reconciled.error.code !== 'absence_unverified') {
                need(false, reconciled.error.code);
            }
        }
        const validated = validateStartOutcome(deepFreeze(JSON.parse(canonicalText(outcome, RECEIPT_BYTES))));
        need(validated.ok, 'state_corrupt');
        return validated;
    });
}
