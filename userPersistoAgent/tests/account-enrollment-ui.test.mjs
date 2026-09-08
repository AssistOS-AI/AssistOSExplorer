import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AccountEnrollment } from '../public/dashboard/enrollment.js';
import { dashboardApi, mountDashboard } from '../public/dashboard/main.js';

class Element {
    constructor() {
        this.value = '';
        this.textContent = '';
        this.innerHTML = '';
        this.isConnected = true;
        this.hidden = false;
        this.disabled = false;
        this.listeners = {};
        this.nodes = new Map();
        this.classList = { add() {}, toggle() {} };
    }
    querySelector(selector) {
        if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
        return this.nodes.get(selector);
    }
    querySelectorAll() { return []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    replaceChildren() { this.innerHTML = ''; }
    focus() { this.focused = true; }
}

function profile(overrides = {}) {
    return {
        user: { id: 'user-1', email: 'member@example.test' },
        roles: ['selfRegistered'], capabilities: ['account.dashboard'],
        allowedAuthMethods: ['password', 'passkey', 'totp'],
        authMethods: [{ type: 'password' }],
        enrollments: { passkey: { configured: false, count: 0 }, totp: { configured: false, pending: false } },
        ...overrides,
    };
}

function fixture(options = {}) {
    const element = new Element();
    const browser = {
        isSecureContext: true, location: { origin: 'https://workspace.example' },
        navigator: { credentials: { create: async () => null } },
    };
    const widget = new AccountEnrollment(element, { browser, ...options });
    widget.updateProfile(profile());
    return { widget, element, browser };
}

const setup = { ok: true, secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/account?secret=JBSWY3DPEHPK3PXP' };

test('passkey enrollment converts browser buffers and preserves its challenge key and origin', async () => {
    const calls = [];
    let refreshed = 0;
    const { widget, browser } = fixture({
        callTool: async (name, args) => {
            calls.push({ name, args });
            return name.endsWith('_options')
                ? { ok: true, challengeKey: 'one-use-key', publicKey: { challenge: 'AQID', user: { id: 'BAUG' }, excludeCredentials: [{ id: 'BwgJ', type: 'public-key' }] } }
                : { ok: true };
        },
        onEnrolled: async () => { refreshed++; },
    });
    browser.navigator.credentials.create = async ({ publicKey, signal }) => {
        assert.deepEqual([...new Uint8Array(publicKey.challenge)], [1, 2, 3]);
        assert.deepEqual([...new Uint8Array(publicKey.user.id)], [4, 5, 6]);
        assert.deepEqual([...new Uint8Array(publicKey.excludeCredentials[0].id)], [7, 8, 9]);
        assert.equal(signal.aborted, false);
        return { id: 'credential-id', rawId: Uint8Array.of(1, 2).buffer, type: 'public-key', response: {
            clientDataJSON: Uint8Array.of(3, 4).buffer, attestationObject: Uint8Array.of(5, 6).buffer,
            getTransports: () => ['internal'],
        } };
    };
    await widget.startPasskey();
    assert.deepEqual(calls[0], { name: 'userpersisto_passkey_registration_options', args: { origin: browser.location.origin } });
    assert.deepEqual(calls[1], { name: 'userpersisto_passkey_registration_verify', args: {
        challengeKey: 'one-use-key', origin: browser.location.origin,
        attestation: { id: 'credential-id', rawId: 'AQI', type: 'public-key', response: { clientDataJSON: 'AwQ', attestationObject: 'BQY', transports: ['internal'] } },
    } });
    assert.equal(refreshed, 1);
    assert.match(widget.status.textContent, /Passkey added/);
    assert.equal(widget.busy, false);
    assert.match(widget.passkeyStatus.textContent, /1 passkey configured/);
});

test('passkey cancellation leaves enrollment retryable and disposal prevents a late verification', async () => {
    const calls = [];
    const { widget, browser } = fixture({ callTool: async (name) => {
        calls.push(name);
        return { ok: true, challengeKey: 'key', publicKey: { challenge: 'AQID', user: { id: 'BAUG' } } };
    } });
    browser.navigator.credentials.create = async () => { const error = new Error('canceled'); error.name = 'NotAllowedError'; throw error; };
    await widget.startPasskey();
    assert.match(widget.status.textContent, /canceled/);
    assert.equal(widget.passkeyButton.disabled, false);
    let signal;
    let resolve;
    browser.navigator.credentials.create = (options) => { signal = options.signal; return new Promise((done) => { resolve = done; }); };
    const pending = widget.startPasskey();
    await new Promise((done) => setImmediate(done));
    widget.dispose();
    assert.equal(signal.aborted, true);
    resolve({});
    await pending;
    assert.equal(calls.filter((name) => name.endsWith('_verify')).length, 0);
});

test('authenticator enrollment retries invalid codes and clears setup secrets after confirmation', async () => {
    let valid = false;
    const calls = [];
    const { widget } = fixture({ callTool: async (name, args) => {
        calls.push({ name, args });
        return name.endsWith('_start') ? setup : valid ? { ok: true } : { ok: false, reason: 'invalid_token' };
    } });
    await widget.startTotp();
    assert.equal(widget.secretInput.value, setup.secret);
    assert.equal(widget.uriInput.value, setup.otpauthUrl);
    assert.equal(widget.setupForm.hidden, false);
    widget.tokenInput.value = '12';
    await widget.verifyTotp();
    assert.equal(calls.length, 1, 'invalid input never submits');
    widget.tokenInput.value = '123456';
    await widget.verifyTotp();
    assert.match(widget.status.textContent, /did not match/);
    assert.equal(widget.tokenInput.value, '');
    assert.equal(widget.secretInput.value, setup.secret);
    valid = true;
    widget.tokenInput.value = '654321';
    await widget.verifyTotp();
    assert.deepEqual(calls.at(-1), { name: 'userpersisto_totp_setup_verify', args: { token: '654321' } });
    assert.equal(widget.secretInput.value, '');
    assert.equal(widget.uriInput.value, '');
    assert.equal(widget.tokenInput.value, '');
    assert.equal(widget.setupForm.hidden, true);
    assert.equal(widget.totpButton.disabled, true);
    assert.match(widget.status.textContent, /Authenticator configured/);
});

test('canceling or unmounting clears secrets and ignores an in-flight setup response', async () => {
    const { widget, element } = fixture({ callTool: async () => setup });
    await widget.startTotp();
    widget.cancel();
    assert.equal(widget.secretInput.value, '');
    assert.equal(widget.uriInput.value, '');
    let complete;
    widget.callTool = () => new Promise((resolve) => { complete = resolve; });
    const pending = widget.startTotp();
    widget.dispose();
    complete(setup);
    await pending;
    assert.equal(widget.secretInput.value, '');
    assert.equal(widget.setupForm.hidden, true);
    assert.equal(element.innerHTML, '');
});

test('disabled methods and browser limitations are visible and block enrollment calls', async () => {
    let called = false;
    const { widget, browser } = fixture({ callTool: () => { called = true; } });
    widget.updateProfile(profile({ allowedAuthMethods: ['password'] }));
    await widget.startPasskey();
    await widget.startTotp();
    assert.equal(called, false);
    assert.match(widget.totpStatus.textContent, /Disabled/);
    assert.match(widget.passkeyStatus.textContent, /Disabled/);
    browser.isSecureContext = false;
    widget.updateProfile(profile());
    assert.equal(widget.passkeyButton.disabled, true);
    assert.match(widget.passkeyStatus.textContent, /secure address/);
});

test('dashboard API uses same-origin credentials and preserves structured enrollment errors', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (path, options) => {
        calls.push({ path, options });
        return { ok: calls.length === 1, json: async () => calls.length === 1 ? { ok: true, profile: profile() } : { ok: false, reason: 'invalid_token' } };
    });
    assert.equal((await dashboardApi('profile')).profile.user.id, 'user-1');
    await assert.rejects(dashboardApi('auth/totp/verify', { token: '123456' }), (error) => error.payload.reason === 'invalid_token');
    assert.equal(calls[0].path, 'api/profile');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[1].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[1].options.body), { token: '123456' });
});

