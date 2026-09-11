import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { getStore, commitStagedPersistence } from '../store.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { encryptOidcPayload, decryptOidcPayload } from '../oidc/secrets.mjs';
import { hashCode, codeHashMatches } from './email-code.mjs';
import { normalizeEmail } from '../users.mjs';

// One email challenge attempt per (flow, parent, browser). Codes are bound to
// the normalized email, purpose, browser, parent and generation; a resend or
// any email/purpose change starts a new generation. The failure and send
// counters survive resend, change-email and cancel within the attempt.
export const CODE_TTL_MS = 5 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_CODE_FAILURES = 5;
const MAX_SENDS_PER_ATTEMPT = 5;
const ATTEMPT_VERSION = 1;
const PURPOSES = new Set(['login', 'register']);
const FLOWS = new Set(['sso', 'oidc']);
const BROWSER_PROOF = /^[A-Za-z0-9_-]{43}$/;
const HANDLE = /^[a-f0-9]{64}$/;
const EMAIL_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_FAILURE_LIMIT = 10;
const MEMORY_WINDOW_MS = 15 * 60 * 1000;
const MAX_MEMORY_SUBJECTS = 20_000;
const SHARED_SOURCE = 'shared';
const LIMITS = {
    sendPerEmail: 5,
    sendPerSource: 20,
    sendShared: 200,
    discoverPerParent: 20,
    discoverPerSource: 60,
    discoverShared: 600,
};
const memoryBuckets = new Map();

export function attemptError(code, statusCode = 400, extra = {}) {
    const messages = {
        attempt_invalid: 'This sign-in attempt is no longer available. Start again.',
        attempt_expired: 'This sign-in request expired. Start again.',
        code_invalid: 'That code is not correct.',
        code_expired: 'That code expired. Request a new code.',
        too_many_attempts: 'Too many incorrect codes. Start again.',
        rate_limited: 'Too many requests. Wait and try again.',
        delivery_failed: 'We could not send the code. Try again later.',
        resend_too_soon: 'Wait before requesting another code.',
        invalid_email: 'Enter a valid email address.',
    };
    return Object.assign(new Error(messages[code] || 'Unable to continue.'), { code, statusCode, ...extra });
}

function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function emailSubject(email) {
    return digest(`userpersisto:email:${email}`);
}

export function rateSourceKey(rateSource) {
    return typeof rateSource === 'string' && /^[a-f0-9]{64}$/.test(rateSource) ? rateSource : SHARED_SOURCE;
}

// In-memory sliding counters, LRU-bounded and fail-closed when saturated.
export function consumeMemoryBudget(scope, subject, limit, now = Date.now()) {
    const key = `${scope}\0${subject}`;
    let bucket = memoryBuckets.get(key);
    if (bucket && now - bucket.windowStartedAt >= MEMORY_WINDOW_MS) bucket = null;
    if (!bucket) {
        if (memoryBuckets.size >= MAX_MEMORY_SUBJECTS) {
            for (const [candidate, value] of memoryBuckets) if (now - value.windowStartedAt >= MEMORY_WINDOW_MS) memoryBuckets.delete(candidate);
            if (memoryBuckets.size >= MAX_MEMORY_SUBJECTS) throw attemptError('rate_limited', 429, { retryAfter: 60 });
        }
        bucket = { windowStartedAt: now, count: 0 };
    }
    if (bucket.count >= limit) {
        throw attemptError('rate_limited', 429, { retryAfter: Math.max(1, Math.ceil((bucket.windowStartedAt + MEMORY_WINDOW_MS - now) / 1000)) });
    }
    bucket.count += 1;
    memoryBuckets.delete(key);
    memoryBuckets.set(key, bucket);
}

export function resetEmailAttemptLimitsForTests() {
    memoryBuckets.clear();
}

export function discoveryBudget({ parent, rateSource }) {
    const source = rateSourceKey(rateSource);
    consumeMemoryBudget('discover-parent', `${parent.flow}:${parent.id}`, LIMITS.discoverPerParent);
    consumeMemoryBudget('discover-source', source, source === SHARED_SOURCE ? LIMITS.discoverShared : LIMITS.discoverPerSource);
}

function attemptKey(parent, browserProof) {
    return digest(JSON.stringify(['userpersisto:auth-attempt:v1', parent.flow, parent.id, digest(browserProof)]));
}

function context(key) {
    return `userpersisto:auth-attempt:${ATTEMPT_VERSION}:${key}`;
}

function assertParent(parent) {
    if (!parent || !FLOWS.has(parent.flow) || typeof parent.id !== 'string' || !parent.id || parent.id.length > 512
        || !Number.isSafeInteger(parent.expiresAt)) throw attemptError('attempt_invalid');
    if (parent.expiresAt <= Date.now()) throw attemptError('attempt_expired', 410);
}

