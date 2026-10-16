/**
 * Client API key authentication — signed-subject only.
 *
 * The only accepted bearer token is a Ploinky-minted signed-subject key of the
 * exact shape `<subjectId>|<signature>`, where the signature is an Ed25519
 * signature over the *exact UTF-8 bytes of subjectId and nothing else*. This
 * verifier is independent of (but byte-compatible with) the Ploinky signer in
 * `ploinky/cli/services/subjectIdentityKey.js`:
 *   - public key: raw 32-byte Ed25519 key, base64url (no padding), supplied via
 *     `config.env.PLOINKY_AGENT_API_PUBLIC_KEY`;
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

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import * as apiKeysDao from '../../db/dao/api-keys-dao.mjs';
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
const ENCODED_USER_API_KEY_PREFIX = 'sk-soul-';
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

// Subject validators — anchored end-to-end, identical to the Ploinky signer so
// a key minted there classifies the same way here. The segment alphabet
// excludes '/' and '|' so an agent id cannot smuggle a second slash and a user
// id cannot contain a slash.
const SEGMENT = '[A-Za-z0-9._:-]+';
const AGENT_SUBJECT_RE = new RegExp(`^agent:(${SEGMENT})/(${SEGMENT})$`);
const USER_SUBJECT_RE = new RegExp(`^user:(${SEGMENT})$`);

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
    const publicKeyB64 = env.PLOINKY_AGENT_API_PUBLIC_KEY;
    if (!publicKeyB64) {
        throw new InvalidApiKeyError(
            'Signed-subject auth is not configured: PLOINKY_AGENT_API_PUBLIC_KEY is missing'
        );
    }

    // 3. Parse the inbound public token. User keys must be encoded as
    //    sk-soul-<base64url(raw signed-subject key)>; agent keys remain raw.
    const { subjectId, signature, subjectType } = parseInboundApiKeyToken(token);

    // 5. Verify the Ed25519 signature over the exact subject bytes.
    const publicKeyObject = publicKeyObjectFromBase64url(publicKeyB64);
    if (!verifySignedSubject(subjectId, signature, publicKeyObject)) {
        throw new InvalidApiKeyError('Signed subject API key signature is invalid');
    }

    // 6. Find-or-create the deterministic row for this subject, keyed on
    //    subject_id. The signature check above is the security gate; no key
    //    material is hashed or stored.
    const row = await apiKeysDao.upsertSignedSubjectKey(appCtx.pool, {
        subjectId,
        subjectType,
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
 * Parse the inbound public bearer token.
 *
 * User keys are public wrappers: sk-soul-<base64url(user:<id>|<sig>)>.
 * Agent keys keep the raw signed-subject format because they are injected into
 * agent runtime env by Ploinky.
 *
 * @param {string} token
 * @returns {{ subjectId: string, signature: string, subjectType: 'agent'|'user' }}
 * @throws {InvalidApiKeyError}
 */
export function parseInboundApiKeyToken(token) {
    if (String(token || '').startsWith(ENCODED_USER_API_KEY_PREFIX)) {
        const decoded = decodeEncodedUserApiKey(token);
        const parsed = parseSignedSubjectApiKey(decoded);
        const subjectType = classifySubjectType(parsed.subjectId);
        if (subjectType !== 'user') {
            throw new InvalidApiKeyError(
                'Encoded API keys must contain a user signed-subject key'
            );
        }
        return { ...parsed, subjectType };
    }

    const parsed = parseSignedSubjectApiKey(token);
    const subjectType = classifySubjectType(parsed.subjectId);
    if (subjectType === 'user') {
        throw new InvalidApiKeyError(
            'Raw user signed-subject API keys are not accepted'
        );
    }
    return { ...parsed, subjectType };
}

export function decodeEncodedUserApiKey(token) {
    const payload = String(token || '').slice(ENCODED_USER_API_KEY_PREFIX.length);
    const decoded = decodeCanonicalBase64url(payload);
    if (!decoded) {
        throw new InvalidApiKeyError('Encoded user API key payload is malformed');
    }
    return decoded.toString('utf8');
}

function decodeCanonicalBase64url(value) {
    const text = String(value || '');
    if (!text || !BASE64URL_RE.test(text)) return null;
    const decoded = Buffer.from(text, 'base64url');
    if (decoded.length === 0 || decoded.toString('base64url') !== text) {
        return null;
    }
    return decoded;
}

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
    const signature = rawKey.slice(delimiter + 1);
    if (!decodeCanonicalBase64url(signature)) {
        throw new InvalidApiKeyError(
            'Signed subject API key signature must be canonical base64url'
        );
    }
    return {
        subjectId: rawKey.slice(0, delimiter),
        signature,
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
            'PLOINKY_AGENT_API_PUBLIC_KEY must decode to 32 raw Ed25519 bytes'
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
            'PLOINKY_AGENT_API_PUBLIC_KEY could not be parsed as Ed25519'
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
    const signature = decodeCanonicalBase64url(signatureB64url);
    if (!signature) return false;
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
