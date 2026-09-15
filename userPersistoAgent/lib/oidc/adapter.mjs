import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { errors } from 'oidc-provider';
import { getStore, flush } from '../store.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { encryptOidcPayload, decryptOidcPayload } from './secrets.mjs';

const operationOwnership = new AsyncLocalStorage();
let operationTail = Promise.resolve();
const nextExpirySweep = new WeakMap();
const EXPIRY_SWEEP_BATCH = 100;

// The provider invokes model revocations concurrently inside one request's
// persistence scope. Keep each adapter read/change/save indivisible there too.
function withOidcOperation(operation) {
    return withPersistenceScope(async () => {
        if (operationOwnership.getStore()?.active) return operation();
        const previous = operationTail;
        let release;
        operationTail = new Promise((resolve) => { release = resolve; });
        await previous;
        const owner = { active: true };
        try {
            return await operationOwnership.run(owner, operation);
        } finally {
            owner.active = false;
            release();
        }
    });
}

export function oidcIndex(kind, value) {
    return value ? createHash('sha256').update(`${kind}\0${String(value)}`).digest('hex') : '';
}

function keyFor(model, id) {
    if (typeof id !== 'string' || !id || !/^[A-Za-z][A-Za-z0-9]*$/.test(model)) throw new TypeError('Invalid OIDC record identifier.');
    return oidcIndex(model, id);
}

function decryptRecord(record) {
    return decryptOidcPayload(record.payload, `oidc:${record.model}:${record.recordKey}`);
}

async function sweepExpiredRecords(store) {
    const now = Date.now();
    if ((nextExpirySweep.get(store) || 0) > now) return;
    const result = await store.select('oidcRecord', { expiresAt: { $gt: 0, $lte: now } }, { start: 0, pageSize: EXPIRY_SWEEP_BATCH });
    for (const record of result.objects || []) await store.deleteOidcRecord(record.id);
    // A backlog is drained in bounded batches on subsequent writes. When it is
    // empty, at most one full expiry scan per minute is added to ordinary writes.
    nextExpirySweep.set(store, result.filteredCount > EXPIRY_SWEEP_BATCH ? now : now + 60_000);
}

async function liveRecord(store, model, id) {
    const record = await store.getOidcRecordByRecordKey(keyFor(model, id));
    if (!record) return undefined;
    if (record.expiresAt && record.expiresAt <= Date.now()) {
        await store.deleteOidcRecord(record.id);
        await flush();
        return undefined;
    }
    return record;
}

export async function readOidcDocument(model, id) {
    return withOidcOperation(async () => {
        const record = await liveRecord(await getStore(), model, id);
        return record ? decryptRecord(record) : undefined;
    });
}

export async function writeOidcDocument(model, id, payload, expiresIn, { persist = true } = {}) {
    return withOidcOperation(async () => {
        if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn < 0)) throw new TypeError('Invalid OIDC record lifetime.');
        const store = await getStore();
        await sweepExpiredRecords(store);
        const recordKey = keyFor(model, id);
        const previous = await store.getOidcRecordByRecordKey(recordKey);
        const data = structuredClone(payload);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Invalid OIDC record payload.');
        if (previous && ['AuthorizationCode', 'RefreshToken', 'DeviceCode'].includes(model)) {
            const consumed = decryptRecord(previous).consumed;
            if (consumed) data.consumed = consumed;
        }
        const clientId = data.clientId || data.params?.client_id;
        const record = {
            recordKey,
            model,
            payload: encryptOidcPayload(data, `oidc:${model}:${recordKey}`),
            expiresAt: expiresIn === undefined ? 0 : Date.now() + Math.floor(expiresIn * 1000),
            grantHash: oidcIndex('grant', data.grantId),
            clientHash: oidcIndex('client', clientId),
            uidHash: oidcIndex(`${model}:uid`, data.uid),
            userCodeHash: oidcIndex(`${model}:userCode`, data.userCode),
        };
        if (previous) await store.updateOidcRecord(previous.id, record);
        else await store.createOidcRecord(record);
        if (persist) await flush();
    });
}

export async function removeOidcDocument(model, id, { persist = true } = {}) {
    return withOidcOperation(async () => {
        const store = await getStore();
        const existing = await store.getOidcRecordByRecordKey(keyFor(model, id));
        if (existing) {
            await store.deleteOidcRecord(existing.id);
            if (persist) await flush();
        }
    });
}

export async function listOidcDocuments(model) {
    return withOidcOperation(async () => {
        const store = await getStore();
        const records = await store.getOidcModelsObjectsByModel(model) || [];
        return records.filter((record) => !record.expiresAt || record.expiresAt > Date.now()).map(decryptRecord);
    });
}

async function revokeGrant(grantId, { persist = true } = {}) {
    const store = await getStore();
    const records = await store.getOidcGrantsObjectsByGrantHash(oidcIndex('grant', grantId)) || [];
    const grant = await store.getOidcRecordByRecordKey(keyFor('Grant', grantId));
    const previousMarker = await store.getOidcRecordByRecordKey(keyFor('RevokedGrant', grantId));
    let expiresAt = Math.max(Date.now() + 60_000, previousMarker?.expiresAt || 0);
    const distinctRecords = new Map([...records, ...(grant ? [grant] : [])].map((record) => [record.id, record]));
    for (const record of distinctRecords.values()) {
        expiresAt = Math.max(expiresAt, record.expiresAt);
        if (await store.getOidcRecordByRecordKey(record.recordKey)) await store.deleteOidcRecord(record.id);
    }
    // Reject a request that loaded this grant before revocation and saves later.
    await writeOidcDocument('RevokedGrant', grantId, { revoked: true }, (expiresAt - Date.now()) / 1000, { persist });
}

