import crypto from 'node:crypto';
import { credentialVersion } from './credentialVersion.mjs';
import { getStore, flush, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { authGenerationOf, getUserByEmail, getUserById, sanitizeUser } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { stageCredentialGenerationAdvance } from './generation.mjs';
import { clearLoginFailures, isLoginLocked, recordLoginFailure, withLoginAttemptLock } from './login-attempts.mjs';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const SETUP_TTL_MS = 2 * 60 * 1000;
const MAX_SETUP_ATTEMPTS = 5;

function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
}

function base32Decode(secret) {
    const clean = String(secret || '').replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of clean) {
        const index = BASE32_ALPHABET.indexOf(char);
        if (index < 0) {
            throw new Error('Invalid TOTP secret.');
        }
        value = (value << 5) | index;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function settingsKey() {
    const key = String(process.env.USERPERSISTO_SETTINGS_KEY || process.env.USERPERSISTO_SETTINGS_SECRET || '').trim();
    if (!key) {
        throw new Error('USERPERSISTO_SETTINGS_KEY is required for TOTP secrets.');
    }
    return crypto.createHash('sha256').update(key).digest();
}

function encryptSecret(secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', settingsKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptSecret(value) {
    const parts = String(value || '').split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
        return String(value || '');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', settingsKey(), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(parts[3], 'base64url')),
        decipher.final()
    ]).toString('utf8');
}

function hotp(secret, counter) {
    const key = base32Decode(secret);
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const code = (
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff)
    ) % (10 ** DIGITS);
    return String(code).padStart(DIGITS, '0');
}

function counterFor(time = Date.now()) {
    return Math.floor(time / 1000 / PERIOD_SECONDS);
}

function matchingCounter(secret, token, at = Date.now()) {
    const value = String(token || '').trim();
    if (!/^\d{6}$/.test(value)) {
        return null;
    }
    const counter = counterFor(at);
    for (let offset = -WINDOW; offset <= WINDOW; offset += 1) {
        const candidate = counter + offset;
        if (generateToken(secret, candidate) === value) return candidate;
    }
    return null;
}

function methodKey(userId) {
    return `${userId}:totp`;
}

function setupChallengeId(userId) {
    return `totp-setup:${userId}`;
}

