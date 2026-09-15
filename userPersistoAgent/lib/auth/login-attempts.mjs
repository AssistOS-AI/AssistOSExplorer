import { getStore, flush } from '../store.mjs';
import { serialize } from '../serial.mjs';

const MAX_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 5 * 60 * 1000;

export function withLoginAttemptLock(email, task) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return serialize(`auth-login:${normalizedEmail}`, task);
}

export function isLoginLocked(user) {
    if ((user?.loginAttempts || 0) < MAX_ATTEMPTS) return false;
    const lastAttempt = user?.lastLoginAttempt ? new Date(user.lastLoginAttempt).getTime() : 0;
    return Number.isFinite(lastAttempt) && Date.now() - lastAttempt < LOCK_WINDOW_MS;
}

export async function recordLoginFailure(user) {
    const store = await getStore();
    const updated = await store.updateUser(user.id, {
        loginAttempts: (user.loginAttempts || 0) + 1,
        lastLoginAttempt: new Date().toISOString(),
    });
    await flush();
    return updated;
}

export async function clearLoginFailures(user) {
    const store = await getStore();
    const updated = await store.updateUser(user.id, { loginAttempts: 0, lastLoginAttempt: '' });
    await flush();
    return updated;
}
