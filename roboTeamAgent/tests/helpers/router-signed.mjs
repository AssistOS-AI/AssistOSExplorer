import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Router-signed request fixtures for the HTTP tests. Requests are minted by the
// sibling Ploinky checkout's real HTTP-route minter and verified by its real
// Agent helper; importing this module fails when that checkout is missing.
// Importing it also configures the verifier environment for the whole test
// process (each test file runs in its own process).
const PLOINKY_ROOT = fileURLToPath(new URL('../../../../ploinky/', import.meta.url));
process.env.PLOINKY_MASTER_KEY ||= '5'.repeat(64);
process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY_ROOT, 'node_modules', 'achillesAgentLib');
const { buildHttpRouteAuthInfoHeader } = await import(new URL('cli/server/routerHandlers.js', `file://${PLOINKY_ROOT}`).href);
const { deriveAgentRequestSecret } = await import(new URL('cli/utils/security/masterKey.js', `file://${PLOINKY_ROOT}`).href);
const { sha256RawBodyHash } = await import(new URL('Agent/lib/requestHash.mjs', `file://${PLOINKY_ROOT}`).href);

export const AGENT_ID = 'agent:AchillesCLI/roboTeamAgent';
export const EXTERNAL_PREFIX = '/base-agent-additional-server/roboTeamAgent/3001';
const DEFINITION = { includeAuthInfo: true, issueInvocation: true, routeKey: 'roboTeamAgent', route: { repo: 'AchillesCLI', agent: 'roboTeamAgent' } };
const ENV_KEYS = ['PLOINKY_AGENT_RUNTIME_ROOT', 'PLOINKY_AGENT_ID', 'PLOINKY_AGENT_SECRET'];

export function configureAgentEnv(overrides = {}) {
    const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const next = {
        PLOINKY_AGENT_RUNTIME_ROOT: path.join(PLOINKY_ROOT, 'Agent'),
        PLOINKY_AGENT_ID: AGENT_ID,
        PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(AGENT_ID),
        ...overrides,
    };
    for (const key of ENV_KEYS) {
        if (next[key] === undefined) delete process.env[key];
        else process.env[key] = next[key];
    }
    return () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}
configureAgentEnv();

// The session principal the Router would sign for a fixture user. A listed
// role set decides the capability: an administrator is entitled by role alone
// and keeps an empty capability list; every other fixture user (the "user"
// role and role-less actors) holds the Explorer access capability.
export function signedPrincipal({ id, username = id, roles = [] }) {
    const admin = roles.some((role) => String(role).trim().toLowerCase() === 'admin');
    return { id, username, email: '', roles: [...roles], capabilities: admin ? [] : ['explorer.access'] };
}

// Headers for one request, minted over the exact method, path, query and body.
export function signedHeaders(user, method, pathWithQuery, bodyString = '') {
    const external = `${EXTERNAL_PREFIX}${pathWithQuery}`;
    const parsed = new URL(`http://127.0.0.1:8080${external}`);
    const req = { method, url: external, headers: {}, user };
    return buildHttpRouteAuthInfoHeader(req, parsed, DEFINITION, {
        bodyHash: sha256RawBodyHash(Buffer.from(bodyString)), routePath: new URL(`http://127.0.0.1:8080${pathWithQuery}`).pathname,
    });
}

// A fixture user marker. Only a value produced here is re-signed by routerFetch,
// so a forged or hand-written header is never upgraded.
const MARKER = '__routerFetchPrincipal';
const NONCE = crypto.randomUUID();
export function authHeader(userId = 'user', roles = ['user']) {
    return JSON.stringify({ user: { id: userId, username: userId, roles }, [MARKER]: NONCE });
}

const AUTH_HEADER = 'x-ploinky-auth-info';

// fetch for a test that talks to the real server: a header produced by
// authHeader() is replaced, at send time, by headers signed over this
// request's method, path, query and body bytes. Everything else is untouched.
export async function routerFetch(input, init = undefined) {
    const headers = init?.headers;
    if (headers === undefined) return fetch(input, init);
    if (Object.getPrototypeOf(headers) !== Object.prototype) throw new TypeError('routerFetch requires plain-object headers');
    const key = Object.keys(headers).find((name) => name.toLowerCase() === AUTH_HEADER);
    let marked = null;
    if (key !== undefined && typeof headers[key] === 'string') {
        try { marked = JSON.parse(headers[key]); } catch { marked = null; }
    }
    if (!marked || marked[MARKER] !== NONCE) return fetch(input, init);
    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body)) throw new TypeError('routerFetch requires a string or Buffer body');
    const url = new URL(String(input));
    const { [key]: _marker, ...rest } = headers;
    const signed = signedHeaders(signedPrincipal(marked.user), String(init.method || 'GET').toUpperCase(), `${url.pathname}${url.search}`, body ?? '');
    return fetch(input, { ...init, headers: { ...rest, ...signed } });
}