function assertBrowser(browserProof) {
    if (typeof browserProof !== 'string' || !BROWSER_PROOF.test(browserProof)) throw attemptError('attempt_invalid', 400);
}

function emptyPayload(parent) {
    return { flow: parent.flow, parentId: parent.id, email: '', purpose: '', generation: 0, failures: 0, sends: 0,
        challenge: null, completion: null };
}

async function cleanExpired(store, now) {
    for (const type of ['authAttempt', 'authThrottle']) {
        const result = await store.select(type, { expiresAt: { $gt: 0, $lte: now } }, { start: 0, pageSize: 64 });
        const expired = result.objects || [];
        if (!expired.length) continue;
        await commitStagedPersistence(async () => {
            for (const record of expired) {
                if (type === 'authAttempt') await store.deleteAuthAttempt(record.id);
                else await store.deleteAuthThrottle(record.id);
            }
        });
    }
}

function decode(record, key) {
    if (!record || record.version !== ATTEMPT_VERSION || !HANDLE.test(record.attemptKey || '') || record.attemptKey !== key) return null;
    try {
        const payload = decryptOidcPayload(record.payload, context(key));
        return payload && typeof payload === 'object' && payload.status === record.status ? payload : null;
    } catch {
        return null;
    }
}

// Reads the attempt for this parent and browser. Caller holds the persistence
// scope. A missing record is an empty, active attempt that exists only once saved.
async function load(store, parent, browserProof) {
    assertParent(parent);
    assertBrowser(browserProof);
    const key = attemptKey(parent, browserProof);
    const record = await store.getAuthAttemptByAttemptKey(key);
    if (record && record.expiresAt <= Date.now()) {
        await commitStagedPersistence(() => store.deleteAuthAttempt(record.id));
        return { key, record: null, payload: { ...emptyPayload(parent), status: 'active' } };
    }
    const payload = record ? decode(record, key) : { ...emptyPayload(parent), status: 'active' };
    if (!payload || payload.flow !== parent.flow || payload.parentId !== parent.id) throw attemptError('attempt_invalid');
    return { key, record, payload };
}

// Returns a staging function; the caller runs it inside commitStagedPersistence.
function stageSave(store, parent, loaded, payload) {
    const status = payload.status === 'completed' ? 'completed' : 'active';
    const next = { ...payload, status };
    const data = {
        attemptKey: loaded.key,
        status,
        expiresAt: parent.expiresAt,
        version: ATTEMPT_VERSION,
        payload: encryptOidcPayload(next, context(loaded.key)),
    };
    return async () => {
        if (loaded.record) await store.updateAuthAttempt(loaded.record.id, data);
        else await store.createAuthAttempt(data);
        return next;
    };
}

function publicChallenge(payload, now = Date.now()) {
    const challenge = payload.challenge;
    if (!challenge) return null;
    return {
        email: payload.email,
        purpose: payload.purpose,
        expiresAt: challenge.expiresAt,
        resendAt: challenge.delivery === 'failed' ? now : challenge.sentAt + RESEND_COOLDOWN_MS,
        attemptsRemaining: Math.max(0, MAX_CODE_FAILURES - payload.failures),
        delivery: challenge.delivery,
        expired: challenge.expiresAt <= now,
    };
}

export function describeAttempt(payload) {
    if (payload.status === 'completed') return { status: 'completed', completion: { userId: payload.completion?.userId || '' } };
    return { status: 'active', challenge: publicChallenge(payload), locked: payload.failures >= MAX_CODE_FAILURES };
}

// After a completed handoff consumed its parent, the same browser may still
// read the committed outcome (lost-response replay) until the attempt expires.
export function readCompletion({ flow, id, browserProof }) {
    if (typeof browserProof !== 'string' || !BROWSER_PROOF.test(browserProof) || !FLOWS.has(flow) || typeof id !== 'string' || !id) {
        return Promise.resolve(null);
    }
    return withPersistenceScope(async () => {
        const key = attemptKey({ flow, id }, browserProof);
        const record = await (await getStore()).getAuthAttemptByAttemptKey(key);
        if (!record || record.status !== 'completed' || record.expiresAt <= Date.now()) return null;
        const payload = decode(record, key);
        return payload?.status === 'completed' && payload.parentId === id ? payload.completion : null;
    });
}

export function readAttempt({ parent, browserProof }) {
    return withPersistenceScope(async () => {
        const store = await getStore();
        await cleanExpired(store, Date.now());
        const { payload } = await load(store, parent, browserProof);
        return payload;
    });
}

async function readThrottle(store, key, now) {
    const record = await store.getAuthThrottleByThrottleKey(key);
    const live = record && Number.isSafeInteger(record.windowStartedAt) && now - record.windowStartedAt < EMAIL_FAILURE_WINDOW_MS
        && record.windowStartedAt <= now;
    return { record, count: live ? record.count : 0, windowStartedAt: live ? record.windowStartedAt : now };
}

