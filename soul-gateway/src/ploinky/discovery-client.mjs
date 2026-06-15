/**
 * discovery-client.mjs — Soul Gateway-side client for the Ploinky router's
 * OpenAI-agent discovery endpoint.
 *
 * Soul Gateway runs as a Ploinky-managed agent. The router exposes
 * `GET /api/router/openai-agent-discovery`, which enumerates every Ploinky
 * agent that speaks the OpenAI chat-completions surface (Task 6). Soul Gateway
 * polls that endpoint and reconciles the result into its own provider/model
 * catalog (see `reconcile-agents.mjs`).
 *
 * The endpoint is control traffic mediated by the router, NOT vendor LLM
 * inference, so it authenticates with an HTTP Agent Assertion that Soul Gateway
 * signs with its OWN injected `PLOINKY_AGENT_SECRET` — the same signing
 * primitives the Ploinky-agent OpenAI backend uses for outbound calls
 * (`runtime/backends/ploinky/agent-assertion.mjs`). The assertion binds the
 * request surface (method, path, target agent, tool, and `rch` over the exact
 * — empty — GET body) so the router can verify it before answering.
 *
 * Because this is a lifecycle/discovery probe (catalog sync), it is allowed to
 * own its `node:http`/`node:https` transport, exactly like the router's own
 * discovery/delegation calls and the Task 7b agent backend transport. It is NOT
 * a completion/generation path.
 *
 * Failure policy: discovery MUST degrade gracefully. A missing config, a
 * transport error, a non-2xx status, malformed JSON, or an invalid response
 * shape all resolve to `{ complete: false, agents: [] }` (logged), never a
 * throw that could crash startup. The reconciler treats `complete !== true` as
 * "preserve existing discovered rows" — so a failed probe never disables a
 * previously discovered agent.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

import {
    readAgentSecretBuffer,
    signAgentAssertionWithRch,
} from '../runtime/backends/ploinky/agent-assertion.mjs';
import {
    computeRchHttp,
    sha256RawBodyHash,
} from '../runtime/backends/ploinky/request-hash.mjs';

// The router-internal HTTP path of the discovery endpoint. This is the path the
// router verifies the assertion against (the `/<routeKey>` mount prefix, if
// any, is stripped before the signed surface is computed), so it is the path
// the assertion signs.
export const DISCOVERY_PATH = '/api/router/openai-agent-discovery';

// The route key the discovery URL addresses and the value the router checks the
// assertion's `targetAgent` against.
export const DISCOVERY_TARGET_AGENT = 'ploinky-router';

// The tool name the router binds into the discovery assertion. Single source of
// truth shared with the router-side verifier.
export const DISCOVERY_TOOL = '__openai_agent_discovery__';

const DEFAULT_TIMEOUT_MS = 10_000;

const EMPTY_DISCOVERY = Object.freeze({ complete: false, agents: [] });

function noopLog() {}

const NOOP_LOGGER = Object.freeze({
    debug: noopLog,
    info: noopLog,
    warn: noopLog,
    error: noopLog,
});

/**
 * Read the Ploinky transport config the discovery client needs. Accepts either
 * the full app config (`config.env.PLOINKY_*`) or a flat object
 * (`config.PLOINKY_*`) so callers and tests can pass whichever they have.
 *
 * @param {object} config
 * @returns {{ routerUrl: string, agentId: string, secretHex: string }}
 */
export function readDiscoveryConfig(config) {
    const env = config?.env && typeof config.env === 'object' ? config.env : config || {};
    return {
        routerUrl: String(env.PLOINKY_ROUTER_URL ?? config?.PLOINKY_ROUTER_URL ?? '').trim(),
        agentId: String(env.PLOINKY_AGENT_ID ?? config?.PLOINKY_AGENT_ID ?? '').trim(),
        secretHex: String(env.PLOINKY_AGENT_SECRET ?? config?.PLOINKY_AGENT_SECRET ?? '').trim(),
    };
}

/**
 * True when the Ploinky discovery transport config is fully present. Used by
 * the bootstrap to skip discovery cleanly in non-Ploinky/dev mode.
 *
 * @param {object} config
 * @returns {boolean}
 */
export function isDiscoveryConfigured(config) {
    const { routerUrl, agentId, secretHex } = readDiscoveryConfig(config);
    return Boolean(routerUrl && agentId && secretHex);
}

/**
 * Sign the HTTP Agent Assertion for the discovery GET. Reuses the Task 7b
 * signing primitives so the bytes match what the router verifies.
 *
 * @param {object} args
 * @param {string} args.agentId   Soul Gateway's own principal (iss/sub)
 * @param {string} args.secretHex Hex-encoded PLOINKY_AGENT_SECRET
 * @param {number} [args.nowSeconds] Override for deterministic tests
 * @returns {string} Signed compact JWT
 */
export function signDiscoveryAssertion({ agentId, secretHex, nowSeconds }) {
    const secret = readAgentSecretBuffer(secretHex);
    if (!secret) {
        throw new Error('discovery: PLOINKY_AGENT_SECRET must be a hex string');
    }
    const bodyHash = sha256RawBodyHash('');
    const rch = computeRchHttp({
        method: 'GET',
        path: DISCOVERY_PATH,
        query: '',
        bodyHash,
    });
    return signAgentAssertionWithRch({
        secret,
        self: agentId,
        method: 'GET',
        path: DISCOVERY_PATH,
        targetAgent: DISCOVERY_TARGET_AGENT,
        tool: DISCOVERY_TOOL,
        rch,
        nowSeconds,
    });
}

