import { createHash } from 'node:crypto';

// Durable failure budgets stored as `authThrottle` records, shared by bound
// email codes and account passwords. A key digests its purpose and normalized
// subject; each caller owns its window and limit. Callers hold the persistence
// scope and stage writes inside their own commit. Expired records are removed
// by the bounded sweep in emailAttempts.mjs.
export function throttleKey(purpose, subject) {
    return createHash('sha256').update(JSON.stringify([purpose, subject])).digest('hex');
}

// A missing, expired or future-dated window counts from zero at `now`.
export async function readThrottle(store, key, now, windowMs) {
    const record = await store.getAuthThrottleByThrottleKey(key);
    const live = record && Number.isSafeInteger(record.windowStartedAt) && now - record.windowStartedAt < windowMs
        && record.windowStartedAt <= now;
    return { key, record, windowMs, count: live ? record.count : 0, windowStartedAt: live ? record.windowStartedAt : now };
}

export function throttleRetryAfter(throttle, now) {
    return Math.max(1, Math.ceil((throttle.windowStartedAt + throttle.windowMs - now) / 1000));
}

// Returns a staging function for the caller's commitStagedPersistence.
export function stageThrottleFailure(store, throttle) {
    const data = { throttleKey: throttle.key, windowStartedAt: throttle.windowStartedAt, count: throttle.count + 1,
        expiresAt: throttle.windowStartedAt + throttle.windowMs };
    return async () => {
        if (throttle.record) await store.updateAuthThrottle(throttle.record.id, data);
        else await store.createAuthThrottle(data);
    };
}

export function stageThrottleClear(store, throttle) {
    return async () => {
        if (throttle.record) await store.deleteAuthThrottle(throttle.record.id);
    };
}
