import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// Hashing helpers for the deployment-configured administrator password. Ordinary
// accounts are passwordless: there is no password registration, setter or login.
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
