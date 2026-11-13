import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { captureRouterRecoveryAuthentication, expectedRouterRecoveryDiagnostics, validateRouterRecoveryObservation,
    projectRouterRecoveryObservation, acknowledgeRouterRecovery, finalizeRouterRecoveryFailure, RouterRecoveryProofError } from './webtty-router-recovery.mjs';
import { createDiagnosticLedger } from './diagnostic-ledger.mjs';

const principal = Object.freeze({ id: 'USER.Owner', roles: ['admin'] });
const oldCookies = Object.freeze([{ name: 'ploinky_sso', value: 'private-old-session' }]);
const changedCookies = Object.freeze([{ name: 'ploinky_sso', value: 'private-new-session' }]);
const viewId = 'V'.repeat(32);
const streamPath = `/webtty/sessions/prior-terminal/stream?view=${viewId}`;

function response(status, payload) {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

const retiredBody = { ok: false, error: 'not_found' };
const cookieOf = (options) => options.headers.Cookie;

function proof(fetchImpl, overrides = {}) {
    return captureRouterRecoveryAuthentication({ baseURL: 'http://localhost:8080', cookies: oldCookies, principal, fetchImpl, ...overrides });
}

function callbacks(events = []) {
    return {
        streamPath,
        verifyCleanup: async () => { events.push('cleanup'); },
        stopProducer: async () => { events.push('stop'); },
        closeTerminal: async () => { events.push('close'); },
        readCookies: async () => { events.push('cookies'); return oldCookies; },
    };
}

test('real isolated HTTP probes prove the surviving SSO session and an unchanged cookie, with cleanup first and no sign-in', async (t) => {
    const events = [];
    const server = http.createServer((request, reply) => {
        const isOld = request.headers.cookie === 'ploinky_sso=private-old-session';
        assert.equal(isOld, true, 'every probe carries the prior credential');
        if (request.url === '/auth/token') {
            events.push('token');
            reply.writeHead(200, { 'content-type': 'application/json' });
            reply.end(JSON.stringify({ ok: true, user: principal }));
            return;
        }
        assert.equal(request.url, streamPath);
        events.push(request.headers.accept === 'text/event-stream' ? 'retired-probe' : 'absent');
        reply.writeHead(404, { 'content-type': 'application/json' });
        reply.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const recovery = captureRouterRecoveryAuthentication({
        baseURL: `http://127.0.0.1:${server.address().port}`, cookies: oldCookies, principal,
    });
    assert.equal(recovery.mode, 'sso');
    await assert.rejects(recovery.recoverAfterCleanup(callbacks(events)), /out of order/);
    await recovery.proveRestartedAuthentication();
    await recovery.proveRestartedAuthentication();
    const result = await recovery.recoverAfterCleanup(callbacks(events));
    assert.deepEqual(events, ['token', 'token', 'cleanup', 'retired-probe', 'stop', 'close', 'cookies', 'absent']);
    assert.deepEqual(result, { mode: 'sso', priorAuthenticationStatus: 200, ssoCookieUnchanged: true, authenticatedOldStreamStatus: 404 });
    assert.equal(oldCookies[0].value === 'private-old-session', true);
    assert.doesNotMatch(JSON.stringify({ recovery, result }), /private-old|private-new/);
    await assert.rejects(recovery.recoverAfterCleanup(callbacks()), /out of order/);
});

test('cleanup or terminal-close failures prevent the cookie check and the final old-stream probe', async () => {
    for (const failingStep of ['verifyCleanup', 'stopProducer', 'closeTerminal']) {
        let probes = 0;
        const recovery = proof(async (url) => { probes += 1; return url.pathname === '/auth/token' ? response(200, { user: principal }) : response(404, retiredBody); });
        await recovery.proveRestartedAuthentication();
        const actions = callbacks();
        actions[failingStep] = async () => { throw new Error('cleanup incomplete'); };
        actions.readCookies = async () => assert.fail('must not read cookies before the terminal is closed');
        await assert.rejects(recovery.recoverAfterCleanup(actions), /cleanup incomplete/);
        assert.equal(probes, failingStep === 'verifyCleanup' ? 1 : 2, 'a failed cleanup probes no route; a failed close has only the retired-route probe');
    }
});

test('a surviving SSO proof rejects expiry, a different or non-admin principal, redirects, and malformed JSON', async () => {
    for (const reply of [
        response(401, { ok: false, error: 'session_expired' }), response(401, { ok: false, error: 'not_authenticated' }),
        response(200, { user: { id: 'USER.Other', roles: ['admin'] } }), response(200, { user: { id: principal.id, roles: ['user'] } }),
        response(200, { ok: true }), response(503, { ok: false, error: 'authentication_unavailable' }),
        new Response('', { status: 302, headers: { location: '/auth/login' } }),
        new Response('bad json', { status: 200, headers: { 'content-type': 'application/json' } }),
    ]) {
        const recovery = proof(async (_url, options) => {
            assert.equal(options.redirect, 'manual');
            return reply;
        });
        await assert.rejects(recovery.proveRestartedAuthentication(), /must survive|same authenticated administrator|without redirects/);
        await assert.rejects(recovery.recoverAfterCleanup(callbacks()), /out of order/);
    }
});

test('SSO must not need to sign in again: the cookie read after the restart must equal the prior one exactly', async () => {
    const open = () => proof(async (url) => (url.pathname === '/auth/token' ? response(200, { user: principal }) : response(404, retiredBody)));
    for (const [variant, cookies] of [
        ['changed value', changedCookies],
        ['local cookie', [{ name: 'ploinky_jwt', value: 'private-old-session' }]],
        ['two cookies', [...oldCookies, { name: 'ploinky_jwt', value: 'other-private-cookie' }]],
        ['no cookie', []],
    ]) {
        const events = [];
        const recovery = open();
        await recovery.proveRestartedAuthentication();
        const actions = callbacks(events);
        actions.readCookies = async () => cookies;
        await assert.rejects(recovery.recoverAfterCleanup(actions), /SSO session cookie to be unchanged|exactly one authenticated/, variant);
        assert.deepEqual(events, ['cleanup', 'stop', 'close'], `${variant}: the failure comes after the terminal close`);
    }
    const { readCookies, ...withoutCookies } = callbacks();
    const events = [];
    const recovery = open();
    await recovery.proveRestartedAuthentication();
    await assert.rejects(recovery.recoverAfterCleanup({ ...withoutCookies, verifyCleanup: async () => events.push('cleanup') }), /browser cookies/);
    assert.deepEqual(events, [], 'nothing runs without the cookie reader');
    const unchanged = open();
    await unchanged.proveRestartedAuthentication();
    const signInEvents = [];
    await assert.rejects(unchanged.recoverAfterCleanup({ ...callbacks(signInEvents), signIn: async () => signInEvents.push('sign-in') }), /no sign-in step/);
    assert.deepEqual(signInEvents, [], 'a caller that still passes a sign-in is refused before anything runs');
    const actions = callbacks();
    assert.equal((await unchanged.recoverAfterCleanup(actions)).ssoCookieUnchanged, true);
});

test('the old stream must return exact not-found after recovery instead of stale auth denial or success', async () => {
    for (const [status, body] of [[401, { ok: false, error: 'session_expired' }], [401, retiredBody], [200, { ok: true }], [404, { error: 'not_found' }]]) {
        let streamProbes = 0;
        const recovery = proof(async (url) => {
            if (url.pathname === '/auth/token') return response(200, { user: principal });
            // The first stream probe is the retired-route body check; the one after the terminal close is the final absence check.
            streamProbes += 1;
            return streamProbes === 1 ? response(404, retiredBody) : response(status, body);
        });
        await recovery.proveRestartedAuthentication();
        await assert.rejects(recovery.recoverAfterCleanup(callbacks()), /prior terminal stream must remain absent/);
        assert.equal(streamProbes, 2);
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
    actions.readCookies = async () => assert.fail('local JWT does not require replacement');
    const result = await recovery.recoverAfterCleanup(actions);
    assert.deepEqual(events, ['cleanup', 'stop', 'close']);
    assert.equal(result.priorAuthenticationStatus, 200);
    assert.equal(result.ssoCookieUnchanged, null, 'the cookie comparison applies to SSO only');
});

test('unproven or ambiguous cookies fail closed and diagnostic sets retain every exact transport failure', () => {
    for (const cookies of [[], [...oldCookies, { name: 'ploinky_jwt', value: 'jwt' }], [{ name: 'ploinky_guest', value: 'guest' }]]) {
        assert.throws(() => proof(fetch, { cookies }), /exactly one authenticated/);
    }
    for (const mode of ['sso', 'local']) {
        const diagnostics = expectedRouterRecoveryDiagnostics('http://localhost:8080', 'prior-terminal', mode, viewId);
        assert.equal(diagnostics.length, 4);
        assert.equal(diagnostics[0].failure, 'net::ERR_INCOMPLETE_CHUNKED_ENCODING');
        assert.equal(diagnostics[1].text, 'Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING');
        assert.equal(diagnostics[2].status, 404, `${mode}: the retired stream is refused as not found`);
        assert.match(diagnostics[3].text, /404 \(Not Found\)/);
        assert.doesNotMatch(diagnostics[3].text, /401|Unauthorized/);
        assert.equal(diagnostics.every((item) => (item.url || item.locationUrl) === `http://localhost:8080/webtty/sessions/prior-terminal/stream?view=${viewId}`), true);
    }
    assert.throws(() => expectedRouterRecoveryDiagnostics('http://localhost:8080', 'prior-terminal', 'guest', viewId), /Unproven/);
});

test('the prior stream path must carry its view and the diagnostics need one', async () => {
    const recovery = proof(async () => response(200, { user: principal }));
    await recovery.proveRestartedAuthentication();
    for (const bad of ['/webtty/sessions/prior-terminal/stream', '/webtty/sessions/prior-terminal/stream?view=short',
        `/webtty/sessions/prior-terminal/stream?view=${viewId}&x=1`, `/webtty/sessions/prior-terminal/input?view=${viewId}`]) {
        await assert.rejects(recovery.recoverAfterCleanup({ ...callbacks(), streamPath: bad }), /exact prior terminal stream path/);
    }
    assert.throws(() => expectedRouterRecoveryDiagnostics('http://localhost:8080', 'prior-terminal', 'sso'), /view identifier/);
    assert.throws(() => expectedRouterRecoveryDiagnostics('http://localhost:8080', 'prior-terminal', 'sso', 'short'), /view identifier/);
});

test('the retired-stream direct probe uses the prior credential and accepts only the exact not-found body in both modes', async () => {
    for (const mode of ['sso', 'local']) {
        const seen = [];
        const recovery = proof(async (url, options) => {
            seen.push({ path: `${url.pathname}${url.search}`, accept: options.headers.Accept, cookie: cookieOf(options), redirect: options.redirect });
            return response(404, { ok: false, error: 'not_found' });
        }, { cookies: [mode === 'sso' ? oldCookies[0] : { name: 'ploinky_jwt', value: 'private-old-session' }] });
        assert.deepEqual(await recovery.probeRetiredStream(streamPath), { status: 404, bodyValid: true });
        assert.deepEqual(seen, [{ path: streamPath, accept: 'text/event-stream', cookie: `${mode === 'sso' ? 'ploinky_sso' : 'ploinky_jwt'}=private-old-session`, redirect: 'manual' }]);
    }
    const loginBody = { ok: false, error: 'not_authenticated', login: `/auth/login?${new URLSearchParams({ returnTo: streamPath })}` };
    const wrong = [
        () => response(404, { ...retiredBody, extra: true }), () => response(404, { error: 'not_found' }), () => response(404, { ok: false, error: 'not_authenticated' }),
        () => response(401, loginBody), () => response(401, retiredBody), () => response(401, { ok: false, error: 'session_expired' }),
        () => response(200, { ok: true }), () => new Response('', { status: 302, headers: { location: '/auth/login' } }),
        () => new Response('not json', { status: 404, headers: { 'content-type': 'application/json' } }),
        () => new Response(JSON.stringify(retiredBody), { status: 404, headers: { 'content-type': 'text/plain' } }),
    ];
    for (const cookies of [oldCookies, [{ name: 'ploinky_jwt', value: 'x' }]]) {
        for (const reply of wrong) {
            const recovery = proof(async () => reply(), { cookies });
            await assert.rejects(recovery.probeRetiredStream(streamPath), /exact body|without redirects/);
        }
    }
});

test('the lifecycle stop callback is required and runs between the retired-stream probe and the terminal close', async () => {
    const events = [];
    const recovery = proof(async (url, options) => {
        if (url.pathname === '/auth/token') return response(200, { user: principal });
        events.push(options.headers.Accept === 'text/event-stream' ? 'retired-probe' : 'absent');
        return response(404, retiredBody);
    });
    await recovery.proveRestartedAuthentication();
    const { stopProducer, ...withoutStop } = callbacks(events);
    await assert.rejects(recovery.recoverAfterCleanup(withoutStop), /lifecycle stop/);
    assert.deepEqual(events, [], 'nothing runs without the stop callback');
    await recovery.recoverAfterCleanup(callbacks(events));
    assert.deepEqual(events, ['cleanup', 'retired-probe', 'stop', 'close', 'cookies', 'absent']);
});

// --- validation of the recorded observation (synthetic records; real browser records are in the browser test) ---
const T0 = 1_800_000_000_000;
const observation = ({ mode = 'sso', refusals = 1, aborts = [], held = false, tweak = (raw) => raw } = {}) => {
    const status = 404;
    const stop = { before: T0 + 10_000, after: T0 + 10_005, status: 'Disconnected', killDisabled: true };
    const playwright = []; const cdp = []; const nativeEvents = [];
    let clock = T0;
    const stream = (extra = {}) => {
        const index = playwright.filter((r) => r.role === 'stream').length;
        const start = clock; clock += 100;
        const terminalAt = extra.terminalAt ?? clock; clock += 100;
        playwright.push({ id: `p${playwright.length + 1}`, role: 'stream', method: 'GET', resourceType: 'eventsource', frameMain: true, pageOwned: true, redirect: false,
            status: extra.status ?? null, contentType: extra.status ? 'application/json' : null, failure: extra.failure ?? null, correctBody: null, bodyValid: null });
        cdp.push({ id: `c${cdp.length + 1}`, role: 'stream', frame: 'F', document: 'D', at: start, monotonic: 1, method: 'GET', type: 'EventSource', redirect: false,
            responseStatus: extra.status ?? null, terminals: [{ kind: 'failed', at: terminalAt, ...(extra.failure ? { failure: extra.failure } : {}) }] });
        if (extra.closed) nativeEvents.push({ kind: 'error', id: index + 1, at: start + 50, readyState: 2 });
    };
    nativeEvents.push({ kind: 'construct', id: 1, at: T0, instance: true, constructorPreserved: true, exactUrl: true });
    stream({ status: 200, failure: 'net::ERR_INCOMPLETE_CHUNKED_ENCODING' });
    for (let index = 0; index < refusals; index += 1) stream({ status, closed: true, failure: aborts.includes(index) ? 'net::ERR_ABORTED' : null });
    if (held) stream({ failure: 'net::ERR_ABORTED', terminalAt: stop.before + 1 });
    playwright.push({ id: `p${playwright.length + 1}`, role: 'intent', method: 'POST', resourceType: 'fetch', frameMain: true, pageOwned: true, redirect: false,
        status, contentType: 'application/json', failure: null, correctBody: true, bodyValid: true });
    cdp.push({ id: `c${cdp.length + 1}`, role: 'intent', frame: 'F', document: 'D', at: stop.before + 1, monotonic: 1, method: 'POST', type: 'Fetch', redirect: false,
        responseStatus: status, terminals: [{ kind: 'finished', at: stop.before + 20 }] });
    return tweak({ mode, binding: { frameId: 'F', loaderId: 'D', navigations: 0 }, playwright, cdp, orphans: 0, native: { compatible: true, events: nativeEvents }, stop });
};
const params = (mode = 'sso') => ({ baseURL: 'http://127.0.0.1:18080', sessionId: 'prior-terminal', viewId, mode });

test('a validated observation derives its expected signatures from records for one, many and aborted refusals in both modes', () => {
    for (const mode of ['sso', 'local']) {
        const one = validateRouterRecoveryObservation(observation({ mode }), params(mode));
        assert.equal(one.signatures.length, 6, 'interruption (2) + one refusal (2) + close intent (2)');
        const three = validateRouterRecoveryObservation(observation({ mode, refusals: 3, aborts: [1] }), params(mode));
        assert.equal(three.signatures.length, 2 + 3 * 2 + 1 + 2);
        assert.deepEqual(three.summary, { streamAttempts: 4, refusals: 3, refusalAborts: 1, stopCancellations: 0, closeIntents: 1,
            outcomes: ['original-interrupted', 'refusal-native-closed', 'refusal-native-closed-abort', 'refusal-native-closed'] });
        const held = validateRouterRecoveryObservation(observation({ mode, held: true }), params(mode));
        assert.equal(held.summary.stopCancellations, 1);
        assert.equal(held.signatures.length, 2 + 2 + 1 + 2);
    }
});

test('the validator rejects zero refusals, missing identities, duplicates, orphans and misattributed or ambiguous records', () => {
    const cases = {
        'zero refusals': [observation({ refusals: 0 }), /no-retry/],
        'missing binding': [observation({ tweak: (raw) => ({ ...raw, binding: null }) }), /identity-missing/],
        'document changed': [observation({ tweak: (raw) => ({ ...raw, binding: { ...raw.binding, navigations: 1 } }) }), /document-changed/],
        'missing stop timing': [observation({ tweak: (raw) => ({ ...raw, stop: { ...raw.stop, before: 0 } }) }), /timing-missing/],
        'not stopped': [observation({ tweak: (raw) => ({ ...raw, stop: { ...raw.stop, status: 'Connected' } }) }), /not-stopped/],
        'duplicate identity': [observation({ tweak: (raw) => { raw.cdp[1].id = raw.cdp[0].id; return raw; } }), /duplicate/],
        'orphan terminal': [observation({ tweak: (raw) => ({ ...raw, orphans: 1 }) }), /orphan-terminal/],
        'incomplete join': [observation({ tweak: (raw) => { raw.cdp.splice(1, 1); return raw; } }), /incomplete/],
        'foreign frame': [observation({ tweak: (raw) => { raw.playwright[1].frameMain = false; return raw; } }), /foreign-frame/],
        'foreign document': [observation({ tweak: (raw) => { raw.cdp[1].document = 'OTHER'; return raw; } }), /foreign-document/],
        'wrong method': [observation({ tweak: (raw) => { raw.playwright[1].method = 'POST'; return raw; } }), /join: method/],
        'redirect': [observation({ tweak: (raw) => { raw.cdp[1].redirect = true; return raw; } }), /join: redirect/],
        'stale SSO 401 refusal': [observation({ mode: 'sso', tweak: (raw) => { raw.playwright[1].status = 401; raw.cdp[1].responseStatus = 401; return raw; } }), /wrong-status/],
        'stale local 401 refusal': [observation({ mode: 'local', tweak: (raw) => { raw.playwright[1].status = 401; raw.cdp[1].responseStatus = 401; return raw; } }), /wrong-status/],
        'wrong status': [observation({ tweak: (raw) => { raw.playwright[1].status = 503; raw.cdp[1].responseStatus = 503; return raw; } }), /wrong-status/],
        'stale 401 close intent': [observation({ tweak: (raw) => { raw.playwright.at(-1).status = 401; raw.cdp.at(-1).responseStatus = 401; return raw; } }), /intent: response/],
        'wrong content type': [observation({ tweak: (raw) => { raw.playwright[1].contentType = 'text/html'; return raw; } }), /content-type/],
        'status not joined': [observation({ tweak: (raw) => { raw.cdp[1].responseStatus = null; return raw; } }), /status-mismatch/],
        'failure not joined': [observation({ tweak: (raw) => { raw.playwright[1].failure = 'net::ERR_ABORTED'; return raw; } }), /failure-mismatch/],
        'overlapping requests': [observation({ tweak: (raw) => { raw.cdp[1].at = raw.cdp[0].terminals[0].at - 1; return raw; } }), /overlapping/],
        'raw monotonic time': [observation({ tweak: (raw) => { raw.cdp[1].at = 12.5; raw.cdp[1].terminals[0].at = 13; return raw; } }), /join: timing/],
        'two terminals': [observation({ tweak: (raw) => { raw.cdp[1].terminals.push({ kind: 'finished', at: raw.cdp[1].terminals[0].at + 1 }); return raw; } }), /join: timing/],
        'native correlation missing': [observation({ tweak: (raw) => { raw.native.events = raw.native.events.filter((event) => event.kind !== 'error'); return raw; } }), /native-correlation/],
        'unexplained native error': [observation({ tweak: (raw) => { raw.native.events.push({ kind: 'error', id: 9, at: T0 + 5, readyState: 2 }); return raw; } }), /unexplained-error/],
        'incompatible native observer': [observation({ tweak: (raw) => ({ ...raw, native: { ...raw.native, compatible: false } }) }), /incompatible/],
        'retry after stop': [observation({ tweak: (raw) => { raw.cdp[1].at = raw.stop.before + 1; raw.cdp[1].terminals[0].at = raw.stop.before + 2; return raw; } }), /retry-after-stop/],
        'no original interruption': [observation({ tweak: (raw) => { raw.playwright[0].failure = null; delete raw.cdp[0].terminals[0].failure; return raw; } }), /interruption/],
        'second close intent': [observation({ tweak: (raw) => { raw.playwright.push({ ...raw.playwright.at(-1), id: 'p99' }); raw.cdp.push({ ...raw.cdp.at(-1), id: 'c99' }); return raw; } }), /intent: count/],
        'intent wrong request body': [observation({ tweak: (raw) => { raw.playwright.at(-1).correctBody = false; return raw; } }), /intent: response/],
        'intent body not exact': [observation({ tweak: (raw) => { raw.playwright.at(-1).bodyValid = false; return raw; } }), /intent: body/],
        'intent before stop': [observation({ tweak: (raw) => { raw.cdp.at(-1).at = raw.stop.before - 5; return raw; } }), /intent: order/],
        'intent failed': [observation({ tweak: (raw) => { raw.playwright.at(-1).failure = 'net::ERR_ABORTED'; raw.cdp.at(-1).terminals[0] = { kind: 'failed', at: raw.stop.before + 20, failure: 'net::ERR_ABORTED' }; return raw; } }), /intent: order|intent: response/],
    };
    for (const [name, [raw, match]] of Object.entries(cases)) {
        assert.throws(() => validateRouterRecoveryObservation(raw, params()), (error) => error instanceof RouterRecoveryProofError && match.test(`${error.stage}: ${error.classification}`), name);
    }
});

test('a headerless request earns no refusal: a pre-stop abort delivered late and extra headerless requests fail', () => {
    const lastStream = (raw) => raw.cdp.filter((entry) => entry.role === 'stream').at(-1);
    // A headerless abort whose browser terminal predates the stop is not a stop cancellation, whenever Node heard of it.
    assert.throws(() => validateRouterRecoveryObservation(observation({ held: true, tweak: (raw) => { lastStream(raw).terminals[0].at = raw.stop.before - 1; return raw; } }), params()),
        (error) => error instanceof RouterRecoveryProofError && /stop: cancellation-before-stop/.test(`${error.stage}: ${error.classification}`));
    // A headerless request can never be the required refusal.
    assert.throws(() => validateRouterRecoveryObservation(observation({ refusals: 0, held: true }), params()),
        (error) => /refusal: none-observed/.test(`${error.stage}: ${error.classification}`));
    // A headerless request that is not the last attempt is unexplained.
    const notLast = observation({ refusals: 2, tweak: (raw) => {
        const refused = raw.playwright.filter((record) => record.role === 'stream')[1];
        refused.status = null; refused.contentType = null; refused.failure = 'net::ERR_ABORTED';
        const entry = raw.cdp.filter((candidate) => candidate.role === 'stream')[1];
        entry.responseStatus = null; entry.terminals[0] = { kind: 'failed', at: entry.terminals[0].at, failure: 'net::ERR_ABORTED' };
        return raw;
    } });
    assert.throws(() => validateRouterRecoveryObservation(notLast, params()), (error) => /stop: unexplained-headerless-request/.test(`${error.stage}: ${error.classification}`));
});

test('the sanitized projection and safe errors carry no view, session or returnTo values in any encoding', () => {
    const sentinels = [viewId, 'prior-terminal', encodeURIComponent(streamPath), encodeURIComponent(encodeURIComponent(streamPath)), 'returnTo', 'login'];
    const raw = observation({ refusals: 2 });
    for (const record of [...raw.playwright, ...raw.cdp]) { record.url = `http://127.0.0.1:18080${streamPath}`; record.session = 'prior-terminal'; record.view = viewId; }
    const validation = validateRouterRecoveryObservation(raw, params());
    const projection = JSON.stringify(projectRouterRecoveryObservation(raw, { validation, milestones: { cleanupVerified: true } }));
    for (const sentinel of sentinels) assert.equal(projection.includes(sentinel), false, `projection omits ${sentinel.slice(0, 12)}`);
    const failed = JSON.stringify(projectRouterRecoveryObservation(raw, { failure: new RouterRecoveryProofError('join', 'overlapping') }));
    assert.match(failed, /"stage":"join","classification":"overlapping"/);
    for (const sentinel of sentinels) assert.equal(failed.includes(sentinel), false);
    // The ledger's own multiset error quotes full URLs; the safe wrapper keeps only stage and classification.
    // A stale 401 refusal of the retired stream no longer matches the derived 404 set.
    const events = [{ kind: 'response', type: 'error', status: 401, url: `http://127.0.0.1:18080${streamPath}`, method: 'GET' }];
    const ledger = createDiagnosticLedger(events);
    const token = ledger.checkpoint('exact prior-epoch Router stream invalidation');
    let thrown;
    try { acknowledgeRouterRecovery(ledger, token, expectedRouterRecoveryDiagnostics('http://127.0.0.1:18080', 'prior-terminal', 'sso', viewId)); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof RouterRecoveryProofError);
    assert.deepEqual([thrown.stage, thrown.classification], ['diagnostics', 'multiset-mismatch']);
    const surface = `${thrown.message}${thrown.stack}${JSON.stringify(thrown)}`;
    for (const sentinel of [viewId, 'prior-terminal', 'http://127.0.0.1']) assert.equal(surface.includes(sentinel), false, 'no raw operand escapes the safe error');
    assert.equal(ledger.actionableEvents().length, 1, 'a failed proof acknowledges nothing');
    assert.throws(() => ledger.assertNoOpenCheckpoints(), /unconsumed/);
    ledger.closeWithoutAcknowledgement(token);
    ledger.assertNoOpenCheckpoints();
});

test('failure finalization runs in its fixed order, never throws and records its own failures by stage and name only', async () => {
    const make = (failing = null) => {
        const order = [];
        const step = (name, value) => async () => { order.push(name); if (failing === name) throw Object.assign(new Error(`SECRET-${name}-detail ${viewId}`), { name: `${name}Error` }); return value; };
        return {
            order,
            observation: { finalizeFailure: step('stop', { kind: 'failure-cleanup', producerStopped: true }), dispose: step('dispose') },
            persist: step('persist'),
            closeCheckpoints: () => { order.push('checkpoints'); if (failing === 'checkpoints') throw new Error(`SECRET-checkpoints ${viewId}`); },
        };
    };
    const reports = [];
    const clean = make();
    const result = await finalizeRouterRecoveryFailure({ ...clean, report: (message) => reports.push(message) });
    assert.deepEqual(clean.order, ['stop', 'persist', 'checkpoints', 'dispose']);
    assert.deepEqual(result.sequence, ['stop-producer', 'persist', 'close-checkpoints', 'dispose']);
    assert.deepEqual(reports, []);
    for (const failing of ['stop', 'persist', 'checkpoints', 'dispose']) {
        const sample = make(failing);
        const outcome = await finalizeRouterRecoveryFailure({ ...sample, report: (message) => reports.push(message) });
        assert.deepEqual(sample.order, ['stop', 'persist', 'checkpoints', 'dispose'], `${failing}: every later step still runs`);
        assert.equal(outcome.failures.length, 1);
        assert.equal(outcome.sequence.length, 3);
    }
    const surface = JSON.stringify(reports);
    assert.doesNotMatch(surface, /SECRET|V{32}/, 'only stage and error name are reported');
    assert.equal(reports.length, 4);
});