export async function revokeOidcClientArtifacts(clientId, { persist = true } = {}) {
    return withOidcOperation(async () => {
        const store = await getStore();
        const records = await store.getOidcClientsObjectsByClientHash(oidcIndex('client', clientId)) || [];
        const grantIds = new Set();
        for (const record of records) {
            const payload = decryptRecord(record);
            if (record.model === 'Grant' && payload.jti) grantIds.add(payload.jti);
            if (payload.grantId) grantIds.add(payload.grantId);
        }
        for (const grantId of grantIds) await revokeGrant(grantId, { persist: false });
        for (const record of records) {
            if (await store.getOidcRecordByRecordKey(record.recordKey)) await store.deleteOidcRecord(record.id);
        }
        if (persist) await flush();
    });
}

const ACCOUNT_MODELS = ['Session', 'Grant', 'AccessToken', 'RefreshToken', 'AuthorizationCode', 'Interaction'];

// Credential replacement or revocation ends stored OIDC state for the account.
// Self-contained ID tokens are not stored and remain valid until they expire.
export async function revokeOidcAccountArtifacts(accountId, { persist = true } = {}) {
    if (typeof accountId !== 'string' || !accountId) return;
    return withOidcOperation(async () => {
        const store = await getStore();
        const grantIds = new Set();
        const doomed = [];
        for (const model of ACCOUNT_MODELS) {
            for (const record of await store.getOidcModelsObjectsByModel(model) || []) {
                const payload = decryptRecord(record);
                if (payload?.accountId !== accountId && payload?.result?.login?.accountId !== accountId
                    && payload?.session?.accountId !== accountId) continue;
                if (model === 'Grant' && payload.jti) grantIds.add(payload.jti);
                if (payload.grantId) grantIds.add(payload.grantId);
                for (const authorization of Object.values(payload.authorizations || {})) {
                    if (authorization?.grantId) grantIds.add(authorization.grantId);
                }
                doomed.push(record);
            }
        }
        for (const grantId of grantIds) await revokeGrant(grantId, { persist: false });
        for (const record of doomed) {
            if (await store.getOidcRecordByRecordKey(record.recordKey)) await store.deleteOidcRecord(record.id);
        }
        if (persist) await flush();
    });
}

export default class PersistoOidcAdapter {
    constructor(model) {
        this.model = model;
    }

    async upsert(id, payload, expiresIn) {
        return withOidcOperation(async () => {
            if (this.model === 'Client') throw new errors.InvalidClientMetadata('Clients must be managed through administrator tools.');
            const grantId = this.model === 'Grant' ? id : payload.grantId;
            if (grantId && await readOidcDocument('RevokedGrant', grantId)) throw new errors.InvalidGrant('grant was revoked');
            if (payload.grantId && !await readOidcDocument('Grant', payload.grantId)) throw new errors.InvalidGrant('grant is unavailable');
            const clientId = payload.clientId || payload.params?.client_id;
            if (clientId) {
                const client = await readOidcDocument('Client', clientId);
                if (!client?.enabled) throw new errors.InvalidClient('client is unavailable');
            }
            await writeOidcDocument(this.model, id, payload, expiresIn);
        });
    }

    async find(id) {
        if (typeof id !== 'string' || !id) return undefined;
        const payload = await readOidcDocument(this.model, id);
        if (this.model === 'Client') return payload?.enabled ? payload.metadata : undefined;
        return payload;
    }

    async findByUid(uid) {
        return this.findSecondary('uidHash', `${this.model}:uid`, uid);
    }

    async findByUserCode(userCode) {
        return this.findSecondary('userCodeHash', `${this.model}:userCode`, userCode);
    }

    async findSecondary(field, kind, value) {
        if (typeof value !== 'string' || !value) return undefined;
        return withOidcOperation(async () => {
            const store = await getStore();
            const result = await store.select('oidcRecord', { model: this.model, [field]: oidcIndex(kind, value) }, { start: 0, pageSize: 1 });
            const record = result.objects?.[0];
            if (!record) return undefined;
            if (record.expiresAt && record.expiresAt <= Date.now()) {
                await store.deleteOidcRecord(record.id);
                await flush();
                return undefined;
            }
            return decryptRecord(record);
        });
    }

    async consume(id) {
        return withOidcOperation(async () => {
            const store = await getStore();
            const record = await liveRecord(store, this.model, id);
            if (!record) throw new errors.InvalidGrant('token is unavailable');
            const payload = decryptRecord(record);
            if (payload.consumed) {
                if (payload.grantId) await revokeGrant(payload.grantId);
                throw new errors.InvalidGrant('token was already consumed');
            }
            payload.consumed = Math.floor(Date.now() / 1000);
            await store.updateOidcRecord(record.id, { ...record, payload: encryptOidcPayload(payload, `oidc:${record.model}:${record.recordKey}`) });
            await flush();
        });
    }

    async destroy(id) {
        return withOidcOperation(async () => {
            if (this.model === 'Grant') await revokeGrant(id);
            else await removeOidcDocument(this.model, id);
        });
    }

    async revokeByGrantId(grantId) {
        if (typeof grantId !== 'string' || !grantId) return;
        return withOidcOperation(() => revokeGrant(grantId));
    }
}
