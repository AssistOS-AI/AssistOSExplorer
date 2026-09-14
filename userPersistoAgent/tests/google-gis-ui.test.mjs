import test from 'node:test';
import assert from 'node:assert/strict';
import { mountGoogleSignIn } from '../public/auth/google-sign-in.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const ORIGIN = 'http://localhost:8080';
const BASE = '/base-agent-additional-server/userPersistoAgent/7000/service/';

class Element {
    constructor() {
        this.children = [];
        this.listeners = new Map();
        this.hidden = false;
        this.disabled = false;
        this.textContent = '';
    }
    append(child) { this.children.push(child); child.parent = this; }
    replaceChildren() { this.children = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    fire(type) { for (const callback of this.listeners.get(type) || []) callback({ type, target: this }); }
}

function fakeClock() {
    let current = 1_000_000;
    let nextId = 0;
    const timers = new Map();
    return {
        now: () => current,
        setTimeout(callback, duration) {
            const id = ++nextId;
            timers.set(id, { callback, at: current + duration });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        advance(duration) {
            const end = current + duration;
            for (;;) {
                const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > end) break;
                current = next[1].at;
                timers.delete(next[0]);
                next[1].callback();
            }
            current = end;
        },
        count: () => timers.size,
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
}

function jsonResponse(payload, ok = true) { return { ok, json: async () => payload }; }

function harness({ sdk = true, config: changes = {}, fetch } = {}) {
    const clock = fakeClock();
    const nodes = new Map(['config', 'button', 'status', 'cancel', 'retry', 'timer']
        .map((name) => [`google-sign-in-${name}`, new Element()]));
    const config = {
        clientId: '123456-local.apps.googleusercontent.com',
        nonce: 'n'.repeat(43),
        transaction: 'a'.repeat(64),
        expiresAt: clock.now() + 300_000,
        credentialUrl: `${BASE}auth/google/credential`,
        cancelUrl: `${BASE}auth/google/cancel`,
        cancelRedirectUrl: `${BASE}auth/?requestId=original&state=retained`,
        ...changes,
    };
    nodes.get('google-sign-in-config').textContent = JSON.stringify(config);
    const document = {
        getElementById: (id) => nodes.get(id),
        createElement: () => new Element(),
        head: new Element(),
    };
    const navigation = [];
    const initializations = [];
    const renders = [];
    const requests = [];
    let cancellations = 0;
    const googleId = {
        initialize(options) { initializations.push(options); },
        renderButton(target, options) { renders.push({ target, options }); target.append(new Element()); },
        cancel() { cancellations += 1; },
    };
    const window = new Element();
    window.location = { origin: ORIGIN, assign: (path) => navigation.push(path) };
    if (sdk) window.google = { accounts: { id: googleId } };
    const controller = mountGoogleSignIn({
        document,
        window,
        ...clock,
        fetch: async (path, options) => {
            requests.push({ path, options });
            return fetch ? fetch(path, options) : jsonResponse({ ok: true, redirectUrl: `${BASE}auth/google/resume/retained` });
        },
    });
    return {
        document, window, config, googleId, controller, clock, requests, navigation, initializations, renders,
        node: (name) => nodes.get(`google-sign-in-${name}`),
        cancellations: () => cancellations,
        credential(value = 'signed.id.token') { initializations.at(-1).callback({ credential: value }); },
        installSdk() { window.google = { accounts: { id: googleId } }; document.head.children.at(-1).fire('load'); },
    };
}

test('official GIS button sends one credential to the same-origin endpoint with transaction binding', async () => {
    const pending = deferred();
    const h = harness({ fetch: () => pending.promise });
    await h.controller.ready;
    assert.equal(h.initializations.length, 1);
    const options = h.initializations[0];
    assert.equal(options.client_id, h.config.clientId);
    assert.equal(options.nonce, h.config.nonce);
    assert.equal(options.auto_select, false);
    assert.equal(options.ux_mode, 'popup');
    assert.equal(options.use_fedcm_for_button, false);
    assert.equal(h.renders[0].target, h.node('button'));
    assert.equal(h.document.head.children.length, 0);
    h.credential();
    h.credential('duplicate.id.token');
    assert.equal(h.requests.length, 1);
    const request = h.requests[0];
    assert.equal(request.path, h.config.credentialUrl);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), { transaction: h.config.transaction, credential: 'signed.id.token' });
    assert.equal(h.node('button').children.length, 0);
    assert.equal(h.node('button').hidden, true);
    pending.resolve(jsonResponse({ ok: true, redirectUrl: `${BASE}auth/google/resume/verified` }));
    await settle();
    assert.deepEqual(h.navigation, [`${BASE}auth/google/resume/verified`]);
    assert.equal(h.clock.count(), 0);
    assert.equal(h.node('cancel').disabled, true);
    h.credential('late.id.token');
    assert.equal(h.requests.length, 1);
    h.controller.dispose();
});