function emailFailureKey(email) {
    return digest(JSON.stringify(['userpersisto:throttle:email-verify', email]));
}

// Durable aggregate budget across parents, browsers and generations.
async function assertEmailFailureBudget(store, email, now) {
    const throttle = await readThrottle(store, emailFailureKey(email), now);
    if (throttle.count >= EMAIL_FAILURE_LIMIT) {
        throw attemptError('rate_limited', 429, { retryAfter: Math.max(1, Math.ceil((throttle.windowStartedAt + EMAIL_FAILURE_WINDOW_MS - now) / 1000)) });
    }
    return throttle;
}

// Shared by other bound email proofs (Google mailbox and link codes) so the
// aggregate per-address guessing budget covers every code type.
export function assertEmailVerifyBudget(email) {
    return withPersistenceScope(async () => {
        await assertEmailFailureBudget(await getStore(), email, Date.now());
    });
}

export function recordEmailVerifyFailure(email) {
    return withPersistenceScope(async () => {
        const store = await getStore();
        const throttle = await readThrottle(store, emailFailureKey(email), Date.now());
        await commitStagedPersistence(stageEmailFailure(store, email, throttle));
    });
}

function stageEmailFailure(store, email, throttle) {
    const key = emailFailureKey(email);
    const data = { throttleKey: key, windowStartedAt: throttle.windowStartedAt, count: throttle.count + 1,
        expiresAt: throttle.windowStartedAt + EMAIL_FAILURE_WINDOW_MS };
    return async () => {
        if (throttle.record) await store.updateAuthThrottle(throttle.record.id, data);
        else await store.createAuthThrottle(data);
    };
}

// Issues a new generation and stages it before any network delivery. Returns
// the code for the caller's out-of-scope delivery and the generation to confirm.
// `precheck` runs inside the scope to apply account/purpose/policy rules.
export function issueChallenge({ parent, browserProof, email, purpose, rateSource, resend = false, precheck }) {
    if (!PURPOSES.has(purpose)) throw attemptError('invalid_request');
    let normalized;
    try { normalized = normalizeEmail(email); } catch { throw attemptError('invalid_email'); }
    return withPersistenceScope(async () => {
        const store = await getStore();
        const now = Date.now();
        await cleanExpired(store, now);
        const loaded = await load(store, parent, browserProof);
        const payload = loaded.payload;
        if (payload.status === 'completed') throw attemptError('attempt_invalid', 409);
        if (payload.failures >= MAX_CODE_FAILURES) throw attemptError('too_many_attempts', 429);
        const same = payload.email === normalized && payload.purpose === purpose && payload.challenge;
        if (resend && !same) throw attemptError('attempt_invalid', 409);
        if (same && payload.challenge.delivery !== 'failed' && payload.challenge.sentAt + RESEND_COOLDOWN_MS > now) {
            throw attemptError('resend_too_soon', 429, { retryAfter: Math.ceil((payload.challenge.sentAt + RESEND_COOLDOWN_MS - now) / 1000) });
        }
        if (payload.sends >= MAX_SENDS_PER_ATTEMPT) throw attemptError('rate_limited', 429, { retryAfter: Math.ceil((parent.expiresAt - now) / 1000) });
        await assertEmailFailureBudget(store, normalized, now);
        // A refused start (account_exists, account_not_found, registration_disabled)
        // reveals as much as discovery does, so it spends the same budgets as a send.
        const source = rateSourceKey(rateSource);
        consumeMemoryBudget('send-email', emailSubject(normalized), LIMITS.sendPerEmail, now);
        consumeMemoryBudget('send-source', source, source === SHARED_SOURCE ? LIMITS.sendShared : LIMITS.sendPerSource, now);
        const account = precheck ? await precheck(normalized) : null;
        const generation = payload.generation + 1;
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const next = {
            ...payload,
            email: normalized,
            purpose,
            account: account || null,
            generation,
            sends: payload.sends + 1,
            challenge: {
                codeHash: hashCode(code, `${loaded.key}:${generation}`),
                sentAt: now,
                expiresAt: Math.min(now + CODE_TTL_MS, parent.expiresAt),
                delivery: 'pending',
            },
        };
        await commitStagedPersistence(stageSave(store, parent, loaded, next));
        return { code, email: normalized, generation, correlationId: `${parent.flow}-attempt:${loaded.key.slice(0, 16)}:${generation}` };
    });
}

