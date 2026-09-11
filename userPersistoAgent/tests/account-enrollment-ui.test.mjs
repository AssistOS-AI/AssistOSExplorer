import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountEnrollment } from '../public/dashboard/enrollment.js';
import { dashboardApi, mountDashboard, startDashboard } from '../public/dashboard/main.js';

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
        this.children = [];
        this.classList = { add() {}, toggle() {} };
    }
    querySelector(selector) {
        if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
        return this.nodes.get(selector);
    }
    querySelectorAll() { return []; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    replaceChildren(...children) { this.innerHTML = ''; this.children = children; }
    focus() { this.focused = true; }
}

const GRANT = 'G'.repeat(43);

function profile(overrides = {}) {
    return {
        user: { id: 'user-1', email: 'member@example.test' },
        roles: ['selfRegistered'], capabilities: ['account.dashboard'],
        allowedAuthMethods: ['emailCode', 'passkey', 'totp'],
        authMethods: [{ type: 'emailCode' }],
        emailVerified: true,
        reauthenticationMethods: ['emailCode'],
        enrollments: { passkey: { configured: false, count: 0 }, totp: { configured: false, pending: false } },
        contact: { email: '', verified: true, pending: false },
        ...overrides,
    };
}

// Confirmation answers immediately; everything else goes to `handler`.
function tools(handler, calls = []) {
    return async (name, args) => {
        calls.push({ name, args });
        if (name === 'reauth_start') return { ok: true, method: args.method, challenge: { delivery: 'accepted' } };
        if (name === 'reauth_verify') return { ok: true, grant: GRANT, operation: args.operation };
        if (name === 'reauth_cancel') return { ok: true };
        return handler(name, args);
    };
}

// Completes the email-code confirmation: send the code, then submit it.
async function confirm(widget, code = '123456') {
    await widget.submitConfirmation();
    widget.reauthCodeInput.value = code;
    await widget.submitConfirmation();
}

const withoutConfirmation = (calls) => calls.filter((call) => !call.name.startsWith('reauth_'));

function fixture(options = {}) {
    const element = new Element();
    const browser = {
        isSecureContext: true, location: { origin: 'https://workspace.example' },
        navigator: { credentials: { create: async () => null, get: async () => null } },
    };
    const widget = new AccountEnrollment(element, { browser, ...options });
    widget.updateProfile(profile());
    return { widget, element, browser };
}

const setup = { ok: true, setupId: 'setup-1', secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/account?secret=JBSWY3DPEHPK3PXP' };

test('Google confirmation opens a protected popup and uses an actor-bound grant without browser storage', async () => {
    const calls = [];
    const transaction = 'a'.repeat(64);
    const popup = { opener: {}, location: '', close() { this.closed = true; } };
    const { widget, browser } = fixture({ callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'reauth_start') return { ok: true, transaction, authorizationUrl: 'https://accounts.google.com/authorize' };
        if (name === 'reauth_google_complete') return { ok: true, grant: GRANT, operation: 'totp.enroll' };
        if (name === 'userpersisto_totp_setup_start') return setup;
        throw new Error(`Unexpected call ${name}`);
    } });
    browser.open = () => popup;
    Object.defineProperty(browser, 'localStorage', { get() { throw new Error('No browser storage allowed'); } });
    Object.defineProperty(browser, 'sessionStorage', { get() { throw new Error('No browser storage allowed'); } });
    widget.updateProfile(profile({ reauthenticationMethods: ['google'] }));
    await widget.startTotp();
    assert.equal(widget.reauthSubmit.textContent, 'Confirm with Google');
    await widget.submitConfirmation();
    assert.equal(popup.opener, null);
    assert.equal(popup.closed, true);
    assert.equal(popup.location, 'https://accounts.google.com/authorize');
    assert.deepEqual(calls, [
        { name: 'reauth_start', args: { operation: 'totp.enroll', method: 'google' } },
        { name: 'reauth_google_complete', args: { operation: 'totp.enroll', transaction } },
        { name: 'userpersisto_totp_setup_start', args: { grant: GRANT } },
    ]);
    assert.equal(widget.pending, true);
    assert.equal(widget.googleConfirmation, null);
});

