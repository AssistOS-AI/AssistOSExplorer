import { createHash, timingSafeEqual } from 'node:crypto';
import { getStore, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { encryptOidcPayload, decryptOidcPayload } from '../oidc/secrets.mjs';

export const GOOGLE_TRANSACTION_TTL_MS = 5 * 60 * 1000;
export const GOOGLE_TRANSACTION_VERSION = 1;
const TERMINAL = new Set(['consumed', 'failed', 'cancelled']);
const TRANSITIONS = {
    pending: new Set(['exchanging', 'failed', 'cancelled']),
    exchanging: new Set(['verified', 'failed', 'cancelled']),
    verified: new Set(['verified', 'consumed', 'failed', 'cancelled']),
};
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RANDOM_PATTERN = /^[A-Za-z0-9_-]{43,256}$/;
const IMMUTABLE_PAYLOAD_FIELDS = new Set(['browserProofHash', 'configFingerprint', 'createdAt', 'flow', 'parent', 'config']);

function transactionError(code = 'google_transaction_invalid', statusCode = 400) {
    return Object.assign(new Error('This Google sign-in attempt is unavailable. Start again.'), { code, statusCode });
}

function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function hashGoogleState(state) {
    if (typeof state !== 'string' || !RANDOM_PATTERN.test(state)) throw transactionError();
    return digest(state);
}

function context(record) {
    return `userpersisto:google:transaction:${record.version}:${record.stateHash}:${record.status}:${record.expiresAt}`;
}

function parentKey(payload) {
    return JSON.stringify([payload.flow, payload.flow === 'explorer' ? payload.parent.requestId
        : payload.flow === 'reauth' ? payload.parent.userId : payload.parent.uid]);
}

function validatePayload(payload, expiresAt, now) {
    const parent = payload?.parent;
    if (!['explorer', 'oidc', 'reauth'].includes(payload?.flow) || !parent || typeof parent !== 'object'
        || !Number.isSafeInteger(parent.expiresAt) || parent.expiresAt < expiresAt
        || typeof parent.origin !== 'string' || typeof parent.redirectUri !== 'string'
        || (payload.flow === 'explorer' && (!parent.requestId || !parent.state))
        || (payload.flow === 'oidc' && (!parent.uid || !parent.clientId))
        || (payload.flow === 'reauth' && (typeof parent.userId !== 'string' || !parent.userId
            || !Number.isSafeInteger(parent.generation) || parent.generation < 0
            || !['passkey.register', 'totp.enroll', 'contact.verify'].includes(parent.operation)))
        || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + GOOGLE_TRANSACTION_TTL_MS) {
        throw transactionError();
    }
    const origin = new URL(parent.origin);
    const redirect = new URL(parent.redirectUri, parent.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== parent.origin
        || origin.username || origin.password || redirect.username || redirect.password) throw transactionError();
}

async function cleanExpired(store, now) {
    const result = await store.select('googleAuthTransaction', {}, { sortBy: 'expiresAt', start: 0, pageSize: 64 });
    const expired = result.objects.filter((record) => Number.isSafeInteger(record.expiresAt) && record.expiresAt <= now);
    if (expired.length) {
        await commitStagedPersistence(async () => {
            for (const record of expired) await store.deleteGoogleAuthTransaction(record.id);
        });
    }
}

function decodeRecord(record, { browserProof, configFingerprint, statuses } = {}) {
    if (!record || !HASH_PATTERN.test(record.stateHash) || record.version !== GOOGLE_TRANSACTION_VERSION
        || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= Date.now()
        || TERMINAL.has(record.status) || !TRANSITIONS[record.status]) throw transactionError();
    if (typeof browserProof !== 'string' || !RANDOM_PATTERN.test(browserProof)
        || typeof configFingerprint !== 'string' || !configFingerprint) throw transactionError();
    const payload = decryptOidcPayload(record.payload, context(record));
    if (typeof payload?.browserProofHash !== 'string' || !HASH_PATTERN.test(payload.browserProofHash)
        || !timingSafeEqual(Buffer.from(payload.browserProofHash, 'hex'), Buffer.from(digest(browserProof), 'hex'))
        || payload.configFingerprint !== configFingerprint
        || (statuses && !statuses.includes(record.status))) throw transactionError();
    return { handle: record.stateHash, stateHash: record.stateHash, status: record.status, expiresAt: record.expiresAt, payload };
}

async function readInternal(handle, options) {
    if (typeof handle !== 'string' || !HASH_PATTERN.test(handle)) throw transactionError();
    const store = await getStore();
    const record = await store.getGoogleAuthTransactionByStateHash(handle);
    return { record, decoded: decodeRecord(record, options) };
}

export function createGoogleTransaction({ state, browserProof, expiresAt, configFingerprint, payload }) {
    const stateHash = hashGoogleState(state);
    if (typeof browserProof !== 'string' || !RANDOM_PATTERN.test(browserProof)
        || typeof configFingerprint !== 'string' || !configFingerprint || configFingerprint.length > 512) throw transactionError();
    const now = Date.now();
    validatePayload(payload, expiresAt, now);
    // Global creation exclusion makes the per-parent issuance bound apply to
    // simultaneous starts, while each attempt retains its independent proof.
    return serializePersisted('google-transactions:create', async () => {
        const store = await getStore();
        await cleanExpired(store, now);
        if (await store.getGoogleAuthTransactionByStateHash(stateHash)) throw transactionError();
        let activeForParent = 0;
        let offset = 0;
        while (true) {
            const page = await store.select('googleAuthTransaction', {}, { start: offset, pageSize: 100 });
            for (const record of page.objects) {
                if (record.expiresAt > now && !TERMINAL.has(record.status)) {
                    const previous = decryptOidcPayload(record.payload, context(record));
                    if (parentKey(previous) === parentKey(payload)) activeForParent += 1;
                }
            }
            offset += page.objects.length;
            if (activeForParent >= 3 || offset >= 5000) throw transactionError('google_transaction_limit', 429);
            if (page.objects.length < 100) break;
        }
        const nextPayload = {
            ...structuredClone(payload),
            browserProofHash: digest(browserProof),
            configFingerprint,
            createdAt: now,
        };
        const record = { stateHash, status: 'pending', expiresAt, version: GOOGLE_TRANSACTION_VERSION };
        const encrypted = encryptOidcPayload(nextPayload, context(record));
        await commitStagedPersistence(() => store.createGoogleAuthTransaction({ ...record, payload: encrypted }));
        return { handle: stateHash, ...record, payload: nextPayload };
    });
}

export function readGoogleTransaction(handle, options) {
    return serializePersisted(`google-transaction:${handle}`, async () => {
        const store = await getStore();
        await cleanExpired(store, Date.now());
        return (await readInternal(handle, options)).decoded;
    });
}

// The caller must hold the persistence scope continuously through preparation
// and staging. Validate deadlines before any identity mutation, so natural
// expiry cannot turn an otherwise atomic save into a poisoned store.
export async function prepareGoogleTransactionTransition(handle, options, { from, to, patch = {} }) {
    const { record, decoded } = await readInternal(handle, options);
    const allowedFrom = Array.isArray(from) ? from : [from];
    if (!allowedFrom.includes(record.status) || !TRANSITIONS[record.status]?.has(to)
        || !patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some((key) => IMMUTABLE_PAYLOAD_FIELDS.has(key))) throw transactionError();
    const payload = { ...decoded.payload, ...structuredClone(patch) };
    if (to === 'verified') {
        delete payload.verifier;
        delete payload.pkceCodeVerifier;
        delete payload.nonce;
    }
    const next = { ...record, status: to };
    const encrypted = TERMINAL.has(to) ? '' : encryptOidcPayload(payload, context(next));
    const store = await getStore();
    return async () => {
        await store.updateGoogleAuthTransaction(record.id, { status: to, payload: encrypted });
        return { ...decoded, status: to, payload: TERMINAL.has(to) ? null : payload };
    };
}

export function transitionGoogleTransaction(handle, options, transition) {
    return serializePersisted(`google-transaction:${handle}`, async () => {
        // Check expected-state errors before entering staging, so a callback
        // replay or another browser's wrong proof cannot poison valid work.
        const stage = await prepareGoogleTransactionTransition(handle, options, transition);
        return commitStagedPersistence(stage);
    });
}
