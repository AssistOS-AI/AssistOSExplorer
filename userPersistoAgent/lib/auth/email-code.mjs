import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { getStore, flush } from '../store.mjs';
import { getUserByEmail, sanitizeUser } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { sendAuthCode } from '../email-agent-client.mjs';
import { isAuthMethodEnabled } from './methods.mjs';
import { serialize } from '../serial.mjs';

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MIN_START_INTERVAL_MS = 60 * 1000;
const MAX_RATE_LIMIT_SUBJECTS = 10_000;
const lastStartedAt = new Map();

export function hashCode(code, challengeId) {
    const key = process.env.USERPERSISTO_SETTINGS_KEY || '';
    if (!key) {
        throw new Error('USERPERSISTO_SETTINGS_KEY is required to hash auth codes.');
    }
    return createHmac('sha256', key).update(`${challengeId}:${code}`).digest('base64url');
}

export function codeHashMatches(code, challengeId, expectedHash) {
    const actual = Buffer.from(hashCode(code, challengeId));
    const expected = Buffer.from(String(expectedHash || ''));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startEmailCode({ email, purpose = 'login', correlationId = '', createSelfRegistered = false }) {
    if (!(await isAuthMethodEnabled('emailCode'))) {
        throw Object.assign(new Error('Email-code authentication is not enabled.'), { code: 'auth_method_disabled', statusCode: 404 });
    }
    const store = await getStore();
    const normalized = String(email || '').trim().toLowerCase();
    const user = await getUserByEmail(normalized);
    if (createSelfRegistered) {
        throw Object.assign(new Error('Registration requires email and password.'), { code: 'password_registration_required', statusCode: 400 });
    }
    const now = Date.now();
    for (const [key, startedAt] of lastStartedAt) {
        if (now - startedAt >= MIN_START_INTERVAL_MS) lastStartedAt.delete(key);
    }
    const throttleKey = createHash('sha256').update(normalized).digest('base64url');
    const previous = lastStartedAt.get(throttleKey) || 0;
    if (now - previous < MIN_START_INTERVAL_MS || (lastStartedAt.size >= MAX_RATE_LIMIT_SUBJECTS && !previous)) {
        throw Object.assign(new Error('Please wait before requesting another code.'), { code: 'rate_limited', statusCode: 429 });
    }
    lastStartedAt.set(throttleKey, now);
    if (!user) {
        await recordAudit({ actorId: 'anonymous', action: 'auth.emailcode.start', target: normalized, result: 'denied', reason: 'unknown_user' });
        return { challengeId: randomUUID(), code: null, user: null };
    }

    const challengeId = randomUUID();
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    await store.createAuthChallenge({
        challengeId,
        subject: user.id,
        purpose: String(purpose || 'login'),
        codeHash: hashCode(code, challengeId),
        expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
        attempts: 0,
        correlationId: String(correlationId)
    });
    await recordAudit({ actorId: user ? user.id : 'anonymous', action: 'auth.emailcode.start', target: normalized, result: 'ok', reason: correlationId });
    if (code) {
        let deliveryResult = 'failed';
        let providerMessageId = '';
        try {
            const delivery = await sendAuthCode({ to: normalized, code, correlationId });
            deliveryResult = delivery.delivered ? 'sent' : (delivery.result || 'failed');
            providerMessageId = delivery.providerMessageId || '';
        } catch {
            if (process.env.USERPERSISTO_DEV_BOOTSTRAP === 'true') {
                console.warn(`[userPersisto] DEV email-code for ${normalized}: ${code}`);
                deliveryResult = 'dev-console';
            }
        }
        await store.createEmailLog({
            logId: randomUUID(),
            providerMessageId,
            toEmailHash: createHash('sha256').update(normalized).digest('base64url'),
            template: 'auth-code',
            result: deliveryResult,
            correlationId: String(correlationId),
            createdAt: new Date().toISOString()
        });
    }
    await flush();
    return { challengeId, code, user: sanitizeUser(user) };
}

export function verifyEmailCode({ challengeId, code, correlationId }) {
    const normalizedChallengeId = String(challengeId || '');
    return serialize(`email-code:${normalizedChallengeId}`, async () => {
        const store = await getStore();
        if (!(await store.hasAuthChallenge(normalizedChallengeId))) {
            return { ok: false, reason: 'challenge_not_found' };
        }
        const challenge = await store.getAuthChallengeByChallengeId(normalizedChallengeId);
        // Email proof belonging to enrollment or federation is never login proof.
        if (challenge.purpose !== 'login' || (correlationId !== undefined && challenge.correlationId !== correlationId)) {
            return { ok: false, reason: 'challenge_not_found' };
        }
        if (new Date(challenge.expiresAt).getTime() < Date.now()) {
            await store.deleteAuthChallenge(challenge.id);
            await flush();
            return { ok: false, reason: 'code_expired' };
        }
        if ((challenge.attempts || 0) >= MAX_ATTEMPTS) {
            await store.deleteAuthChallenge(challenge.id);
            await flush();
            return { ok: false, reason: 'too_many_attempts' };
        }
        if (!codeHashMatches(String(code || ''), normalizedChallengeId, challenge.codeHash)) {
            await store.updateAuthChallenge(challenge.id, { attempts: (challenge.attempts || 0) + 1 });
            await flush();
            return { ok: false, reason: 'invalid_code' };
        }

        await store.deleteAuthChallenge(challenge.id);
        const user = (await store.hasUser(challenge.subject)) ? await store.getUser(challenge.subject) : null;

        if (!user) {
            await flush();
            return { ok: false, reason: 'unknown_user' };
        }
        if (user.status !== 'active') {
            await flush();
            return { ok: false, reason: 'user_blocked' };
        }
        await recordAudit({ actorId: user.id, action: 'auth.emailcode.verify', target: user.id, result: 'ok', reason: challenge.correlationId });
        await flush();
        return { ok: true, user: sanitizeUser(user) };
    });
}
