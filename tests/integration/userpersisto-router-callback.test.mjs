import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run with explicitly selected PLOINKY_REPO_ROOT and PLOINKY_AGENTLIB_DIR.
// Only generation admission is a fixture: provider, runtime HTTP, bridge,
// callback handler, cookies, and session creation execute their real code.
test('UserPersisto handoffs retain client-error semantics through the Ploinky Router', async (t) => {
    const ploinkyRoot = process.env.PLOINKY_REPO_ROOT;
    assert.ok(ploinkyRoot && path.isAbsolute(ploinkyRoot), 'PLOINKY_REPO_ROOT must select an absolute Ploinky checkout');
    assert.ok(process.env.PLOINKY_AGENTLIB_DIR && path.isAbsolute(process.env.PLOINKY_AGENTLIB_DIR), 'PLOINKY_AGENTLIB_DIR must select the shared runtime');
    assert.ok(fs.existsSync(path.join(ploinkyRoot, 'cli/server/authHandlers/authRoutes.js')));
    const explorerRoot = fileURLToPath(new URL('../../', import.meta.url));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'userpersisto-router-callback-'));
    const previousCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    const environment = {
        PLOINKY_WORKSPACE_ROOT: temp,
        PLOINKY_CWD: temp,
        PLOINKY_MASTER_KEY: randomBytes(32).toString('hex'),
        PERSISTENCE_FOLDER: path.join(temp, 'persisto'),
        USERPERSISTO_SETTINGS_KEY: randomBytes(32).toString('hex'),
        USERPERSISTO_RUNTIME_SECRET: randomBytes(32).toString('hex'),
        USERPERSISTO_AUTH_METHODS: 'password',
        USERPERSISTO_ALLOWED_REDIRECT_ORIGINS: '',
        USERPERSISTO_OIDC_ISSUER: '',
    };
    const previousEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    let providerServer;
    let routerServer;
    let resetStore;
    let providerOrigin;
    let now = Date.now();
    const loginRequests = [];
    const codeExchanges = [];
    const clock = t.mock.method(Date, 'now', () => now);
    const fetchObserver = t.mock.method(globalThis, 'fetch', async (...args) => {
        const response = await originalFetch(...args);
        const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
        if (url.origin === providerOrigin && url.pathname === '/service/runtime/sso-login-request') {
            loginRequests.push({ status: response.status, body: await response.clone().json() });
        }
        if (url.origin === providerOrigin && url.pathname === '/service/runtime/sso-consume-code') {
            codeExchanges.push({ status: response.status, body: await response.clone().json() });
        }
        return response;
    });

    try {
        Object.assign(process.env, environment);
        process.chdir(temp);
        const providerDirectory = path.join(temp, '.ploinky/repos/callback-fixture/identity');
        fs.mkdirSync(path.join(providerDirectory, 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(providerDirectory, 'manifest.json'), JSON.stringify({ ssoProvider: true }));
        const runtimeUrl = pathToFileURL(path.join(explorerRoot, 'userPersistoAgent/runtime/index.mjs')).href;
        fs.writeFileSync(path.join(providerDirectory, 'runtime/index.mjs'), `export * from ${JSON.stringify(runtimeUrl)};\n`);

        const { ensureSeedData } = await import('../../userPersistoAgent/lib/bootstrap.mjs');
        const { createUser, updateUser } = await import('../../userPersistoAgent/lib/users.mjs');
        ({ resetStoreForTests: resetStore } = await import('../../userPersistoAgent/lib/store.mjs'));
        const { startService } = await import('../../userPersistoAgent/service/index.mjs');
        await ensureSeedData();
        const password = randomBytes(24).toString('base64url');
        const user = await createUser({ email: 'callback-user@example.test', password, roles: ['user'] });
        const blockedUser = await createUser({ email: 'callback-blocked@example.test', password, roles: ['user'] });
        providerServer = startService({ port: 0, host: '127.0.0.1' });
        if (!providerServer.listening) await once(providerServer, 'listening');
        providerOrigin = `http://127.0.0.1:${providerServer.address().port}`;
        fs.writeFileSync(path.join(temp, '.ploinky/agents.json'), JSON.stringify({
            _config: { sso: { enabled: true, providerAgent: 'callback-fixture/identity', providerConfig: {
                routerBaseUrl: providerOrigin, runtimePath: '/service/runtime', loginPath: '/service/auth/',
            } } },
        }));

        const { handleAuthRoutes } = await import(pathToFileURL(path.join(ploinkyRoot, 'cli/server/authHandlers/authRoutes.js')).href);
        const snapshot = {
            generation: 'isolated-callback-generation',
            agents: { explorer: { type: 'agent', agentName: 'explorer', repoName: 'callback-fixture', auth: { mode: 'sso' } } },
            routing: { static: { agent: 'explorer' }, routes: { explorer: { agent: 'explorer', repo: 'callback-fixture', hostPort: 0 } } },
            manifests: {},
        };
        const routePlan = { ok: false, hostSelection: { kind: 'control', host: '127.0.0.1' }, snapshot,
            lease: { id: snapshot.generation, snapshot, commit: () => true } };
        routerServer = createServer((request, response) => {
            handleAuthRoutes(request, response, new URL(request.url, `http://${request.headers.host}`), { routePlan }).catch(() => {
                if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'integration_handler_failure' }));
            });
        });
        routerServer.listen(0, '127.0.0.1');
        await once(routerServer, 'listening');
        const routerOrigin = `http://127.0.0.1:${routerServer.address().port}`;

        async function request(url, cookie = '') {
            return fetch(new URL(url, routerOrigin), { redirect: 'manual', headers: { cookie, accept: 'application/json' } });
        }

        async function begin(account = user) {
            const previousCount = loginRequests.length;
            const login = await request('/auth/login?returnTo=%2Fexplorer%2F');
            assert.equal(login.status, 200);
            assert.equal(loginRequests.length, previousCount + 1, 'the real provider runtime creates the login request');
            assert.equal(loginRequests.at(-1).status, 200);
            const { request: providerRequest } = loginRequests.at(-1).body;
            const loginHtml = await login.text();
            const redirect = loginHtml.match(/window\.location\.replace\(("(?:[^"\\]|\\.)*")\);/);
            assert.ok(redirect, 'the Router renders its browser redirect to the identity provider');
            const authorization = new URL(JSON.parse(redirect[1]));
            const state = authorization.searchParams.get('state');
            assert.equal(authorization.origin, routerOrigin, 'browser login retains the public callback origin');
            assert.equal(authorization.searchParams.get('requestId'), providerRequest.providerState);
            const proof = login.headers.getSetCookie().find((cookie) => cookie.startsWith(`ploinky_sso_login_${state}=`));
            assert.ok(proof && /;\s*HttpOnly(?:;|$)/i.test(proof), 'the Router supplies its own browser binding cookie');
            const issued = await fetch(`${providerOrigin}/service/auth/password/login`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ email: account.email, password, requestId: providerRequest.providerState, state }),
            });
            assert.equal(issued.status, 200);
            const data = await issued.json();
            assert.equal(typeof data.code, 'string');
            const callback = new URL(data.redirectUri);
            assert.equal(callback.origin, routerOrigin);
            callback.searchParams.set('code', data.code);
            callback.searchParams.set('state', data.state);
            return { callback: callback.href, cookie: proof.split(';')[0], pendingExpiresAt: Date.parse(providerRequest.expiresAt), issuedAt: now };
        }

        async function assertDenied(response, error) {
            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), { ok: false, error }, 'browser denial does not expose provider-specific details');
            assert.deepEqual(response.headers.getSetCookie(), [], 'a denial issues neither session nor mutation cookies');
        }

        async function assertReplayRejected(flow) {
            const before = codeExchanges.length;
            await assertDenied(await request(flow.callback, flow.cookie), 'invalid_authorization_browser');
            assert.equal(codeExchanges.length, before, 'replay is rejected before another provider code exchange');
        }

        await t.test('valid handoff creates a session once; replay cannot issue cookies', async () => {
            const flow = await begin();
            const response = await request(flow.callback, flow.cookie);
            assert.equal(response.status, 302);
            assert.equal(response.headers.get('location'), '/explorer/');
            assert.equal(codeExchanges.at(-1).status, 200);
            assert.equal(codeExchanges.at(-1).body.user.id, user.id);
            const session = response.headers.getSetCookie().find((cookie) => cookie.startsWith('ploinky_sso='));
            assert.ok(session);
            assert.ok(response.headers.getSetCookie().some((cookie) => cookie.startsWith('ploinky_browser_csrf=')));
            await response.arrayBuffer();
            const identity = await request('/auth/token', session.split(';')[0]);
            assert.equal(identity.status, 200);
            assert.equal((await identity.json()).user.id, user.id);
            await assertReplayRejected(flow);
        });

        await t.test('an expired two-minute code yields neutral 400 while five-minute state is still valid', async () => {
            const flow = await begin();
            now += 2 * 60 * 1000 + 1;
            assert.equal(flow.pendingExpiresAt - flow.issuedAt, 5 * 60 * 1000);
            assert.ok(now < flow.pendingExpiresAt, 'this exercises provider code expiry, not Router state expiry');
            const before = codeExchanges.length;
            await assertDenied(await request(flow.callback, flow.cookie), 'invalid_authorization_code');
            assert.equal(codeExchanges.length, before + 1);
            assert.equal(codeExchanges.at(-1).status, 400);
            assert.deepEqual(codeExchanges.at(-1).body, { ok: false, error: 'auth_code_expired' });
            await assertReplayRejected(flow);
        });

        await t.test('blocking the account after issuance yields neutral 400 without creating a session', async () => {
            const flow = await begin(blockedUser);
            await updateUser(blockedUser.id, { status: 'blocked' });
            assert.ok(now < flow.pendingExpiresAt);
            const before = codeExchanges.length;
            await assertDenied(await request(flow.callback, flow.cookie), 'invalid_authorization_code');
            assert.equal(codeExchanges.length, before + 1);
            assert.equal(codeExchanges.at(-1).status, 403);
            assert.deepEqual(codeExchanges.at(-1).body, { ok: false, error: 'user_not_active' });
            await assertReplayRejected(flow);
        });
    } finally {
        if (routerServer?.listening) await new Promise((resolve, reject) => routerServer.close((error) => error ? reject(error) : resolve()));
        if (providerServer?.listening) await new Promise((resolve, reject) => providerServer.close((error) => error ? reject(error) : resolve()));
        if (resetStore) await resetStore();
        fetchObserver.mock.restore();
        clock.mock.restore();
        process.chdir(previousCwd);
        for (const [key, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
