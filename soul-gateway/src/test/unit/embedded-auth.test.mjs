import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
    authenticateRouterAdmin,
    RouterAuthError,
} from '../../runtime/security/router-auth.mjs';
import {
    authenticateApiKey,
} from '../../runtime/security/api-key-auth.mjs';

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

function bodyHashForRequest(bodyObject) {
    return createHash('sha256')
        .update(canonicalJson(bodyObject ?? {}), 'utf8')
        .digest('base64url');
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

function verifyInvocationToken(token, {
    secret,
    expectedAudience,
    expectedTool,
    bodyObject,
    replayCache,
}) {
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
    if (payload.typ !== 'invocation') {
        throw new Error('jwtVerify: token type is not invocation');
    }
    if (payload.iss !== 'ploinky-router') {
        throw new Error('jwtVerify: issuer mismatch');
    }
    if (String(payload.aud || '') !== String(expectedAudience)) {
        throw new Error('jwtVerify: audience mismatch');
    }
    if (String(payload.tool || '') !== String(expectedTool)) {
        throw new Error('jwtVerify: tool mismatch');
    }
    const expectedBodyHash = bodyHashForRequest(bodyObject ?? {});
    if ((payload.bh ?? payload.body_hash) !== expectedBodyHash) {
        throw new Error('jwtVerify: body hash mismatch');
    }
    const jti = String(payload.jti || '').trim();
    if (!jti) {
        throw new Error('jwtVerify: jti missing');
    }
    if (replayCache?.seen(jti)) {
        throw new Error('jwtVerify: jti has already been consumed');
    }
    replayCache?.remember(jti);
    return { header, payload };
}

// ── Router Admin SSO ────────────────────────────────────────────────

describe('authenticateRouterAdmin', () => {
    const derivedMasterKey = '7'.repeat(64);
    const invocationBody = {
        tool: '__http_service__',
        arguments: {
            method: 'GET',
            path: '/services/soul-gateway/management/providers',
            search: '',
        },
    };
    const routerConfig = {
        env: {
            PLOINKY_DERIVED_MASTER_KEY: derivedMasterKey,
        },
        verifyInvocationToken,
        replayCache: createMemoryReplayCache(),
    };

    function makeReq(authInfo) {
        return {
            headers: {
                'x-ploinky-auth-info': JSON.stringify(authInfo),
            },
        };
    }

    function mintInvocationToken(bodyObject = invocationBody) {
        const now = Math.floor(Date.now() / 1000);
        return signHmacJwt({
            secret: Buffer.from(derivedMasterKey, 'hex'),
            payload: {
                typ: 'invocation',
                iss: 'ploinky-router',
                aud: 'agent:proxies/soul-gateway',
                sub: 'local:admin',
                caller: 'router:first-party',
                tool: '__http_service__',
                scope: [],
                bh: bodyHashForRequest(bodyObject),
                usr: {
                    sub: 'local:admin',
                    id: 'local:admin',
                    email: '',
                    username: 'admin',
                    roles: ['local', 'admin'],
                },
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

    it('rejects invocation tokens whose signed body does not match the header body', async () => {
        const req = makeReq({
            user: { username: 'admin', roles: ['admin'] },
            invocationToken: mintInvocationToken(invocationBody),
            invocationBody: {
                ...invocationBody,
                arguments: {
                    ...invocationBody.arguments,
                    path: '/services/soul-gateway/management/keys',
                },
            },
        });

        await assert.rejects(
            () => authenticateRouterAdmin(req, routerConfig),
            /body hash mismatch/,
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

// ── Workspace Default API Key ───────────────────────────────────────

describe('workspace default API key', () => {
    function makeAppCtx(apiKey) {
        return {
            config: {
                env: {
                    SOUL_GATEWAY_API_KEY: apiKey,
                    API_KEY_HASH_PEPPER: 'test-pepper',
                    ENCRYPTION_KEY: 'test-enc',
                },
            },
            pool: {
                query: async () => ({ rows: [] }),
            },
        };
    }

    it('returns synthetic record when workspace key matches', async () => {
        const key = 'derived-workspace-key-abc';
        const appCtx = makeAppCtx(key);
        const result = await authenticateApiKey(`Bearer ${key}`, appCtx);
        assert.equal(result.id, 'workspace-default');
        assert.equal(result.name, 'workspace-default');
        assert.equal(result.status, 'active');
        assert.equal(result.synthetic, true);
        assert.equal(result.expires_at, null);
    });

    it('accepts the workspace key without SOUL_GATEWAY_MODE', async () => {
        const key = 'derived-workspace-key-abc';
        const appCtx = makeAppCtx(key);
        const result = await authenticateApiKey(`Bearer ${key}`, appCtx);
        assert.equal(result.id, 'workspace-default');
    });

    it('does not return synthetic record when key mismatches', async () => {
        const appCtx = makeAppCtx('correct-key');
        await assert.rejects(
            () => authenticateApiKey('Bearer wrong-key', appCtx),
            (err) => {
                assert(err.errorType === 'invalid_api_key');
                return true;
            },
        );
    });

    it('does not return synthetic record when SOUL_GATEWAY_API_KEY is unset', async () => {
        const appCtx = makeAppCtx(null);
        await assert.rejects(
            () => authenticateApiKey('Bearer some-key', appCtx),
            (err) => {
                assert(err.errorType === 'invalid_api_key');
                return true;
            },
        );
    });

    it('synthetic key has no budget or rate limits', async () => {
        const key = 'derived-key-xyz';
        const appCtx = makeAppCtx(key);
        const result = await authenticateApiKey(`Bearer ${key}`, appCtx);
        assert.equal(result.daily_budget_usd, null);
        assert.equal(result.rpm_limit, null);
        assert.equal(result.tpm_limit, null);
    });

    it('persists the workspace default key when Postgres is configured', async () => {
        const key = 'derived-workspace-key-for-db';
        const queries = [];
        const appCtx = {
            config: {
                env: {
                    SOUL_GATEWAY_API_KEY: key,
                    DATABASE_URL: 'postgres://localhost/soul_gateway',
                    API_KEY_HASH_PEPPER: 'test-pepper',
                    ENCRYPTION_KEY: '8'.repeat(64),
                },
            },
            services: {
                encryptionKey: Buffer.alloc(32, 8),
            },
            pool: {
                query: async (sql, params = []) => {
                    queries.push({ sql, params });
                    if (/SELECT \* FROM soul_gateway\.api_keys WHERE key_hash/.test(sql)) {
                        return { rows: [] };
                    }
                    if (/INSERT INTO soul_gateway\.api_keys/.test(sql)) {
                        return {
                            rows: [{
                                id: '11111111-1111-1111-1111-111111111111',
                                label: params[0],
                                key_hash: params[1],
                                key_hint: params[5],
                                rpm_limit: params[6],
                                tpm_limit: params[7],
                                daily_budget_usd: params[8],
                                monthly_budget_usd: params[9],
                                expires_at: params[10],
                                metadata: params[11],
                                status: 'active',
                            }],
                        };
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                },
            },
        };

        const result = await authenticateApiKey(`Bearer ${key}`, appCtx);

        assert.equal(result.id, '11111111-1111-1111-1111-111111111111');
        assert.equal(result.label, 'workspace-default');
        assert.equal(result.synthetic, true);
        assert.equal(result.rpm_limit, null);
        assert.equal(result.tpm_limit, null);
        const insertQuery = queries.find((query) => /INSERT INTO soul_gateway\.api_keys/.test(query.sql));
        assert.equal(insertQuery.params[6], 60);
        assert.equal(insertQuery.params[7], 100000);
        assert.equal(queries.some((query) => /INSERT INTO soul_gateway\.api_keys/.test(query.sql)), true);
    });
});
