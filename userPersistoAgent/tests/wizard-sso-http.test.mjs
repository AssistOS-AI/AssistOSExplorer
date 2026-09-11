import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { resetStoreForTests } from '../lib/store.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';
import { mountWizard } from '../public/auth/wizard.js';
import { createSsoAdapter } from '../public/auth/sso-adapter.js';

// Integration test: the real wizard, the real SSO adapter, and the real
// service, wired together the way public/auth/main.js wires them (minus a
// real browser). Pattern lifted from tests/registration-http.test.mjs.
async function fixture(fn) {
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-wizard-sso-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
    setup.resetAuthLimitsForTests();
    const mail = [];
    let server;
    try {
        await ensureSeedData();
        server = startService({ port: 0, host: '127.0.0.1' }, { deliverEmail: async (message) => { mail.push(message); return { delivered: true, providerMessageId: 'fixture' }; } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        await fn({ base, mail });
    } finally {
        setup.clearAdministratorPassword();
        setup.resetAuthLimitsForTests();
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
    }
}

// ---- a minimal fake DOM, duplicated (not imported) from auth-ui.test.mjs so
// importing this file never registers that file's tests. Real network I/O
// means we cannot rely on a single microtask flush between interactions, so
// every helper below is paired with waitFor() instead.
class Element {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.parentElement = null;
        this.hidden = false;
        this.disabled = false;
        this.className = '';
        this.focused = false;
        this._text = '';
        this._value = '';
        this.classList = { toggle() {}, add() {}, remove() {} };
    }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    get isConnected() { return this.isRoot || Boolean(this.parentElement?.isConnected); }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') this.className = String(value);
        else if (['hidden', 'disabled', 'required'].includes(name)) this[name] = true;
        else this[name === 'for' ? 'htmlFor' : name] = String(value);
    }
    getAttribute(name) { return name === 'class' ? this.className : this.attributes.get(name) ?? null; }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
    replaceChildren(...children) { this.children.forEach((child) => { child.parentElement = null; }); this.children = []; this._text = ''; this.append(...children); }
    matches(selector) {
        const tag = selector.match(/^[\w-]+/)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) { if (!this.className.split(/\s+/).includes(name)) return false; }
        for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
            if (!this.attributes.has(name)) return false;
            if (value !== undefined && this.getAttribute(name) !== value) return false;
        }
        return true;
    }
    querySelectorAll(selector) {
        const selectors = selector.split(',').map((part) => part.trim());
        return this.children.flatMap((child) => [...(selectors.some((part) => child.matches(part)) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    fire(type) { for (const listener of this.listeners.get(type) || []) listener({ target: this, currentTarget: this, preventDefault() {} }); }
    focus() { this.focused = true; }
}

function createDom() {
    const root = new Element('main');
    root.isRoot = true;
    root.setAttribute('id', 'auth_content');
    const document = { createElement: (tag) => new Element(tag), querySelector: (selector) => (root.matches(selector) ? root : root.querySelector(selector)) };
    return { document, root };
}

async function waitFor(check, { timeout = 5000, interval = 15 } = {}) {
    const startedAt = Date.now();
    while (true) {
        const result = check();
        if (result) return result;
        if (Date.now() - startedAt > timeout) throw new Error(`waitFor timed out; current h1: ${check.h1 || ''}`);
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
}
function h1Text(root) { return root.querySelector('h1')?.textContent || ''; }
async function waitForHeading(root, pattern) {
    return waitFor(() => pattern.test(h1Text(root)), { timeout: 5000 });
}
function findButton(root, text) {
    return root.querySelectorAll('button').find((node) => node.textContent === text || node.textContent.startsWith(text));
}

// The Router adds Origin to every real browser POST automatically; the
// CookieBrowser here is driven directly, so the test supplies it.
function mount(browser, base, requestId, state = requestId) {
    const location = { search: `?requestId=${requestId}&state=${state}`, href: `${base}/service/auth/?requestId=${requestId}&state=${state}`, origin: base };
    const navigated = [];
    const fetchImpl = (url, options = {}) => browser.fetch(url, { ...options, headers: { ...options.headers, origin: base } });
    const adapter = createSsoAdapter({ location, fetch: fetchImpl, navigate: (url) => navigated.push(url) });
    const { document, root } = createDom();
    const instance = mountWizard({ root, document, adapter, storage: null, credentials: undefined });
    return { root, navigated, dispose: instance.dispose };
}

function callbackFromNavigation(navigated, base, expectedState) {
    assert.equal(navigated.length, 1, 'exactly one navigation completed the sign-in');
    const url = new URL(navigated[0]);
    assert.equal(url.origin, base);
    assert.equal(url.pathname, '/auth/callback');
    assert.ok(url.searchParams.get('code'));
    assert.equal(url.searchParams.get('state'), expectedState);
    return url.searchParams.get('code');
}

test('register + unknown claims the first administrator, then a second browser resumes as login + unknown and self-registers', () => fixture(async ({ base, mail }) => {
    const request1 = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser1 = new CookieBrowser();
    const wizard1 = mount(browser1, base, request1.providerState);
    try {
        await waitForHeading(wizard1.root, /Create an account/); // unclaimed setup defaults to register mode
        wizard1.root.querySelector('[name="email"]').value = 'owner@example.test';
        wizard1.root.querySelector('form.start-panel').fire('submit');
        await waitForHeading(wizard1.root, /Enter the 6-digit code sent to owner@example\.test/);
        const code1 = mail.at(-1).code;
        wizard1.root.querySelector('[name="code"]').value = code1;
        wizard1.root.querySelector('form.code-panel').fire('submit');
        await waitFor(() => wizard1.navigated.length === 1);
        const authCode1 = callbackFromNavigation(wizard1.navigated, base, request1.providerState);
        const consumed1 = await consumeAuthCode({ providerState: request1.providerState, code: authCode1 });
        assert.deepEqual(consumed1.roles, ['admin']);
        assert.equal(consumed1.user.email, 'owner@example.test');
    } finally {
        wizard1.dispose();
    }

    const request2 = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser2 = new CookieBrowser();
    const wizard2 = mount(browser2, base, request2.providerState);
    try {
        await waitForHeading(wizard2.root, /Sign in/); // setup is now complete: default mode is login
        wizard2.root.querySelector('[name="email"]').value = 'member@example.test';
        wizard2.root.querySelector('form.start-panel').fire('submit');
        await waitForHeading(wizard2.root, /Create an account\?/); // login + unknown
        assert.match(wizard2.root.textContent, /No account uses member@example\.test\. Create one\?/);
        findButton(wizard2.root, 'Create account').fire('click');
        wizard2.root.querySelector('form.confirm-panel').fire('submit');
        await waitForHeading(wizard2.root, /Enter the 6-digit code sent to member@example\.test/);
        const code2 = mail.at(-1).code;
        wizard2.root.querySelector('[name="code"]').value = code2;
        wizard2.root.querySelector('form.code-panel').fire('submit');
        await waitFor(() => wizard2.navigated.length === 1);
        const authCode2 = callbackFromNavigation(wizard2.navigated, base, request2.providerState);
        const consumed2 = await consumeAuthCode({ providerState: request2.providerState, code: authCode2 });
        assert.deepEqual(consumed2.roles, ['selfRegistered']);
        assert.equal(consumed2.user.email, 'member@example.test');
    } finally {
        wizard2.dispose();
    }
}));

test('register + existing email confirms into sign-in through the chooser and completes with an email code', () => fixture(async ({ base, mail }) => {
    // The first completed sign-in on a fresh fixture becomes the
    // administrator; claim that slot with a throwaway account first so
    // "existing@example.test" is an ordinary (selfRegistered) account.
    await setup.registerWithEmailCode('seed-admin@example.test');
    await setup.registerWithEmailCode('existing@example.test');
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser = new CookieBrowser();
    const wizard = mount(browser, base, request.providerState);
    try {
        await waitForHeading(wizard.root, /Sign in/);
        findButton(wizard.root, 'Create an account').fire('click');
        await waitForHeading(wizard.root, /Create an account/);
        wizard.root.querySelector('[name="email"]').value = 'existing@example.test';
        wizard.root.querySelector('form.start-panel').fire('submit');
        await waitForHeading(wizard.root, /Sign in instead\?/); // register + exists
        assert.match(wizard.root.textContent, /An account already uses existing@example\.test\. Sign in instead\?/);
        wizard.root.querySelector('form.confirm-panel').fire('submit');
        await waitForHeading(wizard.root, /Choose how to sign in/); // the same discovery, no extra request
        const emailButton = findButton(wizard.root, 'Email me a code');
        assert.ok(emailButton, 'email code is a usable method for a verified mailbox');
        emailButton.fire('click');
        await waitForHeading(wizard.root, /Enter the 6-digit code sent to existing@example\.test/);
        const code = mail.at(-1).code;
        wizard.root.querySelector('[name="code"]').value = code;
        wizard.root.querySelector('form.code-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        const authCode = callbackFromNavigation(wizard.navigated, base, request.providerState);
        const consumed = await consumeAuthCode({ providerState: request.providerState, code: authCode });
        assert.equal(consumed.user.email, 'existing@example.test');
        assert.deepEqual(consumed.roles, ['selfRegistered']);
        assert.notEqual(consumed.user.id, undefined);
    } finally {
        wizard.dispose();
    }
}));

test('administrator sign-in on an unclaimed installation creates the email-less administrator', () => fixture(async ({ base }) => {
    const password = setup.configureAdministratorPassword();
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser = new CookieBrowser();
    const wizard = mount(browser, base, request.providerState);
    try {
        await waitForHeading(wizard.root, /Create an account/); // still unclaimed
        assert.match(wizard.root.textContent, /This workspace is not set up yet\. The first completed sign-in becomes its administrator\./);
        findButton(wizard.root, 'Administrator sign-in').fire('click');
        await waitForHeading(wizard.root, /Administrator sign-in/);
        assert.ok(wizard.root.querySelector('[name="contactEmail"]'), 'contact email is offered before setup is complete');
        wizard.root.querySelector('[name="password"]').value = password;
        wizard.root.querySelector('[name="contactEmail"]').value = 'ops@example.test';
        wizard.root.querySelector('form.admin-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        const authCode = callbackFromNavigation(wizard.navigated, base, request.providerState);
        const consumed = await consumeAuthCode({ providerState: request.providerState, code: authCode });
        assert.equal(consumed.user.username, 'administrator');
        assert.equal(consumed.user.email, '');
        assert.deepEqual(consumed.roles, ['admin']);
    } finally {
        wizard.dispose();
    }
}));
