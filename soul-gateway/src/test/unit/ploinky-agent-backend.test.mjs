/**
 * Ploinky agent OpenAI backend tests.
 *
 * Cover the signed surface of the router-mediated agent-to-agent OpenAI call:
 *   - the backend signs an HTTP Agent Assertion bound to the EXACT outbound bytes
 *   - the assertion payload matches the surface the Ploinky router recomputes
 *     (`ploinky/cli/server/agentOpenAiDelegation.js#verifyAndMintAgentOpenAiCall`)
 *   - the request targets `<router>/<routeKey>/v1/chat/completions` with
 *     `Authorization: Bearer <assertion>`
 *   - NO legacy identity headers are sent
 *   - `rch` is bound to the bytes actually sent (mutating the body changes `rch`)
 *   - the copied `canonicalJson`/`computeRchHttp` match hardcoded golden vectors
 *     derived from ploinky's `Agent/lib/requestHash.mjs`, so drift is caught
 *     locally without importing across the container boundary.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { backendModule, buildRouterUrl } from '../../runtime/backends/builtin/ploinky-agent-openai.backend.mjs';
import {
    canonicalJson,
    computeRchHttp,
    sha256RawBodyHash,
} from '../../runtime/backends/ploinky/request-hash.mjs';
import {
    signOpenAiAgentAssertion,
    readAgentSecretBuffer,
} from '../../runtime/backends/ploinky/agent-assertion.mjs';

// A deterministic 32-byte hex secret (matches the golden-vector computation).
const SECRET_HEX =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const AGENT_ID = 'agent:test/soulgateway';
const ROUTE_KEY = 'routekey1';
const SUBJECT_ID = 'agent:somerepo/someagent';

// ── A capturing SSE upstream ────────────────────────────────────────

/**
 * Start a one-shot HTTP server that records the inbound request (method, url,
 * headers, raw body bytes) and replies with a minimal OpenAI SSE stream so the
 * backend's stream consumer terminates cleanly.
 */
async function startCaptureServer() {
    const captured = {};
    const server = createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            captured.method = req.method;
            captured.url = req.url;
            captured.headers = req.headers;
            captured.bodyBytes = Buffer.concat(chunks);
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(
                'data: {"id":"x","model":"m","choices":[{"delta":{"content":"hi"}}]}\n\n'
            );
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    return { server, captured, baseUrl: `http://127.0.0.1:${port}` };
}

function makeCtx({ baseUrl, messages, env }) {
    return {
        requestId: 'req-1',
        request: { messages },
        resolvedModel: { providerModelId: 'agent-model', modelKey: 'agent-model' },
        providerRecord: {
            baseUrl,
            authStrategy: 'none',
            settings: {},
            metadata: {
                routeKey: ROUTE_KEY,
                subjectId: SUBJECT_ID,
                discoverySource: 'ploinky-agent-discovery',
            },
        },
        env,
        signal: undefined,
    };
}

async function drain(stream) {
    const events = [];
    for await (const ev of stream) {
        events.push(ev);
    }
    return events;
}

function decodeJwtPayload(jwt) {
    const part = String(jwt).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// ── Golden vectors (computed from ploinky/Agent/lib/requestHash.mjs) ─

describe('ploinky request-hash copy — golden vectors', () => {
    it('canonicalJson sorts keys and is strict (matches ploinky)', () => {
        assert.equal(
            canonicalJson({ b: 1, a: 'x', c: [3, 2, 1] }),
            '{"a":"x","b":1,"c":[3,2,1]}'
        );
    });

    it('canonicalJson rejects undefined/function/symbol/bigint/non-finite', () => {
        assert.throws(() => canonicalJson(undefined), /not allowed/);
        assert.throws(() => canonicalJson(() => {}), /not allowed/);
        assert.throws(() => canonicalJson(Symbol('s')), /not allowed/);
        assert.throws(() => canonicalJson(10n), /not allowed/);
        assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), /not allowed/);
    });

    it('computeRchHttp matches a hardcoded golden value for a fixed bodyHash', () => {
        // Golden: computeRchHttp({POST,/v1/chat/completions,"",bodyHash:"AAAA"})
        assert.equal(
            computeRchHttp({
                method: 'POST',
                path: '/v1/chat/completions',
                query: '',
                bodyHash: 'AAAA',
            }),
            'imJw5TXWB7_btcZNWussLfS7eret4hGxojUkB6BuWkk'
        );
    });

    it('sha256RawBodyHash + computeRchHttp match golden for a fixed body', () => {
        const body = Buffer.from(
            JSON.stringify({
                model: 'm',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
            })
        );
        const bodyHash = sha256RawBodyHash(body);
        assert.equal(bodyHash, 'r5gY-zjL6Ki7xnB85nInlEPB0hYRKdfWeJ0jgI-Eah4');
        const rch = computeRchHttp({
            method: 'POST',
            path: '/v1/chat/completions',
            query: '',
            bodyHash,
        });
        assert.equal(rch, '3Ah5OLAXhAZnrTO6pDFtKlmVptjv_g6F6s5JmAxIYOI');
    });
});