test('loads only the official SDK, bounds loading, and permits a fresh load retry', async () => {
    const h = harness({ sdk: false });
    const script = h.document.head.children[0];
    assert.equal(script.src, 'https://accounts.google.com/gsi/client');
    assert.equal(script.async, true);
    h.clock.advance(10_000);
    await h.controller.ready;
    assert.match(h.node('status').textContent, /could not load/);
    assert.equal(h.node('retry').hidden, false);
    assert.equal(h.document.head.children.length, 0);
    h.node('retry').fire('click');
    assert.equal(h.document.head.children.length, 1);
    h.installSdk();
    await settle();
    assert.equal(h.initializations.length, 1);
    assert.equal(h.renders.length, 1);
    assert.equal(h.node('button').hidden, false);
    assert.equal(h.node('retry').hidden, true);
    h.controller.dispose();
    assert.equal(h.clock.count(), 0);
});

test('script failure and missing API are visible without accepting credentials', async () => {
    for (const event of ['error', 'load']) {
        const h = harness({ sdk: false });
        h.document.head.children[0].fire(event);
        await h.controller.ready;
        assert.match(h.node('status').textContent, /could not load/);
        assert.equal(h.node('retry').hidden, false);
        assert.equal(h.requests.length, 0);
        h.controller.dispose();
    }
});

test('cancel during SDK loading aborts the loader and cannot render a late button', async () => {
    const h = harness({ sdk: false });
    const script = h.document.head.children[0];
    h.node('cancel').fire('click');
    h.window.google = { accounts: { id: h.googleId } };
    script.fire('load');
    await h.controller.ready;
    await settle();
    assert.equal(h.document.head.children.length, 0);
    assert.equal(h.renders.length, 0);
    assert.deepEqual(JSON.parse(h.requests[0].options.body), { transaction: h.config.transaction });
    assert.equal(h.requests[0].path, h.config.cancelUrl);
    assert.equal(h.navigation.length, 1);
    assert.equal(h.clock.count(), 0);
    h.controller.dispose();
});

test('cancel wins against an in-flight credential response even when fetch ignores abort', async () => {
    const pending = deferred();
    const h = harness({ fetch: (path) => path.endsWith('/credential')
        ? pending.promise : jsonResponse({ ok: true, redirectUrl: `${BASE}auth/?notice=cancelled` }) });
    await h.controller.ready;
    h.credential();
    const original = h.requests[0];
    h.node('cancel').fire('click');
    await settle();
    assert.equal(original.options.signal.aborted, true);
    assert.deepEqual(h.navigation, [`${BASE}auth/?notice=cancelled`]);
    assert.ok(h.cancellations() >= 1);
    assert.equal(h.node('button').children.length, 0);
    assert.equal(h.node('button').hidden, true);
    assert.equal(h.clock.count(), 0);
    pending.resolve(jsonResponse({ ok: true, redirectUrl: '/must-not-navigate' }));
    h.credential('late.id.token');
    await settle();
    assert.equal(h.navigation.length, 1);
    assert.equal(h.requests.length, 2);
    h.controller.dispose();
});

test('pagehide or dispose aborts network work and discards late responses and callbacks', async () => {
    for (const leave of [(h) => h.window.fire('pagehide'), (h) => h.controller.dispose()]) {
        const pending = deferred();
        const h = harness({ fetch: () => pending.promise });
        await h.controller.ready;
        h.credential();
        leave(h);
        await settle();
        assert.equal(h.requests[0].options.signal.aborted, true);
        assert.equal(h.clock.count(), 0);
        assert.equal(h.node('button').children.length, 0);
        pending.resolve(jsonResponse({ ok: true, redirectUrl: '/must-not-navigate' }));
        h.credential('late.id.token');
        h.node('cancel').fire('click');
        await settle();
        assert.deepEqual(h.navigation, []);
        assert.equal(h.requests.length, 1);
        assert.equal(h.window.listeners.get('pagehide').size, 0);
    }
});

