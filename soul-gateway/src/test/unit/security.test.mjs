import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
    encrypt,
    decrypt,
    ensureEncryptionKey,
} from '../../runtime/security/encryption.mjs';
import { requireAdmin } from '../../runtime/security/dashboard-auth.mjs';
import {
    extractBearerToken,
} from '../../runtime/security/api-key-auth.mjs';
import {
    AuthenticationRequiredError,
    InvalidApiKeyError,
    ExpiredApiKeyError,
    RevokedApiKeyError,
} from '../../core/errors.mjs';

// ── Encrypt / Decrypt ───────────────────────────────────────────────

describe('encryption', () => {
    const key = randomBytes(32);

    it('round-trips plaintext through encrypt + decrypt', () => {
        const plaintext = 'Hello, Soul Gateway!';
        const { ciphertext, iv, authTag } = encrypt(plaintext, key);
        const result = decrypt(ciphertext, iv, authTag, key);
        assert.equal(result, plaintext);
    });

    it('round-trips empty string', () => {
        const { ciphertext, iv, authTag } = encrypt('', key);
        assert.equal(decrypt(ciphertext, iv, authTag, key), '');
    });

    it('round-trips unicode content', () => {
        const plaintext = '🚀 こんにちは 世界 — "quotes"';
        const { ciphertext, iv, authTag } = encrypt(plaintext, key);
        assert.equal(decrypt(ciphertext, iv, authTag, key), plaintext);
    });

    it('produces different ciphertexts for the same plaintext (random IV)', () => {
        const a = encrypt('same', key);
        const b = encrypt('same', key);
        assert.notEqual(Buffer.compare(a.ciphertext, b.ciphertext), 0);
        assert.notEqual(Buffer.compare(a.iv, b.iv), 0);
    });

    it('returns Buffer fields with AES-256-GCM-shaped lengths', () => {
        // Locked in to prevent the BLOB round-trip regression: encoding the
        // bytes as hex strings instead of raw bytes doubles the byte count,
        // so the IV/auth-tag lengths must come from raw
        // Buffers, not hex strings. A 12-byte IV and 16-byte tag is the
        // standard AES-256-GCM shape; if encrypt() ever returns hex
        // strings again the lengths jump to 24 and 32 and this test
        // catches it before any provider account is created.
        const { ciphertext, iv, authTag } = encrypt('whatever', key);
        assert(Buffer.isBuffer(ciphertext), 'ciphertext must be a Buffer');
        assert(Buffer.isBuffer(iv), 'iv must be a Buffer');
        assert(Buffer.isBuffer(authTag), 'authTag must be a Buffer');
        assert.equal(iv.length, 12, 'GCM nonce must be 12 bytes');
        assert.equal(authTag.length, 16, 'GCM auth tag must be 16 bytes');
    });

    it('round-trips through a simulated BLOB column (Buffer in, Buffer out)', () => {
        // Mirrors what the SQLite facade does for BLOB columns: the encoded
        // Buffer goes in unchanged and comes back out as a Buffer of
        // exactly the same bytes. If decrypt() ever silently re-decodes
        // its inputs as hex strings, this test fails.
        const plaintext = 'nvapi-NFijszSNRSlZxkY-bXsL0KVEeq4OJcn';
        const { ciphertext, iv, authTag } = encrypt(plaintext, key);

        // Simulate persisting + reading back from a BLOB column —
        // the SQLite facade returns identical Buffer instances, so a deep
        // copy is the closest thing to a "fresh" row from the DB.
        const persistedCiphertext = Buffer.from(ciphertext);
        const persistedIv = Buffer.from(iv);
        const persistedAuthTag = Buffer.from(authTag);

        const result = decrypt(
            persistedCiphertext,
            persistedIv,
            persistedAuthTag,
            key
        );
        assert.equal(result, plaintext);
    });

    it('fails to decrypt with a wrong key', () => {
        const { ciphertext, iv, authTag } = encrypt('secret', key);
        const wrongKey = randomBytes(32);
        assert.throws(() => decrypt(ciphertext, iv, authTag, wrongKey));
    });

    it('fails to decrypt with tampered ciphertext', () => {
        const { ciphertext, iv, authTag } = encrypt('secret', key);
        const tampered = Buffer.from(ciphertext);
        tampered[0] ^= 0xff;
        assert.throws(() => decrypt(tampered, iv, authTag, key));
    });

    it('fails to decrypt with tampered auth tag', () => {
        const { ciphertext, iv, authTag } = encrypt('secret', key);
        const tampered = Buffer.from(authTag);
        tampered[0] ^= 0xff;
        assert.throws(() => decrypt(ciphertext, iv, tampered, key));
    });
});

describe('ensureEncryptionKey', () => {
    it('decodes a valid base64 ENCRYPTION_KEY', () => {
        const raw = randomBytes(32);
        const config = {
            ENCRYPTION_KEY: raw.toString('base64'),
            DATA_DIR: '/tmp',
        };
        const result = ensureEncryptionKey(config);
        assert.deepEqual(result, raw);
    });

    it('throws when ENCRYPTION_KEY decodes to wrong length', () => {
        const config = {
            ENCRYPTION_KEY: randomBytes(16).toString('base64'),
            DATA_DIR: '/tmp',
        };
        assert.throws(() => ensureEncryptionKey(config), /32 bytes/);
    });
});

