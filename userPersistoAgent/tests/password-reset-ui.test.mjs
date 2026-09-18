import test from 'node:test';
import assert from 'node:assert/strict';
import { mountReset } from '../public/auth/reset.js';

// Minimal DOM stub for the standalone reset page. It supports exactly the
// surface reset.js uses: createElement, text/value/disabled, attributes,
// listeners, replaceChildren and tag/id/attribute selectors.
class Element {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.parentElement = null;
        this.disabled = false;
        this.focused = false;
        this._text = '';
        this._value = '';
    }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.children = []; this._text = String(value); }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') this.className = String(value);
        else if (['hidden', 'disabled', 'required', 'readonly'].includes(name)) this[name] = true;
        else if (name === 'id') this.id = String(value);
        else this[name === 'for' ? 'htmlFor' : name] = String(value);
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    append(...children) {
        for (const child of children) {
            if (child === null || child === undefined) continue;
            child.parentElement = this;
            this.children.push(child);
        }
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
            if (!String(this.className || '').split(/\s+/).includes(name)) return false;
        }
        for (const [, name] of selector.matchAll(/#([\w-]+)/g)) if (this.id !== name) return false;
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
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ token = 'A'.repeat(43), status = {}, reset = {}, navigate } = {}) {
    const root = new Element('main');
    root.isRoot = true;
    const document = { createElement: (tag) => new Element(tag), title: 'Choose a new password' };
    const location = { href: `https://account.example.test/service/auth/reset.html#token=${token}`, hash: `#token=${token}`,
        pathname: '/service/auth/reset.html', search: '' };
    const historyCalls = [];
    const history = { replaceState: (...args) => historyCalls.push(args) };
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith('/password/reset/status')) {
            if (typeof status.response === 'function') return status.response();
            return status.response || { ok: true, status: 200, json: async () => ({ ok: true, email: 'owner@example.test',
                expiresAt: Date.now() + 30 * 60 * 1000, passwordPolicy: { minLength: 15, maxLength: 128, maxRawLength: 1024, normalization: 'NFKC' } }) };
        }
        if (url.endsWith('/password/reset')) {
            return reset.response || { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        throw new Error(`Unexpected fetch: ${url}`);
    };
    const navigated = [];
    const handle = mountReset({ root, document, fetch: fetchImpl, location, history, navigate: (url) => { navigated.push(url); navigate?.(url); } });
    return { root, calls, historyCalls, navigated, handle };
}

const h1 = (root) => root.querySelector('h1')?.textContent;
const alertText = (root) => root.querySelectorAll('[role="alert"]').map((node) => node.textContent).join(' ');
const button = (root, text) => {
    const node = root.querySelectorAll('button').find((candidate) => candidate.textContent === text);
    assert.ok(node, `expected a button "${text}"; have ${root.querySelectorAll('button').map((candidate) => candidate.textContent).join(' | ')}`);
    return node;
};

test('P1 shows the address and password fields without maxlength, and P2 changes the password once', async () => {
    const { root, calls, historyCalls, navigated } = fixture();
    await settle();
    assert.equal(h1(root), 'Choose a new password');
    assert.deepEqual(historyCalls[0].slice(-1), ['/service/auth/reset.html'], 'the token leaves the address bar');
    const emailField = root.querySelector('#reset-account-email');
    assert.deepEqual([emailField.value, emailField.readonly, emailField.autocomplete], ['owner@example.test', true, 'username']);
    for (const [id, name] of [['reset-new-password', 'password'], ['reset-confirm-password', 'passwordConfirmation']]) {
        const input = root.querySelector(`#${id}`);
        assert.deepEqual([input.name, input.type, input.autocomplete, input.hasAttribute('maxlength')], [name, 'password', 'new-password', false]);
    }
    assert.doesNotMatch(root.textContent, /Use at least \d+ characters\./, 'no length hint is rendered');
    assert.deepEqual(calls[0], { url: 'https://account.example.test/service/auth/password/reset/status', body: { token: 'A'.repeat(43) } });

    root.querySelector('[name="password"]').value = 'a long enough password';
    root.querySelector('[name="passwordConfirmation"]').value = 'something else entirely';
    await root.querySelector('form.reset-panel').fire('submit');
    assert.equal(h1(root), 'Choose a new password');
    assert.equal(alertText(root), 'The passwords do not match.');
    assert.equal(root.querySelector('[name="passwordConfirmation"]').value, '');
    assert.equal(calls.length, 1, 'a client refusal never calls the server');

    root.querySelector('[name="password"]').value = 'a long enough password';
    root.querySelector('[name="passwordConfirmation"]').value = 'a long enough password';
    await root.querySelector('form.reset-panel').fire('submit');
    assert.equal(h1(root), 'Password changed');
    assert.match(root.textContent, /Your password was changed\. Every session was signed out\./);
    assert.deepEqual(calls[1], { url: 'https://account.example.test/service/auth/password/reset', body: {
        token: 'A'.repeat(43), password: 'a long enough password', passwordConfirmation: 'a long enough password' } });
    await button(root, 'Sign in').fire('click');
    assert.deepEqual(navigated, ['/auth/login?returnTo=%2F']);
});

