import { createHash, randomInt } from 'node:crypto';
import { getStore, commitStagedPersistence } from '../store.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { recordAudit } from '../audit.mjs';
import { hashCode, codeHashMatches } from './email-code.mjs';
import {
    attemptError,
    assertEmailVerifyBudget,
    consumeMemoryBudget,
    deliverCode,
    developmentLogFallback,
    emailSubject,
    recordEmailVerifyFailure,
} from './emailAttempts.mjs';

// Email codes for an already signed-in account: operation re-authentication to
// its verified sign-in mailbox (`reauth-code`) and proof of a new address for
// contact verification (`contact-verify`). One challenge per account and
// purpose; a resend or a change of address/operation starts a new generation.
// Codes are six digits, live five minutes, allow five failures and a resend
// after sixty seconds, and every failure also spends the durable per-address
// budget shared with sign-in and Google codes.
const PURPOSES = new Set(['reauth-code', 'contact-verify']);
const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_FAILURES = 5;
const MAX_SENDS = 5;
const ACCOUNT_SEND_LIMIT = 10;
const SEND_PER_EMAIL_LIMIT = 5;

function challengeKey(purpose, userId) {
    if (!PURPOSES.has(purpose)) throw attemptError('invalid_request');
    return `${purpose}:${userId}`;
}

function metadata(record) {
    try {
        const value = JSON.parse(record?.correlationId || '{}');
        return value && typeof value === 'object' ? value : {};
    } catch {
        return {};
    }
}

function live(record, now) {
    return record && Date.parse(record.expiresAt) > now ? record : null;
}

export function publicAccountChallenge(record, now = Date.now()) {
    if (!record) return null;
    const meta = metadata(record);
    return {
        email: meta.email || '',
        operation: meta.operation || '',
        expiresAt: Date.parse(record.expiresAt),
        resendAt: meta.delivery === 'failed' ? now : Number(meta.sentAt || 0) + RESEND_COOLDOWN_MS,
        attemptsRemaining: Math.max(0, MAX_FAILURES - (record.attempts || 0)),
        delivery: meta.delivery || 'pending',
    };
}

export function readAccountChallenge({ userId, purpose }) {
    return withPersistenceScope(async () => {
        const record = live(await (await getStore()).getAuthChallengeByChallengeId(challengeKey(purpose, userId)), Date.now());
        return record ? { record, meta: metadata(record) } : null;
    });
}

// Stages a new generation before any network delivery; the caller delivers
// outside every lock except its own account/operation lock.
function issue({ userId, purpose, email, operation, accountGeneration, resend }) {
    const id = challengeKey(purpose, userId);
    return withPersistenceScope(async () => {
        const store = await getStore();
        const now = Date.now();
        const existing = await store.getAuthChallengeByChallengeId(id);
        const current = live(existing, now);
        const meta = current ? metadata(current) : null;
        const same = Boolean(meta && meta.email === email && meta.operation === operation);
        if (resend && !same) throw attemptError('attempt_invalid', 409);
        if (same && meta.delivery !== 'failed' && Number(meta.sentAt || 0) + RESEND_COOLDOWN_MS > now) {
            throw attemptError('resend_too_soon', 429, { retryAfter: Math.ceil((Number(meta.sentAt) + RESEND_COOLDOWN_MS - now) / 1000) });
        }
        if (same && Number(meta.sends || 0) >= MAX_SENDS) throw attemptError('rate_limited', 429, { retryAfter: Math.ceil((Date.parse(current.expiresAt) - now) / 1000) });
        await assertEmailVerifyBudget(email);
        consumeMemoryBudget('send-email', emailSubject(email), SEND_PER_EMAIL_LIMIT, now);
        consumeMemoryBudget('account-code', userId, ACCOUNT_SEND_LIMIT, now);
        const codeGeneration = Number(metadata(existing).codeGeneration || 0) + 1;
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const record = {
            subject: userId,
            purpose,
            codeHash: hashCode(code, `${id}:${codeGeneration}`),
            expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
            attempts: same ? current.attempts || 0 : 0,
            correlationId: JSON.stringify({ email, operation, generation: accountGeneration, codeGeneration, sentAt: now,
                sends: (same ? Number(meta.sends || 0) : 0) + 1, delivery: 'pending' }),
        };
        await commitStagedPersistence(async () => {
            if (existing) await store.updateAuthChallenge(existing.id, record);
            else await store.createAuthChallenge({ challengeId: id, ...record });
        });
        const digest = createHash('sha256').update(id).digest('hex').slice(0, 16);
        return { code, codeGeneration, correlationId: `${purpose}:${digest}:${codeGeneration}` };
    });
}