test('dashboard shows Explorer only with its capability and saves profile fields without trusting roles', async (t) => {
    const nodes = new Map();
    const document = { getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
    } };
    let currentProfile = profile({ roles: ['admin'] });
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (path, options) => {
        calls.push({ path, options });
        if (options.method === 'POST') currentProfile = { ...currentProfile, user: { ...currentProfile.user, ...JSON.parse(options.body) }, capabilities: ['explorer.access'] };
        return { ok: true, json: async () => ({ ok: true, profile: currentProfile }) };
    });
    const dashboard = mountDashboard(document);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nodes.get('open-explorer').hidden, true, 'an admin role alone is not an access grant');
    assert.match(nodes.get('workspace-access-message').textContent, /administrator/);
    nodes.get('username').value = 'updated-user';
    nodes.get('display-name').value = 'Updated Name';
    await nodes.get('profile-form').listeners.submit({ preventDefault() {} });
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { username: 'updated-user', displayName: 'Updated Name' });
    assert.equal(nodes.get('open-explorer').hidden, false);
    assert.equal(nodes.get('account-status').textContent, 'Profile saved.');
    dashboard.dispose();
});

test('settings profile navigation and unload dispose the shared enrollment widget', async () => {
    const source = await fs.readFile(new URL('../IDE-plugins/userpersisto-settings/userpersisto-settings.js', import.meta.url), 'utf8');
    const { UserpersistoSettings } = await import(`data:text/javascript;base64,${Buffer.from(source.replace(/^import[\s\S]*?;\s*/, '')).toString('base64')}`);
    const panel = new UserpersistoSettings(new Element(), () => {});
    panel.state.authProfile = { roles: ['admin'] };
    panel.refreshUsers = async () => {};
    let disposed = 0;
    panel.enrollmentWidget = { dispose() { disposed++; } };
    panel.switchPanel(null, 'users');
    assert.equal(disposed, 1);
    panel.enrollmentWidget = { dispose() { disposed++; } };
    panel.afterUnload();
    assert.equal(disposed, 2);
    assert.equal(panel.enrollmentMountEl, null);
    assert.equal(panel.enrollmentWidget, null);
});

