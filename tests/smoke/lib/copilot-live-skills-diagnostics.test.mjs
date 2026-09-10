import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { captureLiveSkillsFailure, liveSkillsDiagnosticText, observeLiveSkillsBrowser } from './copilot-live-skills-diagnostics.mjs';
import { createReleaseGateFailureCollector } from './release-gate-failures.mjs';

test('a 204 status alone does not prove an expected cancellation and exact correlation remains fatal', () => {
    const page = new EventEmitter();
    const errors = [], network = [];
    const observer = observeLiveSkillsBrowser({ errors, network, now: () => '2026-09-11T00:00:00.000Z' });
    observer.observe(page);
    observer.observe(page);
    const request = { url: () => 'https://example.test/webchat/input?token=must-not-appear',
        method: () => 'POST', failure: () => ({ errorText: 'net::ERR_ABORTED' }) };
    page.emit('request', request);
    page.emit('response', { request: () => request, status: () => 204 });
    page.emit('requestfailed', request);
    assert.equal(network.length, 2);
    assert.equal(errors.length, 1);
    assert.deepEqual(errors[0], { kind: 'requestfailed', at: '2026-09-11T00:00:00.000Z', pageId: 'page-1',
        requestId: 'request-1', method: 'POST', path: '/webchat/input', responseStatus: 204, failure: 'net::ERR_ABORTED' });
    assert.equal(network[1].requestId, errors[0].requestId);
    assert.ok(!JSON.stringify({ errors, network }).includes('must-not-appear'));
    observer.detach();
    page.emit('requestfailed', request);
    assert.equal(errors.length, 1);
});

function responseFixture() {
    const page = new EventEmitter(); page.url = () => 'http://127.0.0.1:8080/webchat';
    const errors = [], network = [];
    const observer = observeLiveSkillsBrowser({ errors, network }); observer.observe(page);
    const request = { url: () => 'http://127.0.0.1:8080/webchat/input', method: () => 'POST', resourceType: () => 'fetch',
        isNavigationRequest: () => false, redirectedFrom: () => null, failure: () => ({ errorText: 'net::ERR_ABORTED' }) };
    const response = { request: () => request, status: () => 204, headers: () => ({}),
        fromServiceWorker: () => false, url: () => request.url() };
    return { page, errors, network, observer, request, response };
}

test('only an exact proven 204 acknowledgement cancellation becomes retained transport evidence', () => {
    for (const path of ['/dpuAgent/mcp', '/roboTeamAgent/mcp', '/explorer/mcp', '/webchat/input', '/webchat/interaction']) {
        const f = responseFixture(); f.request.url = () => 'http://127.0.0.1:8080' + path;
        f.page.emit('request', f.request); f.page.emit('response', f.response); f.page.emit('requestfailed', f.request);
        assert.deepEqual(f.errors, []);
        assert.equal(f.network.at(-1).kind, 'completed-no-content-transport');
        assert.equal(f.network.at(-1).requestId, f.network[0].requestId);
        assert.equal(f.network.at(-1).responseStatus, 204);
        assert.equal(f.network.at(-1).failure, 'net::ERR_ABORTED');
        f.observer.detach();
    }
});

test('unexpected statuses, origins, methods, resources, framing and failures remain fatal', () => {
    for (const mutate of [
        ...[200, 202, 401, 403, 500].map(status => f => { f.response.status = () => status; }),
        f => { f.request.method = () => 'GET'; },
        f => { f.request.resourceType = () => 'xhr'; },
        f => { f.request.isNavigationRequest = () => true; },
        f => { f.request.redirectedFrom = () => ({}); },
        f => { f.response.fromServiceWorker = () => true; },
        f => { f.request.url = () => 'https://other.test/webchat/input'; },
        f => { f.request.url = () => 'http://127.0.0.1:8080/unexpected/mcp'; },
        f => { f.request.url = () => 'http://127.0.0.1:8080/webchat/control'; },
        f => { f.response.url = () => 'http://127.0.0.1:8080/dpuAgent/mcp'; },
        f => { f.response.headers = () => ({ 'content-length': '1' }); },
        f => { f.response.headers = () => ({ 'transfer-encoding': 'chunked' }); },
        f => { f.request.failure = () => ({ errorText: 'net::ERR_CONNECTION_RESET' }); },
    ]) {
        const f = responseFixture(); mutate(f);
        f.page.emit('request', f.request); f.page.emit('response', f.response); f.page.emit('requestfailed', f.request);
        assert.equal(f.errors.length, 1); assert.equal(f.network.some(event => event.kind === 'completed-no-content-transport'), false);
        f.observer.detach();
    }
});

test('a proven acknowledgement never excuses another request with the same URL', () => {
    const f = responseFixture();
    f.page.emit('request', f.request); f.page.emit('response', f.response);
    const other = { ...f.request }; f.page.emit('requestfailed', other);
    assert.equal(f.errors.length, 1); assert.equal(f.errors[0].responseStatus, undefined);
    assert.notEqual(f.errors[0].requestId, f.network[0].requestId); f.observer.detach();
});