function setupMetadata(challenge) {
    try {
        const value = JSON.parse(challenge?.correlationId || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

async function stageTotpMethod(store, { userId, secretEncrypted }) {
    const key = methodKey(userId);
    const payload = {
        userId,
        type: 'totp',
        credential: {
            secretEncrypted,
            algorithm: 'SHA1',
            digits: DIGITS,
            periodSeconds: PERIOD_SECONDS,
            enabledAt: new Date().toISOString()
        },
        enabled: true
    };
    const existing = await store.getAuthMethodByKey(key);
    if (existing) {
        return store.updateAuthMethod(existing.id, payload);
    }
    return store.createAuthMethod({ key, ...payload });
}

export function generateToken(secret, counter = counterFor()) {
    return hotp(secret, counter);
}

// Stages a new secret without touching the current credential, which stays
// usable until setupVerify replaces it. A newer start supersedes older setups.
// The caller has consumed an operation grant bound to `generation`.
export function setupStart({ userId, generation }) {
    return serializePersisted('users', async () => {
        const user = await getUserById(userId);
        if (!user || user.status !== 'active') {
            throw Object.assign(new Error('Account is not active.'), { code: 'user_not_active', statusCode: 403 });
        }
        const store = await getStore();
        const secret = base32Encode(crypto.randomBytes(20));
        const setupId = crypto.randomBytes(16).toString('base64url');
        const payload = {
            subject: user.id,
            purpose: 'totp-setup',
            codeHash: encryptSecret(secret),
            expiresAt: new Date(Date.now() + SETUP_TTL_MS).toISOString(),
            attempts: 0,
            correlationId: JSON.stringify({ setupId, generation: Number.isSafeInteger(generation) ? generation : authGenerationOf(user) })
        };
        const existing = await store.getAuthChallengeByChallengeId(setupChallengeId(user.id));
        await commitStagedPersistence(async () => {
            if (existing) await store.updateAuthChallenge(existing.id, payload);
            else await store.createAuthChallenge({ challengeId: setupChallengeId(user.id), ...payload });
            await recordAudit({ actorId: user.id, action: 'auth.totp.setup.start', target: user.id, result: 'ok' }, { save: false });
        });
        const issuer = encodeURIComponent('UserPersisto');
        const label = encodeURIComponent(user.email || user.username || user.id);
        return {
            ok: true,
            setupId,
            secret,
            expiresAt: payload.expiresAt,
            otpauthUrl: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&period=${PERIOD_SECONDS}&digits=${DIGITS}`
        };
    });
}

// Proves possession of the staged secret and, in one staged commit, installs
// it. Replacing an enabled authenticator advances the account generation, which
// revokes sessions and OIDC artifacts minted before the replacement.
export function setupVerify({ userId, token, setupId }) {
    return serializePersisted('users', async () => {
        const store = await getStore();
        const challenge = await store.getAuthChallengeByChallengeId(setupChallengeId(userId));
        if (!challenge || challenge.subject !== userId || challenge.purpose !== 'totp-setup') {
            return { ok: false, reason: 'setup_not_found' };
        }
        const metadata = setupMetadata(challenge);
        if (typeof setupId !== 'string' || !setupId || metadata.setupId !== setupId) {
            return { ok: false, reason: 'setup_superseded' };
        }
        const user = await getUserById(userId);
        if (!user || user.status !== 'active' || metadata.generation !== authGenerationOf(user)
            || new Date(challenge.expiresAt).getTime() < Date.now()) {
            await store.deleteAuthChallenge(challenge.id);
            await flush();
            return { ok: false, reason: 'setup_expired' };
        }
        const counter = matchingCounter(decryptSecret(challenge.codeHash), token);
        if (counter === null) {
            const attempts = (challenge.attempts || 0) + 1;
            if (attempts >= MAX_SETUP_ATTEMPTS) await store.deleteAuthChallenge(challenge.id);
            else await store.updateAuthChallenge(challenge.id, { attempts });
            await flush();
            return { ok: false, reason: attempts >= MAX_SETUP_ATTEMPTS ? 'too_many_attempts' : 'invalid_token' };
        }
        const current = await store.getAuthMethodByKey(methodKey(userId));
        const replacing = Boolean(current?.enabled && current.type === 'totp');
        await commitStagedPersistence(async () => {
            await stageTotpMethod(store, { userId, secretEncrypted: challenge.codeHash });
            await store.deleteAuthChallenge(challenge.id);
            if (replacing) await stageCredentialGenerationAdvance(userId);
            await recordAudit({ actorId: userId, action: replacing ? 'auth.totp.replace' : 'auth.totp.setup.verify', target: userId, result: 'ok' }, { save: false });
        });
        return { ok: true, replaced: replacing };
    });
}

async function verifyTotpForUser(user, token, { includeCredentialProof = false, action = 'auth.totp.login' } = {}) {
    if (!user) return { ok: false, reason: 'invalid_credentials' };
    if (user.status !== 'active') return { ok: false, reason: 'user_blocked' };
    if (isLoginLocked(user)) return { ok: false, reason: 'account_locked' };
    const store = await getStore();
    const method = await store.getAuthMethodByKey(methodKey(user.id));
    if (!method || !method.enabled || method.type !== 'totp') {
        return { ok: false, reason: 'totp_not_configured' };
    }
    const secret = decryptSecret(method.credential?.secretEncrypted);
    const counter = matchingCounter(secret, token);
    const lastUsedCounter = Number(method.credential?.lastUsedCounter ?? -1);
    if (counter === null || counter <= lastUsedCounter) {
        const reason = counter !== null && counter <= lastUsedCounter ? 'replayed_token' : 'invalid_token';
        await recordLoginFailure(user);
        await recordAudit({ actorId: user.id, action, target: user.id, result: 'denied', reason });
        return { ok: false, reason };
    }
    const version = includeCredentialProof ? credentialVersion('totp', method.credential) : undefined;
    await store.updateAuthMethod(method.id, {
        credential: { ...method.credential, lastUsedCounter: counter },
    });
    const fresh = await clearLoginFailures(user);
    await recordAudit({ actorId: user.id, action, target: user.id, result: 'ok' });
    return { ok: true, user: sanitizeUser(fresh), ...(includeCredentialProof ? { credentialKey: method.key, credentialVersion: version } : {}) };
}

export async function loginVerify({ email, token }, { includeCredentialProof = false } = {}) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return withLoginAttemptLock(normalizedEmail, () => serializePersisted('users', async () =>
        verifyTotpForUser(await getUserByEmail(normalizedEmail), token, { includeCredentialProof })));
}

// Re-authentication of an already signed-in account for a sensitive operation.
// It shares the account's login lock, lockout counter and replay protection.
export async function reauthenticationVerify({ userId, token }) {
    const user = await getUserById(userId);
    return withLoginAttemptLock(user?.email || `user:${userId}`, () => serializePersisted('users', async () =>
        verifyTotpForUser(await getUserById(userId), token, { action: 'auth.totp.reauthenticate' })));
}