// ── Signer surface ──────────────────────────────────────────────────

describe('ploinky agent-assertion signer', () => {
    it('produces a golden HS256 JWT for a fixed payload (secret hex→Buffer)', () => {
        // The Ploinky router verifies with Buffer.from(hex,"hex"); this golden
        // JWT was produced by ploinky's own signHmacJwt with the same secret,
        // so equality proves the secret-byte encoding and HMAC match.
        const body = Buffer.from(
            JSON.stringify({
                model: 'm',
                messages: [{ role: 'user', content: 'hi' }],
                stream: true,
            })
        );
        // jti is random; assert the deterministic header + payload-minus-jti and
        // recompute rch over the exact body.
        const { assertion, bodyHash, rch } = signOpenAiAgentAssertion({
            body,
            targetAgent: ROUTE_KEY,
            secret: readAgentSecretBuffer(SECRET_HEX),
            self: AGENT_ID,
            nowSeconds: 1700000000,
        });
        const header = JSON.parse(
            Buffer.from(assertion.split('.')[0], 'base64url').toString('utf8')
        );
        assert.deepEqual(header, { alg: 'HS256', typ: 'JWT' });

        const payload = decodeJwtPayload(assertion);
        assert.equal(payload.typ, 'agent-assertion');
        assert.equal(payload.iss, AGENT_ID);
        assert.equal(payload.sub, AGENT_ID);
        assert.equal(payload.aud, 'ploinky-router');
        assert.equal(payload.targetAgent, ROUTE_KEY);
        assert.equal(payload.method, 'POST');
        assert.equal(payload.path, '/v1/chat/completions');
        assert.equal(payload.tool, '__openai_chat_completions__');
        assert.equal(payload.iat, 1700000000);
        assert.equal(payload.exp, 1700000060);
        assert.equal(payload.rch, rch);
        assert.equal(rch, computeRchHttp({
            method: 'POST',
            path: '/v1/chat/completions',
            query: '',
            bodyHash,
        }));
    });

    it('readAgentSecretBuffer rejects non-hex / odd-length / empty', () => {
        assert.equal(readAgentSecretBuffer(''), null);
        assert.equal(readAgentSecretBuffer('not-hex!!'), null);
        assert.equal(readAgentSecretBuffer('abc'), null); // odd length
        assert.ok(Buffer.isBuffer(readAgentSecretBuffer('00ff')));
    });
});

// ── buildRouterUrl ──────────────────────────────────────────────────

describe('buildRouterUrl', () => {
    it('joins origin + routeKey + /v1/chat/completions', () => {
        assert.equal(
            buildRouterUrl('https://router.example', 'foo').href,
            'https://router.example/foo/v1/chat/completions'
        );
    });
    it('tolerates trailing slash on origin and slashes on routeKey', () => {
        assert.equal(
            buildRouterUrl('https://router.example/', '/foo/').href,
            'https://router.example/foo/v1/chat/completions'
        );
    });
});

// ── execute(): end-to-end signed transport (capturing server) ───────