test('cancelling a pending Google start cancels the returned transaction and suppresses enrollment', async () => {
    const calls = [];
    let finishStart;
    const popup = { close() { this.closed = true; } };
    const { widget, browser } = fixture({ callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'reauth_start') return new Promise((resolve) => { finishStart = resolve; });
        if (name === 'reauth_cancel') return { ok: true };
        throw new Error('A cancelled Google confirmation must not continue');
    } });
    browser.open = () => popup;
    widget.updateProfile(profile({ reauthenticationMethods: ['google'] }));
    await widget.startTotp();
    const confirming = widget.submitConfirmation();
    widget.cancel();
    finishStart({ ok: true, transaction: 'b'.repeat(64), authorizationUrl: 'https://accounts.google.com/authorize' });
    await confirming;
    assert.equal(popup.closed, true);
    assert.equal(popup.location, undefined, 'a late authorization URL never navigates');
    assert.equal(widget.pending, false);
    assert.equal(calls.at(-1).name, 'reauth_cancel');
    assert.equal(calls.at(-1).args.transaction, 'b'.repeat(64));
});

test('blocked Google popups leave confirmation retryable without a server transaction', async () => {
    const { widget, browser } = fixture({ callTool: async () => { throw new Error('Should not start'); } });
    browser.open = () => null;
    widget.updateProfile(profile({ reauthenticationMethods: ['google'] }));
    await widget.startTotp();
    await widget.submitConfirmation();
    assert.equal(widget.busy, false);
    assert.match(widget.status.textContent, /Allow the Google confirmation window/);
    assert.equal(widget.reauthForm.hidden, false);
});

test('passkey enrollment needs fresh confirmation, passes the single-use grant and preserves its challenge and origin', async () => {
    const calls = [];
    let refreshed = 0;
    const { widget, browser } = fixture({
        callTool: tools(async (name) => name.endsWith('_options')
            ? { ok: true, challengeKey: 'one-use-key', publicKey: { challenge: 'AQID', user: { id: 'BAUG' }, excludeCredentials: [{ id: 'BwgJ', type: 'public-key' }] } }
            : { ok: true }, calls),
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
    assert.equal(calls.length, 0, 'opening the confirmation makes no request');
    assert.equal(widget.reauthForm.hidden, false);
    assert.match(widget.reauthTitle.textContent, /add a passkey/);
    await confirm(widget);
    assert.deepEqual(calls.slice(0, 2), [
        { name: 'reauth_start', args: { operation: 'passkey.register', method: 'emailCode' } },
        { name: 'reauth_verify', args: { operation: 'passkey.register', method: 'emailCode', code: '123456' } },
    ]);
    const enrollment = withoutConfirmation(calls);
    assert.deepEqual(enrollment[0], { name: 'userpersisto_passkey_registration_options', args: { origin: browser.location.origin, grant: GRANT } });
    assert.deepEqual(enrollment[1], { name: 'userpersisto_passkey_registration_verify', args: {
        challengeKey: 'one-use-key', origin: browser.location.origin,
        attestation: { id: 'credential-id', rawId: 'AQI', type: 'public-key', response: { clientDataJSON: 'AwQ', attestationObject: 'BQY', transports: ['internal'] } },
    } });
    assert.equal(refreshed, 1);
    assert.match(widget.status.textContent, /Passkey added/);
    assert.equal(widget.busy, false);
    assert.equal(widget.reauthForm.hidden, true);
    assert.equal(widget.reauthCodeInput.value, '');
    assert.equal(JSON.stringify(Object.values(widget)).includes(GRANT), false, 'the grant is not retained');
    assert.match(widget.passkeyStatus.textContent, /1 passkey configured/);
});

test('confirmation rejects malformed input locally, reports server errors and cancels a sent code', async () => {
    const calls = [];
    let verifyResult = { ok: false, error: 'code_invalid', attemptsRemaining: 3 };
    const { widget } = fixture({ callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'reauth_start') return { ok: true, challenge: { delivery: 'unknown' } };
        if (name === 'reauth_verify') return verifyResult;
        return { ok: true };
    } });
    await widget.startTotp();
    await widget.submitConfirmation();
    assert.match(widget.status.textContent, /tried to send a code/);
    widget.reauthCodeInput.value = '12';
    await widget.submitConfirmation();
    assert.equal(calls.filter((call) => call.name === 'reauth_verify').length, 0, 'malformed codes never submit');
    widget.reauthCodeInput.value = '654321';
    await widget.submitConfirmation();
    assert.match(widget.status.textContent, /did not match\. 3 attempts left/);
    assert.equal(widget.reauthCodeInput.value, '', 'a rejected code is cleared');
    verifyResult = { ok: false, error: 'rate_limited', retryAfter: 42 };
    widget.reauthCodeInput.value = '654321';
    await widget.submitConfirmation();
    assert.match(widget.status.textContent, /Wait 42 s/);
    widget.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.at(-1).name, 'reauth_cancel', 'cancelling after a code was sent cancels it on the server');
    assert.equal(widget.reauthForm.hidden, true);
    assert.equal(calls.some((call) => call.name.startsWith('userpersisto_totp')), false);
});