// ── Bearer Token Extraction ─────────────────────────────────────────

describe('extractBearerToken', () => {
    it('extracts the token from a valid header', () => {
        assert.equal(extractBearerToken('Bearer sk-soul-abc'), 'sk-soul-abc');
    });

    it('trims whitespace', () => {
        assert.equal(
            extractBearerToken('Bearer   sk-soul-abc  '),
            'sk-soul-abc'
        );
    });

    it('throws AuthenticationRequiredError for null header', () => {
        assert.throws(
            () => extractBearerToken(null),
            (err) => {
                assert(err instanceof AuthenticationRequiredError);
                return true;
            }
        );
    });

    it('throws AuthenticationRequiredError for undefined header', () => {
        assert.throws(
            () => extractBearerToken(undefined),
            (err) => {
                assert(err instanceof AuthenticationRequiredError);
                return true;
            }
        );
    });

    it('throws AuthenticationRequiredError for non-Bearer scheme', () => {
        assert.throws(
            () => extractBearerToken('Basic abc'),
            (err) => {
                assert(err instanceof AuthenticationRequiredError);
                assert.match(err.message, /Bearer/);
                return true;
            }
        );
    });

    it('throws AuthenticationRequiredError for empty token', () => {
        assert.throws(
            () => extractBearerToken('Bearer '),
            (err) => {
                assert(err instanceof AuthenticationRequiredError);
                return true;
            }
        );
    });
});

// ── Router Admin Auth ───────────────────────────────────────────────

describe('router admin requireAdmin', () => {
    const config = {
        PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway',
        PLOINKY_AGENT_PRINCIPAL: 'agent:proxies/soul-gateway',
        PLOINKY_AGENT_SECRET: '9'.repeat(64),
    };
    const invocationBody = {
        method: 'GET',
        externalPath: '/services/soul-gateway/management/providers',
        path: '/management/providers',
        search: '',
        routeKey: 'soul-gateway',
        bodyHash: 'empty-body-hash',
    };
    const routerAuthOptions = {
        verifyHttpServiceAuthInfo: mock.fn(() => ({
            ok: true,
            payload: { sub: 'local:admin' },
        })),
        replayCache: {
            seen: () => false,
            remember: () => {},
        },
    };

    function makeReq(authInfo, extraHeaders = {}) {
        return {
            method: authInfo?.invocationBody?.method || 'GET',
            url: `${authInfo?.invocationBody?.path || '/management/providers'}${authInfo?.invocationBody?.search || ''}`,
            headers: {
                ...extraHeaders,
                'x-ploinky-auth-info': JSON.stringify(authInfo),
            },
        };
    }

    it('rejects missing router identity', async () => {
        await assert.rejects(
            () => requireAdmin({ headers: {} }, config, routerAuthOptions),
            (err) => err instanceof AuthenticationRequiredError,
        );
    });

    it('rejects dashboard-style bearer tokens without router identity', async () => {
        await assert.rejects(
            () => requireAdmin(
                { headers: { authorization: 'Bearer legacy-dashboard-token' } },
                config,
                routerAuthOptions,
            ),
            (err) => err instanceof AuthenticationRequiredError,
        );
    });

    it('rejects non-admin router users', async () => {
        const req = makeReq({
            user: { username: 'viewer', roles: ['viewer'] },
            invocationToken: 'router.jwt',
            invocationBody,
        });

        await assert.rejects(
            () => requireAdmin(req, config, routerAuthOptions),
            (err) => {
                assert(err instanceof AuthenticationRequiredError);
                assert.match(err.message, /admin role/i);
                return true;
            },
        );
    });

    it('accepts verified admin router identity', async () => {
        const req = makeReq({
            user: { username: 'admin', roles: ['local', 'admin'] },
            invocationToken: 'router.jwt',
            invocationBody,
        });

        const result = await requireAdmin(req, config, routerAuthOptions);

        assert.equal(result.authenticated, true);
        assert.equal(result.source, 'router-sso');
        assert.equal(result.user.username, 'admin');
    });
});

// ── Error types for missing/invalid/expired/revoked keys ────────────

describe('API key error types', () => {
    it('AuthenticationRequiredError is 401', () => {
        const err = new AuthenticationRequiredError();
        assert.equal(err.httpStatus, 401);
        assert.equal(err.errorType, 'authentication_required');
    });

    it('InvalidApiKeyError is 401', () => {
        const err = new InvalidApiKeyError();
        assert.equal(err.httpStatus, 401);
        assert.equal(err.errorType, 'invalid_api_key');
    });

    it('ExpiredApiKeyError is 403', () => {
        const err = new ExpiredApiKeyError();
        assert.equal(err.httpStatus, 403);
        assert.equal(err.errorType, 'api_key_expired');
    });

    it('RevokedApiKeyError is 403', () => {
        const err = new RevokedApiKeyError();
        assert.equal(err.httpStatus, 403);
        assert.equal(err.errorType, 'api_key_revoked');
    });
});