test('the settings MCP wrapper preserves enrollment reasons for specific retry feedback', async () => {
    const source = await fs.readFile(new URL('../IDE-plugins/userpersisto-settings/userpersisto-settings.js', import.meta.url), 'utf8');
    const helperSource = (await fs.readFile(new URL('../../explorer/services/infrastructure/explorerApi.js', import.meta.url), 'utf8'))
        .replace(/^import .+;\r?\n/gm, '');
    const helperUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`;
    const bindings = `import { ensureSuccess, parseToolResult } from ${JSON.stringify(helperUrl)};
        const callAgentTool = async (_agent, name) => ({ content: [{ type: 'text', text: JSON.stringify(name.endsWith('_start') ? ${JSON.stringify(setup)} : { ok: false, reason: 'invalid_token' }) }] });`;
    const { UserpersistoSettings } = await import(`data:text/javascript;base64,${Buffer.from(bindings + source.replace(/^import[\s\S]*?;\s*/, '')).toString('base64')}`);
    const panel = new UserpersistoSettings(new Element(), () => {});
    await assert.rejects(panel.callTool('userpersisto_totp_setup_verify', { token: '123456' }), (error) => {
        assert.equal(error.name, 'ToolError');
        assert.equal(error.data.reason, 'invalid_token');
        assert.equal(error.message, 'Tool execution failed');
        return true;
    });
    const { widget } = fixture({ callTool: (name, args) => panel.callTool(name, args) });
    await widget.startTotp();
    widget.tokenInput.value = '123456';
    await widget.verifyTotp();
    assert.match(widget.status.textContent, /That code did not match/);
    assert.equal(widget.setupForm.hidden, false);
    assert.equal(widget.tokenInput.value, '');
    widget.dispose();
});

test('disabling TOTP invalidates pending setup responses and prevents confirmation', async () => {
    let complete;
    const calls = [];
    const { widget } = fixture({ callTool: (name) => {
        calls.push(name);
        return new Promise((resolve) => { complete = resolve; });
    } });
    const pending = widget.startTotp();
    widget.updateProfile(profile({ allowedAuthMethods: ['password'] }));
    complete(setup);
    await pending;
    assert.equal(widget.secretInput.value, '');
    assert.equal(widget.uriInput.value, '');
    assert.equal(widget.setupForm.hidden, true);
    assert.equal(widget.confirmButton.disabled, true);
    assert.equal(widget.totpButton.disabled, true);
    assert.equal(widget.busy, false);
    assert.match(widget.totpStatus.textContent, /Disabled/);
    widget.tokenInput.value = '123456';
    await widget.verifyTotp();
    assert.deepEqual(calls, ['userpersisto_totp_setup_start']);

    widget.updateProfile(profile());
    widget.callTool = async () => setup;
    await widget.startTotp();
    assert.equal(widget.secretInput.value, setup.secret);
    widget.updateProfile(profile({ allowedAuthMethods: ['password'] }));
    assert.equal(widget.secretInput.value, '');
    assert.equal(widget.setupForm.hidden, true);
    assert.equal(widget.confirmButton.disabled, true);
    widget.dispose();
});

test('disabling passkeys invalidates pending options and aborts an active browser prompt', async () => {
    let completeOptions;
    const calls = [];
    const { widget, browser } = fixture({ callTool: (name) => {
        calls.push(name);
        return new Promise((resolve) => { completeOptions = resolve; });
    } });
    let browserCalls = 0;
    browser.navigator.credentials.create = async () => { browserCalls++; return {}; };
    const options = { ok: true, challengeKey: 'one-use-key', publicKey: { challenge: 'AQID', user: { id: 'BAUG' } } };
    const pendingOptions = widget.startPasskey();
    widget.updateProfile(profile({ allowedAuthMethods: ['password'] }));
    completeOptions(options);
    await pendingOptions;
    assert.equal(browserCalls, 0);
    assert.equal(widget.passkeyButton.disabled, true);

    widget.updateProfile(profile());
    widget.callTool = async (name) => { calls.push(name); return options; };
    let completePrompt;
    let signal;
    browser.navigator.credentials.create = (args) => {
        signal = args.signal;
        return new Promise((resolve) => { completePrompt = resolve; });
    };
    const pendingPrompt = widget.startPasskey();
    await new Promise((resolve) => setImmediate(resolve));
    widget.updateProfile(profile({ allowedAuthMethods: ['password'] }));
    assert.equal(signal.aborted, true);
    completePrompt({});
    await pendingPrompt;
    assert.equal(calls.some((name) => name.endsWith('_verify')), false);
    assert.equal(widget.busy, false);
    assert.equal(widget.passkeyButton.disabled, true);
    widget.dispose();
});

test('dashboard session errors offer a sign-in link returning to the account page', async (t) => {
    let code = 'not_authenticated';
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, json: async () => ({ ok: false, error: code }) }));
    for (code of ['not_authenticated', 'authentication_required', 'invalid_session']) {
        const nodes = new Map();
        const document = { getElementById: (id) => {
            if (!nodes.has(id)) nodes.set(id, new Element());
            return nodes.get(id);
        } };
        const dashboard = mountDashboard(document);
        await new Promise((resolve) => setImmediate(resolve));
        assert.match(nodes.get('account-status').textContent, /session has expired/);
        const login = nodes.get('account-login');
        assert.equal(login.hidden, false);
        const destination = new URL(login.href, 'https://workspace.example');
        assert.equal(destination.pathname, '/auth/login');
        assert.match(destination.searchParams.get('returnTo'), /\/dashboard\/$/);
        dashboard.dispose();
    }
});

test('session expiry after loading on save, enrollment, or profile refresh clears setup and exposes sign-in', async (t) => {
    let scenario;
    let profileCalls;
    const expired = () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: 'authentication_required' }) });
    const success = (payload) => ({ ok: true, status: 200, json: async () => payload });
    t.mock.method(globalThis, 'fetch', async (path, options) => {
        if (path === 'api/profile') {
            if (options.method === 'POST' || (++profileCalls > 1 && scenario === 'refresh')) return expired();
            return success({ ok: true, profile: profile() });
        }
        if (path === 'api/auth/totp/start') return scenario === 'start' ? expired() : success(setup);
        if (path === 'api/auth/totp/verify') return scenario === 'verify' ? expired() : success({ ok: true });
        throw new Error(`Unexpected path ${path}`);
    });
    for (scenario of ['save', 'start', 'verify', 'refresh']) {
        profileCalls = 0;
        const nodes = new Map();
        const document = { getElementById: (id) => {
            if (!nodes.has(id)) nodes.set(id, new Element());
            return nodes.get(id);
        } };
        const dashboard = mountDashboard(document);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(nodes.get('account-content').hidden, false, scenario);
        assert.equal(nodes.get('account-login').hidden, true, scenario);
        const enrollment = nodes.get('account-enrollment');
        const field = (key) => enrollment.querySelector(`[data-${key}]`);
        if (scenario === 'save') {
            await nodes.get('profile-form').listeners.submit({ preventDefault() {} });
        } else {
            field('totp-start').listeners.click();
            await new Promise((resolve) => setImmediate(resolve));
            if (scenario !== 'start') {
                assert.equal(field('totp-secret').value, setup.secret, scenario);
                field('totp-token').value = '123456';
                field('totp-setup').listeners.submit({ preventDefault() {} });
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        assert.match(nodes.get('account-status').textContent, /session has expired/, scenario);
        assert.equal(nodes.get('account-login').hidden, false, scenario);
        assert.equal(nodes.get('account-content').hidden, true, scenario);
        assert.equal(nodes.get('save-profile').disabled, true, scenario);
        assert.equal(field('totp-secret').value, '', scenario);
        assert.equal(field('totp-uri').value, '', scenario);
        assert.equal(field('totp-token').value, '', scenario);
        assert.equal(field('totp-setup').hidden, true, scenario);
        dashboard.dispose();
    }
});