// Records the delivery outcome for the still-current generation only.
export function recordDelivery({ parent, browserProof, generation, delivery, providerMessageId = '', correlationId = '' }) {
    return withPersistenceScope(async () => {
        const store = await getStore();
        const loaded = await load(store, parent, browserProof);
        const payload = loaded.payload;
        const current = payload.status === 'active' && payload.generation === generation && payload.challenge;
        await commitStagedPersistence(async () => {
            if (current) {
                await stageSave(store, parent, loaded, { ...payload, challenge: { ...payload.challenge, delivery } })();
            }
            await store.createEmailLog({
                logId: digest(`${loaded.key}:${generation}:${Date.now()}:${Math.random()}`).slice(0, 32),
                providerMessageId: String(providerMessageId || ''),
                toEmailHash: createHash('sha256').update(payload.email || '').digest('base64url'),
                template: 'auth-code',
                result: delivery,
                correlationId: String(correlationId || ''),
                createdAt: new Date().toISOString(),
            });
        });
        return current ? publicChallenge({ ...payload, challenge: { ...payload.challenge, delivery } }) : null;
    });
}

// Delivery is network work outside every lock except the caller's parent lock.
// Provider acceptance, a known failure and an unknown outcome stay distinct.
export async function deliverCode(deliver, { to, code, correlationId }) {
    try {
        const result = await deliver({ to, code, correlationId });
        if (result?.delivered === true) return { delivery: 'accepted', providerMessageId: result.providerMessageId || '' };
        return { delivery: 'failed', providerMessageId: '' };
    } catch {
        return { delivery: 'unknown', providerMessageId: '' };
    }
}

export function developmentLogFallback({ to, code, delivery }) {
    // Explicit development-only escape hatch; never a production method.
    if (delivery === 'accepted' || process.env.USERPERSISTO_DEV_BOOTSTRAP !== 'true') return delivery;
    console.warn(`[userPersisto] DEVELOPMENT email code for ${to}: ${code}`);
    return 'development-log';
}

// Verifies a submitted code for the current generation. Caller holds the users
// lock (and so the persistence scope) and the parent lock. On success the
// challenge is consumed in the same staged commit as the caller's completion.
export async function checkChallengeCode({ parent, browserProof, code }) {
    const store = await getStore();
    const now = Date.now();
    const loaded = await load(store, parent, browserProof);
    const payload = loaded.payload;
    if (payload.status === 'completed') return { completed: true, payload, loaded };
    if (!payload.challenge) throw attemptError('attempt_invalid', 409);
    if (payload.failures >= MAX_CODE_FAILURES) throw attemptError('too_many_attempts', 429);
    if (payload.challenge.delivery === 'pending' || payload.challenge.delivery === 'failed') throw attemptError('attempt_invalid', 409);
    if (payload.challenge.expiresAt <= now) throw attemptError('code_expired', 410);
    const throttle = await assertEmailFailureBudget(store, payload.email, now);
    const submitted = typeof code === 'string' ? code.trim() : '';
    const matches = /^\d{6}$/.test(submitted)
        && codeHashMatches(submitted, `${loaded.key}:${payload.generation}`, payload.challenge.codeHash);
    if (!matches) {
        const failures = payload.failures + 1;
        const next = { ...payload, failures, ...(failures >= MAX_CODE_FAILURES ? { challenge: null } : {}) };
        const saveAttempt = stageSave(store, parent, loaded, next);
        const saveThrottle = stageEmailFailure(store, payload.email, throttle);
        await commitStagedPersistence(async () => { await saveAttempt(); await saveThrottle(); });
        if (failures >= MAX_CODE_FAILURES) throw attemptError('too_many_attempts', 429);
        throw attemptError('code_invalid', 400, { attemptsRemaining: MAX_CODE_FAILURES - failures });
    }
    return { completed: false, payload, loaded, email: payload.email, purpose: payload.purpose };
}

// Stage the proof's consumption: either the completion tombstone for the
// account the caller staged, or a cleared challenge when the verified proof
// cannot be used (late collision, disabled policy). Counters are preserved.
export function stageChallengeOutcome(store, parent, checked, { userId = '', generation, handoff = null } = {}) {
    const payload = checked.payload;
    const next = userId
        ? { ...payload, status: 'completed', challenge: null, completion: { userId, generation, handoff } }
        : { ...payload, challenge: null, email: '', purpose: '' };
    return stageSave(store, parent, checked.loaded, next);
}

// Cancels unfinished work server-side. A completed attempt stays completed:
// cancellation cannot undo an account that was already committed.
export function cancelAttempt({ parent, browserProof }) {
    return withPersistenceScope(async () => {
        const store = await getStore();
        const loaded = await load(store, parent, browserProof);
        const payload = loaded.payload;
        if (payload.status === 'completed') return { status: 'completed' };
        if (loaded.record && (payload.challenge || payload.email)) {
            await commitStagedPersistence(stageSave(store, parent, loaded, { ...payload, challenge: null, email: '', purpose: '' }));
        }
        return { status: 'cancelled' };
    });
}

export function sameProof(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && timingSafeEqual(a, b);
}
