/**
 * Client API key authentication.
 *
 * Extracts the bearer token, hashes it with HMAC-SHA256 + pepper,
 * looks it up in the database, and validates status / expiry.
 */

import { createHmac } from 'node:crypto';
import * as apiKeysDao from '../../db/dao/api-keys-dao.mjs';
import {
    AuthenticationRequiredError,
    InvalidApiKeyError,
    ExpiredApiKeyError,
    RevokedApiKeyError,
} from '../../core/errors.mjs';

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
 * If API_KEY_HASH_PEPPER is explicitly set, use it.
 * Otherwise fall back to ENCRYPTION_KEY.
 *
 * @param {{ API_KEY_HASH_PEPPER: string|null, ENCRYPTION_KEY: string|null }} config
 * @returns {string}
 */
export function derivePepper(config) {
    if (config.API_KEY_HASH_PEPPER) return config.API_KEY_HASH_PEPPER;
    if (config.ENCRYPTION_KEY) return config.ENCRYPTION_KEY;
    throw new Error(
        'Neither API_KEY_HASH_PEPPER nor ENCRYPTION_KEY is configured'
    );
}