/**
 * Build the discovery URL `<routerUrl>/api/router/openai-agent-discovery`,
 * tolerating a trailing slash on the router origin so we never emit a
 * double-slashed path.
 *
 * @param {string} routerUrl
 * @returns {URL}
 */
export function buildDiscoveryUrl(routerUrl) {
    const origin = String(routerUrl).replace(/\/+$/, '');
    return new URL(`${origin}${DISCOVERY_PATH}`);
}

/**
 * Perform the discovery GET and return the raw response body text + status.
 * Resolves (never rejects) on transport error so the caller can degrade.
 *
 * @param {URL} url
 * @param {object} headers
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, statusCode: number|null, body: string, error: Error|null }>}
 */
function httpGet(url, headers, timeoutMs) {
    return new Promise((resolve) => {
        const isHttps = url.protocol === 'https:';
        const reqFn = isHttps ? httpsRequest : httpRequest;
        const opts = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            headers,
        };

        const req = reqFn(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    statusCode: res.statusCode,
                    body: Buffer.concat(chunks).toString('utf8'),
                    error: null,
                });
            });
            res.on('error', (err) => {
                resolve({ ok: false, statusCode: res.statusCode ?? null, body: '', error: err });
            });
        });
        req.on('error', (err) => {
            resolve({ ok: false, statusCode: null, body: '', error: err });
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`discovery request timed out after ${timeoutMs}ms`));
        });
        req.end();
    });
}

/**
 * Validate the discovery response shape and normalize it. Returns
 * `{ complete, agents }` with only well-formed agents kept. `complete` is true
 * only when the response explicitly says `complete === true`; anything else is
 * treated as a partial/preserve-existing response.
 *
 * @param {*} parsed
 * @returns {{ complete: boolean, agents: object[] }}
 */
export function validateDiscoveryResponse(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { complete: false, agents: [] };
    }
    if (!Array.isArray(parsed.agents)) {
        return { complete: false, agents: [] };
    }

    const agents = [];
    for (const agent of parsed.agents) {
        if (!agent || typeof agent !== 'object') {
            continue;
        }
        const subjectId = typeof agent.subjectId === 'string' ? agent.subjectId.trim() : '';
        const routeKey = typeof agent.routeKey === 'string' ? agent.routeKey.trim() : '';
        const repo = typeof agent.repo === 'string' ? agent.repo.trim() : '';
        const agentName = typeof agent.agent === 'string' ? agent.agent.trim() : '';
        // Each agent MUST carry the four identity strings the reconciler keys on.
        if (!subjectId || !routeKey || !repo || !agentName) {
            continue;
        }
        agents.push(agent);
    }

    return { complete: parsed.complete === true, agents };
}

/**
 * Fetch + validate the Ploinky router's OpenAI-agent discovery. Never throws:
 * any failure resolves to `{ complete: false, agents: [] }` (logged) so the
 * caller preserves existing discovered rows.
 *
 * @param {object} config            App config (`config.env.PLOINKY_*`) or flat `PLOINKY_*`.
 * @param {object} [options]
 * @param {object} [options.log]     Logger (debug/info/warn/error).
 * @param {number} [options.timeoutMs]
 * @param {number} [options.nowSeconds] Deterministic signing override (tests).
 * @returns {Promise<{ complete: boolean, agents: object[] }>}
 */
export async function discoverPloinkyAgents(config, options = {}) {
    const log = options.log || NOOP_LOGGER;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

    const { routerUrl, agentId, secretHex } = readDiscoveryConfig(config);
    if (!routerUrl || !agentId || !secretHex) {
        log.debug?.('ploinky discovery skipped: incomplete transport config', {
            hasRouterUrl: Boolean(routerUrl),
            hasAgentId: Boolean(agentId),
            hasSecret: Boolean(secretHex),
        });
        return { ...EMPTY_DISCOVERY };
    }

    let url;
    let assertion;
    try {
        url = buildDiscoveryUrl(routerUrl);
        assertion = signDiscoveryAssertion({
            agentId,
            secretHex,
            nowSeconds: options.nowSeconds,
        });
    } catch (err) {
        log.warn?.('ploinky discovery signing failed', { error: err.message });
        return { ...EMPTY_DISCOVERY };
    }

    const headers = {
        Authorization: `Bearer ${assertion}`,
        Accept: 'application/json',
    };

    const res = await httpGet(url, headers, timeoutMs);
    if (res.error) {
        log.warn?.('ploinky discovery request failed', {
            url: `${url.origin}${url.pathname}`,
            error: res.error.message,
        });
        return { ...EMPTY_DISCOVERY };
    }
    if (!res.ok) {
        // Non-2xx is a FAILED discovery: preserve existing rows, never disable.
        log.warn?.('ploinky discovery returned non-2xx', {
            url: `${url.origin}${url.pathname}`,
            status: res.statusCode,
        });
        return { ...EMPTY_DISCOVERY };
    }

    let parsed;
    try {
        parsed = JSON.parse(res.body);
    } catch (err) {
        log.warn?.('ploinky discovery returned non-JSON body', {
            error: err.message,
        });
        return { ...EMPTY_DISCOVERY };
    }

    const validated = validateDiscoveryResponse(parsed);
    log.debug?.('ploinky discovery completed', {
        complete: validated.complete,
        agents: validated.agents.length,
    });
    return validated;
}

export default {
    DISCOVERY_PATH,
    DISCOVERY_TARGET_AGENT,
    DISCOVERY_TOOL,
    readDiscoveryConfig,
    isDiscoveryConfigured,
    signDiscoveryAssertion,
    buildDiscoveryUrl,
    validateDiscoveryResponse,
    discoverPloinkyAgents,
};
