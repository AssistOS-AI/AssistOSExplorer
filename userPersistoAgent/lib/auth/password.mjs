import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStore, flush } from '../store.mjs';
import { getUserByEmail, getUserById, sanitizeUser } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { clearLoginFailures, isLoginLocked, recordLoginFailure, withLoginAttemptLock } from './login-attempts.mjs';
import { credentialVersion } from './credentialVersion.mjs';

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;

export function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 1024) {
        throw Object.assign(new Error('Password must contain between 8 and 1024 characters.'), {
            code: 'invalid_password',
            statusCode: 400,
        });
    }
}

export function hashPassword(password) {
    validatePassword(password);
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, KEYLEN, { N, r, p });
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
    if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) {
        return false;
    }
    try {
        const [, n, rr, pp, saltB64, hashB64] = stored.split('$');
        const salt = Buffer.from(saltB64, 'base64url');
        const expected = Buffer.from(hashB64, 'base64url');
        if (Number(n) !== N || Number(rr) !== r || Number(pp) !== p || salt.length !== 16 || expected.length !== KEYLEN) return false;
        const actual = scryptSync(String(password ?? ''), salt, KEYLEN, { N, r, p });
        return expected.length > 0 && timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString('base64url'));

export function loginWithPassword(email, password, { includeCredentialProof = false } = {}) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return withLoginAttemptLock(normalizedEmail, async () => {
        const user = await getUserByEmail(normalizedEmail);
        const valid = verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
        if (!user) return { ok: false, reason: 'invalid_credentials' };
        if (user.status !== 'active') return { ok: false, reason: 'user_blocked' };
        if (isLoginLocked(user)) return { ok: false, reason: 'account_locked' };
        if (!user.passwordHash || !valid) {
            await recordLoginFailure(user);
            await recordAudit({ actorId: user.id, action: 'auth.password.login', target: user.id, result: 'denied', reason: 'invalid_credentials' });
            return { ok: false, reason: 'invalid_credentials' };
        }
        const version = includeCredentialProof ? credentialVersion('password', user.passwordHash) : undefined;
        const fresh = await clearLoginFailures(user);
        await recordAudit({ actorId: user.id, action: 'auth.password.login', target: user.id, result: 'ok' });
        return { ok: true, user: sanitizeUser(fresh), ...(includeCredentialProof ? { credentialVersion: version } : {}) };
    });
}

export async function setPassword({ userId, newPassword, actorId }) {
    const user = await getUserById(userId);
    if (!user) {
        throw Object.assign(new Error('User not found.'), { code: 'user_not_found', statusCode: 404 });
    }
    await withLoginAttemptLock(user.email, async () => {
        const store = await getStore();
        await store.updateUser(user.id, {
            passwordHash: hashPassword(newPassword),
            loginAttempts: 0,
            lastLoginAttempt: ''
        });
        await flush();
    });
    await recordAudit({ actorId: actorId || userId, action: 'auth.password.set', target: userId, result: 'ok' });
}