test('expiry aborts verification and enables a fresh return after the server transaction expires', async () => {
    const pending = deferred();
    const h = harness({
        config: { expiresAt: 1_001_000 },
        fetch: (path) => path.endsWith('/credential') ? pending.promise : jsonResponse({ ok: false, error: 'google_failed' }, false),
    });
    await h.controller.ready;
    h.credential();
    h.clock.advance(1000);
    await settle();
    assert.match(h.node('status').textContent, /expired/);
    assert.equal(h.requests[0].options.signal.aborted, true);
    assert.equal(h.clock.count(), 0);
    assert.equal(h.node('retry').hidden, true);
    pending.resolve(jsonResponse({ ok: true, redirectUrl: '/must-not-navigate' }));
    await settle();
    assert.deepEqual(h.navigation, []);
    h.node('cancel').fire('click');
    await settle();
    assert.deepEqual(h.navigation, [h.config.cancelRedirectUrl]);
    h.controller.dispose();
});

test('already expired configuration never loads Google or submits a credential', async () => {
    const h = harness({ sdk: false, config: { expiresAt: 999_999 } });
    await h.controller.ready;
    assert.equal(h.document.head.children.length, 0);
    assert.equal(h.requests.length, 0);
    assert.match(h.node('status').textContent, /expired/);
    assert.equal(h.clock.count(), 0);
    h.controller.dispose();
});

test('rejected credentials cannot be resubmitted and return safely after terminal server failure', async () => {
    const h = harness({ fetch: () => jsonResponse({ ok: false, error: 'google_failed' }, false) });
    await h.controller.ready;
    h.credential();
    await settle();
    assert.match(h.node('status').textContent, /start a new attempt/);
    assert.equal(h.node('retry').hidden, true);
    h.credential();
    h.node('retry').fire('click');
    assert.equal(h.requests.length, 1);
    h.node('cancel').fire('click');
    await settle();
    assert.deepEqual(h.navigation, [h.config.cancelRedirectUrl]);
    h.controller.dispose();
});

test('reauthentication requests auth_time and explains a stale Google session', async () => {
    const h = harness({
        config: { reauthentication: true },
        fetch: () => jsonResponse({ ok: false, error: 'google_recent_authentication_required' }, false),
    });
    await h.controller.ready;
    assert.equal(h.initializations[0].essential_claims, 'auth_time');
    h.credential();
    await settle();
    assert.match(h.node('status').textContent, /Sign in to Google again/);
    assert.match(h.node('status').textContent, /another existing sign-in method/);
    h.controller.dispose();
});

test('configuration refuses external and ambiguous endpoint or return URLs before loading Google', async () => {
    for (const field of ['credentialUrl', 'cancelUrl', 'cancelRedirectUrl']) {
        for (const value of ['https://evil.example/collect', '//evil.example/collect', '/\\evil.example/collect', '/\nevil.example/collect', '/path#fragment', '/x/..//evil.example/', '/.%2e//evil.example/']) {
            const h = harness({ sdk: false, config: { [field]: value } });
            await h.controller.ready;
            assert.match(h.node('status').textContent, /page is invalid/);
            assert.equal(h.document.head.children.length, 0);
            assert.equal(h.node('cancel').disabled, true);
            assert.equal(h.requests.length, 0);
            assert.equal(h.clock.count(), 0);
            h.controller.dispose();
        }
    }
});

test('credential success refuses external or malformed response redirects', async () => {
    for (const redirectUrl of ['https://evil.example/', '//evil.example/', '/\\evil.example/', '/\tevil.example/', '/x/..//evil.example/', '/.%2e//evil.example/', undefined]) {
        const h = harness({ fetch: () => jsonResponse({ ok: true, redirectUrl }) });
        await h.controller.ready;
        h.credential();
        await settle();
        assert.deepEqual(h.navigation, []);
        assert.match(h.node('status').textContent, /could not be completed/);
        h.controller.dispose();
    }
});

test('network and response-body timeouts are bounded, abort the request, and cannot replay a token', async () => {
    for (const fetch of [() => new Promise(() => {}), () => ({ ok: true, json: () => new Promise(() => {}) })]) {
        const h = harness({ fetch });
        await h.controller.ready;
        h.credential();
        h.clock.advance(15_000);
        await settle();
        assert.equal(h.requests[0].options.signal.aborted, true);
        assert.match(h.node('status').textContent, /start a new attempt/);
        assert.deepEqual(h.navigation, []);
        h.credential();
        assert.equal(h.requests.length, 1);
        h.controller.dispose();
        assert.equal(h.clock.count(), 0);
    }
});

test('missing or oversized Google credentials fail without sending a network request', async () => {
    for (const value of ['', null, 'a'.repeat(32_769)]) {
        const h = harness();
        await h.controller.ready;
        h.credential(value);
        await settle();
        assert.equal(h.requests.length, 0);
        assert.match(h.node('status').textContent, /usable sign-in response/);
        h.credential('a.new.token');
        assert.equal(h.requests.length, 0);
        h.controller.dispose();
    }
});
