import { createHash, randomUUID } from 'node:crypto';
import { getStore, flush } from './store.mjs';
import { recordAudit } from './audit.mjs';
import { serializePersisted as serialize } from './serial.mjs';

const CREDIT_TYPES = new Set(['grant', 'purchase', 'spend', 'reserve', 'release', 'refund', 'adminAdjustment']);

function assertAmount(amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw Object.assign(new Error('Amount must be a positive safe integer.'), { code: 'invalid_amount', statusCode: 400 });
    }
}

function requireUserId(userId) {
    const normalized = String(userId || '').trim();
    if (!normalized) throw Object.assign(new Error('userId is required.'), { code: 'user_id_required', statusCode: 400 });
    return normalized;
}

function requireReference(referenceId, type) {
    const normalized = String(referenceId || '').trim();
    if (!normalized) throw Object.assign(new Error(`${type} requires a stable referenceId.`), { code: 'reference_id_required', statusCode: 400 });
    if (normalized.length > 256) throw Object.assign(new Error('referenceId is too long.'), { code: 'invalid_reference_id', statusCode: 400 });
    return normalized;
}

function transactionId({ userId, type, referenceId }) {
    if (!referenceId) return randomUUID();
    return createHash('sha256').update(`v1\0${userId}\0${type}\0${referenceId}`).digest('base64url');
}

function normalizeWindow({ start = 0, pageSize = 100 } = {}) {
    return {
        start: Number.isInteger(start) && start >= 0 ? start : 0,
        pageSize: Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 500) : 100,
    };
}

async function allTransactions(store, userId) {
    const entries = [];
    const pageSize = 500;
    let start = 0;
    while (true) {
        const result = await store.select('creditTx', { userId }, { start, pageSize });
        const objects = result.objects || [];
        entries.push(...objects);
        start += objects.length;
        const totalCount = Number(result.filteredCount ?? result.totalCount);
        if (!objects.length || (Number.isFinite(totalCount) && start >= totalCount) || objects.length < pageSize) break;
    }
    return entries.sort((left, right) => (
        Number(left.sequence || 0) - Number(right.sequence || 0)
        || String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
        || String(left.txId || '').localeCompare(String(right.txId || ''))
    ));
}

function replay(entries) {
    let balance = 0;
    let reservedBalance = 0;
    for (const entry of entries) {
        const amount = Number(entry.amount || 0);
        if (['grant', 'purchase', 'refund', 'adminAdjustment'].includes(entry.type)) balance += amount;
        if (entry.type === 'reserve') {
            balance -= amount;
            reservedBalance += amount;
        }
        if (entry.type === 'spend') reservedBalance -= amount;
        if (entry.type === 'release') {
            balance += amount;
            reservedBalance -= amount;
        }
        if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(reservedBalance) || balance < 0 || reservedBalance < 0) {
            throw Object.assign(new Error(`Credit ledger invariant failed at transaction ${entry.txId}.`), { code: 'ledger_invariant_failed', statusCode: 500 });
        }
    }
    return { balance, reservedBalance };
}

async function reconcileAccount(store, userId, entries = null) {
    const history = entries || await allTransactions(store, userId);
    const expected = replay(history);
    const account = await store.getCreditAccountByUserId(userId);
    if (!account) {
        await store.createCreditAccount({ userId, ...expected });
    } else if (Number(account.balance || 0) !== expected.balance || Number(account.reservedBalance || 0) !== expected.reservedBalance) {
        await store.updateCreditAccount(account.id, expected);
    }
    return expected;
}

function reservationId(userId, referenceId) {
    return createHash('sha256').update(`reservation-v2\0${userId}\0${referenceId}`).digest('base64url');
}