async function isolatedBrowser(t) {
    const serverEvents = [], serverRequests = [], timers = new Set();
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://fixture');
        if (request.method === 'GET' && url.pathname === '/') {
            response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>204 diagnostic fixture</title>'); return;
        }
        response.on('finish', () => serverEvents.push({ path: url.pathname, mode: url.searchParams.get('mode'), finished: true }));
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            serverRequests.push({ path: url.pathname, method: request.method, body });
            const mode = url.searchParams.get('mode');
            if (mode === 'hanging') return;
            if (mode === 'partial' || mode === 'truncated') {
                response.writeHead(200, { 'content-length': '10000' }); response.write('partial');
                if (mode === 'truncated') { const timer = setTimeout(() => response.destroy(), 20); timers.add(timer); }
                return;
            }
            response.writeHead(mode === '200' ? 200 : 204); response.end();
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    return { browser, serverEvents, serverRequests, origin: `http://127.0.0.1:${server.address().port}` };
}

test('real Chromium reports completed unread 204 acknowledgements as aborts; consuming them completes normally', async t => {
    const f = await isolatedBrowser(t);
    const cases = [
        { path: '/dpuAgent/mcp', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } },
        { path: '/roboTeamAgent/mcp', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } },
        { path: '/explorer/mcp', payload: { jsonrpc: '2.0', method: 'notifications/initialized' } },
        { path: '/webchat/input', payload: { text: 'fixture acknowledgement' } },
        { path: '/webchat/interaction', payload: { interactionId: 'fixture-interaction', optionId: 'allow-once' } },
        { path: '/webchat/interaction', payload: { interactionId: 'fixture-interaction', cancelled: true } },
        { path: '/webchat/interaction', payload: { interactionId: 'fixture-interaction', cancelled: true }, keepalive: true },
    ];
    for (const consume of [false, true]) {
        const page = await f.browser.newPage(), errors = [], network = [];
        await page.goto(f.origin); const observer = observeLiveSkillsBrowser({ errors, network }); observer.observe(page);
        for (const { path, payload, keepalive = false } of cases) {
            const terminal = page.waitForEvent(consume ? 'requestfinished' : 'requestfailed', { predicate: request => new URL(request.url()).pathname === path });
            const result = await page.evaluate(async ({ path, payload, keepalive, consume }) => {
                const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), keepalive });
                return { status: response.status, ok: response.ok, ...(consume ? { text: await response.text() } : {}) };
            }, { path, payload, keepalive, consume });
            const request = await terminal;
            assert.equal(result.status, 204); assert.equal(result.ok, true);
            assert(f.serverEvents.some(event => event.path === path && event.finished));
            assert.deepEqual(f.serverRequests.at(-1), { path, method: 'POST', body: JSON.stringify(payload) });
            if (consume) { assert.equal(result.text, ''); assert.equal(request.failure(), null); }
            else assert.equal(request.failure().errorText, 'net::ERR_ABORTED');
        }
        assert.deepEqual(errors, []);
        assert.equal(network.filter(event => event.kind === 'completed-no-content-transport').length, consume ? 0 : cases.length);
        observer.detach(); await page.close();
    }
});

test('real browser unread 200, unknown 204, pre-response and partial-body cancellations stay fatal', async t => {
    const f = await isolatedBrowser(t), page = await f.browser.newPage(), errors = [], network = [];
    await page.goto(f.origin); const observer = observeLiveSkillsBrowser({ errors, network }); observer.observe(page);
    for (const [path, mode] of [['/webchat/input', '200'], ['/unexpected/mcp', '204'], ['/webchat/input', 'hanging'],
        ['/webchat/input', 'partial'], ['/dpuAgent/mcp', 'truncated'], ['/explorer/mcp', '200'],
        ['/explorer/mcp', 'hanging'], ['/explorer/mcp', 'partial'], ['/explorer/mcp', 'truncated']]) {
        const before = errors.filter(event => event.kind === 'requestfailed').length;
        const failed = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === path });
        await page.evaluate(async ({ path, mode }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 150);
            try {
                const response = await fetch(path + '?mode=' + mode, { method: 'POST', body: 'fixture', signal: controller.signal });
                if (mode === 'partial' || mode === 'truncated') await response.text();
            } catch { /* The diagnostic, rather than pageerror, must retain this failed transport. */ }
            finally { clearTimeout(timer); }
        }, { path, mode });
        await failed;
        assert.equal(errors.filter(event => event.kind === 'requestfailed').length, before + 1, `${path}/${mode} must stay fatal`);
    }
    assert.equal(network.some(event => event.kind === 'completed-no-content-transport'), false);
    assert(errors.some(event => event.responseStatus === undefined));
    assert(errors.some(event => event.responseStatus === 200)); observer.detach(); await page.close();
});

