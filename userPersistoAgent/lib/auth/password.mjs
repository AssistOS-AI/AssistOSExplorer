import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Asynchronous key derivation for account passwords. Exactly one scrypt profile
// is supported: a stored verifier must parse to it or it fails closed. Callers
// pass a secret already normalized by userPassword.mjs and never hash inside
// the persistence scope or the users lock. A bounded gate caps concurrent and
// queued work; a saturated gate refuses with `rate_limited` and is never a
// failed guess.
const PROFILE = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_ACTIVE = 2;
const MAX_QUEUED = 16;
const QUEUE_WAIT_MS = 5_000;
const VERIFIER = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

let profile = PROFILE;
let observer = null;
let dummy = null;
let active = 0;
const waiting = [];

function saturated() {
    return Object.assign(new Error('Too many requests. Wait and try again.'), { code: 'rate_limited', statusCode: 429, retryAfter: 5 });
}

function acquire() {
    if (active < MAX_ACTIVE) {
        active += 1;
        return Promise.resolve();
    }
    if (waiting.length >= MAX_QUEUED) return Promise.reject(saturated());
    return new Promise((resolve, reject) => {
        const entry = {
            resolve,
            timer: setTimeout(() => {
                const index = waiting.indexOf(entry);
                if (index >= 0) waiting.splice(index, 1);
                reject(saturated());
            }, QUEUE_WAIT_MS),
        };
        waiting.push(entry);
    });
}

// A finished evaluation hands its slot directly to the oldest waiter.
function release() {
    const next = waiting.shift();
    if (next) {
        clearTimeout(next.timer);
        next.resolve();
        return;
    }
    active -= 1;
}

function derive(secret, salt, { N, r, p, maxmem }) {
    return new Promise((resolve, reject) => {
        scrypt(secret, salt, KEY_BYTES, { N, r, p, maxmem }, (error, key) => (error ? reject(error) : resolve(key)));
    });
}

async function gated(secret, salt, purpose, validateAdmission) {
    await acquire();
    try {
        // State may change while this request waits for a global KDF slot.
        // Callers revalidate here, outside their persistence and users locks.
        if (validateAdmission) await validateAdmission();
        const selected = profile;
        if (observer) await observer({ purpose, profile: selected });
        return await derive(secret, salt, selected);
    } finally {
        release();
    }
}

// Returns `{ salt, hash }` only for the supported profile with exact lengths.
export function parseVerifier(stored) {
    const match = typeof stored === 'string' ? VERIFIER.exec(stored) : null;
    if (!match) return null;
    const [, n, r, p, saltText, hashText] = match;
    if (n !== String(profile.N) || r !== String(profile.r) || p !== String(profile.p)) return null;
    const salt = Buffer.from(saltText, 'base64url');
    const hash = Buffer.from(hashText, 'base64url');
    if (salt.length !== SALT_BYTES || hash.length !== KEY_BYTES
        || salt.toString('base64url') !== saltText || hash.toString('base64url') !== hashText) return null;
    return { salt, hash };
}

export async function hashSecret(secret, { validateAdmission } = {}) {
    const salt = randomBytes(SALT_BYTES);
    const key = await gated(secret, salt, 'hash', validateAdmission);
    return `scrypt$${profile.N}$${profile.r}$${profile.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

// Always runs one evaluation. An absent or unsupported verifier is compared
// with a process-wide dummy, so the work does not reveal which case applied.
export async function verifySecret(secret, stored, { validateAdmission } = {}) {
    const parsed = parseVerifier(stored);
    dummy ||= { salt: randomBytes(SALT_BYTES), hash: randomBytes(KEY_BYTES) };
    const target = parsed || dummy;
    const key = await gated(secret, target.salt, 'verify', validateAdmission);
    return timingSafeEqual(key, target.hash) && Boolean(parsed);
}

// Test seams in the style of setStoreFaultInjectorForTests. No request or
// environment variable reaches them. An observer may return a promise to hold
// an evaluation inside the gate.
export function setKdfProfileForTests({ N, r, p, maxmem = PROFILE.maxmem }) {
    profile = Object.freeze({ N, r, p, maxmem });
}

export function setKdfObserverForTests(callback = null) {
    observer = callback;
}

export function resetKdfForTests() {
    profile = PROFILE;
    observer = null;
    dummy = null;
}

export const SUPPORTED_KDF_PROFILE = PROFILE;
