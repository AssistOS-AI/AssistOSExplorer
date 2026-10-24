import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';

// The actual UserPersisto service and wizard behind a small Router stand-in.
// Google's script address resolves to a local socket that never answers, so
// the wizard's script request stays pending without any traffic to Google.
const PREFIX = '/base-agent-additional-server/userPersistoAgent/7000';
const WIZARD = `${PREFIX}/service/auth/`;
const GIS = 'https://accounts.google.com/gsi/client';
const userPersisto = (relative) => new URL(`../../../userPersistoAgent/${relative}`, import.meta.url).href;

test('a password sign-in retires Google before navigating and only a proven script abort is acknowledged', { timeout: 180_000 }, async (t) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-navigation-cancellation-'));
    process.env.PERSISTENCE_FOLDER = path.join(scratch, 'persisto');
    process.env.USERPERSISTO_SETTINGS_KEY = 'fixture-settings-key-for-local-test';
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
    const [{ ensureSeedData }, { getStore, resetStoreForTests }, { updateAuthPolicy }, { createLoginRequest, consumeAuthCode }, setup, { startService }] = await Promise.all([
        import(userPersisto('lib/bootstrap.mjs')), import(userPersisto('lib/store.mjs')), import(userPersisto('lib/policy.mjs')),
        import(userPersisto('lib/sso.mjs')), import(userPersisto('tests/helpers/setup.mjs')), import(userPersisto('service/index.mjs'))]);

    const started = performance.now();
    let events = [];
    const record = (kind, detail = {}) => events.push({ kind, atMs: performance.now() - started, ...detail });
    let cleanupMode = 'normal';
    let sinkMode = 'hold';
    let destinationScript = '';
    const parents = new Map();
    const sessions = new Map();
    const heldResponses = new Set();
    const sinkSockets = new Set();
    let service;
    let front;
    let sink;
    let browser;
    try {
        service = startService({ port: 0, host: '127.0.0.1' }, { emailStatus: async () => ({ available: false }) });
        if (!service.listening) await once(service, 'listening');
        const servicePort = service.address().port;
        front = http.createServer(async (req, res) => {
            const url = new URL(req.url, 'http://fixture.invalid');
            if (url.pathname === '/auth/token') {
                const user = sessions.get(/fixture-session=([a-f0-9-]+)/.exec(req.headers.cookie || '')?.[1]);
                res.writeHead(user ? 200 : 401, { 'content-type': 'application/json' });
                res.end(JSON.stringify(user ? { user: { id: user.id, email: user.email, roles: ['user'] } } : { error: 'unauthenticated' }));
                return;
            }
            if (url.pathname === '/auth/login') {
                const request = await createLoginRequest({ redirectUri: `${baseURL}/auth/callback` });
                const state = `fixture-state-${parents.size}`;
                parents.set(state, { providerState: request.providerState, returnTo: url.searchParams.get('returnTo') });
                res.writeHead(302, { location: `${WIZARD}?requestId=${encodeURIComponent(request.providerState)}&state=${state}` }).end();
                return;
            }
            if (url.pathname === '/auth/callback') {
                record('callback-received');
                const parent = parents.get(url.searchParams.get('state'));
                const described = await consumeAuthCode({ providerState: parent?.providerState, code: url.searchParams.get('code') });
                const session = crypto.randomUUID();
                sessions.set(session, described.user);
                res.writeHead(302, { location: parent.returnTo, 'set-cookie': `fixture-session=${session}; Path=/; HttpOnly` }).end();
                return;
            }
            if (url.pathname === '/destination') {
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end(`<h1 id="destination">Destination</h1>${destinationScript ? `<script>${destinationScript}</script>` : ''}`);
                return;
            }
            if (!url.pathname.startsWith(`${PREFIX}/`)) { res.writeHead(404).end(); return; }
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            const cleanup = url.pathname === `${WIZARD}google/cancel`;
            if (cleanup) {
                record('cancel-received', { keys: Object.keys(JSON.parse(body.toString() || '{}')).sort(), sameOrigin: req.headers.origin === baseURL });
                if (cleanupMode === 'status-500' || cleanupMode === 'status-400') {
                    res.writeHead(cleanupMode === 'status-500' ? 500 : 400, { 'content-type': 'application/json' }).end('{"ok":false}');
                    return;
                }
                if (cleanupMode === 'abort') { req.socket.destroy(); return; }
                if (cleanupMode === 'hang') { heldResponses.add(res); return; }
            }
            const upstream = http.request({ host: '127.0.0.1', port: servicePort, path: url.pathname.slice(PREFIX.length) + url.search, method: req.method,
                headers: { ...req.headers, host: `127.0.0.1:${servicePort}`, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'http', 'x-forwarded-prefix': PREFIX } }, (response) => {
                const parts = [];
                response.on('data', (part) => parts.push(part));
                response.on('end', () => {
                    const payload = Buffer.concat(parts);
                    if (url.pathname === `${WIZARD}google/start` && response.statusCode === 200) {
                        const handle = JSON.parse(payload).transaction;
                        record('google-started', { handle, setsProof: (response.headers['set-cookie'] || []).some((value) => value.startsWith(`up_google_${handle}=`)) });
                    }
                    if (cleanup) {
                        // Only metadata: the body may carry the parent's address.
                        record('cancel-upstream', { status: response.statusCode, clearsProof: (response.headers['set-cookie'] || []).some((value) => /Max-Age=0/.test(value)) });
                    }
                    const deliver = () => {
                        if (res.destroyed) { record('downstream-closed'); return; }
                        res.writeHead(response.statusCode, response.headers);
                        res.end(payload);
                        if (cleanup) record('cancel-delivered');
                    };
                    if (cleanup && cleanupMode === 'delay') setTimeout(deliver, 800);
                    else deliver();
                });
            });
            upstream.on('error', () => { if (!res.destroyed) res.writeHead(502).end(); });
            upstream.end(body);
        });
        await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
        const baseURL = `http://127.0.0.1:${front.address().port}`;
        sink = net.createServer((socket) => {
            sinkSockets.add(socket);
            socket.on('error', () => {});
            if (sinkMode === 'reset') socket.destroy();
        });
        await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
        process.env.SMOKE_BASE_URL = baseURL;
        process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${baseURL}${WIZARD}google/callback`;
        process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS = baseURL;
        setup.resetAuthLimitsForTests();
        await ensureSeedData();
        const email = 'cancellation-fixture@example.test';
        const { password } = await setup.signUpDirect(email, { redirectUri: `${baseURL}/auth/callback` });
        await updateAuthPolicy({ enabledAuthMethods: ['password', 'google'] });
        const account = { username: email, loginEmail: email, signInMethod: 'password', accountPassword: password };
        const { signIn } = await import('./auth.mjs');
        const { assertPageDiagnosticsClean, attachPageDiagnostics } = await import('./fixtures.mjs');
        browser = await chromium.launch({ args: [`--host-resolver-rules=MAP accounts.google.com 127.0.0.1:${sink.address().port},MAP * ~NOTFOUND,EXCLUDE 127.0.0.1`] });

        const statusOf = async (handle) => (await (await getStore()).select('googleAuthTransaction')).objects.find((row) => row.stateHash === handle)?.status;
        async function run({ diagnostics: attach = true, auxiliaryCdp = false, signInAccount = account } = {}) {
            events = [];
            const artifacts = fs.mkdtempSync(path.join(scratch, 'artifacts-'));
            const context = await browser.newContext({ baseURL });
            const page = await context.newPage();
            const observed = [];
            for (const kind of ['request', 'requestfinished', 'requestfailed']) {
                page.on(kind, (request) => {
                    const url = new URL(request.url());
                    if (url.pathname === `${WIZARD}google/cancel` || url.href === GIS || url.pathname === '/auth/callback') {
                        observed.push({ kind, path: url.href === GIS ? 'gis' : url.pathname.replace(WIZARD, ''), failure: request.failure()?.errorText });
                        record(`browser-${kind}`, { path: observed.at(-1).path });
                    }
                });
            }
            if (auxiliaryCdp) {
                const session = await context.newCDPSession(page);
                await session.send('Network.enable');
                await session.send('Page.enable');
            }
            const diagnostics = attach ? attachPageDiagnostics(page, { outputPath: (...parts) => path.join(artifacts, ...parts) }, 'auth') : null;
            let principal;
            let error;
            try {
                principal = await signIn(page, signInAccount, '/destination', { requireConfiguredPrincipal: true });
            } catch (failure) {
                error = failure;
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
            const handle = events.find((event) => event.kind === 'google-started')?.handle;
            const cookies = (await context.cookies()).map(({ name }) => name);
            const result = { page, context, artifacts, diagnostics, principal, error, handle, observed, cookies, events: [...events] };
            result.close = async () => {
                await context.close();
                fs.rmSync(artifacts, { recursive: true, force: true });
            };
            return result;
        }
        const at = (result, kind) => result.events.find((event) => event.kind === kind)?.atMs;
        const cleanupFailures = (result) => result.observed.filter(({ kind, path: where }) => kind === 'requestfailed' && where === 'google/cancel');
        const gisAborts = (diagnostics) => diagnostics.events.filter((event) => event.kind === 'requestfailed' && event.url === GIS);
        const proofs = (diagnostics) => diagnostics.events.filter((event) => event.kind === 'navigationcancellation');

        for (const auxiliaryCdp of [false, true]) {
            await t.test(`normal cleanup ${auxiliaryCdp ? 'with' : 'without'} an auxiliary CDP session`, async () => {
                cleanupMode = 'normal';
                const result = await run({ auxiliaryCdp });
                try {
                    assert.equal(result.error, undefined, result.error?.message);
                    assert.equal(result.principal.canonicalUsername, email);
                    assert.equal(result.page.url(), `${baseURL}/destination`);
                    const received = result.events.filter((event) => event.kind === 'cancel-received');
                    assert.deepEqual(received.map(({ keys, sameOrigin }) => [keys, sameOrigin]), [[['transaction'], true]], 'exactly one cleanup request');
                    assert.deepEqual(result.events.filter((event) => event.kind === 'cancel-upstream').map(({ status, clearsProof }) => [status, clearsProof]), [[200, true]]);
                    assert.ok(at(result, 'cancel-delivered') < at(result, 'callback-received'), 'the cleanup response is delivered before the callback navigation');
                    const cleanupFinished = result.events.find((event) => event.kind === 'browser-requestfinished' && event.path === 'google/cancel')?.atMs;
                    const callbackRequested = result.events.find((event) => event.kind === 'browser-request' && event.path === '/auth/callback')?.atMs;
                    assert.ok(cleanupFinished < callbackRequested, 'the browser finished the cleanup body before requesting the callback');
                    assert.deepEqual(cleanupFailures(result), [], 'no cleanup POST requestfailed');
                    assert.equal(result.events.find((event) => event.kind === 'google-started')?.setsProof, true);
                    assert.equal(result.cookies.includes(`up_google_${result.handle}`), false, 'the exact proof cookie is removed');
                    assert.equal(await statusOf(result.handle), 'cancelled');
                    await resetStoreForTests();
                    assert.equal(await statusOf(result.handle), 'cancelled', 'cancellation is durable after reopening the store');
                    assert.equal(gisAborts(result.diagnostics).length, 1, 'the original script abort is retained');
                    assert.equal(gisAborts(result.diagnostics)[0].failure, 'net::ERR_ABORTED');
                    assert.equal(proofs(result.diagnostics).length, 1, 'exactly one explicit acknowledgement');
                    assert.deepEqual(result.diagnostics.actionableEvents(), []);
                    assert.doesNotThrow(() => assertPageDiagnosticsClean(result.page));
                    await result.diagnostics.flush();
                    const saved = fs.readFileSync(path.join(result.artifacts, 'diagnostics', 'auth.browser-events.json'), 'utf8');
                    for (const value of [password, email, result.handle, 'requestId=', 'code=', 'fixture-state', 'fixture-session']) {
                        assert.equal(saved.includes(value), false, 'persisted evidence omits private values');
                    }
                } finally {
                    await result.close();
                }
            });
        }

        await t.test('a controlled cleanup delay lies between password success and the navigation', async () => {
            cleanupMode = 'delay';
            const result = await run();
            try {
                assert.equal(result.error, undefined, result.error?.message);
                assert.ok(at(result, 'callback-received') - at(result, 'cancel-received') >= 750, 'the navigation waited for the delayed cleanup');
                assert.ok(at(result, 'cancel-delivered') < at(result, 'callback-received'));
                assert.deepEqual(cleanupFailures(result), []);
                assert.equal(await statusOf(result.handle), 'cancelled');
                assert.equal(proofs(result.diagnostics).length, 1);
                assert.deepEqual(result.diagnostics.actionableEvents(), []);
            } finally {
                await result.close();
            }
        });

        for (const mode of ['status-500', 'status-400', 'abort', 'hang']) {
            await t.test(`a cleanup ${mode} keeps the primary sign-in but stays a strict failure`, async () => {
                cleanupMode = mode;
                const result = await run();
                try {
                    assert.equal(result.error, undefined, result.error?.message);
                    assert.equal(result.principal.canonicalUsername, email, 'the valid primary handoff is not withheld');
                    const actionable = result.diagnostics.actionableEvents();
                    assert.ok(actionable.some((event) => String(event.url || '').endsWith(`${WIZARD}google/cancel`)), 'the cleanup failure is actionable');
                    assert.ok(actionable.some((event) => event.url === GIS), 'the script abort is not acknowledged next to another error');
                    assert.deepEqual(proofs(result.diagnostics), []);
                    assert.throws(() => assertPageDiagnosticsClean(result.page), /browser console, page, or network errors/);
                    assert.equal(await statusOf(result.handle), 'pending', 'unconfirmed cleanup is not reported as retired');
                } finally {
                    for (const held of heldResponses) held.destroy();
                    heldResponses.clear();
                    await result.close();
                }
            });
        }
        cleanupMode = 'normal';

        for (const [name, script] of [['console error', 'console.error("unexpected destination failure")'], ['page error', 'throw new Error("unexpected destination exception")']]) {
            await t.test(`an unrelated ${name} prevents the acknowledgement`, async () => {
                destinationScript = script;
                const result = await run();
                try {
                    assert.equal(result.error, undefined, result.error?.message);
                    assert.equal(await statusOf(result.handle), 'cancelled');
                    const actionable = result.diagnostics.actionableEvents();
                    assert.ok(actionable.some((event) => event.url === GIS));
                    assert.ok(actionable.some((event) => event.kind === (name === 'page error' ? 'pageerror' : 'console')));
                    assert.deepEqual(proofs(result.diagnostics), []);
                } finally {
                    destinationScript = '';
                    await result.close();
                }
            });
        }

        await t.test('an early non-abort Google network failure stays actionable', async () => {
            sinkMode = 'reset';
            const result = await run();
            try {
                assert.equal(result.error, undefined, result.error?.message);
                const failures = gisAborts(result.diagnostics);
                assert.equal(failures.length, 1);
                assert.notEqual(failures[0].failure, 'net::ERR_ABORTED');
                assert.deepEqual(proofs(result.diagnostics), []);
                assert.deepEqual(result.diagnostics.actionableEvents().map(({ kind, url, location }) => [kind, url || location?.url]),
                    [['requestfailed', GIS], ['console', GIS]], 'the failure and its console report both stay actionable');
                assert.equal(await statusOf(result.handle), 'cancelled', 'cleanup does not depend on Google availability');
            } finally {
                sinkMode = 'hold';
                await result.close();
            }
        });

        await t.test('a refused password closes the checkpoint without acknowledgement and reports the refusal', async () => {
            const result = await run({ signInAccount: { ...account, accountPassword: `${password} mistyped` } });
            try {
                assert.match(String(result.error?.message), /UserPersisto refused the sign-in: That password is not correct/);
                assert.deepEqual(result.events.filter((event) => event.kind === 'cancel-received'), [], 'the wizard stays on its page');
                assert.deepEqual(proofs(result.diagnostics), []);
                assert.ok(result.diagnostics.actionableEvents().some((event) => event.kind === 'response' && event.status === 401));
                await assert.doesNotReject(result.diagnostics.flush(), 'no checkpoint is left open to mask the failure');
                assert.equal(await statusOf(result.handle), 'pending');
            } finally {
                await result.close();
            }
        });

        await t.test('a page without diagnostics signs in with the same cleanup and no acknowledgement claim', async () => {
            const result = await run({ diagnostics: false });
            try {
                assert.equal(result.error, undefined, result.error?.message);
                assert.equal(result.principal.canonicalUsername, email);
                assert.deepEqual(cleanupFailures(result), []);
                assert.equal(await statusOf(result.handle), 'cancelled');
            } finally {
                await result.close();
            }
        });
    } finally {
        for (const held of heldResponses) held.destroy();
        for (const socket of sinkSockets) socket.destroy();
        await browser?.close();
        for (const server of [front, service, sink]) {
            if (server?.listening) {
                server.closeAllConnections?.();
                await new Promise((resolve) => server.close(resolve));
            }
        }
        await resetStoreForTests();
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});
