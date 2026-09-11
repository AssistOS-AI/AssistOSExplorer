import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { publicKeyRequestFromServer, assertionCredentialToServer } from '../public/auth/auth-api.js';

class Element {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.parentElement = null;
        this.hidden = false;
        this.disabled = false;
        this.selected = false;
        this.className = '';
        this._text = '';
        this._value = '';
        this.classList = {
            toggle: (name, force) => {
                const names = new Set(this.className.split(/\s+/).filter(Boolean));
                if (force ?? !names.has(name)) names.add(name);
                else names.delete(name);
                this.className = [...names].join(' ');
            },
            add: (name) => this.classList.toggle(name, true),
            remove: (name) => this.classList.toggle(name, false),
        };
    }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get value() {
        if (this.tagName === 'SELECT') return this.children.find((child) => child.selected)?.value || this.children[0]?.value || '';
        return this._value;
    }
    set value(value) {
        this._value = String(value);
        if (this.tagName === 'SELECT') this.children.forEach((child) => { child.selected = child.value === this._value; });
    }
    get isConnected() { return this.isRoot || Boolean(this.parentElement?.isConnected); }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') this.className = String(value);
        else if (['hidden', 'disabled', 'selected', 'required'].includes(name)) this[name] = true;
        else this[name === 'for' ? 'htmlFor' : name] = String(value);
    }
    getAttribute(name) { return name === 'class' ? this.className : this.attributes.get(name) ?? null; }
    append(...children) {
        for (const child of children) {
            child.parentElement = this;
            this.children.push(child);
        }
    }
    prepend(child) { child.parentElement = this; this.children.unshift(child); }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
        this.parentElement = null;
    }
    replaceChildren(...children) {
        this.children.forEach((child) => { child.parentElement = null; });
        this.children = [];
        this._text = '';
        this.append(...children);
    }
    matches(selector) {
        const tag = selector.match(/^[\w-]+/)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) {
            if (!this.className.split(/\s+/).includes(name)) return false;
        }
        for (const [, name] of selector.matchAll(/#([\w-]+)/g)) {
            if (this.id !== name) return false;
        }
        for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
            if (!this.attributes.has(name)) return false;
            if (value !== undefined && this.getAttribute(name) !== value) return false;
        }
        return true;
    }
    querySelectorAll(selector) {
        const selectors = selector.split(',').map((part) => part.trim());
        return this.children.flatMap((child) => [
            ...(selectors.some((part) => child.matches(part)) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    async fire(type) {
        const event = { target: this, currentTarget: this, preventDefault() {} };
        await Promise.all((this.listeners.get(type) || []).map((listener) => listener(event)));
        await settle();
    }
    focus() { this.focused = true; }
    reset() { this.querySelectorAll('input').forEach((input) => { input.value = ''; }); }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const state = 'state+/=&';
const requestId = 'live:request';
const origin = 'https://workspace.example:9443';
const search = `?state=${encodeURIComponent(state)}&requestId=${encodeURIComponent(requestId)}&returnTo=%2Fprivate%3Fx%3D1`;
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });
const success = { ok: true, code: 'one-use-code', redirectUri: `${origin}/auth/callback` };
const payload = (extra = {}, id = requestId) => ({ state, requestId: id, providerState: id, origin, ...extra });

async function fixture({ methods = ['password'], defaultMethod = 'password', setup = {}, post, query = search, credentials } = {}) {
    const root = new Element('main');
    root.isRoot = true;
    root.setAttribute('id', 'auth_content');
    const document = { createElement: (tag) => new Element(tag), querySelector: (selector) => root.matches(selector) ? root : root.querySelector(selector) };
    const redirects = [];
    const window = { location: { search: query, origin, assign: (url) => redirects.push(url) }, PublicKeyCredential: function PublicKeyCredential() {} };
    const navigator = { credentials: credentials || { get: async () => { throw new Error('Unexpected passkey request'); } } };
    const calls = [];
    const fetch = async (path, options = {}) => {
        if (path === 'methods') return response({ ok: true, methods, defaultMethod });
        if (path === 'setup') return response({ ok: true, needsInitialAdmin: false, selfRegistrationEnabled: true, enabledAuthMethods: methods, ...setup });
        const call = { path, options, body: JSON.parse(options.body || '{}') };
        calls.push(call);
        return post ? post(call) : response(success);
    };
    const source = await fs.readFile(new URL('../public/auth/main.js', import.meta.url), 'utf8');
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const run = new AsyncFunction('document', 'window', 'navigator', 'fetch', 'publicKeyRequestFromServer', 'assertionCredentialToServer', source.replace(/^import .* from '\.\/auth-api\.js';\s*/, ''));
    await run(document, window, navigator, fetch, publicKeyRequestFromServer, assertionCredentialToServer);
    return { root, window, calls, redirects };
}

function form(root, className) {
    assert.equal(root.querySelectorAll('form').length, 1, 'only one authentication form is mounted');
    const result = root.querySelector(`form.${className}`);
    assert.ok(result, `expected ${className}`);
    return result;
}

function button(root, text) {
    const result = root.querySelectorAll('button').find((node) => node.textContent === text);
    assert.ok(result, `expected button ${text}`);
    return result;
}

function assertLabels(root) {
    for (const input of root.querySelectorAll('input, select')) {
        assert.ok(input.id, `${input.name || input.tagName} has an id`);
        assert.ok(root.querySelectorAll('label').some((label) => label.htmlFor === input.id), `label is associated with ${input.id}`);
    }
}

test('sign-in and registration switch one form at a time, clear passwords, and preserve the SSO request', async () => {
    const { root, window, calls, redirects } = await fixture();
    const signIn = form(root, 'password-panel');
    assert.equal(root.querySelector('select'), null, 'one method does not need a selector');
    assertLabels(root);
    const oldPassword = signIn.querySelector('[name="password"]');
    oldPassword.value = 'do-not-retain';
    const create = button(root, 'Create account');
    assert.equal(create.type, 'button', 'the switch must not submit credentials');
    await create.fire('click');
    const registration = form(root, 'registration-panel');
    assert.equal(oldPassword.value, '', 'detached password is cleared');
    assert.match(root.textContent, /Your account starts with dashboard access by default\. Ask an administrator for access to Explorer\./);
    assertLabels(root);
    const registrationPassword = registration.querySelector('[name="password"]');
    registrationPassword.value = 'discard-on-return';
    await button(root, 'Sign in').fire('click');
    assert.equal(registrationPassword.value, '');
    assert.equal(form(root, 'password-panel').querySelector('[name="password"]').value, '');
    assert.equal(calls.length, 0, 'view switches do not make authentication requests');
    await button(root, 'Create account').fire('click');
    const active = form(root, 'registration-panel');
    active.querySelector('[name="email"]').value = '  member@example.test  ';
    active.querySelector('[name="password"]').value = 'correct-horse-12';
    await active.fire('submit');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, 'register');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(calls[0].body, payload({ email: 'member@example.test', password: 'correct-horse-12' }));
    assert.equal(window.location.search, search, 'switching never rewrites transaction query parameters');
    const callback = new URL(redirects[0]);
    assert.equal(callback.origin, origin);
    assert.equal(callback.pathname, '/auth/callback');
    assert.equal(callback.searchParams.get('state'), state);
    assert.equal(callback.searchParams.get('code'), success.code);
});

test('the entered email address is carried over across view and method switches while secrets are cleared', async () => {
    const { root } = await fixture({ methods: ['password', 'totp'], defaultMethod: 'password' });
    const signIn = form(root, 'password-panel');
    signIn.querySelector('[name="email"]').value = 'member@example.test';
    signIn.querySelector('[name="password"]').value = 'never-carried-over';
    await button(root, 'Create account').fire('click');
    const registration = form(root, 'registration-panel');
    assert.equal(registration.querySelector('[name="email"]').value, 'member@example.test', 'email survives the switch to registration');
    assert.equal(registration.querySelector('[name="password"]').value, '', 'password never survives a switch');
    registration.querySelector('[name="email"]').value = 'corrected@example.test';
    await button(root, 'Sign in').fire('click');
    const back = form(root, 'password-panel');
    assert.equal(back.querySelector('[name="email"]').value, 'corrected@example.test', 'the latest entered email follows the user back');
    assert.equal(back.querySelector('[name="password"]').value, '');
    const selector = root.querySelector('select');
    selector.value = 'totp';
    await selector.fire('change');
    const totp = form(root, 'totp-panel');
    assert.equal(totp.querySelector('[name="email"]').value, 'corrected@example.test', 'email survives a method switch');
    assert.equal(totp.querySelector('[name="token"]').value, '');
});

test('first installation exposes owner registration only even when later registration or password login is disabled', async () => {
    const query = `?state=${encodeURIComponent(state)}&providerState=first-owner`;
    const { root, calls } = await fixture({ methods: ['emailCode'], defaultMethod: 'emailCode', setup: { needsInitialAdmin: true, selfRegistrationEnabled: false }, query });
    const owner = form(root, 'registration-panel');
    assert.match(root.textContent, /Create the installation owner/);
    assert.match(root.textContent, /first account becomes administrator/i);
    assert.equal(root.querySelector('select'), null);
    assert.deepEqual(root.querySelectorAll('button').map((node) => node.textContent), ['Create admin account']);
    assertLabels(root);
    owner.querySelector('[name="email"]').value = 'owner@example.test';
    owner.querySelector('[name="password"]').value = 'explicit-owner-password';
    await owner.fire('submit');
    assert.equal(calls[0].path, 'register');
    assert.deepEqual(calls[0].body, payload({ email: 'owner@example.test', password: 'explicit-owner-password' }, 'first-owner'));
});

test('registration-disabled and password-disabled installations expose no create-account switch', async () => {
    for (const options of [
        { setup: { selfRegistrationEnabled: false }, expected: 'password-panel' },
        { methods: ['totp'], defaultMethod: 'password', expected: 'totp-panel' },
    ]) {
        const { root } = await fixture(options);
        form(root, options.expected);
        assert.equal(root.querySelectorAll('button').some((node) => node.textContent === 'Create account'), false);
        assert.equal(root.querySelector('select'), null, 'a disabled default is not added as another method');
        assertLabels(root);
    }
});

test('Google-only registration has no password form and never sends account or role overrides', async () => {
    const { root, calls, redirects } = await fixture({ methods: ['google'], post: () => response({ authorizationUrl: 'https://accounts.google.com/authorize' }) });
    assert.equal(root.querySelector('input'), null);
    await button(root, 'Create account').fire('click');
    assert.equal(root.querySelector('input'), null);
    await button(root, 'Continue with Google').fire('click');
    assert.deepEqual(calls[0].body, { requestId, state });
    assert.equal(calls[0].path, 'google/start');
    assert.deepEqual(redirects, ['https://accounts.google.com/authorize']);
});

test('no effective methods cannot fall back to password and a detached Google response cannot redirect', async () => {
    const empty = await fixture({ methods: [] });
    assert.match(empty.root.textContent, /No sign-in methods/);
    assert.equal(empty.root.querySelector('form'), null);
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { root, redirects } = await fixture({ methods: ['password', 'google'], post: () => pending });
    const click = button(root, 'Continue with Google').fire('click');
    await settle();
    await button(root, 'Create account').fire('click');
    release(response({ authorizationUrl: 'https://accounts.google.com/authorize' }));
    await click;
    assert.deepEqual(redirects, []);
});

test('method selection honors an enabled default and posts password and authenticator credentials without changing SSO state', async () => {
    const { root, calls, window } = await fixture({ methods: ['password', 'emailCode', 'passkey', 'totp'], defaultMethod: 'totp' });
    let selector = root.querySelector('select');
    assert.ok(selector);
    assert.equal(selector.value, 'totp');
    assert.deepEqual(new Set(selector.children.map((node) => node.value)), new Set(['password', 'emailCode', 'passkey', 'totp']));
    assert.ok(root.querySelectorAll('label').some((node) => node.textContent === 'Sign-in method'));
    const totp = form(root, 'totp-panel');
    assertLabels(root);
    const token = totp.querySelector('[name="token"]');
    token.value = ' 123456 ';
    totp.querySelector('[name="email"]').value = ' member@example.test ';
    await totp.fire('submit');
    assert.equal(calls[0].path, 'totp/verify');
    assert.deepEqual(calls[0].body, payload({ email: 'member@example.test', token: '123456' }));
    selector.value = 'password';
    await selector.fire('change');
    assert.equal(token.value, '', 'method changes clear authenticator codes');
    const password = form(root, 'password-panel');
    password.querySelector('[name="email"]').value = 'member@example.test';
    password.querySelector('[name="password"]').value = 'sign-in-secret';
    await password.fire('submit');
    assert.equal(calls[1].path, 'password/login');
    assert.deepEqual(calls[1].body, payload({ email: 'member@example.test', password: 'sign-in-secret' }));
    selector = root.querySelector('select');
    selector.value = 'passkey';
    await selector.fire('change');
    assert.equal(password.querySelector('[name="password"]').value, '');
    form(root, 'passkey-panel');
    assertLabels(root);
    assert.equal(window.location.search, search);
});

test('a disabled default method never appears in the selector or mounts a disabled form', async () => {
    const { root } = await fixture({ methods: ['emailCode', 'totp'], defaultMethod: 'password' });
    const selector = root.querySelector('select');
    assert.deepEqual(selector.children.map((node) => node.value), ['emailCode', 'totp']);
    assert.equal(selector.value, 'emailCode');
    form(root, 'email-panel');
    assert.equal(root.querySelector('[name="password"]'), null);
    assertLabels(root);
});

test('email-code view discards its challenge and code when switching methods and verifies only a fresh challenge', async () => {
    let sequence = 0;
    const { root, calls } = await fixture({ methods: ['emailCode', 'totp'], defaultMethod: 'emailCode', post: ({ path }) => response(path === 'email-code/start' ? { ok: true, challengeId: `challenge-${++sequence}` } : success) });
    const first = form(root, 'email-panel');
    first.querySelector('[name="email"]').value = 'member@example.test';
    await button(root, 'Send code').fire('click');
    assert.equal(first.querySelector('.email-code-fields').hidden, false);
    const oldCode = first.querySelector('[name="code"]');
    oldCode.value = '111111';
    let selector = root.querySelector('select');
    selector.value = 'totp';
    await selector.fire('change');
    assert.equal(oldCode.value, '');
    selector = root.querySelector('select');
    selector.value = 'emailCode';
    await selector.fire('change');
    const current = form(root, 'email-panel');
    assert.equal(current.querySelector('.email-code-fields').hidden, true);
    assert.equal(current.querySelector('[name="code"]').value, '');
    current.querySelector('[name="email"]').value = 'member@example.test';
    await button(root, 'Send code').fire('click');
    current.querySelector('[name="code"]').value = ' 654321 ';
    await button(root, 'Verify').fire('click');
    assert.deepEqual(calls.map((call) => call.path), ['email-code/start', 'email-code/start', 'email-code/verify']);
    assert.deepEqual(calls[0].body, payload({ email: 'member@example.test' }));
    assert.deepEqual(calls[2].body, payload({ challengeId: 'challenge-2', code: '654321' }));
});

test('passkey sign-in preserves challenge, assertion bytes, origin, and SSO request through both requests', async () => {
    const credentials = { get: async ({ publicKey }) => {
        assert.deepEqual([...new Uint8Array(publicKey.challenge)], [1, 2, 3]);
        assert.deepEqual([...new Uint8Array(publicKey.allowCredentials[0].id)], [4, 5, 6]);
        return { id: 'credential-id', rawId: Uint8Array.of(7, 8).buffer, type: 'public-key', response: {
            clientDataJSON: Uint8Array.of(1).buffer, authenticatorData: Uint8Array.of(2).buffer,
            signature: Uint8Array.of(3).buffer, userHandle: null,
        } };
    } };
    const { root, calls, redirects } = await fixture({ methods: ['password', 'passkey'], defaultMethod: 'passkey', credentials, post: ({ path }) => response(path === 'passkey/options' ? { ok: true, challengeKey: 'retained-challenge', publicKey: { challenge: 'AQID', allowCredentials: [{ id: 'BAUG', type: 'public-key' }] } } : success) });
    const passkey = form(root, 'passkey-panel');
    passkey.querySelector('[name="email"]').value = 'member@example.test';
    await passkey.fire('submit');
    assert.deepEqual(calls.map((call) => call.path), ['passkey/options', 'passkey/verify']);
    assert.deepEqual(calls[0].body, payload({ email: 'member@example.test' }));
    assert.deepEqual(calls[1].body, payload({ email: 'member@example.test', challengeKey: 'retained-challenge', assertion: {
        id: 'credential-id', rawId: 'Bwg', type: 'public-key', response: { clientDataJSON: 'AQ', authenticatorData: 'Ag', signature: 'Aw', userHandle: '' },
    } }));
    assert.equal(redirects.length, 1);
});

test('a late error or success from an abandoned form cannot change or redirect the current view', async () => {
    for (const result of [response({ ok: false, error: 'old_password_error' }, false), response(success)]) {
        let complete;
        const { root, redirects } = await fixture({ post: () => new Promise((resolve) => { complete = resolve; }) });
        const password = form(root, 'password-panel');
        password.querySelector('[name="email"]').value = 'member@example.test';
        password.querySelector('[name="password"]').value = 'old-password';
        const pending = password.fire('submit');
        await settle();
        await button(root, 'Create account').fire('click');
        complete(result);
        await pending;
        await settle();
        const registration = form(root, 'registration-panel');
        assert.doesNotMatch(root.textContent, /old_password_error/);
        assert.equal(registration.querySelector('button[type="submit"]').disabled, false);
        assert.equal(redirects.length, 0);
    }
});

test('an error for the active sign-in form remains visible and permits a corrected retry', async () => {
    let attempts = 0;
    const { root, calls, redirects } = await fixture({ post: () => ++attempts === 1 ? response({ ok: false, error: 'invalid_credentials' }, false) : response(success) });
    const password = form(root, 'password-panel');
    password.querySelector('[name="email"]').value = 'member@example.test';
    password.querySelector('[name="password"]').value = 'mistyped-password';
    await password.fire('submit');
    assert.match(root.textContent, /invalid_credentials/);
    assert.equal(password.querySelector('button[type="submit"]').disabled, false);
    password.querySelector('[name="password"]').value = 'corrected-password';
    await password.fire('submit');
    assert.equal(calls[1].body.password, 'corrected-password');
    assert.equal(redirects.length, 1);
});

test('a late email challenge does not restore code fields after switching away and back', async () => {
    let complete;
    const { root } = await fixture({ methods: ['emailCode', 'password'], defaultMethod: 'emailCode', post: () => new Promise((resolve) => { complete = resolve; }) });
    form(root, 'email-panel').querySelector('[name="email"]').value = 'member@example.test';
    const pending = button(root, 'Send code').fire('click');
    await settle();
    let selector = root.querySelector('select');
    selector.value = 'password';
    await selector.fire('change');
    selector = root.querySelector('select');
    selector.value = 'emailCode';
    await selector.fire('change');
    complete(response({ ok: true, challengeId: 'abandoned-challenge' }));
    await pending;
    await settle();
    assert.equal(form(root, 'email-panel').querySelector('.email-code-fields').hidden, true);
    assert.doesNotMatch(root.textContent, /Code sent/);
});

test('switching away from passkey sign-in ignores late options and aborts an active browser prompt', async () => {
    const options = { ok: true, challengeKey: 'abandoned-key', publicKey: { challenge: 'AQID', allowCredentials: [] } };
    for (const phase of ['options', 'prompt']) {
        let complete;
        let signal;
        let browserCalls = 0;
        const credentials = { get: async (args) => {
            browserCalls++;
            signal = args.signal;
            return new Promise((resolve) => { complete = resolve; });
        } };
        const { root, calls, redirects } = await fixture({ methods: ['passkey', 'password'], defaultMethod: 'passkey', credentials,
            post: () => phase === 'options' ? new Promise((resolve) => { complete = resolve; }) : response(options),
        });
        const passkey = form(root, 'passkey-panel');
        passkey.querySelector('[name="email"]').value = 'member@example.test';
        const pending = passkey.fire('submit');
        await settle();
        const selector = root.querySelector('select');
        selector.value = 'password';
        await selector.fire('change');
        if (phase === 'prompt') assert.equal(signal?.aborted, true, 'switching aborts the browser request');
        complete(phase === 'options' ? response(options) : {});
        await pending;
        await settle();
        assert.equal(browserCalls, phase === 'options' ? 0 : 1);
        assert.deepEqual(calls.map((call) => call.path), ['passkey/options'], 'an abandoned credential never reaches verification');
        assert.equal(redirects.length, 0);
        form(root, 'password-panel');
    }
});