async function reconcileReservation(store, userId, referenceId, history) {
    const lifecycle = history.filter((entry) => entry.referenceId === referenceId && ['reserve', 'spend', 'release'].includes(entry.type));
    const opening = lifecycle.find((entry) => entry.type === 'reserve');
    const terminal = lifecycle.filter((entry) => entry.type !== 'reserve');
    if (terminal.length > 1 || (terminal.length && (!opening || terminal[0].amount !== opening.amount))) {
        throw Object.assign(new Error('Reservation ledger is inconsistent.'), { code: 'ledger_invariant_failed', statusCode: 500 });
    }
    const scopedId = reservationId(userId, referenceId);
    let record = await store.getCreditReservationByReservationId(scopedId);
    if (!record) {
        const legacy = await store.getCreditReservationByReservationId(referenceId);
        // Legacy references were global. Another user's projection must never
        // hide this user's journal or prevent its stranded reserve being repaired.
        if (legacy?.userId === userId) record = legacy;
    }
    if (!opening) return record;
    const status = terminal[0]?.type === 'spend' ? 'committed' : terminal[0]?.type === 'release' ? 'released' : 'reserved';
    const projection = {
        userId, referenceId, amount: opening.amount, status,
        reason: opening.reason, createdAt: opening.createdAt,
        updatedAt: terminal[0]?.createdAt || opening.createdAt,
    };
    if (!record) return store.createCreditReservation({ reservationId: scopedId, ...projection });
    if (record.userId !== userId) throw Object.assign(new Error('Reservation owner mismatch.'), { code: 'ledger_invariant_failed', statusCode: 500 });
    if (record.status !== status || record.amount !== opening.amount) {
        return store.updateCreditReservation(record.id, projection);
    }
    return record;
}

async function mutate({
    userId,
    type,
    amount,
    reason = '',
    referenceId = '',
    actorId = '',
    requireStableReference = false,
    reservationTransition = '',
}) {
    const normalizedUserId = requireUserId(userId);
    assertAmount(amount);
    if (!CREDIT_TYPES.has(type)) throw new Error(`Unknown credit transaction type: ${type}`);
    const normalizedReference = requireStableReference ? requireReference(referenceId, type) : String(referenceId || '').trim();
    const txId = transactionId({ userId: normalizedUserId, type, referenceId: normalizedReference });

    return serialize(`credits:${normalizedUserId}`, async () => {
        const store = await getStore();
        const duplicate = await store.getCreditTxByTxId(txId);
        if (duplicate) {
            if (Number(duplicate.amount) !== amount
                || String(duplicate.userId) !== normalizedUserId
                || String(duplicate.referenceId || '') !== normalizedReference) {
                throw Object.assign(new Error('The idempotency reference was already used with different transaction data.'), {
                    code: 'idempotency_conflict',
                    statusCode: 409,
                });
            }
            const history = await allTransactions(store, normalizedUserId);
            const reconciled = await reconcileAccount(store, normalizedUserId, history);
            if (reservationTransition) {
                await reconcileReservation(store, normalizedUserId, normalizedReference, history);
            }
            await flush();
            return {
                ...reconciled,
                txId,
                idempotent: true,
            };
        }

        if (!(await store.hasUser(normalizedUserId))) {
            throw Object.assign(new Error('User not found.'), { code: 'user_not_found', statusCode: 404 });
        }
        const history = await allTransactions(store, normalizedUserId);
        const current = await reconcileAccount(store, normalizedUserId, history);
        let next = { ...current };
        if (['grant', 'purchase', 'refund', 'adminAdjustment'].includes(type)) next.balance += amount;
        if (type === 'reserve') {
            next.balance -= amount;
            next.reservedBalance += amount;
        }
        if (type === 'spend') next.reservedBalance -= amount;
        if (type === 'release') {
            next.balance += amount;
            next.reservedBalance -= amount;
        }
        if (!Number.isSafeInteger(next.balance) || !Number.isSafeInteger(next.reservedBalance) || next.balance < 0 || next.reservedBalance < 0) {
            throw Object.assign(new Error(`Insufficient credits for ${type} of ${amount}.`), { code: 'insufficient_credits', statusCode: 409 });
        }

        let reservationRecord = null;
        if (reservationTransition) {
            reservationRecord = await reconcileReservation(store, normalizedUserId, normalizedReference, history);
            if (reservationTransition === 'reserved') {
                if (reservationRecord) throw Object.assign(new Error('Reservation reference is already in use.'), { code: 'reservation_conflict', statusCode: 409 });
            } else {
                if (!reservationRecord || reservationRecord.userId !== normalizedUserId || reservationRecord.amount !== amount) {
                    throw Object.assign(new Error('Reservation does not match this user and amount.'), { code: 'reservation_mismatch', statusCode: 409 });
                }
                if (reservationRecord.status !== 'reserved') {
                    throw Object.assign(new Error(`Reservation is already ${reservationRecord.status}.`), { code: 'reservation_closed', statusCode: 409 });
                }
            }
        }

        const timestamp = new Date().toISOString();
        await store.createCreditTx({
            txId,
            userId: normalizedUserId,
            sequence: history.length + 1,
            type,
            amount,
            reason: String(reason || ''),
            referenceId: normalizedReference,
            balanceAfter: next.balance,
            reservedAfter: next.reservedBalance,
            createdAt: timestamp,
        });
        if (reservationTransition === 'reserved') {
            await store.createCreditReservation({
                reservationId: reservationId(normalizedUserId, normalizedReference),
                referenceId: normalizedReference,
                userId: normalizedUserId,
                amount,
                status: 'reserved',
                reason: String(reason || ''),
                createdAt: timestamp,
                updatedAt: timestamp,
            });
        } else if (reservationTransition) {
            await store.updateCreditReservation(reservationRecord.id, {
                status: reservationTransition,
                updatedAt: timestamp,
            });
        }
        const account = await store.getCreditAccountByUserId(normalizedUserId);
        if (account) await store.updateCreditAccount(account.id, next);
        else await store.createCreditAccount({ userId: normalizedUserId, ...next });
        await flush();

        await recordAudit({
            actorId: actorId || normalizedUserId,
            action: `credits.${type}`,
            target: normalizedUserId,
            reason: normalizedReference || reason || '',
        });
        await flush();
        return { ...next, txId, idempotent: false };
    });
}