test('an uncorrelated failure has no invented response and pages have distinct identities', () => {
    const one = new EventEmitter(), two = new EventEmitter();
    const errors = [], network = [];
    const observer = observeLiveSkillsBrowser({ errors, network });
    observer.observe(one); observer.observe(two);
    const request = { url: () => 'https://example.test/roboTeamAgent/mcp', method: () => 'GET', failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) };
    two.emit('requestfailed', request);
    one.emit('console', { type: () => 'error', text: () => 'gateway failed' });
    assert.equal(errors[0].pageId, 'page-2');
    assert.equal(errors[0].responseStatus, undefined);
    assert.equal(errors[1].pageId, 'page-1');
    assert.equal(errors[1].message, 'gateway failed');
});

test('text diagnostics remove structured credentials and credentials in captured UI text', () => {
    const text = liveSkillsDiagnosticText({ sessionId: 'private-session', cookie: 'private-cookie',
        failureUI: { text: 'password=private-password\nAuthorization: Bearer private-token\nphase original' } });
    for (const value of ['private-session', 'private-cookie', 'private-password', 'private-token']) assert.ok(!text.includes(value));
    assert.match(text, /phase original/);
});

function captureFixture() {
    const order = [];
    const evidence = { currentPhase: { label: 'original', stage: 'persisted native completion' }, phases: [],
        lastRuntime: { session: { messages: [{ status: 'pending' }] } } };
    const error = new Error('original: one completed persisted native turn within 150 seconds');
    const collector = createReleaseGateFailureCollector({ env: {} });
    const input = { error, evidence, collector,
        captureRuntime: async () => { order.push('runtime'); return { session: { messages: [{ status: 'pending' }], skillExecution: { active: true } } }; },
        copilot: { isClosed: () => false,
            evaluate: async () => { order.push('ui'); return { text: 'approval pending', controls: [{ id: 'cancel', hidden: false }] }; },
            screenshot: async options => { order.push('screenshot'); assert.match(options.style, /color: transparent/); return Buffer.from('fixture'); } },
        testInfo: { attach: async name => { order.push(`attach:${name}`); } } };
    return { input, order };
}

test('the failed phase, pending runtime and popup evidence are captured before cancellation and close', async () => {
    const { input, order } = captureFixture();
    await captureLiveSkillsFailure(input);
    order.push('cancel', 'close', 'delete');
    assert.deepEqual(order, ['runtime', 'ui', 'screenshot', 'attach:copilot-live-skills-failure-layout.png', 'cancel', 'close', 'delete']);
    assert.equal(input.evidence.failureRuntime.session.skillExecution.active, true);
    assert.equal(input.evidence.primaryFailure.phase.label, 'original');
    assert.equal(input.evidence.failureUI.text, 'approval pending');
    assert.equal(input.collector.failures.length, 0);
});

test('a failed runtime read retains the last snapshot and still captures the popup', async () => {
    const { input, order } = captureFixture();
    input.captureRuntime = async () => { throw new Error('runtime is unavailable'); };
    await captureLiveSkillsFailure(input);
    assert.equal(input.evidence.lastRuntime.session.messages[0].status, 'pending');
    assert.equal(input.evidence.failureRuntime, undefined);
    assert.ok(order.includes('screenshot'));
    assert.throws(() => input.collector.throwIfAny({ primaryError: input.error }), error => {
        assert.equal(error.errors.length, 2);
        assert.match(error.errors[0].message, /within 150 seconds/);
        assert.match(error.errors[1].message, /runtime is unavailable/);
        return true;
    });
});

test('screenshot, browser, cleanup and attachment failures cannot mask the primary timeout', async () => {
    const { input } = captureFixture();
    input.copilot.screenshot = async () => { throw new Error('screenshot failed'); };
    await captureLiveSkillsFailure(input);
    input.collector.add('browser', new Error('net::ERR_CONNECTION_RESET'));
    input.collector.add('cleanup', new Error('native cancellation failed'));
    await input.collector.required('attachment', async () => { throw new Error('attachment failed'); });
    assert.throws(() => input.collector.throwIfAny({ primaryError: input.error }), error => {
        assert.equal(error.errors.length, 5);
        assert.match(error.errors[0].message, /within 150 seconds/);
        for (const message of ['screenshot failed', 'net::ERR_CONNECTION_RESET', 'native cancellation failed', 'attachment failed']) assert.match(error.message, new RegExp(message));
        return true;
    });
    assert.equal(input.evidence.failureRuntime.session.skillExecution.active, true);
    assert.ok(input.evidence.failureUI);
});

test('missing popup diagnostics are explicit failures rather than silently skipped evidence', async () => {
    const { input } = captureFixture();
    input.copilot.isClosed = () => true;
    await captureLiveSkillsFailure(input);
    assert.equal(input.collector.failures.length, 2);
    assert.match(input.collector.failures[0].message, /already closed/);
});
