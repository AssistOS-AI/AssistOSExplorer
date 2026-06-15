import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
    discoverPloinkyAgents,
    validateDiscoveryResponse,
    isDiscoveryConfigured,
    signDiscoveryAssertion,
    buildDiscoveryUrl,
    DISCOVERY_PATH,
    DISCOVERY_TARGET_AGENT,
    DISCOVERY_TOOL,
} from '../../ploinky/discovery-client.mjs';
import {
    computeRchHttp,
    sha256RawBodyHash,
} from '../../runtime/backends/ploinky/request-hash.mjs';

const SILENT_LOG = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

// A 32-byte (64 hex char) secret, the shape Ploinky injects.
const SECRET_HEX = 'a'.repeat(64);
const AGENT_ID = 'agent:proxies/soul-gateway';

function decodeJwtPayload(jwt) {
    const [, body] = jwt.split('.');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

/**
 * Start a one-shot HTTP server that captures the inbound request and replies
 * with `responder({ req })` → { status, body }.
 */
async function withServer(responder, fn) {
    const captured = { method: null, url: null, headers: null };
    const server = createServer((req, res) => {
        captured.method = req.method;
        captured.url = req.url;
        captured.headers = req.headers;
        const { status = 200, body = '', contentType = 'application/json' } =
            responder({ req }) || {};
        res.writeHead(status, { 'Content-Type': contentType });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const routerUrl = `http://127.0.0.1:${port}`;
    try {
        return await fn({ routerUrl, captured });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function validAgent(overrides = {}) {
    return {
        subjectId: 'agent:demo/echo',
        routeKey: 'demo-echo',
        repo: 'demo',
        agent: 'echo',
        name: 'Echo Agent',
        routerPath: '/demo-echo',
        chatCompletionsPath: '/demo-echo/v1/chat/completions',
        supportsStreaming: true,
        usesDefaultOpenAiResponder: true,
        manifest: { name: 'echo', version: '1.0.0' },
        ...overrides,
    };
}

describe('discovery-client config helpers', () => {
    it('reads PLOINKY_* from config.env', () => {
        const config = {
            env: {
                PLOINKY_ROUTER_URL: 'http://router',
                PLOINKY_AGENT_ID: AGENT_ID,
                PLOINKY_AGENT_SECRET: SECRET_HEX,
            },
        };
        assert.equal(isDiscoveryConfigured(config), true);
    });

    it('reads PLOINKY_* from a flat config too', () => {
        const config = {
            PLOINKY_ROUTER_URL: 'http://router',
            PLOINKY_AGENT_ID: AGENT_ID,
            PLOINKY_AGENT_SECRET: SECRET_HEX,
        };
        assert.equal(isDiscoveryConfigured(config), true);
    });

    it('is not configured when any field is missing', () => {
        assert.equal(
            isDiscoveryConfigured({
                env: { PLOINKY_ROUTER_URL: 'http://router' },
            }),
            false
        );
    });

    it('builds the discovery URL without a double slash', () => {
        assert.equal(
            buildDiscoveryUrl('http://router/').href,
            `http://router${DISCOVERY_PATH}`
        );
        assert.equal(
            buildDiscoveryUrl('http://router').href,
            `http://router${DISCOVERY_PATH}`
        );
    });
});

describe('signDiscoveryAssertion', () => {
    it('signs the exact GET surface with the rch over an empty body', () => {
        const jwt = signDiscoveryAssertion({
            agentId: AGENT_ID,
            secretHex: SECRET_HEX,
            nowSeconds: 1_000,
        });
        const payload = decodeJwtPayload(jwt);

        assert.equal(payload.typ, 'agent-assertion');
        assert.equal(payload.iss, AGENT_ID);
        assert.equal(payload.sub, AGENT_ID);
        assert.equal(payload.aud, 'ploinky-router');
        assert.equal(payload.targetAgent, DISCOVERY_TARGET_AGENT);
        assert.equal(payload.method, 'GET');
        assert.equal(payload.path, DISCOVERY_PATH);
        assert.equal(payload.tool, DISCOVERY_TOOL);

        const expectedRch = computeRchHttp({
            method: 'GET',
            path: DISCOVERY_PATH,
            query: '',
            bodyHash: sha256RawBodyHash(''),
        });
        assert.equal(payload.rch, expectedRch);
    });

    it('throws on a non-hex secret', () => {
        assert.throws(
            () => signDiscoveryAssertion({ agentId: AGENT_ID, secretHex: 'not-hex' }),
            /hex string/
        );
    });
});

describe('validateDiscoveryResponse', () => {
    it('keeps only well-formed agents and reports complete', () => {
        const out = validateDiscoveryResponse({
            complete: true,
            agents: [
                validAgent(),
                { subjectId: 'agent:x/y' }, // missing routeKey/repo/agent
                null,
                { routeKey: 'z', repo: 'z', agent: 'z' }, // missing subjectId
            ],
        });
        assert.equal(out.complete, true);
        assert.equal(out.agents.length, 1);
        assert.equal(out.agents[0].subjectId, 'agent:demo/echo');
    });

    it('treats missing complete as false', () => {
        const out = validateDiscoveryResponse({ agents: [validAgent()] });
        assert.equal(out.complete, false);
        assert.equal(out.agents.length, 1);
    });

    it('treats a non-object / non-array agents as empty + incomplete', () => {
        assert.deepEqual(validateDiscoveryResponse(null), {
            complete: false,
            agents: [],
        });
        assert.deepEqual(validateDiscoveryResponse({ complete: true }), {
            complete: false,
            agents: [],
        });
        assert.deepEqual(validateDiscoveryResponse([]), {
            complete: false,
            agents: [],
        });
    });
});

describe('discoverPloinkyAgents', () => {
    it('fetches, sends the bearer assertion, and returns validated data', async () => {
        await withServer(
            () => ({
                status: 200,
                body: { complete: true, agents: [validAgent()] },
            }),
            async ({ routerUrl, captured }) => {
                const result = await discoverPloinkyAgents(
                    {
                        env: {
                            PLOINKY_ROUTER_URL: routerUrl,
                            PLOINKY_AGENT_ID: AGENT_ID,
                            PLOINKY_AGENT_SECRET: SECRET_HEX,
                        },
                    },
                    { log: SILENT_LOG }
                );

                assert.equal(result.complete, true);
                assert.equal(result.agents.length, 1);
                assert.equal(result.agents[0].subjectId, 'agent:demo/echo');

                // Verify transport surface.
                assert.equal(captured.method, 'GET');
                assert.equal(captured.url, DISCOVERY_PATH);
                assert.match(
                    captured.headers.authorization,
                    /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/
                );
            }
        );
    });

    it('treats a non-2xx status as a failed discovery (preserve existing)', async () => {
        await withServer(
            () => ({ status: 503, body: { error: 'unavailable' } }),
            async ({ routerUrl }) => {
                const result = await discoverPloinkyAgents(
                    {
                        env: {
                            PLOINKY_ROUTER_URL: routerUrl,
                            PLOINKY_AGENT_ID: AGENT_ID,
                            PLOINKY_AGENT_SECRET: SECRET_HEX,
                        },
                    },
                    { log: SILENT_LOG }
                );
                assert.deepEqual(result, { complete: false, agents: [] });
            }
        );
    });

    it('treats malformed JSON as a failed discovery', async () => {
        await withServer(
            () => ({ status: 200, body: 'not json{' }),
            async ({ routerUrl }) => {
                const result = await discoverPloinkyAgents(
                    {
                        env: {
                            PLOINKY_ROUTER_URL: routerUrl,
                            PLOINKY_AGENT_ID: AGENT_ID,
                            PLOINKY_AGENT_SECRET: SECRET_HEX,
                        },
                    },
                    { log: SILENT_LOG }
                );
                assert.deepEqual(result, { complete: false, agents: [] });
            }
        );
    });

    it('skips cleanly (no throw, no request) when config is incomplete', async () => {
        const result = await discoverPloinkyAgents(
            { env: { PLOINKY_ROUTER_URL: 'http://router' } },
            { log: SILENT_LOG }
        );
        assert.deepEqual(result, { complete: false, agents: [] });
    });

    it('degrades on a connection error to an unreachable router', async () => {
        // Reserve a port, then close the server so the connect refuses.
        const { routerUrl } = await withServer(
            () => ({ status: 200, body: { complete: true, agents: [] } }),
            async ({ routerUrl }) => ({ routerUrl })
        );
        const result = await discoverPloinkyAgents(
            {
                env: {
                    PLOINKY_ROUTER_URL: routerUrl,
                    PLOINKY_AGENT_ID: AGENT_ID,
                    PLOINKY_AGENT_SECRET: SECRET_HEX,
                },
            },
            { log: SILENT_LOG, timeoutMs: 2000 }
        );
        assert.deepEqual(result, { complete: false, agents: [] });
    });
});