test('the administrator password confirmation is sent once and cleared; a passkey confirmation uses the browser prompt', async () => {
    const calls = [];
    const { widget, browser } = fixture({ callTool: tools(async () => setup, calls) });
    widget.updateProfile(profile({ reauthenticationMethods: ['adminPassword', 'passkey'] }));
    await widget.startTotp();
    assert.equal(widget.reauthPasswordLabel.hidden, false);
    await widget.submitConfirmation();
    assert.match(widget.status.textContent, /administrator password/);
    widget.reauthPasswordInput.value = 'configured-admin-value';
    await widget.submitConfirmation();
    assert.deepEqual(calls[0], { name: 'reauth_verify', args: { operation: 'totp.enroll', method: 'adminPassword', password: 'configured-admin-value' } });
    assert.equal(widget.reauthPasswordInput.value, '');
    assert.deepEqual(calls[1], { name: 'userpersisto_totp_setup_start', args: { grant: GRANT } });
    widget.cancel();

    calls.length = 0;
    browser.navigator.credentials.get = async ({ publicKey }) => {
        assert.deepEqual([...new Uint8Array(publicKey.challenge)], [1, 2, 3]);
        return { id: 'cred', rawId: Uint8Array.of(9).buffer, type: 'public-key', response: {
            clientDataJSON: Uint8Array.of(1).buffer, authenticatorData: Uint8Array.of(2).buffer, signature: Uint8Array.of(3).buffer, userHandle: null,
        } };
    };
    widget.callTool = async (name, args) => {
        calls.push({ name, args });
        if (name === 'reauth_start') return { ok: true, challengeKey: 'reauth-key', publicKey: { challenge: 'AQID', allowCredentials: [] } };
        if (name === 'reauth_verify') return { ok: true, grant: GRANT };
        return setup;
    };
    await widget.startTotp();
    widget.selectConfirmationMethod('passkey');
    await widget.submitConfirmation();
    assert.deepEqual(calls[0], { name: 'reauth_start', args: { operation: 'totp.enroll', method: 'passkey' } });
    assert.deepEqual(calls[1].args, { operation: 'totp.enroll', method: 'passkey', challengeKey: 'reauth-key',
        assertion: { id: 'cred', rawId: 'CQ', type: 'public-key', response: { clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw', userHandle: '' } } });
    widget.dispose();
});

test('without any confirmation method enrollment explains itself and makes no request', async () => {
    let called = false;
    const { widget } = fixture({ callTool: () => { called = true; } });
    widget.updateProfile(profile({ reauthenticationMethods: [] }));
    await widget.startTotp();
    assert.equal(called, false);
    assert.equal(widget.reauthForm.hidden, true);
    assert.match(widget.status.textContent, /No confirmation method/);
});

test('passkey cancellation leaves enrollment retryable and disposal prevents a late verification', async () => {
    const calls = [];
    const { widget, browser } = fixture({ callTool: tools(async () => ({ ok: true, challengeKey: 'key', publicKey: { challenge: 'AQID', user: { id: 'BAUG' } } }), calls) });
    browser.navigator.credentials.create = async () => { const error = new Error('canceled'); error.name = 'NotAllowedError'; throw error; };
    await widget.startPasskey();
    await confirm(widget);
    assert.match(widget.status.textContent, /canceled/);
    assert.equal(widget.passkeyButton.disabled, false);
    let signal;
    let resolve;
    browser.navigator.credentials.create = (options) => { signal = options.signal; return new Promise((done) => { resolve = done; }); };
    await widget.startPasskey();
    const pending = confirm(widget);
    await new Promise((done) => setImmediate(done));
    widget.dispose();
    assert.equal(signal.aborted, true);
    resolve({});
    await pending;
    assert.equal(calls.filter((call) => call.name.endsWith('_verify') && !call.name.startsWith('reauth')).length, 0);
});

test('authenticator enrollment retries invalid codes, binds verification to its setup and clears secrets', async () => {
    let valid = false;
    const calls = [];
    const { widget } = fixture({ callTool: tools(async (name) => name.endsWith('_start') ? setup : valid ? { ok: true, replaced: false } : { ok: false, reason: 'invalid_token' }, calls) });
    await widget.startTotp();
    await confirm(widget);
    assert.equal(widget.secretInput.value, setup.secret);
    assert.equal(widget.uriInput.value, setup.otpauthUrl);
    assert.equal(widget.setupForm.hidden, false);
    assert.equal(widget.reauthForm.hidden, true);
    widget.tokenInput.value = '12';
    await widget.verifyTotp();
    assert.equal(withoutConfirmation(calls).length, 1, 'invalid input never submits');
    widget.tokenInput.value = '123456';
    await widget.verifyTotp();
    assert.match(widget.status.textContent, /did not match/);
    assert.equal(widget.tokenInput.value, '');
    assert.equal(widget.secretInput.value, setup.secret);
    valid = true;
    widget.tokenInput.value = '654321';
    await widget.verifyTotp();
    assert.deepEqual(calls.at(-1), { name: 'userpersisto_totp_setup_verify', args: { token: '654321', setupId: 'setup-1' } });
    assert.equal(widget.secretInput.value, '');
    assert.equal(widget.uriInput.value, '');
    assert.equal(widget.tokenInput.value, '');
    assert.equal(widget.setupForm.hidden, true);
    assert.equal(widget.totpButton.textContent, 'Replace authenticator');
    assert.equal(widget.totpButton.disabled, false, 'a configured authenticator can be replaced');
    assert.match(widget.status.textContent, /Authenticator configured/);
});

test('replacing an authenticator reports that other sessions are signed out', async () => {
    const { widget } = fixture({ callTool: tools(async (name) => name.endsWith('_start') ? setup : { ok: true, replaced: true }) });
    widget.updateProfile(profile({ enrollments: { passkey: { configured: false, count: 0 }, totp: { configured: true, pending: false } } }));
    assert.match(widget.totpStatus.textContent, /keeps the current one working/);
    await widget.startTotp();
    await confirm(widget);
    widget.tokenInput.value = '654321';
    await widget.verifyTotp();
    assert.match(widget.status.textContent, /Authenticator replaced\. Other sessions are signed out/);
});

test('canceling or unmounting clears secrets and ignores an in-flight setup response', async () => {
    const { widget, element } = fixture({ callTool: tools(async () => setup) });
    await widget.startTotp();
    await confirm(widget);
    widget.cancel();
    assert.equal(widget.secretInput.value, '');
    assert.equal(widget.uriInput.value, '');
    let complete;
    widget.callTool = tools(() => new Promise((resolve) => { complete = resolve; }));
    await widget.startTotp();
    const pending = confirm(widget);
    await new Promise((resolve) => setImmediate(resolve));
    widget.dispose();
    complete(setup);
    await pending;
    assert.equal(widget.secretInput.value, '');
    assert.equal(widget.setupForm.hidden, true);
    assert.equal(element.innerHTML, '');
});

test('disabled methods, browser limitations and an unverified sign-in email block enrollment calls', async () => {
    let called = false;
    const { widget, browser } = fixture({ callTool: () => { called = true; } });
    widget.updateProfile(profile({ allowedAuthMethods: ['emailCode'] }));
    await widget.startPasskey();
    await widget.startTotp();
    assert.equal(called, false);
    assert.match(widget.totpStatus.textContent, /Disabled/);
    assert.match(widget.passkeyStatus.textContent, /Disabled/);
    widget.updateProfile(profile({ emailVerified: false, user: { id: 'user-1', email: '' } }));
    await widget.startPasskey();
    await widget.startTotp();
    assert.equal(called, false);
    assert.match(widget.passkeyStatus.textContent, /Verify a sign-in email first/);
    assert.match(widget.totpStatus.textContent, /Verify a sign-in email first/);
    browser.isSecureContext = false;
    widget.updateProfile(profile());
    assert.equal(widget.passkeyButton.disabled, true);
    assert.match(widget.passkeyStatus.textContent, /secure address/);
});

test('an account without a verified sign-in email proves its contact address after confirmation', async () => {
    const calls = [];
    let refreshed = 0;
    let verifyResult = { ok: false, error: 'code_invalid', attemptsRemaining: 4 };
    const { widget } = fixture({ callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'reauth_verify') return { ok: true, grant: GRANT };
        if (name === 'contact_start') return { ok: true, challenge: { delivery: 'accepted' } };
        if (name === 'contact_verify') return verifyResult;
        return { ok: true };
    }, onEnrolled: async () => { refreshed++; } });
    widget.updateProfile(profile({ user: { id: 'admin-1', email: '', username: 'administrator' }, emailVerified: false,
        reauthenticationMethods: ['adminPassword'], contact: { email: 'ops@example.test', verified: false, pending: false } }));
    assert.equal(widget.contactSection.hidden, false);
    assert.match(widget.contactStatus.textContent, /ops@example\.test is not verified and cannot be used to sign in/);
    assert.equal(widget.contactEmailInput.value, 'ops@example.test');
    widget.contactEmailInput.value = 'not-an-email';
    await widget.startContactVerification();
    assert.equal(widget.reauthForm.hidden, true);
    assert.match(widget.status.textContent, /valid email/);
    widget.contactEmailInput.value = 'ops@example.test';
    await widget.startContactVerification();
    assert.match(widget.reauthTitle.textContent, /verify a sign-in email/);
    widget.reauthPasswordInput.value = 'configured-admin-value';
    await widget.submitConfirmation();
    assert.deepEqual(calls.slice(0, 2), [
        { name: 'reauth_verify', args: { operation: 'contact.verify', method: 'adminPassword', password: 'configured-admin-value' } },
        { name: 'contact_start', args: { email: 'ops@example.test', grant: GRANT } },
    ]);
    assert.equal(widget.contactCodeForm.hidden, false);
    assert.match(widget.status.textContent, /We sent a code to ops@example\.test/);
    await widget.resendContactCode();
    assert.deepEqual(calls.at(-1), { name: 'contact_start', args: { email: 'ops@example.test', resend: true } });
    widget.contactCodeInput.value = '000000';
    await widget.verifyContactCode();
    assert.match(widget.status.textContent, /4 attempts left/);
    assert.equal(widget.contactCodeInput.value, '');
    verifyResult = { ok: true, email: 'ops@example.test' };
    widget.contactCodeInput.value = '123456';
    await widget.verifyContactCode();
    assert.deepEqual(calls.at(-1), { name: 'contact_verify', args: { code: '123456' } });
    assert.match(widget.status.textContent, /ops@example\.test is now your verified sign-in email/);
    assert.equal(refreshed, 1);
    assert.equal(widget.contactSection.hidden, true);
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
    const document = { querySelectorAll: () => [], getElementById: (id) => {
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

test('the email-less administrator is shown by username and its methods are labeled', async (t) => {
    const nodes = new Map();
    const document = { querySelectorAll: () => [], getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
    } };
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true, profile: profile({
        user: { id: 'admin-1', email: '', username: 'administrator' }, emailVerified: false,
        authMethods: [{ type: 'adminPassword' }, { type: 'google' }],
    }) }) }));
    const dashboard = mountDashboard(document);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nodes.get('account-email').textContent, 'administrator');
    assert.equal(nodes.get('account-methods').textContent, 'Administrator password · Google');
    dashboard.dispose();
});

