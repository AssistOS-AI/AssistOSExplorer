import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    authenticateRouterAdmin,
    RouterAuthError,
} from '../../runtime/security/router-auth.mjs';
import {
    authenticateApiKey,
    parseSignedSubjectApiKey,
} from '../../runtime/security/api-key-auth.mjs';
import { ensureEncryptionKey } from '../../runtime/security/encryption.mjs';
import { authenticateMiddleware } from '../../runtime/route/authenticate.mjs';
import { openDatabase, initializeSchema } from '../../db/sqlite-db.mjs';
import {
    makeSignedSubjectKey,
    makeSignedSubjectSigner,
} from '../fixtures/signed-subject-key.mjs';

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}

function base64urlJson(obj) {
    return base64url(Buffer.from(JSON.stringify(obj), 'utf8'));
}

function canonicalJson(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function signHmacJwt({ payload, secret }) {
    const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
    const body = base64urlJson(payload);
    const signingInput = `${header}.${body}`;
    const sig = base64url(createHmac('sha256', secret).update(signingInput).digest());
    return `${signingInput}.${sig}`;
}

function base64urlDecode(segment) {
    const padding = '==='.slice((segment.length + 3) % 4);
    const base64 = (segment + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64');
}

function createMemoryReplayCache() {
    const seen = new Set();
    return {
        seen(jti) {
            return seen.has(jti);
        },
        remember(jti) {
            seen.add(jti);
        },
    };
}

function sha256RawBodyHash(body = '') {
    const bytes = Buffer.isBuffer(body)
        ? body
        : Buffer.from(body === undefined || body === null ? '' : body);
    return createHash('sha256').update(bytes).digest('base64url');
}

function computeRchHttp({ method, path, query, bodyHash }) {
    return createHash('sha256')
        .update(canonicalJson({
            method: String(method ?? ''),
            path: String(path ?? ''),
            query: query === undefined || query === null ? '' : String(query),
            bodyHash: String(bodyHash ?? ''),
        }), 'utf8')
        .digest('base64url');
}

function verifyHttpServiceAuthInfo(headers, {
    env,
    replayCache,
    method,
    path,
    query = '',
    bodyHash,
}) {
    const authInfo = JSON.parse(headers['x-ploinky-auth-info']);
    const token = authInfo.invocationToken;
    const invocationBody = authInfo.invocationBody;
    if (String(invocationBody.method || '').toUpperCase() !== String(method || '').toUpperCase()) {
        return { ok: false, reason: 'HTTP service method mismatch' };
    }
    if (String(invocationBody.path || '') !== String(path || '')) {
        return { ok: false, reason: 'HTTP service path mismatch' };
    }
    if (String(invocationBody.search ?? '') !== String(query ?? '')) {
        return { ok: false, reason: 'HTTP service query mismatch' };
    }
    if (String(invocationBody.bodyHash || '') !== String(bodyHash || '')) {
        return { ok: false, reason: 'HTTP service body hash mismatch' };
    }

    const secretHex = String(env.PLOINKY_AGENT_SECRET || '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
        return { ok: false, reason: 'PLOINKY_AGENT_SECRET not configured' };
    }
    const secret = Buffer.from(secretHex, 'hex');
    const expectedAudience = env.PLOINKY_AGENT_ID || env.PLOINKY_AGENT_PRINCIPAL;
    const parts = token.split('.');
    assert.equal(parts.length, 3);
    const header = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
    const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
    const signature = base64urlDecode(parts[2]);
    const signingInput = `${parts[0]}.${parts[1]}`;
    const expected = createHmac('sha256', secret).update(signingInput).digest();
    if (header.alg !== 'HS256') {
        throw new Error(`jwtVerify: unsupported alg ${header.alg}`);
    }
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
        throw new Error('jwtVerify: signature invalid');
    }
    if (payload.typ !== 'router-request') {
        return { ok: false, reason: 'jwtVerify: token type is not router-request' };
    }
    if (payload.iss !== 'ploinky-router') {
        return { ok: false, reason: 'jwtVerify: issuer mismatch' };
    }
    if (String(payload.aud || '') !== String(expectedAudience)) {
        return { ok: false, reason: 'jwtVerify: audience mismatch' };
    }
    if (String(payload.tool || '') !== '__http_service__') {
        return { ok: false, reason: 'jwtVerify: tool mismatch' };
    }
    if (String(payload.method || '') !== String(method || '').toUpperCase()) {
        return { ok: false, reason: 'jwtVerify: method mismatch' };
    }
    if (String(payload.path || '') !== String(path || '')) {
        return { ok: false, reason: 'jwtVerify: path mismatch' };
    }
    const rch = computeRchHttp({
        method,
        path,
        query,
        bodyHash,
    });
    if (String(payload.rch || '') !== rch) {
        return { ok: false, reason: 'jwtVerify: request hash mismatch' };
    }
    const jti = String(payload.jti || '').trim();
    if (!jti) {
        return { ok: false, reason: 'jwtVerify: jti missing' };
    }
    if (replayCache?.seen(jti)) {
        return { ok: false, reason: 'jwtVerify: jti has already been consumed' };
    }
    replayCache?.remember(jti);
    return { ok: true, header, payload, authInfo, invocationBody, bodyHash };
}

// ── Router Admin SSO ────────────────────────────────────────────────

describe('authenticateRouterAdmin', () => {
    const agentSecret = '7'.repeat(64);
    const invocationBody = {
        method: 'GET',
        externalPath: '/services/soul-gateway/management/providers',
        path: '/management/providers',
        search: '',
        routeKey: 'soul-gateway',
        bodyHash: sha256RawBodyHash(''),
    };
    const routerConfig = {
        env: {
            PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway',
            PLOINKY_AGENT_PRINCIPAL: 'agent:proxies/soul-gateway',
            PLOINKY_AGENT_SECRET: agentSecret,
        },
        verifyHttpServiceAuthInfo,
        replayCache: createMemoryReplayCache(),
    };

    function makeReq(authInfo, { method = 'GET', url = '/management/providers' } = {}) {
        return {
            method,
            url,
            headers: {
                'x-ploinky-auth-info': JSON.stringify(authInfo),
            },
        };
    }

    function mintInvocationToken(bodyObject = invocationBody) {
        const now = Math.floor(Date.now() / 1000);
        return signHmacJwt({
            secret: Buffer.from(agentSecret, 'hex'),
            payload: {
                typ: 'router-request',
                iss: 'ploinky-router',
                aud: 'agent:proxies/soul-gateway',
                sub: 'user:local:admin',
                actor: {
                    kind: 'user',
                    id: 'user:local:admin',
                    roles: ['local', 'admin'],
                },
                method: bodyObject.method,
                path: bodyObject.path,
                tool: '__http_service__',
                usr: {
                    sub: 'local:admin',
                    id: 'local:admin',
                    email: '',
                    username: 'admin',
                    roles: ['local', 'admin'],
                },
                rch: computeRchHttp({
                    method: bodyObject.method,
                    path: bodyObject.path,
                    query: bodyObject.search,
                    bodyHash: bodyObject.bodyHash,
                }),
                jti: randomBytes(16).toString('base64url'),
                iat: now,
                exp: now + 60,
            },
        });
    }

    it('returns null when no auth info header', async () => {
        const req = { headers: {} };
        const result = await authenticateRouterAdmin(req, routerConfig);
        assert.equal(result, null);
    });

    it('returns null for malformed JSON in auth info header', async () => {
        const req = {
            headers: { 'x-ploinky-auth-info': 'not-json' },
        };
        const result = await authenticateRouterAdmin(req, routerConfig);
        assert.equal(result, null);
    });

    it('throws RouterAuthError when user lacks admin role', async () => {
        const req = makeReq({
            user: { username: 'viewer', roles: ['viewer'] },
            invocationToken: 'tok',
        });
        await assert.rejects(
            () => authenticateRouterAdmin(req, routerConfig),
            (err) => {
                assert(err instanceof RouterAuthError);
                assert.match(err.message, /admin role/i);
                return true;
            },
        );
    });

    it('throws RouterAuthError when roles array is missing', async () => {
        const req = makeReq({
            user: { username: 'admin' },
            invocationToken: 'tok',
        });
        await assert.rejects(
            () => authenticateRouterAdmin(req, routerConfig),
            (err) => err instanceof RouterAuthError,
        );
    });

    it('throws RouterAuthError when invocation token is missing', async () => {
        const req = makeReq({
            user: { username: 'admin', roles: ['admin'] },
        });
        await assert.rejects(
            () => authenticateRouterAdmin(req, routerConfig),
            (err) => {
                assert(err instanceof RouterAuthError);
                assert.match(err.message, /invocation token/i);
                return true;
            },
        );
    });

    it('accepts admin router SSO when invocation token matches the signed body', async () => {
        const req = makeReq({
            user: { username: 'admin', roles: ['admin'] },
            invocationToken: mintInvocationToken(),
            invocationBody,
        });

        const result = await authenticateRouterAdmin(req, routerConfig);

        assert.equal(result.authenticated, true);
        assert.equal(result.source, 'router-sso');
        assert.equal(result.user.username, 'admin');
    });

    it('throws RouterAuthError when invocation body is missing', async () => {
        const req = makeReq({
            user: { username: 'admin', roles: ['admin'] },
            invocationToken: mintInvocationToken(),
        });

        await assert.rejects(
            () => authenticateRouterAdmin(req, routerConfig),
            (err) => {
                assert(err instanceof RouterAuthError);
                assert.match(err.message, /invocation body/i);
                return true;
            },
        );
    });

    it('rejects invocation tokens whose request hash does not match the header body', async () => {
        const req = makeReq({
            user: { username: 'admin', roles: ['admin'] },
            invocationToken: mintInvocationToken(invocationBody),
            invocationBody: {
                ...invocationBody,
                bodyHash: sha256RawBodyHash(JSON.stringify({ tampered: true })),
            },
        });

        await assert.rejects(
            () => authenticateRouterAdmin(req, routerConfig),
            /request hash mismatch/,
        );
    });

    it('rejects replayed router invocation tokens', async () => {
        const invocationToken = mintInvocationToken();
        const req = makeReq({
            user: { username: 'admin', roles: ['admin'] },
            invocationToken,
            invocationBody,
        });

        await authenticateRouterAdmin(req, routerConfig);
        await assert.rejects(
            () => authenticateRouterAdmin(req, routerConfig),
            /already been consumed/,
        );
    });
});

// ── Signed-Subject API Key ──────────────────────────────────────────
//
// Revocation semantics covered here:
//   - Revoking the DB row blocks that deterministic key (denied, never
//     reactivated).
//   - Deleting the DB row permits recreation on the next valid signed request.
//   - Per-subject key rotation is not available without changing the subject id
//     (the key is deterministic for a subject + signing key).
//   - Rotating the Ploinky signing key invalidates all signed-subject keys at
//     once (covered implicitly: a key signed by one keypair fails against a
//     different public key — see "rejects a key signed by a different key").

describe('signed-subject API key', () => {
    async function withSignedDb(fn) {
        const dir = await mkdtemp(join(tmpdir(), 'soul-signed-'));
        const db = await openDatabase({ SQLITE_PATH: join(dir, 'gateway.sqlite3') });
        try {
            await initializeSchema(db);
            return await fn(db);
        } finally {
            await db.end();
            await rm(dir, { recursive: true, force: true });
        }
    }

    function makeEnv(publicKeyBase64url) {
        return {
            PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY: publicKeyBase64url,
            API_KEY_HASH_PEPPER: 'test-pepper',
            ENCRYPTION_KEY: '8'.repeat(64),
        };
    }

    it('authenticates a valid agent key and creates a DB row', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'agent:AssistOSExplorer/llmAssistant';
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };

            const result = await authenticateApiKey(`Bearer ${apiKey}`, appCtx);

            assert.equal(result.subjectId, subjectId);
            assert.equal(result.subjectType, 'agent');
            assert.equal(result.apiKeySource, 'signed-subject');
            assert.equal(result.apiKeyId, result.id);
            assert.equal(result.status, 'active');

            const stored = await db.query(
                'SELECT subject_id, subject_type, source FROM api_keys WHERE subject_id = $1',
                [subjectId]
            );
            assert.equal(stored.rows.length, 1);
            assert.equal(stored.rows[0].subject_type, 'agent');
            assert.equal(stored.rows[0].source, 'signed-subject');
        });
    });

    it('authenticates a valid user key and creates a DB row', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'user:alice';
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };

            const result = await authenticateApiKey(`Bearer ${apiKey}`, appCtx);

            assert.equal(result.subjectId, subjectId);
            assert.equal(result.subjectType, 'user');
            assert.equal(result.apiKeySource, 'signed-subject');

            const stored = await db.query(
                'SELECT subject_type FROM api_keys WHERE subject_id = $1',
                [subjectId]
            );
            assert.equal(stored.rows.length, 1);
            assert.equal(stored.rows[0].subject_type, 'user');
        });
    });

    it('does not require ciphertext columns to insert a row', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'agent:proxies/soul-gateway';
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };

            await authenticateApiKey(`Bearer ${apiKey}`, appCtx);

            // The api_keys table has no ciphertext columns at all.
            const cols = await db.query("PRAGMA table_info('api_keys')", []);
            const names = cols.rows.map((c) => c.name);
            assert.equal(names.includes('key_ciphertext'), false);
            assert.equal(names.includes('key_iv'), false);
            assert.equal(names.includes('key_auth_tag'), false);
            assert.equal(names.includes('key_hash'), true);
        });
    });

    it('returns one logical row for concurrent first use of the same key', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'agent:AssistOSExplorer/tasksAgent';
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };

            const [a, b] = await Promise.all([
                authenticateApiKey(`Bearer ${apiKey}`, appCtx),
                authenticateApiKey(`Bearer ${apiKey}`, appCtx),
            ]);

            assert.equal(a.id, b.id, 'both requests resolve to the same row id');
            const stored = await db.query(
                'SELECT id FROM api_keys WHERE subject_id = $1',
                [subjectId]
            );
            assert.equal(stored.rows.length, 1, 'exactly one row persisted');
        });
    });

    it('denies a revoked signed key and does not reactivate it', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'user:bob';
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };

            const first = await authenticateApiKey(`Bearer ${apiKey}`, appCtx);
            // Revoke the row, then re-present the same key.
            await db.query(
                "UPDATE api_keys SET status = 'revoked', revoked_at = now() WHERE id = $1",
                [first.id]
            );

            await assert.rejects(
                () => authenticateApiKey(`Bearer ${apiKey}`, appCtx),
                (err) => err.errorType === 'api_key_revoked'
            );

            // Still revoked — never reactivated by the failed auth attempt.
            const stored = await db.query(
                'SELECT status FROM api_keys WHERE id = $1',
                [first.id]
            );
            assert.equal(stored.rows[0].status, 'revoked');
        });
    });

    it('recreates a deleted signed key on the next valid request', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'agent:AssistOSExplorer/gitAgent';
            const { apiKey, publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };

            const first = await authenticateApiKey(`Bearer ${apiKey}`, appCtx);
            await db.query('DELETE FROM api_keys WHERE id = $1', [first.id]);
            assert.equal(
                (await db.query('SELECT id FROM api_keys WHERE subject_id = $1', [subjectId])).rows.length,
                0
            );

            const recreated = await authenticateApiKey(`Bearer ${apiKey}`, appCtx);
            assert.equal(recreated.subjectId, subjectId);
            assert.equal(recreated.status, 'active');
            const stored = await db.query(
                'SELECT id FROM api_keys WHERE subject_id = $1',
                [subjectId]
            );
            assert.equal(stored.rows.length, 1);
        });
    });

    it('does not accept a legacy workspace env key', async () => {
        await withSignedDb(async (db) => {
            const { publicKeyBase64url } = makeSignedSubjectKey('user:ignored');
            const env = {
                ...makeEnv(publicKeyBase64url),
                // Legacy workspace key var — must no longer grant access.
                SOUL_GATEWAY_API_KEY: 'legacy-workspace-secret',
            };
            const appCtx = { config: { env }, pool: db };

            await assert.rejects(
                () => authenticateApiKey('Bearer legacy-workspace-secret', appCtx),
                (err) => err.errorType === 'invalid_api_key'
            );
        });
    });

    it('fails signed-subject auth when the public key is missing', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'user:carol';
            const { apiKey } = makeSignedSubjectKey(subjectId);
            const appCtx = {
                config: {
                    env: {
                        PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY: null,
                        API_KEY_HASH_PEPPER: 'test-pepper',
                    },
                },
                pool: db,
            };

            await assert.rejects(
                () => authenticateApiKey(`Bearer ${apiKey}`, appCtx),
                (err) => {
                    assert.equal(err.errorType, 'invalid_api_key');
                    assert.match(err.message, /PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY/);
                    return true;
                }
            );
        });
    });

    it('rejects a key whose signature does not verify', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'agent:AssistOSExplorer/llmAssistant';
            const { publicKeyBase64url } = makeSignedSubjectKey(subjectId);
            // Tamper: keep the subject but corrupt the signature.
            const badKey = `${subjectId}|${'A'.repeat(86)}`;
            const appCtx = { config: { env: makeEnv(publicKeyBase64url) }, pool: db };

            await assert.rejects(
                () => authenticateApiKey(`Bearer ${badKey}`, appCtx),
                (err) => err.errorType === 'invalid_api_key'
            );
        });
    });

    it('rejects a key signed by a different keypair (key rotation invalidates)', async () => {
        await withSignedDb(async (db) => {
            const subjectId = 'agent:AssistOSExplorer/llmAssistant';
            const { apiKey } = makeSignedSubjectKey(subjectId);
            // A *different* keypair's public key — simulates a rotated signing key.
            const { publicKeyBase64url: otherPub } = makeSignedSubjectKey('user:unused');
            const appCtx = { config: { env: makeEnv(otherPub) }, pool: db };

            await assert.rejects(
                () => authenticateApiKey(`Bearer ${apiKey}`, appCtx),
                (err) => err.errorType === 'invalid_api_key'
            );
        });
    });

    it('rejects subjects outside the agent/user grammar', async () => {
        await withSignedDb(async (db) => {
            // Sign a structurally-invalid subject with a valid keypair; the
            // subject classifier must reject it before/independent of the
            // signature check.
            const signer = makeSignedSubjectSigner();
            const badSubject = 'service:foo';
            const apiKey = `${badSubject}|${signer.sign(badSubject)}`;
            const appCtx = {
                config: { env: makeEnv(signer.publicKeyBase64url) },
                pool: db,
            };

            await assert.rejects(
                () => authenticateApiKey(`Bearer ${apiKey}`, appCtx),
                (err) => err.errorType === 'invalid_api_key'
            );
        });
    });
});

// ── parseSignedSubjectApiKey ────────────────────────────────────────

describe('parseSignedSubjectApiKey', () => {
    it('splits a well-formed <subjectId>|<signature>', () => {
        const parsed = parseSignedSubjectApiKey('agent:repo/name|sigbytes');
        assert.equal(parsed.subjectId, 'agent:repo/name');
        assert.equal(parsed.signature, 'sigbytes');
    });

    it('rejects a missing delimiter', () => {
        assert.throws(
            () => parseSignedSubjectApiKey('agent:repo/name'),
            (err) => err.errorType === 'invalid_api_key'
        );
    });

    it('rejects an empty subject (leading delimiter)', () => {
        assert.throws(
            () => parseSignedSubjectApiKey('|sig'),
            (err) => err.errorType === 'invalid_api_key'
        );
    });

    it('rejects an empty signature (trailing delimiter)', () => {
        assert.throws(
            () => parseSignedSubjectApiKey('agent:repo/name|'),
            (err) => err.errorType === 'invalid_api_key'
        );
    });

    it('rejects more than one delimiter', () => {
        assert.throws(
            () => parseSignedSubjectApiKey('agent:repo/name|sig|extra'),
            (err) => err.errorType === 'invalid_api_key'
        );
    });
});
