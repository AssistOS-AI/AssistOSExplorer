import { createHash, randomUUID } from 'node:crypto';
import { getStore, flush } from './store.mjs';
import { replayCreditLots } from './credit-expiry.mjs';
import { recordAudit } from './audit.mjs';
import { serializePersisted as serialize } from './serial.mjs';

const CREDIT_TYPES = new Set(['grant', 'purchase', 'spend', 'reserve', 'release', 'refund', 'adminAdjustment', 'expire']);

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
        if (entry.type === 'expire') balance -= amount;
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
    return { balance: expected.balance, reservedBalance: expected.reservedBalance };
}

async function expireCredits(store, userId, history, date = new Date()) {
    if (!history.some(entry => entry.expiresAt)) return history;
    const { balance, reservedBalance } = replay(history);
    let remainingBalance = balance;
    const lots = replayCreditLots(history);
    for (const lot of lots) {
        if (!lot.remaining || lot.deadline > date.getTime()) continue;
        remainingBalance -= lot.remaining;
        const sequence = history.length + 1;
        const referenceId = `expire:${lot.id}:${sequence}`;
        const entry = {
            userId, type: 'expire', amount: lot.remaining, expiredLotId: lot.id,
            reason: 'Contribution points expired', referenceId, sequence,
            txId: transactionId({ userId, type: 'expire', referenceId }),
            balanceAfter: remainingBalance, reservedAfter: reservedBalance, createdAt: date.toISOString(),
        };
        await store.createCreditTx(entry);
        history.push(entry);
    }
    return history;
}

export function inspectCreditExpiry(userId, referenceId) {
    const normalizedUserId = requireUserId(userId);
    return serialize(`credits:${normalizedUserId}`, async () => {
        const store = await getStore();
        if (!(await store.hasUser(normalizedUserId))) return {remaining:0};
        const history = await expireCredits(store, normalizedUserId, await allTransactions(store, normalizedUserId));
        const lot = replayCreditLots(history).find(item => item.referenceId === referenceId);
        await reconcileAccount(store, normalizedUserId, history);
        await flush();
        return { remaining: lot?.remaining || 0 };
    });
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
    const record = await store.getCreditReservationByReservationId(scopedId);

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
    expiresAt = '',
    restoresSpend = false,
}) {
    const normalizedUserId = requireUserId(userId);
    assertAmount(amount);
    if (expiresAt && (type !== 'grant' || !Number.isFinite(Date.parse(expiresAt)))) {
        throw Object.assign(new Error('Invalid credit expiration.'), { code: 'invalid_credit_expiration', statusCode: 400 });
    }
    if (!CREDIT_TYPES.has(type)) throw new Error(`Unknown credit transaction type: ${type}`);
    const normalizedReference = requireStableReference ? requireReference(referenceId, type) : String(referenceId || '').trim();
    const txId = transactionId({ userId: normalizedUserId, type, referenceId: normalizedReference });

    return serialize(`credits:${normalizedUserId}`, async () => {
        const store = await getStore();
        const duplicate = await store.getCreditTxByTxId(txId);
        if (duplicate) {
            if (Number(duplicate.amount) !== amount
                || String(duplicate.userId) !== normalizedUserId
                || String(duplicate.referenceId || '') !== normalizedReference
                || String(duplicate.expiresAt || '') !== expiresAt
                || (duplicate.restoresSpend === 'yes') !== restoresSpend) {
                throw Object.assign(new Error('The idempotency reference was already used with different transaction data.'), {
                    code: 'idempotency_conflict',
                    statusCode: 409,
                });
            }
            const history = await expireCredits(store, normalizedUserId, await allTransactions(store, normalizedUserId));
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
        const history = await expireCredits(store, normalizedUserId, await allTransactions(store, normalizedUserId));
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
            await flush();
            throw Object.assign(new Error(`Insufficient credits for ${type} of ${amount}.`), { code: 'insufficient_credits', statusCode: 409, available: current.balance });
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
        const entry = {
            txId,
            userId: normalizedUserId,
            sequence: history.length + 1,
            type,
            amount,
            reason: String(reason || reservationRecord?.reason || ''),
            referenceId: normalizedReference,
            ...(expiresAt ? { expiresAt } : {}),
            ...(restoresSpend ? { restoresSpend: 'yes' } : {}),
            balanceAfter: next.balance,
            reservedAfter: next.reservedBalance,
            createdAt: timestamp,
        };
        await store.createCreditTx(entry);
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
        history.push(entry);
        const updated = await expireCredits(store, normalizedUserId, history);
        const balance = await reconcileAccount(store, normalizedUserId, updated);
        await flush();

        await recordAudit({
            actorId: actorId || normalizedUserId,
            action: `credits.${type}`,
            target: normalizedUserId,
            reason: normalizedReference || reason || '',
        });
        await flush();
        return { ...balance, txId, idempotent: false };
    });
}

export function getBalance(userId, {includeExpiring = false} = {}) {
    const normalizedUserId = requireUserId(userId);
    return serialize(`credits:${normalizedUserId}`, async () => {
        const store = await getStore();
        if (!(await store.hasUser(normalizedUserId))) {
            throw Object.assign(new Error('User not found.'), { code: 'user_not_found', statusCode: 404 });
        }
        const history = await expireCredits(store, normalizedUserId, await allTransactions(store, normalizedUserId));
        const balance = await reconcileAccount(store, normalizedUserId, history);
        await flush();
        if (!includeExpiring) return balance;
        const expiring = replayCreditLots(history).filter(lot => lot.remaining && Number.isFinite(lot.deadline))
            .sort((left,right) => left.deadline - right.deadline)
            .map(lot => ({ amount: lot.remaining, expiresAt: new Date(lot.deadline).toISOString() }));
        return { ...balance, expiring };
    });
}

export function grant({ userId, amount, reason = '', referenceId = '', actorId = 'system', expiresAt = '' }) {
    return mutate({ userId, type: 'grant', amount, reason, referenceId, actorId, expiresAt, requireStableReference: true });
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

export async function refundSpend({ userId, amount, reason, referenceId, actorId }) {
    const store = await getStore();
    const spend = await store.getCreditTxByTxId(transactionId({ userId, type: 'spend', referenceId }));
    if (!spend || spend.amount !== amount) {
        throw Object.assign(new Error('A matching debit is required.'), { code: 'spend_mismatch', statusCode: 409 });
    }
    return mutate({ userId, type: 'refund', amount, reason, referenceId, actorId, restoresSpend: true, requireStableReference: true });
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
