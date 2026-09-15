import { isDeepStrictEqual } from 'node:util';

import { diagnosticEventSignature } from './diagnostic-ledger.mjs';

function authenticationCookie(cookies) {
    const selected = (cookies || []).filter((cookie) => ['ploinky_sso', 'ploinky_jwt'].includes(cookie.name));
    if (selected.length !== 1 || typeof selected[0].value !== 'string'
        || !/^[^\x00-\x20;,\x7f]+$/.test(selected[0].value)) {
        throw new Error('Router recovery requires exactly one authenticated SSO or local session cookie.');
    }
    return { name: selected[0].name, value: selected[0].value };
}

function requireSameAdministrator(principal, expectedId) {
    if (!principal || typeof principal.id !== 'string' || !principal.id
        || principal.id !== expectedId || !principal.roles?.includes('admin')) {
        throw new Error('Router recovery must retain the same authenticated administrator.');
    }
}

export function recoveryConsoleText(mode) {
    if (!['sso', 'local'].includes(mode)) throw new Error('Unproven Router authentication mode.');
    return `Failed to load resource: the server responded with a status of ${mode === 'sso' ? '401 (Unauthorized)' : '404 (Not Found)'}`;
}

export function expectedRouterRecoveryDiagnostics(baseURL, sessionId, mode) {
    const text = recoveryConsoleText(mode);
    const url = new URL(`/webtty/sessions/${encodeURIComponent(sessionId)}/stream`, baseURL).toString();
    return [
        diagnosticEventSignature({ kind: 'requestfailed', type: 'error', url, method: 'GET', failure: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING' }),
        diagnosticEventSignature({ kind: 'console', type: 'error', text: 'Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING', location: { url } }),
        diagnosticEventSignature({ kind: 'response', type: 'error', status: mode === 'sso' ? 401 : 404, url, method: 'GET' }),
        diagnosticEventSignature({ kind: 'console', type: 'error', text, location: { url } }),
    ];
}

// Session values stay in this closure, never in evidence or assertion operands.
// Node fetch has no browser cookie jar, so an expired-cookie response cannot
// clear or replace the browser's credential during the crash proof.
export function captureRouterRecoveryAuthentication({ baseURL, cookies, principal, timeoutMs = 20_000, fetchImpl = fetch }) {
    const origin = new URL(baseURL);
    if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(origin.hostname)
        || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error('Router recovery requires the selected loopback HTTP origin.');
    }
    const prior = authenticationCookie(cookies);
    const expectedId = principal?.id;
    requireSameAdministrator(principal, expectedId);
    const mode = prior.name === 'ploinky_sso' ? 'sso' : 'local';
    let priorAuthenticationProved = false;
    let completed = false;
    async function probe(pathname, cookie) {
        const target = new URL(pathname, origin);
        if (target.origin !== origin.origin) throw new Error('Router recovery probe left the selected origin.');
        let response;
        try {
            response = await fetchImpl(target, {
                method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
                headers: { Accept: 'application/json', Cookie: `${cookie.name}=${cookie.value}`, Connection: 'close' },
            });
        } catch (_) {
            throw new Error('Router recovery authentication probe could not complete.');
        }
        if (response.redirected || response.status >= 300 && response.status < 400
            || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
            throw new Error('Router recovery probe must return JSON without redirects.');
        }
        const payload = await response.json().catch(() => null);
        return { status: response.status, payload };
    }
    return Object.freeze({
        mode,
        async proveRestartedAuthentication() {
            const result = await probe('/auth/token', prior);
            if (mode === 'sso') {
                if (result.status !== 401 || !isDeepStrictEqual(result.payload, { ok: false, error: 'session_expired' })) {
                    throw new Error('The prior SSO session must expire after Router restart.');
                }
            } else {
                if (result.status !== 200) throw new Error('The local JWT session must survive Router restart.');
                requireSameAdministrator(result.payload?.user, expectedId);
            }
            priorAuthenticationProved = true;
        },
        async recoverAfterCleanup({ verifyCleanup, closeTerminal, signIn, readCookies, streamPath }) {
            if (!priorAuthenticationProved || completed) throw new Error('Router recovery authentication transition is out of order.');
            if (!/^\/webtty\/sessions\/[A-Za-z0-9_-]+\/stream$/.test(streamPath)) {
                throw new Error('Router recovery requires the exact prior terminal stream path.');
            }
            await verifyCleanup();
            await closeTerminal();
            let current = prior;
            if (mode === 'sso') {
                const authenticated = await signIn();
                requireSameAdministrator(authenticated, expectedId);
                current = authenticationCookie(await readCookies());
                const replaced = current.name === 'ploinky_sso' && current.value !== prior.value;
                if (!replaced) throw new Error('Router recovery requires a newly issued SSO session.');
            }
            const result = await probe(streamPath, current);
            if (result.status !== 404 || !isDeepStrictEqual(result.payload, { ok: false, error: 'not_found' })) {
                throw new Error('The prior terminal stream must remain absent after authenticated recovery.');
            }
            completed = true;
            return Object.freeze({ mode, priorAuthenticationStatus: mode === 'sso' ? 401 : 200,
                renewedSsoSession: mode === 'sso', authenticatedOldStreamStatus: 404 });
        },
    });
}
