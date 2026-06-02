/**
 * Client API key authentication.
 *
 * Extracts the bearer token, hashes it with HMAC-SHA256 + pepper,
 * looks it up in the database, and validates status / expiry.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import * as apiKeysDao from '../../db/dao/api-keys-dao.mjs';
import { encrypt, ensureEncryptionKey } from './encryption.mjs';
import {
    AuthenticationRequiredError,
    InvalidApiKeyError,
    ExpiredApiKeyError,
    RevokedApiKeyError,
} from '../../core/errors.mjs';

const WORKSPACE_API_KEY_DB_RPM_LIMIT = 60;
const WORKSPACE_API_KEY_DB_TPM_LIMIT = 100000;

/**
 * Authenticate an incoming request by its API key.
 *
 * @param {string|null|undefined} authHeader  The raw Authorization header value
 * @param {{ config: object, pool: object }} appCtx  Application context
 * @returns {Promise<object>} The api_keys row record
 * @throws {AuthenticationRequiredError} missing / malformed header
 * @throws {InvalidApiKeyError}          key not found in database
 * @throws {RevokedApiKeyError}          key has status 'revoked'
 * @throws {ExpiredApiKeyError}          key has passed its expires_at
 */
export async function authenticateApiKey(authHeader, appCtx) {
    // 1. Extract bearer token
    const token = extractBearerToken(authHeader);

    // 1b. Ploinky workspace key: auto-persist when a DB is available so
    // sessions, budgets, and audit rows keep a real FK-compatible key id.
    if (matchWorkspaceKey(token, appCtx.config.env)) {
        return ensureWorkspaceApiKeyRecord(token, appCtx);
    }

    // 2. HMAC the token
    const pepper = derivePepper(appCtx.config.env);
    const keyHash = hashApiKey(token, pepper);

    // 3. Lookup
    const keyRecord = await apiKeysDao.findByHash(appCtx.pool, keyHash);
    if (!keyRecord) {
        throw new InvalidApiKeyError();
    }

    // 4. Check status
    if (keyRecord.status === 'revoked') {
        throw new RevokedApiKeyError();
    }

    // 5. Check expiry
    if (keyRecord.expires_at && new Date(keyRecord.expires_at) <= new Date()) {
        throw new ExpiredApiKeyError();
    }

    // 6. Fire-and-forget last_used_at update (don't slow down the request)
    apiKeysDao.updateLastUsed(appCtx.pool, keyRecord.id).catch(() => {});

    return keyRecord;
}

// ── Exported helpers (also used in key generation) ──────────────────

/**
 * Extract a bearer token from the Authorization header.
 *
 * @param {string|null|undefined} authHeader
 * @returns {string} The raw token string
 * @throws {AuthenticationRequiredError}
 */
export function extractBearerToken(authHeader) {
    if (!authHeader) {
        throw new AuthenticationRequiredError('Missing Authorization header');
    }

    if (!authHeader.startsWith('Bearer ')) {
        throw new AuthenticationRequiredError(
            'Authorization header must use Bearer scheme'
        );
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
        throw new AuthenticationRequiredError('Bearer token is empty');
    }

    return token;
}

/**
 * HMAC-SHA256 hash an API key with the pepper.
 *
 * @param {string} token  The raw API key
 * @param {string} pepper The HMAC pepper
 * @returns {string} hex-encoded hash
 */
export function hashApiKey(token, pepper) {
    return createHmac('sha256', pepper).update(token).digest('hex');
}

/**
 * Derive the pepper used for API key hashing.
 *
 * If API_KEY_HASH_PEPPER is explicitly set, use it. Otherwise fall back to
 * ENCRYPTION_KEY, then to the persisted encryption key under DATA_DIR.
 *
 * @param {{ API_KEY_HASH_PEPPER: string|null, ENCRYPTION_KEY: string|null, DATA_DIR?: string }} config
 * @returns {string}
 */
export function derivePepper(config) {
    if (config.API_KEY_HASH_PEPPER) return config.API_KEY_HASH_PEPPER;
    if (config.ENCRYPTION_KEY) return config.ENCRYPTION_KEY;
    if (config.DATA_DIR) return ensureEncryptionKey(config).toString('base64');
    throw new Error(
        'Neither API_KEY_HASH_PEPPER, ENCRYPTION_KEY, nor DATA_DIR encryption key is configured'
    );
}

