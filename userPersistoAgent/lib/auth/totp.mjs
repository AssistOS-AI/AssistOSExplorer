import crypto from 'node:crypto';
import { credentialVersion } from './credentialVersion.mjs';
import { getStore, flush } from '../store.mjs';
import { getUserByEmail, getUserById, sanitizeUser } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { clearLoginFailures, isLoginLocked, recordLoginFailure, withLoginAttemptLock } from './login-attempts.mjs';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const SETUP_TTL_MS = 2 * 60 * 1000;

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

function verifyToken(secret, token, at = Date.now()) {
    return matchingCounter(secret, token, at) !== null;
}

function methodKey(userId) {
    return `${userId}:totp`;
}

function setupChallengeId(userId) {
    return `totp-setup:${userId}`;
}

async function upsertSetupChallenge({ userId, secretEncrypted }) {
    const store = await getStore();
    const challengeId = setupChallengeId(userId);
    const payload = {
        subject: userId,
        purpose: 'totp-setup',
        codeHash: secretEncrypted,
        expiresAt: new Date(Date.now() + SETUP_TTL_MS).toISOString(),
        attempts: 0,
        correlationId: ''
    };
    const existing = await store.getAuthChallengeByChallengeId(challengeId);
    if (existing) {
        await store.updateAuthChallenge(existing.id, payload);
        return { ...existing, ...payload, challengeId };
    }
    return store.createAuthChallenge({ challengeId, ...payload });
}

async function upsertTotpMethod({ userId, secretEncrypted }) {
    const store = await getStore();
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

export async function setupStart({ userId }) {
    const user = await getUserById(userId);
    if (!user) {
        throw new Error(`Unknown user: ${userId}`);
    }
    const secret = base32Encode(crypto.randomBytes(20));
    await upsertSetupChallenge({ userId: user.id, secretEncrypted: encryptSecret(secret) });
    await recordAudit({ actorId: user.id, action: 'auth.totp.setup.start', target: user.id, result: 'ok' });
    await flush();
    const issuer = encodeURIComponent('UserPersisto');
    const label = encodeURIComponent(user.email || user.id);
    return {
        ok: true,
        secret,
        otpauthUrl: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&period=${PERIOD_SECONDS}&digits=${DIGITS}`
    };
}

export async function setupVerify({ userId, token }) {
    const store = await getStore();
    const challenge = await store.getAuthChallengeByChallengeId(setupChallengeId(userId));
    if (!challenge || challenge.subject !== userId) {
        return { ok: false, reason: 'setup_not_found' };
    }
    if (new Date(challenge.expiresAt).getTime() < Date.now()) {
        await store.deleteAuthChallenge(challenge.id);
        await flush();
        return { ok: false, reason: 'setup_expired' };
    }
    const secret = decryptSecret(challenge.codeHash);
    if (!verifyToken(secret, token)) {
        await store.updateAuthChallenge(challenge.id, { attempts: (challenge.attempts || 0) + 1 });
        await flush();
        return { ok: false, reason: 'invalid_token' };
    }
    await upsertTotpMethod({ userId, secretEncrypted: challenge.codeHash });
    await store.deleteAuthChallenge(challenge.id);
    await recordAudit({ actorId: userId, action: 'auth.totp.setup.verify', target: userId, result: 'ok' });
    await flush();
    return { ok: true };
}

export async function loginVerify({ email, token }, { includeCredentialProof = false } = {}) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return withLoginAttemptLock(normalizedEmail, async () => {
        const user = await getUserByEmail(normalizedEmail);
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
            await recordLoginFailure(user);
            await recordAudit({
                actorId: user.id,
                action: 'auth.totp.login',
                target: user.id,
                result: 'denied',
                reason: counter !== null && counter <= lastUsedCounter ? 'replayed_token' : 'invalid_token',
            });
            return { ok: false, reason: counter !== null && counter <= lastUsedCounter ? 'replayed_token' : 'invalid_token' };
        }
        const version = includeCredentialProof ? credentialVersion('totp', method.credential) : undefined;
        await store.updateAuthMethod(method.id, {
            credential: { ...method.credential, lastUsedCounter: counter },
        });
        const fresh = await clearLoginFailures(user);
        await recordAudit({ actorId: user.id, action: 'auth.totp.login', target: user.id, result: 'ok' });
        return { ok: true, user: sanitizeUser(fresh), ...(includeCredentialProof ? { credentialKey: method.key, credentialVersion: version } : {}) };
    });
}