function recordDelivery({ userId, purpose, email, codeGeneration, delivery, providerMessageId, correlationId }) {
    const id = challengeKey(purpose, userId);
    return withPersistenceScope(async () => {
        const store = await getStore();
        const record = await store.getAuthChallengeByChallengeId(id);
        const meta = metadata(record);
        const current = live(record, Date.now()) && meta.codeGeneration === codeGeneration;
        await commitStagedPersistence(async () => {
            if (current) await store.updateAuthChallenge(record.id, { correlationId: JSON.stringify({ ...meta, delivery }) });
            await store.createEmailLog({
                logId: createHash('sha256').update(`${id}:${codeGeneration}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 32),
                providerMessageId: String(providerMessageId || ''),
                toEmailHash: createHash('sha256').update(email).digest('base64url'),
                template: purpose,
                result: delivery,
                correlationId: String(correlationId || ''),
                createdAt: new Date().toISOString(),
            });
        });
        return current ? publicAccountChallenge({ ...record, correlationId: JSON.stringify({ ...meta, delivery }) }) : null;
    });
}

// Issues and delivers a code. A known delivery failure is reported, never
// announced as success; an unknown transport outcome is reported as such.
export async function sendAccountCode({ userId, purpose, email, operation = '', accountGeneration, resend = false, deliver }) {
    const issued = await issue({ userId, purpose, email, operation, accountGeneration, resend });
    const outcome = await deliverCode(deliver, { to: email, code: issued.code, correlationId: issued.correlationId });
    const delivery = developmentLogFallback({ to: email, code: issued.code, delivery: outcome.delivery });
    const challenge = await recordDelivery({ userId, purpose, email, codeGeneration: issued.codeGeneration, delivery,
        providerMessageId: outcome.providerMessageId, correlationId: issued.correlationId });
    if (delivery === 'failed') throw attemptError('delivery_failed', 502);
    if (!challenge) throw attemptError('attempt_invalid', 409);
    return challenge;
}

// Verifies a submitted code for the current generation. The caller holds its
// account lock and the persistence scope, and stages `consume` in the same
// commit as the operation the proof authorizes. Failures commit before throwing.
export async function checkAccountCode({ userId, purpose, code, operation = '' }) {
    const id = challengeKey(purpose, userId);
    const store = await getStore();
    const now = Date.now();
    const record = await store.getAuthChallengeByChallengeId(id);
    const meta = metadata(record);
    if (!record || record.subject !== userId || record.purpose !== purpose || meta.operation !== operation) throw attemptError('attempt_invalid', 409);
    if (meta.delivery === 'pending' || meta.delivery === 'failed') throw attemptError('attempt_invalid', 409);
    if (Date.parse(record.expiresAt) <= now) throw attemptError('code_expired', 410);
    if ((record.attempts || 0) >= MAX_FAILURES) throw attemptError('too_many_attempts', 429);
    await assertEmailVerifyBudget(meta.email);
    const submitted = typeof code === 'string' ? code.trim() : '';
    if (!/^\d{6}$/.test(submitted) || !codeHashMatches(submitted, `${id}:${meta.codeGeneration}`, record.codeHash)) {
        const attempts = (record.attempts || 0) + 1;
        await commitStagedPersistence(async () => {
            if (attempts >= MAX_FAILURES) await store.deleteAuthChallenge(record.id);
            else await store.updateAuthChallenge(record.id, { attempts });
            await recordAudit({ actorId: userId, action: `auth.${purpose}.verify`, target: userId, result: 'denied', reason: 'invalid_code' }, { save: false });
        });
        await recordEmailVerifyFailure(meta.email);
        if (attempts >= MAX_FAILURES) throw attemptError('too_many_attempts', 429);
        throw attemptError('code_invalid', 400, { attemptsRemaining: MAX_FAILURES - attempts });
    }
    return { meta, consume: () => store.deleteAuthChallenge(record.id) };
}

export async function cancelAccountCode({ userId, purpose }) {
    return withPersistenceScope(async () => {
        const store = await getStore();
        const record = await store.getAuthChallengeByChallengeId(challengeKey(purpose, userId));
        if (record) await commitStagedPersistence(() => store.deleteAuthChallenge(record.id));
    });
}