// Drives the confirmation step through the real dashboard API wiring.
async function confirmThroughDashboard(enrollment) {
    enrollment.querySelector('[data-reauth]').listeners.submit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    enrollment.querySelector('[data-reauth-code]').value = '123456';
    enrollment.querySelector('[data-reauth]').listeners.submit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
}

const confirmationResponse = (path) => {
    if (path === 'api/reauth/start') return { ok: true, status: 200, json: async () => ({ ok: true, challenge: { delivery: 'accepted' } }) };
    if (path === 'api/reauth/verify') return { ok: true, status: 200, json: async () => ({ ok: true, grant: GRANT }) };
    return null;
};

test('leaving My Account clears setup secrets and ignores a pending setup response', async (t) => {
    const nodes = new Map();
    const document = { querySelectorAll: () => [], getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
    } };
    let finishSetup;
    t.mock.method(globalThis, 'fetch', async (path) => {
        if (path === 'api/profile') return { ok: true, json: async () => ({ ok: true, profile: profile() }) };
        return confirmationResponse(path) || new Promise((resolve) => { finishSetup = resolve; });
    });
    const dashboard = mountDashboard(document);
    await new Promise((resolve) => setImmediate(resolve));
    const enrollment = nodes.get('account-enrollment');
    enrollment.querySelector('[data-totp-start]').listeners.click();
    await confirmThroughDashboard(enrollment);
    dashboard.dispose();
    finishSetup({ ok: true, json: async () => setup });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(enrollment.querySelector('[data-totp-secret]').value, '');
    assert.equal(enrollment.querySelector('[data-totp-uri]').value, '');
    assert.equal(enrollment.querySelector('[data-totp-setup]').hidden, true);
    assert.equal(enrollment.querySelector('[data-reauth-code]').value, '');
});

