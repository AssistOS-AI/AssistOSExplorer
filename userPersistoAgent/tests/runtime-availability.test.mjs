import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createProvider } from '../runtime/index.mjs';

// The Router ends a session only on a definitive refusal from `sso-user`;
// every other outcome must reach it as `providerUnavailable`.
async function stubRuntime(t, handler) {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
    }));
    return `http://127.0.0.1:${server.address().port}`;
}

function providerFor(routerBaseUrl) {
    const config = { routerBaseUrl, runtimePath: '/service/runtime', runtimeSecret: 'fixture-secret' };
    return createProvider({ getConfig: async () => config });
}

const SESSION = Object.freeze({ provider: 'userPersistoAgent', userId: 'USER.fixture', generation: 0 });

function reply(status, body, contentType = 'application/json') {
    return (_req, res) => {
        res.writeHead(status, { 'Content-Type': contentType });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
}

for (const [code, status] of [['session_revoked', 401], ['user_not_active', 403], ['user_not_found', 404]]) {
    test(`sso-user ${status} ${code} is a definitive refusal`, async (t) => {
        const provider = providerFor(await stubRuntime(t, reply(status, { ok: false, error: code })));
        await assert.rejects(provider.sso_refresh_session({ providerSession: SESSION }), (error) => {
            assert.equal(error.code, code);
            assert.equal(error.statusCode, status);
            assert.equal(error.providerUnavailable, undefined);
            return true;
        });
    });
}

for (const [label, handler] of [
    ['a 503 while the agent restarts', reply(503, { ok: false, error: 'EDGE_GENERATION_INACTIVE' })],
    ['a 500 internal error', reply(500, { ok: false, error: 'internal_error' })],
    ['a 502 HTML gateway page', reply(502, '<html>bad gateway</html>', 'text/html')],
    ['a Router 404 for a missing route', reply(404, { ok: false, error: 'not_found' })],
    ['a runtime secret mismatch', reply(401, { ok: false, error: 'runtime secret required' })],
    ['a refusal code with the wrong status', reply(500, { ok: false, error: 'user_not_found' })],
    ['a malformed success body', reply(200, { ok: true })],
]) {
    test(`sso-user ${label} is provider unavailability, not a refusal`, async (t) => {
        const provider = providerFor(await stubRuntime(t, handler));
        await assert.rejects(provider.sso_refresh_session({ providerSession: SESSION }),
            (error) => error.providerUnavailable === true);
    });
}

test('an unreachable runtime is provider unavailability', async (t) => {
    const base = await stubRuntime(t, reply(200, {}));
    const closed = new URL(base);
    // Reserve, then release, a port so nothing listens on it.
    const probe = http.createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    closed.port = String(probe.address().port);
    await new Promise((resolve) => probe.close(resolve));
    await assert.rejects(providerFor(closed.origin).sso_refresh_session({ providerSession: SESSION }),
        (error) => error.providerUnavailable === true);
});

test('a missing runtime secret configuration is provider unavailability', async () => {
    const provider = createProvider({ getConfig: async () => { throw new Error('UserPersisto runtime secret is not configured'); } });
    await assert.rejects(provider.sso_refresh_session({ providerSession: SESSION }),
        (error) => error.providerUnavailable === true);
});

test('the caller signal aborts a hung validation at once and releases the socket', async (t) => {
    let opened = 0;
    let closedSockets = 0;
    const base = await stubRuntime(t, (req) => {
        opened += 1;
        req.socket.on('close', () => { closedSockets += 1; });
    });
    const controller = new AbortController();
    const pending = providerFor(base).sso_refresh_session({ providerSession: SESSION, signal: controller.signal });
    while (opened === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    controller.abort(new Error('bridge deadline'));
    await assert.rejects(pending, (error) => error.providerUnavailable === true);
    assert.ok(Date.now() - started < 1000);
    for (let i = 0; i < 100 && closedSockets === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(closedSockets, 1);
});

test('a hung validation without a caller signal is bounded below the Router deadline', async (t) => {
    const base = await stubRuntime(t, () => {});
    const started = Date.now();
    await assert.rejects(providerFor(base).sso_refresh_session({ providerSession: SESSION }),
        (error) => error.providerUnavailable === true);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 3_500 && elapsed < 5_000, `elapsed ${elapsed} ms`);
});
