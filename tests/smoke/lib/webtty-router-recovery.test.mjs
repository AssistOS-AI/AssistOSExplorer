import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { captureRouterRecoveryAuthentication, expectedRouterRecoveryDiagnostics } from './webtty-router-recovery.mjs';

const principal = Object.freeze({ id: 'USER.Owner', roles: ['admin'] });
const oldCookies = Object.freeze([{ name: 'ploinky_sso', value: 'private-old-session' }]);
const newCookies = Object.freeze([{ name: 'ploinky_sso', value: 'private-new-session' }]);
const streamPath = '/webtty/sessions/prior-terminal/stream';

function response(status, payload) {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function proof(fetchImpl, overrides = {}) {
    return captureRouterRecoveryAuthentication({ baseURL: 'http://localhost:8080', cookies: oldCookies, principal, fetchImpl, ...overrides });
}

function callbacks(events = []) {
    return {
        streamPath,
        verifyCleanup: async () => { events.push('cleanup'); },
        closeTerminal: async () => { events.push('close'); },
        signIn: async () => { events.push('sign-in'); return principal; },
        readCookies: async () => { events.push('cookies'); return newCookies; },
    };
}

test('real isolated HTTP expiry probes retain the old credential and require cleanup before fresh SSO', async (t) => {
    const events = [];
    const server = http.createServer((request, reply) => {
        const isOld = request.headers.cookie === 'ploinky_sso=private-old-session';
        if (request.url === '/auth/token') {
            assert.equal(isOld, true);
            events.push('expired');
            reply.writeHead(401, { 'content-type': 'application/json', 'set-cookie': 'ploinky_sso=; Max-Age=0; Path=/' });
            reply.end(JSON.stringify({ ok: false, error: 'session_expired' }));
            return;
        }
        assert.equal(request.url, streamPath);
        assert.equal(request.headers.cookie === 'ploinky_sso=private-new-session', true);
        events.push('absent');
        reply.writeHead(404, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const recovery = captureRouterRecoveryAuthentication({
        baseURL: `http://127.0.0.1:${server.address().port}`, cookies: oldCookies, principal,
    });
    await assert.rejects(recovery.recoverAfterCleanup(callbacks(events)), /out of order/);
    await recovery.proveRestartedAuthentication();
    await recovery.proveRestartedAuthentication();
    const result = await recovery.recoverAfterCleanup(callbacks(events));
    assert.deepEqual(events, ['expired', 'expired', 'cleanup', 'close', 'sign-in', 'cookies', 'absent']);
    assert.deepEqual(result, { mode: 'sso', priorAuthenticationStatus: 401, renewedSsoSession: true, authenticatedOldStreamStatus: 404 });
    assert.equal(oldCookies[0].value === 'private-old-session', true);
    assert.doesNotMatch(JSON.stringify({ recovery, result }), /private-old|private-new/);
    await assert.rejects(recovery.recoverAfterCleanup(callbacks()), /out of order/);
});

test('cleanup or terminal-close failures prevent reauthentication and old-stream probing', async () => {
    for (const failingStep of ['verifyCleanup', 'closeTerminal']) {
        let probes = 0;
        const recovery = proof(async () => { probes += 1; return response(401, { ok: false, error: 'session_expired' }); });
        await recovery.proveRestartedAuthentication();
        const actions = callbacks();
        actions[failingStep] = async () => { throw new Error('cleanup incomplete'); };
        actions.signIn = async () => assert.fail('must not reauthenticate');
        await assert.rejects(recovery.recoverAfterCleanup(actions), /cleanup incomplete/);
        assert.equal(probes, 1);
    }
});

test('expired SSO proof rejects success, wrong error bodies, redirects, and malformed JSON', async () => {
    for (const reply of [
        response(200, { user: principal }), response(401, { ok: false, error: 'not_authenticated' }),
        response(401, { ok: false, error: 'session_expired', extra: true }),
        new Response('', { status: 302, headers: { location: '/auth/login' } }),
        new Response('bad json', { status: 401, headers: { 'content-type': 'application/json' } }),
    ]) {
        const recovery = proof(async (_url, options) => {
            assert.equal(options.redirect, 'manual');
            return reply;
        });
        await assert.rejects(recovery.proveRestartedAuthentication(), /expire|without redirects/);
        await assert.rejects(recovery.recoverAfterCleanup(callbacks()), /out of order/);
    }
});

test('renewed SSO requires unchanged administrator identity and a different private cookie', async () => {
    for (const variant of ['different-id', 'non-admin', 'old-cookie', 'local-cookie']) {
        const recovery = proof(async () => response(401, { ok: false, error: 'session_expired' }));
        await recovery.proveRestartedAuthentication();
        const actions = callbacks();
        if (variant === 'different-id') actions.signIn = async () => ({ id: 'USER.Other', roles: ['admin'] });
        if (variant === 'non-admin') actions.signIn = async () => ({ id: principal.id, roles: ['user'] });
        if (variant === 'old-cookie') actions.readCookies = async () => oldCookies;
        if (variant === 'local-cookie') actions.readCookies = async () => [{ name: 'ploinky_jwt', value: 'other-private-cookie' }];
        await assert.rejects(recovery.recoverAfterCleanup(actions), /same authenticated administrator|newly issued SSO/);
    }
});

test('authenticated old stream must return exact not-found instead of stale auth denial or success', async () => {
    for (const [status, body] of [[401, { ok: false, error: 'session_expired' }], [200, { ok: true }], [404, { error: 'not_found' }]]) {
        const recovery = proof(async (url) => url.pathname === '/auth/token'
            ? response(401, { ok: false, error: 'session_expired' }) : response(status, body));
        await recovery.proveRestartedAuthentication();
        await assert.rejects(recovery.recoverAfterCleanup(callbacks()), /prior terminal stream must remain absent/);
    }
});

test('separately proven local JWT survives Router restart without a new sign-in', async () => {
    const events = [];
    const recovery = proof(async (url, options) => {
        assert.equal(options.headers.Cookie === 'ploinky_jwt=private-local-session', true);
        return url.pathname === '/auth/token' ? response(200, { user: principal }) : response(404, { ok: false, error: 'not_found' });
    }, { cookies: [{ name: 'ploinky_jwt', value: 'private-local-session' }] });
    await recovery.proveRestartedAuthentication();
    const actions = callbacks(events);
    actions.signIn = async () => assert.fail('surviving local JWT must not reauthenticate');
    actions.readCookies = async () => assert.fail('local JWT does not require replacement');
    const result = await recovery.recoverAfterCleanup(actions);
    assert.deepEqual(events, ['cleanup', 'close']);
    assert.equal(result.priorAuthenticationStatus, 200);
    assert.equal(result.renewedSsoSession, false);
});

test('unproven or ambiguous cookies fail closed and diagnostic sets retain every exact transport failure', () => {
    for (const cookies of [[], [...oldCookies, { name: 'ploinky_jwt', value: 'jwt' }], [{ name: 'ploinky_guest', value: 'guest' }]]) {
        assert.throws(() => proof(fetch, { cookies }), /exactly one authenticated/);
    }
    for (const mode of ['sso', 'local']) {
        const diagnostics = expectedRouterRecoveryDiagnostics('http://localhost:8080', 'prior-terminal', mode);
        assert.equal(diagnostics.length, 4);
        assert.equal(diagnostics[0].failure, 'net::ERR_INCOMPLETE_CHUNKED_ENCODING');
        assert.equal(diagnostics[1].text, 'Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING');
        assert.equal(diagnostics[2].status, mode === 'sso' ? 401 : 404);
        assert.match(diagnostics[3].text, mode === 'sso' ? /401 \(Unauthorized\)/ : /404 \(Not Found\)/);
        assert.equal(diagnostics.every((item) => (item.url || item.locationUrl) === 'http://localhost:8080/webtty/sessions/prior-terminal/stream'), true);
    }
    assert.throws(() => expectedRouterRecoveryDiagnostics('http://localhost:8080', 'prior-terminal', 'guest'), /Unproven/);
});
