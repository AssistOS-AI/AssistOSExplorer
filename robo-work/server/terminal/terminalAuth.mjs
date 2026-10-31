import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Router-service token verification for the robot-terminal channel (plan section 10.1 "Verification"; M-8 SPEC coordinatorAuth row). The
// worker never re-implements this verifier: it loads Ploinky's own `<agent dir>/lib/routerServiceToken.mjs` (the Agent tree Ploinky
// mounts into every agent container, ROBO_WORK_PLOINKY_AGENT_DIR, default /Agent; the same directory runtime sources are read from) and
// uses its `verifyRouterServiceToken` with a bounded replay cache from `createRouterServiceReplayCache`. When the module cannot be loaded
// every upgrade is refused 503 (fail closed).
//
//   upgrade  `x-ploinky-auth-info` must be exactly the JSON object `{"routerServiceToken": "<jws>"}`; purpose
//            `execution-provider-terminal`, audience = this worker's principal, path = the terminals path, and `iat * 1000 >=
//            generationStartMs` (this process's start: defence in depth only, the hello token carries replay protection)
//   hello    the `helloToken` of a hello or reattach frame: purpose `execution-provider-terminal-hello` with `expectedNonce` = the nonce of
//            this connection's challenge (no generation floor; nonce and jti suffice)
// Both throw TerminalAuthError { status: 401 (refused) | 503 (verifier unavailable or misconfigured), reason }. A Router Request token
// (`typ: router-request`, the token of every routed user or agent invocation) is refused by the verifier, as is any identity claim.

export class TerminalAuthError extends Error {
    constructor(status, reason) {
        super('terminal authentication refused');
        this.status = status;
        this.reason = reason;
    }
}

const MAX_AUTH_INFO = 16 * 1024;

export function upgradeTokenFrom(header) {
    const value = Array.isArray(header) ? null : header;
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_AUTH_INFO) throw new TerminalAuthError(401, 'auth_info');
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new TerminalAuthError(401, 'auth_info'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || typeof parsed.routerServiceToken !== 'string') {
        throw new TerminalAuthError(401, 'auth_info');
    }
    return parsed.routerServiceToken;
}

// `module`: the loaded routerServiceToken module (tests pass Ploinky's file directly).
export function createTerminalAuth({ module, secret, audience, path: terminalsPath, generationStartMs }) {
    if (!module || typeof module.verifyRouterServiceToken !== 'function' || typeof module.createRouterServiceReplayCache !== 'function') {
        throw new TypeError('the Router-service token module is required');
    }
    const replayCache = module.createRouterServiceReplayCache();
    const verify = (token, options) => {
        try {
            return module.verifyRouterServiceToken(token, { secret, expectedAudience: audience, path: terminalsPath, replayCache, ...options });
        } catch (error) {
            const misconfigured = error?.code === 'ROUTER_SERVICE_VERIFIER_MISCONFIGURED';
            throw new TerminalAuthError(misconfigured ? 503 : 401, misconfigured ? 'verifier' : 'token');
        }
    };
    return Object.freeze({
        verifyUpgrade(header) {
            verify(upgradeTokenFrom(header), { purpose: module.EXECUTION_PROVIDER_TERMINAL_PURPOSE, generationStartMs });
        },
        verifyHello(token, nonce) {
            verify(token, { purpose: module.EXECUTION_PROVIDER_TERMINAL_HELLO_PURPOSE, expectedNonce: nonce });
        }
    });
}

// Loads the module from the Ploinky Agent directory; null when it is not there (the caller then refuses every upgrade).
export async function loadTerminalAuth({ agentDir, ...options }) {
    try {
        const module = await import(pathToFileURL(path.join(agentDir, 'lib', 'routerServiceToken.mjs')).href);
        return createTerminalAuth({ module, ...options });
    } catch {
        return null;
    }
}

// The auth of a worker that could not load the verifier: every upgrade is refused 503.
export const UNAVAILABLE_AUTH = Object.freeze({
    verifyUpgrade() { throw new TerminalAuthError(503, 'verifier_unavailable'); },
    verifyHello() { throw new TerminalAuthError(503, 'verifier_unavailable'); }
});
