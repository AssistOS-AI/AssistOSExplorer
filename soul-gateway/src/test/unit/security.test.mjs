import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';

import {
    encrypt,
    decrypt,
    ensureEncryptionKey,
} from '../../runtime/security/encryption.mjs';
import { compareDashboardPassword } from '../../runtime/security/password.mjs';
import { generateCsrfToken, verifyCsrf } from '../../runtime/security/csrf.mjs';
import {
    loginAdmin,
    requireAdmin,
    createAdminSessionCookie,
} from '../../runtime/security/dashboard-auth.mjs';
import {
    extractBearerToken,
    hashApiKey,
    derivePepper,
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
        // Locked in to prevent the bytea round-trip regression: pg writes
        // hex strings into bytea columns by UTF-8 encoding (doubling the
        // byte count), so the IV/auth-tag lengths must come from raw
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

    it('round-trips through a simulated bytea column (Buffer in, Buffer out)', () => {
        // Mirrors what node-postgres does for bytea columns: the encoded
        // Buffer goes in unchanged and comes back out as a Buffer of
        // exactly the same bytes. If decrypt() ever silently re-decodes
        // its inputs as hex strings, this test fails.
        const plaintext = 'nvapi-NFijszSNRSlZxkY-bXsL0KVEeq4OJcn';
        const { ciphertext, iv, authTag } = encrypt(plaintext, key);

        // Simulate persisting + reading back from a bytea column —
        // node-postgres returns identical Buffer instances, so a deep
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

// ── API Key HMAC Hash ───────────────────────────────────────────────

describe('hashApiKey', () => {
    it('produces a deterministic hex HMAC-SHA256', () => {
        const token = 'sk-soul-abc123';
        const pepper = 'my-pepper';
        const expected = createHmac('sha256', pepper)
            .update(token)
            .digest('hex');
        assert.equal(hashApiKey(token, pepper), expected);
    });

    it('produces different hashes for different tokens', () => {
        const pepper = 'pepper';
        assert.notEqual(
            hashApiKey('token-a', pepper),
            hashApiKey('token-b', pepper)
        );
    });

    it('produces different hashes for different peppers', () => {
        assert.notEqual(
            hashApiKey('token', 'pepper-a'),
            hashApiKey('token', 'pepper-b')
        );
    });
});

describe('derivePepper', () => {
    it('prefers API_KEY_HASH_PEPPER when set', () => {
        assert.equal(
            derivePepper({ API_KEY_HASH_PEPPER: 'p', ENCRYPTION_KEY: 'e' }),
            'p'
        );
    });

    it('falls back to ENCRYPTION_KEY', () => {
        assert.equal(
            derivePepper({ API_KEY_HASH_PEPPER: null, ENCRYPTION_KEY: 'e' }),
            'e'
        );
    });

    it('throws when neither is set', () => {
        assert.throws(
            () =>
                derivePepper({
                    API_KEY_HASH_PEPPER: null,
                    ENCRYPTION_KEY: null,
                }),
            /neither/i
        );
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

// ── Admin Session Token ─────────────────────────────────────────────

describe('admin session sign/verify (loginAdmin + requireAdmin)', () => {
    const signingKey = 'test-signing-key-abc123';
    const config = {
        DASHBOARD_PASSWORD: 's3cret',
        ADMIN_SESSION_SIGNING_KEY: signingKey,
    };

    it('loginAdmin returns a valid token on correct password', async () => {
        const { token, expiresAt } = await loginAdmin('s3cret', config);
        assert.equal(typeof token, 'string');
        assert(token.includes('.'), 'token should contain a dot separator');
        assert(expiresAt > Date.now(), 'expiry should be in the future');
    });

    it('loginAdmin throws for wrong password', async () => {
        await assert.rejects(
            () => loginAdmin('wrong', config),
            (err) => {
                assert(err instanceof AuthenticationRequiredError);
                return true;
            }
        );
    });

    it('loginAdmin throws when DASHBOARD_PASSWORD is unset', async () => {
        await assert.rejects(
            () =>
                loginAdmin('whatever', { ...config, DASHBOARD_PASSWORD: null }),
            (err) => {
                assert(err instanceof AuthenticationRequiredError);
                return true;
            }
        );
    });

    it('requireAdmin accepts a valid Bearer token', async () => {
        const { token } = await loginAdmin('s3cret', config);
        const req = { headers: { authorization: `Bearer ${token}` } };
        const decoded = requireAdmin(req, config);
        assert(decoded.exp > Date.now());
    });

    it('requireAdmin accepts a valid cookie token', async () => {
        const { token } = await loginAdmin('s3cret', config);
        const req = {
            headers: { cookie: `soul_session=${encodeURIComponent(token)}` },
        };
        const decoded = requireAdmin(req, config);
        assert(decoded.exp > Date.now());
    });

    it('requireAdmin throws for missing token', () => {
        const req = { headers: {} };
        assert.throws(
            () => requireAdmin(req, config),
            (err) => err instanceof AuthenticationRequiredError
        );
    });

    it('requireAdmin throws for tampered token', async () => {
        const { token } = await loginAdmin('s3cret', config);
        const tampered = token.slice(0, -4) + 'xxxx';
        const req = { headers: { authorization: `Bearer ${tampered}` } };
        assert.throws(
            () => requireAdmin(req, config),
            (err) => err instanceof AuthenticationRequiredError
        );
    });

    it('requireAdmin throws for expired token', () => {
        // Craft a token that already expired
        const exp = Date.now() - 1000;
        const payload = String(exp);
        const sig = createHmac('sha256', signingKey)
            .update(payload)
            .digest('hex');
        const expiredToken = `${payload}.${sig}`;

        const req = { headers: { authorization: `Bearer ${expiredToken}` } };
        assert.throws(
            () => requireAdmin(req, config),
            (err) => {
                assert(err instanceof AuthenticationRequiredError);
                assert.match(err.message, /expired/i);
                return true;
            }
        );
    });
});

describe('createAdminSessionCookie', () => {
    it('produces a well-formed Set-Cookie value', () => {
        const cookie = createAdminSessionCookie('tok.sig', 43_200_000);
        assert(cookie.startsWith('soul_session='));
        assert(cookie.includes('HttpOnly'));
        assert(cookie.includes('SameSite=Strict'));
        assert(cookie.includes('Path=/'));
        assert(cookie.includes('Max-Age=43200'));
    });
});

// ── CSRF ────────────────────────────────────────────────────────────

describe('CSRF tokens', () => {
    it('generates a 64-character hex token', () => {
        const token = generateCsrfToken();
        assert.equal(typeof token, 'string');
        assert.equal(token.length, 64);
        assert.match(token, /^[0-9a-f]+$/);
    });

    it('generates unique tokens', () => {
        const a = generateCsrfToken();
        const b = generateCsrfToken();
        assert.notEqual(a, b);
    });

    it('verifyCsrf passes when tokens match', () => {
        const token = generateCsrfToken();
        const reqCtx = {
            headers: { 'x-csrf-token': token },
            session: { csrfToken: token },
        };
        assert.equal(verifyCsrf(reqCtx), true);
    });

    it('verifyCsrf throws when header is missing', () => {
        const reqCtx = {
            headers: {},
            session: { csrfToken: 'abc' },
        };
        assert.throws(() => verifyCsrf(reqCtx), /Missing CSRF/);
    });

    it('verifyCsrf throws when session token is missing', () => {
        const reqCtx = {
            headers: { 'x-csrf-token': 'abc' },
            session: {},
        };
        assert.throws(() => verifyCsrf(reqCtx), /No CSRF token in session/);
    });

    it('verifyCsrf throws on mismatch', () => {
        const reqCtx = {
            headers: { 'x-csrf-token': 'aaa' },
            session: { csrfToken: 'bbb' },
        };
        assert.throws(() => verifyCsrf(reqCtx), /mismatch/i);
    });
});

// ── Timing-Safe Password Comparison ─────────────────────────────────

describe('compareDashboardPassword', () => {
    it('returns true for matching passwords', () => {
        assert.equal(compareDashboardPassword('s3cret', 's3cret'), true);
    });

    it('returns false for different passwords', () => {
        assert.equal(compareDashboardPassword('s3cret', 'wrong'), false);
    });

    it('returns false for different length passwords', () => {
        assert.equal(
            compareDashboardPassword('short', 'much-longer-password'),
            false
        );
    });

    it('returns false when input is not a string', () => {
        assert.equal(compareDashboardPassword(null, 's3cret'), false);
        assert.equal(compareDashboardPassword(123, 's3cret'), false);
        assert.equal(compareDashboardPassword(undefined, 's3cret'), false);
    });

    it('returns false when expected is not a string', () => {
        assert.equal(compareDashboardPassword('s3cret', null), false);
    });

    it('returns false for empty strings', () => {
        assert.equal(compareDashboardPassword('', 's3cret'), false);
        assert.equal(compareDashboardPassword('s3cret', ''), false);
        assert.equal(compareDashboardPassword('', ''), false);
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