function matchWorkspaceKey(token, env) {
    const expected = env.SOUL_GATEWAY_API_KEY;
    if (!expected) return null;

    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

async function ensureWorkspaceApiKeyRecord(token, appCtx) {
    const env = appCtx.config.env;
    const hasPersistentDb = Boolean(appCtx.pool);
    if (!hasPersistentDb) {
        return buildWorkspaceApiKeyRecord();
    }

    const pepper = derivePepper(env);
    const keyHash = hashApiKey(token, pepper);
    const existing = await apiKeysDao.findByHash(appCtx.pool, keyHash);
    if (existing) {
        return normalizeWorkspaceApiKeyRecord(existing);
    }

    const encryptionKey =
        appCtx.services?.encryptionKey || ensureEncryptionKey(env);
    const {
        ciphertext: keyCiphertext,
        iv: keyIv,
        authTag: keyAuthTag,
    } = encrypt(token, encryptionKey);

    try {
        const row = await apiKeysDao.create(appCtx.pool, {
            label: 'workspace-default',
            keyHash,
            keyCiphertext,
            keyIv,
            keyAuthTag,
            keyHint: buildKeyHint(token),
            rpmLimit: WORKSPACE_API_KEY_DB_RPM_LIMIT,
            tpmLimit: WORKSPACE_API_KEY_DB_TPM_LIMIT,
            dailyBudgetUsd: null,
            monthlyBudgetUsd: null,
            expiresAt: null,
            metadata: {
                workspaceDefault: true,
                synthetic: true,
                managedBy: 'soul-gateway',
            },
        });
        return normalizeWorkspaceApiKeyRecord(row);
    } catch (err) {
        // A concurrent writer won the race on the key_hash unique index.
        // node:sqlite surfaces this as ERR_SQLITE_ERROR with extended result
        // code 2067 (SQLITE_CONSTRAINT_UNIQUE) and a "UNIQUE constraint failed"
        // message; SQLSTATE 23505 is kept for compatibility. In all cases re-read the row
        // that now exists instead of failing the request.
        const isUniqueViolation =
            err?.errcode === 2067 ||
            /UNIQUE constraint failed/i.test(err?.message || '') ||
            err?.code === '23505';
        if (isUniqueViolation) {
            const row = await apiKeysDao.findByHash(appCtx.pool, keyHash);
            if (row) return normalizeWorkspaceApiKeyRecord(row);
        }
        throw err;
    }
}

function buildKeyHint(token) {
    const value = String(token || '');
    if (value.length <= 12) return value;
    return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function buildWorkspaceApiKeyRecord(fields = {}) {
    return {
        ...fields,
        id: fields.id || 'workspace-default',
        label: fields.label || 'workspace-default',
        name: fields.name || fields.label || 'workspace-default',
        status: 'active',
        expires_at: null,
        daily_budget_usd: null,
        monthly_budget_usd: null,
        rpm_limit: null,
        tpm_limit: null,
        synthetic: true,
    };
}

function normalizeWorkspaceApiKeyRecord(row) {
    return buildWorkspaceApiKeyRecord({
        ...row,
        label: row.label || 'workspace-default',
        name: row.name || row.label || 'workspace-default',
    });
}

export function isWorkspaceDefaultKeyRecord(row) {
    if (!row) return false;
    const metadata = normalizeMetadata(row.metadata);
    return (
        row.id === 'workspace-default' ||
        row.label === 'workspace-default' ||
        metadata.workspaceDefault === true ||
        metadata.embedded === true ||
        metadata.managedBy === 'soul-gateway'
    );
}

export function buildWorkspaceDefaultApiKeyManagementRecord(row = {}) {
    const metadata = {
        ...normalizeMetadata(row.metadata),
        workspaceDefault: true,
        synthetic: true,
        managedBy: 'soul-gateway',
    };

    return {
        ...row,
        id: row.id || 'workspace-default',
        label: row.label || 'workspace-default',
        name: row.name || row.label || 'workspace-default',
        status: 'active',
        key_hint: null,
        keyHint: null,
        rpm_limit: null,
        rpmLimit: null,
        tpm_limit: null,
        tpmLimit: null,
        daily_budget_usd: null,
        dailyBudgetUsd: null,
        monthly_budget_usd: null,
        monthlyBudgetUsd: null,
        expires_at: null,
        expiresAt: null,
        metadata,
        synthetic: true,
        managed: true,
        revocable: false,
        revealable: false,
    };
}

function normalizeMetadata(metadata) {
    if (!metadata) return {};
    if (typeof metadata === 'object' && !Array.isArray(metadata)) {
        return metadata;
    }
    if (typeof metadata === 'string') {
        try {
            const parsed = JSON.parse(metadata);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : {};
        } catch {
            return {};
        }
    }
    return {};
}

export const isEmbeddedWorkspaceKeyRecord = isWorkspaceDefaultKeyRecord;
export const buildEmbeddedApiKeyManagementRecord =
    buildWorkspaceDefaultApiKeyManagementRecord;
