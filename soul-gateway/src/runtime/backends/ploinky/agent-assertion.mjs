import crypto from 'node:crypto';

import { sha256RawBodyHash, computeRchHttp } from './request-hash.mjs';

/**
 * agent-assertion.mjs — Soul Gateway-side signer for the HTTP Agent Assertion
 * JWT used on router-mediated agent-to-agent OpenAI calls.
 *
 * Soul Gateway proves its own identity to the Ploinky router by signing a
 * short-lived assertion with its OWN injected `PLOINKY_AGENT_SECRET`. The
 * assertion binds the request surface (method, path, target agent, tool, and
 * `rch` over the exact outbound body bytes) so the router can apply MCP policy
 * and mint a target-scoped Router Request. This mirrors the agent-side signer
 * `ploinky/Agent/lib/agentAssertion.mjs#signAgentHttpAssertion`, recreated here
 * because that module lives under the container-mounted `Agent/` tree rather
 * than in the `achillesAgentLib` package Soul Gateway depends on.
 *
 * The byte-exact verifier is `ploinky/cli/server/agentOpenAiDelegation.js`
 * (`verifyAndMintAgentOpenAiCall`). It recomputes `rch` with
 * `computeRchHttp({ method:'POST', path:'/v1/chat/completions', query:'',
 * bodyHash: sha256RawBodyHash(bufferedBytes) })` — the FIXED internal OpenAI
 * path, NOT the `/<routeKey>` URL prefix (the prefix is stripped before the
 * signed surface is computed) — and requires `payload.targetAgent` to equal the
 * route key the URL addressed (`AgentAssertionService.validatePayload`). Those
 * values are reflected below and must not drift.
 *
 * Secret-byte encoding: `PLOINKY_AGENT_SECRET` is a hex string. The router
 * verifies with `Buffer.from(hex, 'hex')` (Ploinky
 * `invocationAuth.mjs#readAgentSecret`), and the Ploinky signer feeds that same
 * Buffer to `crypto.createHmac('sha256', secret)`
 * (`achillesAgentLib/jwt/jwtSign.mjs#signHmacJwt`). We therefore hex-decode the
 * secret to a Buffer and use it as the raw HMAC key.
 */

// Tool name the router binds into the assertion for an agent-to-agent OpenAI
// call. Single source of truth shared with the router/agent verifiers.
export const OPENAI_CHAT_COMPLETIONS_TOOL = '__openai_chat_completions__';

// The agent-internal HTTP path of an OpenAI chat completion. This is the path
// the router/AgentServer verify against AFTER stripping the `/<routeKey>` mount
// prefix, so it is the path the assertion signs — never the route-key-prefixed
// URL path.
export const OPENAI_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

const ASSERTION_TTL_SECONDS = 60;

function base64urlJson(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

/**
 * Turn the injected hex `PLOINKY_AGENT_SECRET` into the raw HMAC key bytes the
 * router uses to verify. Returns a Buffer, or null when the secret is absent or
 * not a hex string.
 *
 * @param {string} secretHex
 * @returns {Buffer|null}
 */
export function readAgentSecretBuffer(secretHex) {
    const hex = String(secretHex ?? '').trim();
    if (!hex) {
        return null;
    }
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
        return null;
    }
    return Buffer.from(hex, 'hex');
}

/**
 * Standard HS256 JWT signer. Byte-for-byte equivalent to Ploinky's
 * `signHmacJwt({ payload, secret })`: base64url(header) + '.' + base64url(body)
 * + '.' + base64url(HMAC-SHA256(signingInput, secret)).
 *
 * @param {object} args
 * @param {object} args.payload
 * @param {Buffer} args.secret Raw HMAC key bytes
 * @returns {string}
 */
export function signHmacJwt({ payload, secret }) {
    if (!secret || !Buffer.isBuffer(secret)) {
        throw new Error('signHmacJwt: secret (Buffer) required');
    }
    const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
    const body = base64urlJson(payload);
    const signingInput = `${header}.${body}`;
    const sig = crypto
        .createHmac('sha256', secret)
        .update(signingInput)
        .digest('base64url');
    return `${signingInput}.${sig}`;
}