test('dashboard API preserves enrollment reasons for specific retry feedback', async (t) => {
    t.mock.method(globalThis, 'fetch', async (path) => confirmationResponse(path) || ({
        ok: path.endsWith('/start'),
        status: path.endsWith('/start') ? 200 : 400,
        json: async () => path.endsWith('/start') ? setup : { ok: false, reason: 'invalid_token' },
    }));
    await assert.rejects(dashboardApi('auth/totp/verify', { token: '123456' }), (error) => {
        assert.equal(error.payload.reason, 'invalid_token');
        assert.equal(error.status, 400);
        return true;
    });
    const paths = { reauth_start: 'reauth/start', reauth_verify: 'reauth/verify', userpersisto_totp_setup_start: 'auth/totp/start', userpersisto_totp_setup_verify: 'auth/totp/verify' };
    const { widget } = fixture({ callTool: (name, args) => dashboardApi(paths[name], args) });
    await widget.startTotp();
    await confirm(widget);
    widget.tokenInput.value = '123456';
    await widget.verifyTotp();
    assert.match(widget.status.textContent, /That code did not match/);
    assert.equal(widget.setupForm.hidden, false);
    assert.equal(widget.tokenInput.value, '');
    widget.dispose();
});

test('session expiry after loading on save, confirmation, enrollment, or profile refresh clears setup and exposes sign-in', async (t) => {
    let scenario;
    let profileCalls;
    const expired = () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: 'authentication_required' }) });
    const success = (payload) => ({ ok: true, status: 200, json: async () => payload });
    t.mock.method(globalThis, 'fetch', async (path, options) => {
        if (path === 'api/profile') {
            if (options.method === 'POST' || (++profileCalls > 1 && scenario === 'refresh')) return expired();
            return success({ ok: true, profile: profile() });
        }
        if (path === 'api/reauth/start') return success({ ok: true, challenge: { delivery: 'accepted' } });
        if (path === 'api/reauth/verify') return scenario === 'confirm' ? expired() : success({ ok: true, grant: GRANT });
        if (path === 'api/auth/totp/start') return scenario === 'start' ? expired() : success(setup);
        if (path === 'api/auth/totp/verify') return scenario === 'verify' ? expired() : success({ ok: true });
        throw new Error(`Unexpected path ${path}`);
    });
    for (scenario of ['save', 'confirm', 'start', 'verify', 'refresh']) {
        profileCalls = 0;
        const nodes = new Map();
        const document = { querySelectorAll: () => [], getElementById: (id) => {
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
            await confirmThroughDashboard(enrollment);
            if (!['confirm', 'start'].includes(scenario)) {
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
        assert.equal(field('reauth-code').value, '', scenario);
        assert.equal(field('totp-setup').hidden, true, scenario);
        dashboard.dispose();
    }
});

test('disabling TOTP invalidates pending setup responses and prevents confirmation', async () => {
    let complete;
    const calls = [];
    const { widget } = fixture({ callTool: tools(() => new Promise((resolve) => { complete = resolve; }), calls) });
    await widget.startTotp();
    const pending = confirm(widget);
    await new Promise((resolve) => setImmediate(resolve));
    widget.updateProfile(profile({ allowedAuthMethods: ['emailCode'] }));
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
    assert.deepEqual(withoutConfirmation(calls).map((call) => call.name), ['userpersisto_totp_setup_start']);

    widget.updateProfile(profile());
    widget.callTool = tools(async () => setup);
    await widget.startTotp();
    await confirm(widget);
    assert.equal(widget.secretInput.value, setup.secret);
    widget.updateProfile(profile({ allowedAuthMethods: ['emailCode'] }));
    assert.equal(widget.secretInput.value, '');
    assert.equal(widget.setupForm.hidden, true);
    assert.equal(widget.confirmButton.disabled, true);
    widget.dispose();
});

test('disabling passkeys invalidates pending options and aborts an active browser prompt', async () => {
    let completeOptions;
    const calls = [];
    const { widget, browser } = fixture({ callTool: tools(() => new Promise((resolve) => { completeOptions = resolve; }), calls) });
    let browserCalls = 0;
    browser.navigator.credentials.create = async () => { browserCalls++; return {}; };
    const options = { ok: true, challengeKey: 'one-use-key', publicKey: { challenge: 'AQID', user: { id: 'BAUG' } } };
    await widget.startPasskey();
    const pendingOptions = confirm(widget);
    await new Promise((resolve) => setImmediate(resolve));
    widget.updateProfile(profile({ allowedAuthMethods: ['emailCode'] }));
    completeOptions(options);
    await pendingOptions;
    assert.equal(browserCalls, 0);
    assert.equal(widget.passkeyButton.disabled, true);

    widget.updateProfile(profile());
    widget.callTool = tools(async () => options, calls);
    let completePrompt;
    let signal;
    browser.navigator.credentials.create = (args) => {
        signal = args.signal;
        return new Promise((resolve) => { completePrompt = resolve; });
    };
    await widget.startPasskey();
    const pendingPrompt = confirm(widget);
    await new Promise((resolve) => setImmediate(resolve));
    widget.updateProfile(profile({ allowedAuthMethods: ['emailCode'] }));
    assert.equal(signal.aborted, true);
    completePrompt({});
    await pendingPrompt;
    assert.equal(calls.some((call) => call.name === 'userpersisto_passkey_registration_verify'), false);
    assert.equal(widget.busy, false);
    assert.equal(widget.passkeyButton.disabled, true);
    widget.dispose();
});

test('dashboard session errors offer a sign-in link returning to the account page', async (t) => {
    let code = 'not_authenticated';
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, json: async () => ({ ok: false, error: code }) }));
    for (code of ['not_authenticated', 'authentication_required', 'invalid_session']) {
        const nodes = new Map();
        const document = { querySelectorAll: () => [], getElementById: (id) => {
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

test('My Account page lifecycle clears setup on pagehide and reloads a restored page', async (t) => {
    const nodes = new Map();
    const document = { querySelectorAll: () => [], getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
    } };
    const events = new Map();
    let reloads = 0;
    const host = {
        addEventListener: (name, callback, options) => { events.set(name, { callback, options }); },
        location: { reload() { reloads++; } },
    };
    t.mock.method(globalThis, 'fetch', async (path) => confirmationResponse(path) || ({
        ok: true,
        json: async () => path === 'api/profile' ? { ok: true, profile: profile() } : setup,
    }));
    startDashboard(document, host);
    await new Promise((resolve) => setImmediate(resolve));
    const enrollment = nodes.get('account-enrollment');
    enrollment.querySelector('[data-totp-start]').listeners.click();
    await confirmThroughDashboard(enrollment);
    assert.equal(enrollment.querySelector('[data-totp-secret]').value, setup.secret);
    assert.equal(enrollment.querySelector('[data-totp-setup]').hidden, false);
    events.get('pagehide').callback();
    assert.deepEqual(events.get('pagehide').options, { once: true });
    assert.equal(enrollment.querySelector('[data-totp-secret]').value, '');
    assert.equal(enrollment.querySelector('[data-totp-uri]').value, '');
    assert.equal(enrollment.querySelector('[data-totp-setup]').hidden, true);
    assert.equal(enrollment.innerHTML, '');
    events.get('pageshow').callback({ persisted: false });
    assert.equal(reloads, 0);
    events.get('pageshow').callback({ persisted: true });
    assert.equal(reloads, 1);
});

test('My Account navigation disposes the page before a pending profile can restore content', async (t) => {
    const nodes = new Map();
    const document = { querySelectorAll: () => [], getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
    } };
    const events = new Map();
    const host = { addEventListener: (name, callback) => { events.set(name, callback); }, location: { reload() {} } };
    let finishProfile;
    t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { finishProfile = resolve; }));
    startDashboard(document, host);
    events.get('pagehide')();
    finishProfile({ ok: true, json: async () => ({ ok: true, profile: profile() }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(nodes.get('account-email'), undefined, 'late profile must not render personal data');
    assert.equal(nodes.get('account-enrollment').innerHTML, '');
});
