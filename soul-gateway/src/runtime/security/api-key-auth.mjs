/**
 * Client API key authentication — signed-subject only.
 *
 * The only accepted bearer token is a Ploinky-minted signed-subject key of the
 * exact shape `<subjectId>|<signature>`, where the signature is an Ed25519
 * signature over the *exact UTF-8 bytes of subjectId and nothing else*. This
 * verifier is independent of (but byte-compatible with) the Ploinky signer in
 * `ploinky/cli/services/soulGatewaySubjectKey.js`:
 *   - public key: raw 32-byte Ed25519 key, base64url (no padding), supplied via
 *     `config.env.PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY`;
 *   - subject ids: `agent:<repo>/<agentName>` or `user:<userId>`, validated with
 *     the same anchored regexes the signer uses.
 *
 * On a valid request we upsert a deterministic `api_keys` row (one per subject)
 * and return a normalized auth subject. The row carries the FK id, limits, and
 * budgets the rest of the pipeline reads, plus the normalized
 * `{ subjectId, subjectType, apiKeyId, apiKeySource }` fields.
 *
 * Revocation semantics:
 *   - Revoking the DB row blocks that deterministic key (denied below; never
 *     reactivated).
 *   - Deleting the DB row permits recreation on the next valid signed request.
 *   - Per-subject rotation requires changing the subject id (the key is
 *     deterministic for a given subject + signing key).
 *   - Rotating the Ploinky signing key invalidates all signed-subject keys at
 *     once (every signature fails against the new public key).
 */

import { createHmac, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import * as apiKeysDao from '../../db/dao/api-keys-dao.mjs';
import { ensureEncryptionKey } from './encryption.mjs';
import {
    AuthenticationRequiredError,
    InvalidApiKeyError,
    ExpiredApiKeyError,
    RevokedApiKeyError,
} from '../../core/errors.mjs';

// Fixed 12-byte DER prefix for an Ed25519 SubjectPublicKeyInfo (RFC 8410). A raw
// 32-byte Ed25519 public key is exactly these bytes followed by the key bytes,
// so a base64url raw-32 key rebuilds into a usable KeyObject by re-prepending
// this prefix. Must stay byte-identical to the Ploinky signer's encoding.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PUBLIC_KEY_BYTES = 32;

// Subject validators — anchored end-to-end, identical to the Ploinky signer so
// a key minted there classifies the same way here. The segment alphabet
// excludes '/' and '|' so an agent id cannot smuggle a second slash and a user
// id cannot contain a slash.
const SEGMENT = '[A-Za-z0-9._:-]+';
const AGENT_SUBJECT_RE = new RegExp(`^agent:(${SEGMENT})/(${SEGMENT})$`);
const USER_SUBJECT_RE = new RegExp(`^user:(${SEGMENT})$`);

const SIGNED_SUBJECT_DEFAULT_RPM_LIMIT = 60;
const SIGNED_SUBJECT_DEFAULT_TPM_LIMIT = 100000;

/**
 * Authenticate an incoming request by its signed-subject API key.
 *
 * @param {string|null|undefined} authHeader  Raw Authorization header value.
 * @param {{ config: { env: object }, pool: object }} appCtx  Application context.
 * @returns {Promise<object>} Normalized auth subject merged onto the api_keys
 *   row: { ...row, subjectId, subjectType, apiKeyId, apiKeySource }.
 * @throws {AuthenticationRequiredError} missing / malformed header.
 * @throws {InvalidApiKeyError}          missing public key, malformed key,
 *                                       invalid subject, or failed signature.
 * @throws {RevokedApiKeyError}          resulting row has status 'revoked'.
 * @throws {ExpiredApiKeyError}          row has passed its expires_at.
 */
export async function authenticateApiKey(authHeader, appCtx) {
    const env = appCtx.config.env;

    // 1. Extract bearer token.
    const token = extractBearerToken(authHeader);

    // 2. Require the Ploinky public key. Without it signed-subject auth cannot
    //    verify anything, so reject rather than silently accepting.
    const publicKeyB64 = env.PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY;
    if (!publicKeyB64) {
        throw new InvalidApiKeyError(
            'Signed-subject auth is not configured: PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY is missing'
        );
    }

    // 3. Parse <subjectId>|<signature>.
    const { subjectId, signature } = parseSignedSubjectApiKey(token);

    // 4. Classify the subject BEFORE doing signature math.
    const subjectType = classifySubjectType(subjectId);

    // 5. Verify the Ed25519 signature over the exact subject bytes.
    const publicKeyObject = publicKeyObjectFromBase64url(publicKeyB64);
    if (!verifySignedSubject(subjectId, signature, publicKeyObject)) {
        throw new InvalidApiKeyError('Signed subject API key signature is invalid');
    }

    // 6. Upsert the deterministic row for this subject. The key hash is computed
    //    here (the pepper stays in the security layer) and passed to the DAO.
    const pepper = derivePepper(env);
    const keyHash = hashApiKey(token, pepper);
    const row = await apiKeysDao.createSignedSubjectKeyRecord(appCtx.pool, {
        keyHash,
        subjectId,
        subjectType,
        keyHint: buildKeyHint(subjectId),
        rpmLimit: SIGNED_SUBJECT_DEFAULT_RPM_LIMIT,
        tpmLimit: SIGNED_SUBJECT_DEFAULT_TPM_LIMIT,
    });

    if (!row) {
        // Should not happen: create() returns the row, and the post-conflict
        // re-read found nothing only if the row was deleted between the
        // conflict and the re-read. Treat as a transient invalid key.
        throw new InvalidApiKeyError();
    }

    // 7. Deny revoked rows; never reactivate them.
    if (row.status === 'revoked') {
        throw new RevokedApiKeyError();
    }

    // 8. Honor an explicit expiry if one was set on the row.
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
        throw new ExpiredApiKeyError();
    }

    // 9. Fire-and-forget last_used_at update (don't slow down the request).
    apiKeysDao.updateLastUsed(appCtx.pool, row.id).catch(() => {});

    return {
        ...row,
        subjectId,
        subjectType,
        apiKeyId: row.id,
        apiKeySource: 'signed-subject',
    };
}

// ── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a signed-subject API key of the form `<subjectId>|<signature>`.
 *
 * Rejects a missing/empty subject, a missing/empty signature, and any key with
 * more than one delimiter.
 *
 * @param {string} rawKey
 * @returns {{ subjectId: string, signature: string }}
 * @throws {InvalidApiKeyError}
 */
export function parseSignedSubjectApiKey(rawKey) {
    const delimiter = rawKey.indexOf('|');
    if (delimiter <= 0 || delimiter === rawKey.length - 1) {
        throw new InvalidApiKeyError(
            'Signed subject API key must use <subjectId>|<signature>'
        );
    }
    if (rawKey.indexOf('|', delimiter + 1) !== -1) {
        throw new InvalidApiKeyError(
            'Signed subject API key must contain exactly one delimiter'
        );
    }
    return {
        subjectId: rawKey.slice(0, delimiter),
        signature: rawKey.slice(delimiter + 1),
    };
}

// ── Subject classification ──────────────────────────────────────────

/**
 * Classify a subject id into 'agent' or 'user', matching the Ploinky signer's
 * anchored validators. Anything else is rejected.
 *
 * @param {string} subjectId
 * @returns {'agent'|'user'}
 * @throws {InvalidApiKeyError}
 */
export function classifySubjectType(subjectId) {
    if (AGENT_SUBJECT_RE.test(subjectId)) return 'agent';
    if (USER_SUBJECT_RE.test(subjectId)) return 'user';
    throw new InvalidApiKeyError(
        'Signed subject id must match agent:<repo>/<agentName> or user:<userId>'
    );
}

// ── Ed25519 verification ────────────────────────────────────────────

/**
 * Rebuild an Ed25519 public KeyObject from a base64url raw-32-byte key.
 *
 * @param {string} b64
 * @returns {import('node:crypto').KeyObject}
 * @throws {InvalidApiKeyError}
 */
export function publicKeyObjectFromBase64url(b64) {
    const raw = Buffer.from(String(b64 || ''), 'base64url');
    if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
        throw new InvalidApiKeyError(
            'PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY must decode to 32 raw Ed25519 bytes'
        );
    }
    try {
        return createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
            format: 'der',
            type: 'spki',
        });
    } catch {
        throw new InvalidApiKeyError(
            'PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY could not be parsed as Ed25519'
        );
    }
}

/**
 * Verify an Ed25519 signature (base64url) over the exact UTF-8 bytes of the
 * subject id. Returns false on any malformed signature or verification failure.
 *
 * @param {string} subjectId
 * @param {string} signatureB64url
 * @param {import('node:crypto').KeyObject} publicKeyObject
 * @returns {boolean}
 */
export function verifySignedSubject(subjectId, signatureB64url, publicKeyObject) {
    const signature = Buffer.from(String(signatureB64url || ''), 'base64url');
    if (signature.length === 0) return false;
    try {
        return cryptoVerify(
            null,
            Buffer.from(subjectId, 'utf8'),
            publicKeyObject,
            signature
        );
    } catch {
        return false;
    }
}

// ── Exported helpers (also used in key generation) ──────────────────

/**
 * Extract a bearer token from the Authorization header.
 *
 * @param {string|null|undefined} authHeader
 * @returns {string} The raw token string.
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
 * @param {string} token  The raw API key.
 * @param {string} pepper The HMAC pepper.
 * @returns {string} hex-encoded hash.
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

function buildKeyHint(value) {
    const str = String(value || '');
    if (str.length <= 12) return str;
    return `${str.slice(0, 8)}...${str.slice(-4)}`;
}