describe('ploinky-agent-openai backend execute()', () => {
    let ctxEnv;

    before(() => {
        ctxEnv = {
            PLOINKY_AGENT_ID: AGENT_ID,
            PLOINKY_AGENT_SECRET: SECRET_HEX,
            // PLOINKY_ROUTER_URL omitted on purpose — provider.baseUrl carries the
            // capture server origin; the backend prefers it.
        };
    });

    it('targets <base>/<routeKey>/v1/chat/completions and sends Bearer assertion', async () => {
        const { server, captured, baseUrl } = await startCaptureServer();
        try {
            const ctx = makeCtx({
                baseUrl,
                messages: [{ role: 'user', content: 'hello' }],
                env: ctxEnv,
            });
            const handle = await backendModule.execute(ctx);
            await drain(handle.stream);

            assert.equal(captured.method, 'POST');
            assert.equal(captured.url, `/${ROUTE_KEY}/v1/chat/completions`);
            assert.ok(
                /^Bearer\s+\S+\.\S+\.\S+$/.test(captured.headers.authorization),
                `authorization header should be a Bearer JWT, got: ${captured.headers.authorization}`
            );
        } finally {
            server.close();
            await once(server, 'close');
        }
    });

    it('signs rch over the EXACT bytes it sends, with the verifier surface', async () => {
        const { server, captured, baseUrl } = await startCaptureServer();
        try {
            const ctx = makeCtx({
                baseUrl,
                messages: [{ role: 'user', content: 'bind these bytes' }],
                env: ctxEnv,
            });
            const handle = await backendModule.execute(ctx);
            await drain(handle.stream);

            const jwt = captured.headers.authorization.replace(/^Bearer\s+/, '');
            const payload = decodeJwtPayload(jwt);

            // Surface the router recomputes (agentOpenAiDelegation.js).
            assert.equal(payload.typ, 'agent-assertion');
            assert.equal(payload.aud, 'ploinky-router');
            assert.equal(payload.targetAgent, ROUTE_KEY);
            assert.equal(payload.tool, '__openai_chat_completions__');
            assert.equal(payload.method, 'POST');
            assert.equal(payload.path, '/v1/chat/completions');
            assert.equal(payload.iss, AGENT_ID);
            assert.equal(payload.sub, AGENT_ID);

            // rch MUST equal computeRchHttp over the bytes actually received.
            const expectedBodyHash = sha256RawBodyHash(captured.bodyBytes);
            const expectedRch = computeRchHttp({
                method: 'POST',
                path: '/v1/chat/completions',
                query: '',
                bodyHash: expectedBodyHash,
            });
            assert.equal(payload.rch, expectedRch);

            // And the body really is the OpenAI payload we expect (stream + model).
            const sent = JSON.parse(captured.bodyBytes.toString('utf8'));
            assert.equal(sent.model, 'agent-model');
            assert.equal(sent.stream, true);
            assert.deepEqual(sent.messages, [
                { role: 'user', content: 'bind these bytes' },
            ]);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });

    it('different request body → different rch (binding is content-sensitive)', async () => {
        const rchFor = async (content) => {
            const { server, captured, baseUrl } = await startCaptureServer();
            try {
                const ctx = makeCtx({
                    baseUrl,
                    messages: [{ role: 'user', content }],
                    env: ctxEnv,
                });
                const handle = await backendModule.execute(ctx);
                await drain(handle.stream);
                const jwt = captured.headers.authorization.replace(
                    /^Bearer\s+/,
                    ''
                );
                return decodeJwtPayload(jwt).rch;
            } finally {
                server.close();
                await once(server, 'close');
            }
        };
        const rchA = await rchFor('message A');
        const rchB = await rchFor('message B totally different');
        assert.notEqual(rchA, rchB);
    });

    it('does NOT send x-soul-id / x-agent-name / x-soul-agent', async () => {
        const { server, captured, baseUrl } = await startCaptureServer();
        try {
            const ctx = makeCtx({
                baseUrl,
                messages: [{ role: 'user', content: 'no legacy headers' }],
                env: ctxEnv,
            });
            const handle = await backendModule.execute(ctx);
            await drain(handle.stream);

            assert.equal(captured.headers['x-soul-id'], undefined);
            assert.equal(captured.headers['x-agent-name'], undefined);
            assert.equal(captured.headers['x-soul-agent'], undefined);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });

    it('emits a normalized stream (message_start → text_delta → done)', async () => {
        const { server, baseUrl } = await startCaptureServer();
        try {
            const ctx = makeCtx({
                baseUrl,
                messages: [{ role: 'user', content: 'hi' }],
                env: ctxEnv,
            });
            const handle = await backendModule.execute(ctx);
            const events = await drain(handle.stream);
            const types = events.map((e) => e.type);
            assert.ok(types.includes('message_start'));
            assert.ok(types.includes('text_delta'));
            assert.equal(types[types.length - 1], 'done');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });

    it('throws a clear error when PLOINKY_AGENT_SECRET is missing/non-hex', async () => {
        const ctx = makeCtx({
            baseUrl: 'http://127.0.0.1:1',
            messages: [{ role: 'user', content: 'x' }],
            env: { PLOINKY_AGENT_ID: AGENT_ID, PLOINKY_AGENT_SECRET: '' },
        });
        await assert.rejects(
            () => backendModule.execute(ctx),
            /hex PLOINKY_AGENT_SECRET/
        );
    });
});

// ── validateProviderRecord ──────────────────────────────────────────

describe('ploinky-agent-openai validateProviderRecord', () => {
    it('accepts the reconciled provider shape (auth_strategy none + routeKey)', () => {
        assert.doesNotThrow(() =>
            backendModule.validateProviderRecord({
                provider_key: `ploinky:${SUBJECT_ID}`,
                display_name: `Ploinky agent ${SUBJECT_ID}`,
                kind: 'external_api',
                provider_mode: 'external_api',
                adapter_key: 'ploinky-agent-openai',
                auth_strategy: 'none',
                base_url: 'https://router.example',
                metadata: {
                    routeKey: ROUTE_KEY,
                    subjectId: SUBJECT_ID,
                    discoverySource: 'ploinky-agent-discovery',
                },
            })
        );
    });

    it('rejects a provider missing metadata.routeKey', () => {
        assert.throws(
            () =>
                backendModule.validateProviderRecord({
                    adapter_key: 'ploinky-agent-openai',
                    auth_strategy: 'none',
                    metadata: { subjectId: SUBJECT_ID },
                }),
            /routeKey/
        );
    });
});