test('a missing, malformed or rejected token shows one P3 message and never calls reset', async () => {
    for (const token of ['', 'short', 'x'.repeat(44), 'has spaces '.repeat(4)]) {
        const { root, calls } = fixture({ token });
        await settle();
        assert.equal(h1(root), 'This link is not valid', JSON.stringify(token));
        assert.match(root.textContent, /This reset link is invalid or has expired\. Request a new one from the sign-in page\./);
        assert.deepEqual(calls, [], 'no status probe for a malformed token');
        await button(root, 'Go to sign in').fire('click');
    }
    const unknown = fixture({ status: { response: { ok: false, status: 400, json: async () => ({ ok: false, error: 'reset_link_invalid' }) } } });
    await settle();
    assert.equal(h1(unknown.root), 'This link is not valid');
    assert.match(unknown.root.textContent, /This reset link is invalid or has expired\. Request a new one from the sign-in page\./);
});

test('a reset refused as invalid opens P3, while input and rate refusals keep the link usable', async () => {
    const refusals = [
        [{ code: 'reset_link_invalid' }, 'a long enough password', 'invalid', null],
        [{ code: 'invalid_password', reason: 'too_common' }, 'passwordpassword1', 'choose', 'Choose a password that is harder to guess.'],
        [{ code: 'rate_limited', retryAfter: 12 }, 'a long enough password', 'choose', 'Too many attempts. Wait 12 s and try again.'],
    ];
    for (const [error, chosen, expectedScreen, copy] of refusals) {
        const { root, calls } = fixture({ reset: { response: { ok: false, status: error.code === 'reset_link_invalid' ? 400 : 429,
            json: async () => ({ ok: false, error: error.code, ...error }) } } });
        await settle();
        root.querySelector('[name="password"]').value = chosen;
        root.querySelector('[name="passwordConfirmation"]').value = chosen;
        await root.querySelector('form.reset-panel').fire('submit');
        if (expectedScreen === 'invalid') {
            assert.equal(h1(root), 'This link is not valid');
            assert.match(root.textContent, /This reset link is invalid or has expired\. Request a new one from the sign-in page\./);
        } else {
            assert.equal(h1(root), 'Choose a new password', error.code);
            assert.equal(alertText(root), copy);
            assert.equal(root.querySelector('[name="password"]').value, '', 'secrets are emptied after the response');
            assert.equal(root.querySelector('[name="passwordConfirmation"]').value, '');
        }
        assert.equal(calls.at(-1).url, 'https://account.example.test/service/auth/password/reset');
    }
});

test('client-side password rules are checked before any server call and a policy with minLength > 1 still requires it', async () => {
    const { root, calls } = fixture({ status: { response: { ok: true, status: 200, json: async () => ({ ok: true, email: 'owner@example.test',
        expiresAt: Date.now() + 60000, passwordPolicy: { minLength: 20, maxLength: 64, maxRawLength: 512, normalization: 'NFKC' } }) } } });
    await settle();
    assert.doesNotMatch(root.textContent, /Use at least \d+ characters\./, 'no length hint is rendered');
    root.querySelector('[name="password"]').value = 'nineteen chars only';
    root.querySelector('[name="passwordConfirmation"]').value = 'nineteen chars only';
    await root.querySelector('form.reset-panel').fire('submit');
    assert.equal(alertText(root), 'Use at least 20 characters.');
    assert.equal(root.querySelector('[name="password"]').focused, true);
    assert.equal(calls.length, 1, 'only the status probe ran');
});

const validStatus = () => ({ ok: true, status: 200, json: async () => ({ ok: true, email: 'owner@example.test',
    expiresAt: Date.now() + 30 * 60 * 1000, passwordPolicy: { minLength: 15, maxLength: 128, maxRawLength: 1024, normalization: 'NFKC' } }) });

test('a failed status check other than an invalid link offers Try again with the in-memory token', async () => {
    const token = 'B'.repeat(43);
    const failures = [
        [() => ({ ok: false, status: 429, json: async () => ({ ok: false, error: 'rate_limited', retryAfter: 30 }) }), 'Too many attempts. Wait 30 s and try again.'],
        [() => ({ ok: false, status: 503, json: async () => ({ ok: false, error: 'persistence_unavailable' }) }), 'Something went wrong. Try again.'],
        [() => { throw new TypeError('Failed to fetch'); }, 'Something went wrong. Try again.'],
    ];
    for (const [failure, copy] of failures) {
        let attempts = 0;
        const { root, calls, historyCalls } = fixture({ token, status: { response: () => (attempts++ === 0 ? failure() : validStatus()) } });
        await settle();
        assert.equal(h1(root), 'We could not check this link');
        assert.equal(alertText(root), copy);
        assert.equal(root.textContent.includes('This link is not valid'), false);
        assert.deepEqual(historyCalls[0].slice(-1), ['/service/auth/reset.html'], 'the token already left the address bar');
        await button(root, 'Try again').fire('click');
        await settle();
        assert.equal(h1(root), 'Choose a new password');
        assert.deepEqual(calls.map((call) => [call.url, call.body.token]), [
            ['https://account.example.test/service/auth/password/reset/status', token],
            ['https://account.example.test/service/auth/password/reset/status', token],
        ]);
    }
});

test('the page handle never exposes the token; only its requests carry it', async () => {
    const token = 'C'.repeat(43);
    const { root, calls, handle } = fixture({ token });
    await settle();
    assert.equal(h1(root), 'Choose a new password');
    assert.equal(Object.hasOwn(handle.state(), 'token'), false);
    assert.equal(JSON.stringify(handle.state()).includes(token), false);
    root.querySelector('[name="password"]').value = 'a long enough password';
    root.querySelector('[name="passwordConfirmation"]').value = 'a long enough password';
    await root.querySelector('form.reset-panel').fire('submit');
    assert.deepEqual(calls.map((call) => call.body.token), [token, token]);
});