export function getBalance(userId) {
    const normalizedUserId = requireUserId(userId);
    return serialize(`credits:${normalizedUserId}`, async () => {
        const store = await getStore();
        if (!(await store.hasUser(normalizedUserId))) {
            throw Object.assign(new Error('User not found.'), { code: 'user_not_found', statusCode: 404 });
        }
        const balance = await reconcileAccount(store, normalizedUserId);
        await flush();
        return balance;
    });
}

export function grant({ userId, amount, reason = '', referenceId = '', actorId = 'system' }) {
    return mutate({ userId, type: 'grant', amount, reason, referenceId, actorId, requireStableReference: true });
}

export function applyPurchase({ userId, amount, referenceId }) {
    return mutate({ userId, type: 'purchase', amount, referenceId, actorId: 'stripe', requireStableReference: true });
}

export function reserve({ userId, amount, reason = '', referenceId }) {
    return mutate({ userId, type: 'reserve', amount, reason, referenceId, requireStableReference: true, reservationTransition: 'reserved' });
}

export function commit({ userId, amount, referenceId }) {
    return mutate({ userId, type: 'spend', amount, referenceId, requireStableReference: true, reservationTransition: 'committed' });
}

export function release({ userId, amount, referenceId }) {
    return mutate({ userId, type: 'release', amount, referenceId, requireStableReference: true, reservationTransition: 'released' });
}

export function refund({ userId, amount, reason = '', referenceId, actorId = 'system' }) {
    return mutate({ userId, type: 'refund', amount, reason, referenceId, actorId, requireStableReference: true });
}

export function adminAdjust({ userId, amount, reason = '', referenceId = '', actorId = 'system' }) {
    return mutate({ userId, type: 'adminAdjustment', amount, reason, referenceId, actorId, requireStableReference: true });
}

export async function ledger({ userId, start = 0, pageSize = 100 } = {}) {
    const normalizedUserId = requireUserId(userId);
    const store = await getStore();
    if (!(await store.hasUser(normalizedUserId))) {
        throw Object.assign(new Error('User not found.'), { code: 'user_not_found', statusCode: 404 });
    }
    const window = normalizeWindow({ start, pageSize });
    const result = await store.select('creditTx', { userId: normalizedUserId }, {
        sortBy: 'sequence',
        descending: true,
        ...window,
    });
    return {
        entries: result.objects,
        totalCount: result.filteredCount ?? result.totalCount ?? result.objects.length,
    };
}