/**
 * Build + sign an HTTP Agent Assertion from an already-computed `rch`. The
 * payload shape mirrors Ploinky's `signAgentAssertionWithRch` exactly (key set,
 * `tool`-optional behavior, target/secret guards), so the router accepts it.
 *
 * @param {object} args
 * @param {Buffer} args.secret      Raw HMAC key (hex-decoded agent secret)
 * @param {string} args.self        Source agent id (iss/sub) — Soul Gateway's own principal
 * @param {string} args.method
 * @param {string} args.path
 * @param {string} args.targetAgent Route key the URL addresses (router checks this)
 * @param {string} [args.tool]
 * @param {string} args.rch
 * @param {number} [args.nowSeconds] Override for deterministic tests
 * @returns {string} Signed compact JWT
 */
export function signAgentAssertionWithRch({
    secret,
    self,
    method,
    path,
    targetAgent,
    tool,
    rch,
    nowSeconds,
}) {
    if (!secret) {
        throw new Error('agentAssertion: PLOINKY_AGENT_SECRET not configured');
    }
    if (!self) {
        throw new Error('agentAssertion: PLOINKY_AGENT_ID not configured');
    }
    const target = String(targetAgent ?? '').trim();
    if (!target) {
        throw new Error('agentAssertion: targetAgent is required');
    }
    const iat =
        typeof nowSeconds === 'number'
            ? Math.floor(nowSeconds)
            : Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'agent-assertion',
        iss: self,
        sub: self,
        aud: 'ploinky-router',
        targetAgent: target,
        method: String(method),
        path: String(path),
        rch,
        iat,
        exp: iat + ASSERTION_TTL_SECONDS,
        jti: crypto.randomBytes(16).toString('base64url'),
    };
    if (tool !== undefined && tool !== null && String(tool) !== '') {
        payload.tool = String(tool);
    }
    return signHmacJwt({ payload, secret });
}

/**
 * Sign an HTTP Agent Assertion for a router-mediated OpenAI chat-completions
 * call. The signed `rch` binds the EXACT raw outbound body bytes
 * (`sha256RawBodyHash(body)`) plus the fixed OpenAI surface, matching the
 * router's `computeRchHttp` recomputation. The caller passes the precise Buffer
 * it will send so hashing and sending share identical bytes.
 *
 * @param {object} args
 * @param {Buffer} args.body          Exact outbound body bytes (already serialized)
 * @param {string} args.targetAgent   Route key the URL addresses
 * @param {Buffer} args.secret        Raw HMAC key (hex-decoded agent secret)
 * @param {string} args.self          Source agent id (Soul Gateway's principal)
 * @param {number} [args.nowSeconds]  Override for deterministic tests
 * @returns {{ assertion: string, bodyHash: string, rch: string }}
 */
export function signOpenAiAgentAssertion({
    body = Buffer.alloc(0),
    targetAgent,
    secret,
    self,
    nowSeconds,
}) {
    const bodyHash = sha256RawBodyHash(body);
    const rch = computeRchHttp({
        method: 'POST',
        path: OPENAI_CHAT_COMPLETIONS_PATH,
        query: '',
        bodyHash,
    });
    const assertion = signAgentAssertionWithRch({
        secret,
        self,
        method: 'POST',
        path: OPENAI_CHAT_COMPLETIONS_PATH,
        targetAgent,
        tool: OPENAI_CHAT_COMPLETIONS_TOOL,
        rch,
        nowSeconds,
    });
    return { assertion, bodyHash, rch };
}

export default {
    OPENAI_CHAT_COMPLETIONS_TOOL,
    OPENAI_CHAT_COMPLETIONS_PATH,
    readAgentSecretBuffer,
    signHmacJwt,
    signAgentAssertionWithRch,
    signOpenAiAgentAssertion,
};
