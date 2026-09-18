import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { resetStoreForTests } from '../lib/store.mjs';
import { updateAuthPolicy } from '../lib/policy.mjs';
import { getUserByEmail } from '../lib/users.mjs';
import { completeGoogleIdentity, GOOGLE_ISSUER } from '../lib/externalIdentities.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';
import { mountWizard } from '../public/auth/wizard.js';
import { createSsoAdapter } from '../public/auth/sso-adapter.js';

// Integration test: the real wizard, the real SSO adapter, and the real
// service, wired together the way public/auth/main.js wires them (minus a
// real browser).
async function fixture(fn) {
    const environment = { ...process.env };
    const folder = await mkdtemp(join(tmpdir(), 'userpersisto-wizard-sso-http-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-settings-key';
    for (const name of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_SIGNUP_EMAIL_VERIFICATION_REQUIRED']) delete process.env[name];
    setup.resetAuthLimitsForTests();
    const mail = [];
    const delivery = { fail: 0 };
    let server;
    try {
        await ensureSeedData();
        // These journeys exercise the verified code flow; the direct-signup
        // default is covered by signup-direct-http and auth-ui tests.
        await updateAuthPolicy({ signupEmailVerificationRequired: true }, { emailStatus: async () => ({ available: true }) });
        server = startService({ port: 0, host: '127.0.0.1' }, { deliverEmail: async (message) => {
            mail.push(message);
            if (delivery.fail > 0) {
                delivery.fail -= 1;
                return { delivered: false };
            }
            return { delivered: true, providerMessageId: 'fixture' };
        } });
        if (!server.listening) await once(server, 'listening');
        const base = `http://127.0.0.1:${server.address().port}`;
        await fn({ base, mail, delivery });
    } finally {
        if (server?.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
        await resetStoreForTests();
        await rm(folder, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
        Object.assign(process.env, environment);
    }
}

// ---- a minimal fake DOM, duplicated (not imported) from auth-ui.test.mjs so
// importing this file never registers that file's tests. Real network I/O
// means a single microtask flush is not enough, so helpers use waitFor().
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
        else if (['hidden', 'disabled', 'required', 'readonly'].includes(name)) this[name] = true;
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
        if (Date.now() - startedAt > timeout) throw new Error('waitFor timed out');
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
}
function h1Text(root) { return root.querySelector('h1')?.textContent || ''; }
async function waitForHeading(root, pattern) {
    try {
        return await waitFor(() => pattern.test(h1Text(root)));
    } catch {
        assert.fail(`expected heading ${pattern}, have "${h1Text(root)}": ${root.textContent}`);
    }
}
function findButton(root, text) {
    return root.querySelectorAll('button').find((node) => node.textContent === text);
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
    assert.equal(url.searchParams.get('state'), expectedState);
    return url.searchParams.get('code');
}

async function nextFromStart(wizard, email) {
    await waitForHeading(wizard.root, /^Sign in$/);
    wizard.root.querySelector('[name="email"]').value = email;
    wizard.root.querySelector('form.start-panel').fire('submit');
}

async function signUpThroughWizard(wizard, mail, email, password) {
    await nextFromStart(wizard, email);
    await waitForHeading(wizard.root, /^(Create an account\?|Enter your password)$/);
    const offer = wizard.root.querySelector('form.signup-offer-panel');
    if (offer) offer.fire('submit');
    else [...wizard.root.querySelectorAll('button')].find((node) => node.textContent === 'Sign up').fire('click');
    await waitForHeading(wizard.root, /^Create your password$/);
    wizard.root.querySelector('[name="password"]').value = password;
    wizard.root.querySelector('[name="passwordConfirmation"]').value = password;
    wizard.root.querySelector('form.signup-password-panel').fire('submit');
}

async function signIn(base, fn) {
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const wizard = mount(new CookieBrowser(), base, request.providerState);
    try {
        const code = await fn(wizard, request);
        return consumeAuthCode({ providerState: request.providerState, code });
    } finally {
        wizard.dispose();
    }
}

test('the first signup through S4, S5 and S6 claims the administrator and a second browser self-registers', () => fixture(async ({ base, mail }) => {
    const ownerPassword = setup.newTestPassword();
    const owner = await signIn(base, async (wizard, request) => {
        await waitFor(() => /The first completed sign-in becomes its administrator/.test(wizard.root.textContent));
        await signUpThroughWizard(wizard, mail, 'owner@example.test', ownerPassword);
        await waitForHeading(wizard.root, /^Enter the 6-digit code sent to owner@example\.test$/);
        assert.equal(await getUserByEmail('owner@example.test'), null, 'no account before the code');
        assert.equal(mail.at(-1).purpose, 'signup-verification');
        wizard.root.querySelector('[name="code"]').value = mail.at(-1).code;
        wizard.root.querySelector('form.signup-code-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        return callbackFromNavigation(wizard.navigated, base, request.providerState);
    });
    assert.deepEqual([owner.user.email, owner.roles], ['owner@example.test', ['admin']]);

    const member = await signIn(base, async (wizard, request) => {
        await signUpThroughWizard(wizard, mail, 'member@example.test', setup.newTestPassword());
        await waitForHeading(wizard.root, /^Enter the 6-digit code sent to member@example\.test$/);
        wizard.root.querySelector('[name="code"]').value = mail.at(-1).code;
        wizard.root.querySelector('form.signup-code-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        return callbackFromNavigation(wizard.navigated, base, request.providerState);
    });
    assert.deepEqual([member.user.email, member.roles, member.capabilities.includes('explorer.access')], ['member@example.test', ['selfRegistered'], false]);

    // The owner's chosen password signs in on S2 without any code.
    const sentBefore = mail.length;
    const again = await signIn(base, async (wizard, request) => {
        await nextFromStart(wizard, 'owner@example.test');
        await waitForHeading(wizard.root, /^Enter your password$/);
        wizard.root.querySelector('[name="password"]').value = 'not the owner password';
        wizard.root.querySelector('form.password-panel').fire('submit');
        await waitFor(() => /That password is not correct/.test(wizard.root.textContent));
        assert.equal(wizard.root.querySelector('[name="password"]').value, '');
        wizard.root.querySelector('[name="password"]').value = ownerPassword;
        wizard.root.querySelector('form.password-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        return callbackFromNavigation(wizard.navigated, base, request.providerState);
    });
    assert.equal(again.user.id, owner.user.id);
    assert.equal(mail.length, sentBefore, 'password login sends no code');
}));

test('Try another way signs a registered account in with an email code against the real service', () => fixture(async ({ base, mail }) => {
    await setup.signUpWithPassword('owner@example.test');
    const existing = await setup.signUpWithPassword('existing@example.test');
    const consumed = await signIn(base, async (wizard, request) => {
        await nextFromStart(wizard, 'existing@example.test');
        await waitForHeading(wizard.root, /^Enter your password$/);
        findButton(wizard.root, 'Try another way').fire('click');
        await waitForHeading(wizard.root, /^Try another way$/);
        const entries = wizard.root.querySelectorAll('.auth-method').map((entry) => entry.querySelector('button'));
        assert.deepEqual(entries.map((node) => [node.textContent, node.disabled]),
            [['Email me a code', false], ['Use a passkey', true], ['Use an authenticator app', true]]);
        findButton(wizard.root, 'Email me a code').fire('click');
        await waitForHeading(wizard.root, /^Enter the 6-digit code sent to existing@example\.test$/);
        assert.equal(Object.hasOwn(mail.at(-1), 'purpose'), false);
        wizard.root.querySelector('[name="code"]').value = mail.at(-1).code;
        wizard.root.querySelector('form.code-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        return callbackFromNavigation(wizard.navigated, base, request.providerState);
    });
    assert.equal(consumed.user.id, existing.user.id);
}));

test('a failed delivery after staging recovers with Send again and never asks for the password again', () => fixture(async ({ base, mail, delivery }) => {
    const password = setup.newTestPassword();
    const created = await signIn(base, async (wizard, request) => {
        delivery.fail = 1;
        await signUpThroughWizard(wizard, mail, 'retry@example.test', password);
        await waitForHeading(wizard.root, /^We could not send the code$/);
        assert.equal(wizard.root.querySelector('[name="code"]').disabled, true);
        assert.equal(wizard.root.querySelectorAll('input').some((input) => input.type === 'password'), false);
        findButton(wizard.root, 'Send again').fire('click');
        await waitForHeading(wizard.root, /^Enter the 6-digit code sent to retry@example\.test$/);
        assert.equal(mail.length, 2);
        wizard.root.querySelector('[name="code"]').value = mail.at(-1).code;
        wizard.root.querySelector('form.signup-code-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        return callbackFromNavigation(wizard.navigated, base, request.providerState);
    });
    assert.deepEqual(created.roles, ['admin']);
    const signedIn = await signIn(base, async (wizard, request) => {
        await nextFromStart(wizard, 'retry@example.test');
        await waitForHeading(wizard.root, /^Enter your password$/);
        wizard.root.querySelector('[name="password"]').value = password;
        wizard.root.querySelector('form.password-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        return callbackFromNavigation(wizard.navigated, base, request.providerState);
    });
    assert.equal(signedIn.user.id, created.user.id, 'the originally chosen password was kept');
}));

test('a lost signup response resumes the durable challenge and completes without resubmitting a password', () => fixture(async ({ base, mail }) => {
    const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
    const browser = new CookieBrowser();
    const send = browser.fetch.bind(browser);
    let signupStarts = 0;
    browser.fetch = async (url, options) => {
        const response = await send(url, options);
        if (new URL(url).pathname === '/service/auth/signup/start') {
            signupStarts++;
            assert.equal(response.status, 200);
            await response.arrayBuffer(); // The server committed; its response was lost on the way back.
            throw new TypeError('Failed to fetch');
        }
        return response;
    };
    const wizard = mount(browser, base, request.providerState);
    try {
        await signUpThroughWizard(wizard, mail, 'response-lost@example.test', setup.newTestPassword());
        await waitForHeading(wizard.root, /^Enter the 6-digit code sent to response-lost@example\.test$/);
        assert.equal(wizard.root.querySelector('[name="password"]'), null);
        assert.equal(signupStarts, 1);
        assert.equal(mail.length, 1);
        assert.equal(await getUserByEmail('response-lost@example.test'), null);
        wizard.root.querySelector('[name="code"]').value = mail[0].code;
        wizard.root.querySelector('form.signup-code-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        const consumed = await consumeAuthCode({ providerState: request.providerState,
            code: callbackFromNavigation(wizard.navigated, base, request.providerState) });
        assert.equal(consumed.user.email, 'response-lost@example.test');
        assert.deepEqual(consumed.roles, ['admin']);
        assert.equal(signupStarts, 1);
    } finally { wizard.dispose(); }
}));

test('a Google-created account sees the neutral unavailable password state and can use another way', () => fixture(async ({ base, mail }) => {
    const { user } = await completeGoogleIdentity({ identity: { issuer: GOOGLE_ISSUER, subject: 'wizard-google-owner', email: 'google-owner@gmail.com', emailVerified: true } });
    const consumed = await signIn(base, async (wizard, request) => {
        await nextFromStart(wizard, 'google-owner@gmail.com');
        await waitForHeading(wizard.root, /^Enter your password$/);
        assert.equal(wizard.root.querySelector('[name="password"]').disabled, true);
        assert.equal(findButton(wizard.root, 'Log in').disabled, true);
        assert.match(wizard.root.textContent, /Password sign-in is not available for this account here\. Choose Try another way\./);
        assert.doesNotMatch(wizard.root.textContent, /Google account|linked/i);
        findButton(wizard.root, 'Try another way').fire('click');
        await waitForHeading(wizard.root, /^Try another way$/);
        findButton(wizard.root, 'Email me a code').fire('click');
        await waitForHeading(wizard.root, /^Enter the 6-digit code sent to google-owner@gmail\.com$/);
        wizard.root.querySelector('[name="code"]').value = mail.at(-1).code;
        wizard.root.querySelector('form.code-panel').fire('submit');
        await waitFor(() => wizard.navigated.length === 1);
        return callbackFromNavigation(wizard.navigated, base, request.providerState);
    });
    assert.equal(consumed.user.id, user.id);
}));

test('the default policy signs an unknown address up without any code through the real wizard', () => fixture(async ({ base, mail }) => {
    await updateAuthPolicy({ signupEmailVerificationRequired: false }, { emailStatus: async () => ({ available: true }) });
    const password = setup.newTestPassword();
    const consumed = await signIn(base, async (wizard, request) => {
        await nextFromStart(wizard, 'direct-wizard@example.test');
        await waitForHeading(wizard.root, /^(Create an account\?|Enter your password)$/);
        const offer = wizard.root.querySelector('form.signup-offer-panel');
        if (offer) offer.fire('submit');
        else findButton(wizard.root, 'Sign up').fire('click');
        await waitForHeading(wizard.root, /^Create your password$/);
        assert.match(wizard.root.textContent, /No email verification is needed now\. You can verify your email later from My Account\./);
        wizard.root.querySelector('[name="password"]').value = password;
        wizard.root.querySelector('[name="passwordConfirmation"]').value = password;
        wizard.root.querySelector('form.signup-password-panel').fire('submit');
        await waitForHeading(wizard.root, /^Signing you in…$/);
        await waitFor(() => wizard.navigated.length === 1);
        return callbackFromNavigation(wizard.navigated, base, request.providerState);
    });
    assert.deepEqual([consumed.user.email, consumed.roles], ['direct-wizard@example.test', ['admin']]);
    assert.equal(consumed.user.emailVerifiedAt, '');
    assert.equal(mail.length, 0, 'the direct flow never sends mail');
    assert.equal((await getUserByEmail('direct-wizard@example.test')).emailVerifiedAt, '');
}));
