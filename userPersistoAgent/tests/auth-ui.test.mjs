import test from 'node:test';
import assert from 'node:assert/strict';
import { mountWizard } from '../public/auth/wizard.js';
import { createSsoAdapter } from '../public/auth/sso-adapter.js';
import { createOidcAdapter } from '../public/auth/oidc-adapter.js';

// ---- fake DOM --------------------------------------------------------------
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
        this.focused = false;
        this.submitted = false;
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
        else if (['hidden', 'disabled', 'selected', 'required', 'readonly'].includes(name)) this[name] = true;
        else this[name === 'for' ? 'htmlFor' : name] = String(value);
    }
    getAttribute(name) { return name === 'class' ? this.className : this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    append(...children) {
        for (const child of children) {
            child.parentElement = this;
            this.children.push(child);
        }
    }
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
    // A real HTMLFormElement.submit() does not fire 'submit' listeners (only
    // requestSubmit() does); the OIDC adapter relies on that, so the fake only
    // flips a flag tests can observe.
    submit() { this.submitted = true; }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function createDocument() {
    const root = new Element('main');
    root.isRoot = true;
    root.setAttribute('id', 'auth_content');
    const body = new Element('body');
    body.isRoot = true;
    const document = { createElement: (tag) => new Element(tag), querySelector: (selector) => (root.matches(selector) ? root : root.querySelector(selector)), body };
    return { document, root, body };
}

function fakeStorage() {
    const data = new Map();
    return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }, data };
}

function fakeClock(start = Date.now()) {
    let now = start;
    let timers = [];
    let nextId = 1;
    return {
        now: () => now,
        setInterval: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; },
        clearInterval: (id) => { timers = timers.filter((timer) => timer.id !== id); },
        advance(ms) { now += ms; for (const timer of [...timers]) timer.fn(); },
    };
}

// ---- fake adapter (wizard behaviour talks only to this contract) -----------
const POLICY = { minLength: 15, maxLength: 128, maxRawLength: 1024, normalization: 'NFKC' };
const ALL_METHODS = { password: true, emailCode: true, passkey: true, totp: true, google: false };

function wizardState(overrides = {}) {
    return {
        expiresAt: Date.now() + 5 * 60 * 1000,
        setupComplete: true,
        initialPasswordSetup: false,
        registration: true,
        signup: { email: true, google: false },
        methods: { ...ALL_METHODS },
        passwordPolicy: POLICY,
        attempt: { status: 'active', challenge: null, locked: false, signupPending: false },
        ...overrides,
    };
}
function challengeFor(overrides = {}) {
    return { email: 'member@example.test', purpose: 'login', expiresAt: Date.now() + 5 * 60 * 1000, resendAt: Date.now() + 60 * 1000,
        attemptsRemaining: 5, delivery: 'accepted', expired: false, ...overrides };
}
const signupChallenge = (overrides = {}) => challengeFor({ purpose: 'register', email: 'new@example.test', ...overrides });
const REGISTERED = { exists: true, methods: { password: true, emailCode: true, passkey: true, totp: true } };
const UNKNOWN = { exists: false, methods: { password: false, emailCode: false, passkey: false, totp: false } };

function baseAdapter(overrides = {}) {
    return {
        flow: 'sso', clientName: '', screenHint: '', storageKey: 'wizard-test', notice: '',
        attempt: async () => wizardState(),
        cancel: async () => ({ status: 'cancelled' }),
        discover: async () => REGISTERED,
        passwordLogin: async () => ({ code: 'handoff' }),
        startSignup: async () => ({ challenge: signupChallenge() }),
        resendSignup: async () => ({ challenge: signupChallenge() }),
        changeSignupEmail: async (email) => ({ challenge: signupChallenge({ email }) }),
        verifySignup: async () => ({ code: 'handoff' }),
        startEmail: async () => ({ challenge: challengeFor() }),
        verifyEmail: async () => ({ code: 'handoff' }),
        verifyTotp: async () => ({ code: 'handoff' }),
        verifyPasskey: async () => ({ code: 'handoff' }),
        passkeyOptions: async () => ({ challengeKey: 'challenge-key', publicKey: { challenge: 'AQID', allowCredentials: [] } }),
        startGoogle: async () => ({}),
        complete: () => {},
        restart: () => {},
        ...overrides,
    };
}
function fail(code, extra = {}) {
    return Object.assign(new Error(code), { code, ...extra });
}

async function mount({ adapter, storage = null, clock = fakeClock(), credentials } = {}) {
    const { document, root, body } = createDocument();
    const instance = mountWizard({ root, document, adapter, storage, clock, credentials });
    await settle();
    return { root, body, clock, instance, dispose: instance.dispose };
}

function h1(root) {
    const node = root.querySelector('h1');
    assert.ok(node, 'expected an h1 on the current screen');
    return node;
}
function button(root, text) {
    const node = root.querySelectorAll('button').find((candidate) => candidate.textContent === text);
    assert.ok(node, `expected a button "${text}"; have ${root.querySelectorAll('button').map((candidate) => candidate.textContent).join(' | ')}`);
    return node;
}
function hasButton(root, text) {
    return root.querySelectorAll('button').some((candidate) => candidate.textContent === text);
}
function assertLabels(root) {
    for (const input of root.querySelectorAll('input, select')) {
        assert.ok(input.id, `${input.name || input.tagName} has an id`);
        assert.ok(root.querySelectorAll('label').some((label) => label.htmlFor === input.id), `label is associated with ${input.id}`);
    }
}
function alertText(root) {
    return root.querySelectorAll('[role="alert"]').map((node) => node.textContent).join(' ');
}
async function submitEmail(root, email = 'member@example.test') {
    root.querySelector('[name="email"]').value = email;
    await root.querySelector('form.start-panel').fire('submit');
}
async function toPassword(overrides = {}) {
    const mounted = await mount({ adapter: baseAdapter(overrides.adapter), storage: overrides.storage, clock: overrides.clock, credentials: overrides.credentials });
    await submitEmail(mounted.root, overrides.email);
    return mounted;
}
async function toSignupPassword(adapterOverrides = {}, options = {}) {
    const mounted = await mount({ adapter: baseAdapter({ discover: async () => UNKNOWN, ...adapterOverrides }), ...options });
    await submitEmail(mounted.root, 'new@example.test');
    await mounted.root.querySelector('form.signup-offer-panel').fire('submit');
    return mounted;
}
async function createAccount(root, password = 'a long enough password', confirmation = password) {
    root.querySelector('[name="password"]').value = password;
    root.querySelector('[name="passwordConfirmation"]').value = confirmation;
    await root.querySelector('form.signup-password-panel').fire('submit');
}

// ==== S1 start ==============================================================

test('S1 orders Sign in with Google, Email and Next with no password, administrator or mode control', async () => {
    for (const flow of ['sso', 'oidc']) {
        const adapter = baseAdapter({ flow, attempt: async () => wizardState({ methods: { ...ALL_METHODS, google: true } }),
            ...(flow === 'oidc' ? { clientName: 'Explorer', abort: () => {} } : {}) });
        const { root } = await mount({ adapter });
        assert.equal(h1(root).textContent, 'Sign in');
        const form = root.querySelector('form.start-panel');
        assert.deepEqual(form.children.filter((node) => ['BUTTON', 'LABEL', 'INPUT'].includes(node.tagName))
            .map((node) => (node.tagName === 'INPUT' ? `input:${node.name}` : node.textContent)),
        ['Sign in with Google', 'Email', 'input:email', 'Next', ...(flow === 'oidc' ? ['Cancel'] : [])]);
        const emailInput = root.querySelector('[name="email"]');
        assert.deepEqual([emailInput.type, emailInput.autocomplete, emailInput.required], ['email', 'email', true]);
        assert.equal(root.querySelectorAll('input[type="password"]').length, 0);
        for (const retired of ['Admin password', 'Administrator sign-in', 'Create an account', 'Sign up']) assert.equal(hasButton(root, retired) || root.textContent.includes(retired), false, retired);
        assertLabels(root);
        if (flow === 'oidc') assert.match(root.textContent, /Continue to Explorer/);
    }
});

test('the Google button is rendered only when usable and starts the Google flow', async () => {
    const withoutGoogle = await mount({ adapter: baseAdapter() });
    assert.equal(withoutGoogle.root.querySelector('.google-button'), null);
    let started = 0;
    const { root } = await mount({ adapter: baseAdapter({ attempt: async () => wizardState({ methods: { ...ALL_METHODS, google: true } }), startGoogle: async () => { started += 1; } }) });
    const google = root.querySelector('.google-button');
    assert.equal(google.textContent, 'Sign in with Google');
    await google.fire('click');
    assert.equal(started, 1);
});

test('an unclaimed installation shows the first-run notice and an OIDC signup hint only changes the heading', async () => {
    const unclaimed = await mount({ adapter: baseAdapter({ attempt: async () => wizardState({ setupComplete: false }) }) });
    assert.match(unclaimed.root.textContent, /This workspace is not set up yet\. The first completed sign-in becomes its administrator\./);
    assert.equal(h1(unclaimed.root).textContent, 'Sign in');
    const hinted = await mount({ adapter: baseAdapter({ flow: 'oidc', clientName: 'Explorer', screenHint: 'signup', abort: () => {} }) });
    assert.equal(h1(hinted.root).textContent, 'Create your account');
    assert.ok(hinted.root.querySelector('[name="email"]'));
    assert.equal(hinted.root.querySelectorAll('input[type="password"]').length, 0);
});

test('Next with an empty or invalid email shows the copy, focuses Email and calls no server', async () => {
    const calls = [];
    const { root } = await mount({ adapter: baseAdapter({ discover: async (email) => { calls.push(email); return REGISTERED; } }) });
    for (const value of ['', 'not-an-email', 'a@b']) {
        await submitEmail(root, value);
        assert.equal(alertText(root), 'Enter a valid email address.');
        assert.equal(root.querySelector('[name="email"]').focused, true);
    }
    assert.deepEqual(calls, []);
});

test('Next branches only on discovery: registered to S2, unknown to S4, Google-only signup to S10, otherwise S11', async () => {
    const registered = await toPassword();
    assert.equal(h1(registered.root).textContent, 'Enter your password');
    const offer = await mount({ adapter: baseAdapter({ discover: async () => UNKNOWN }) });
    await submitEmail(offer.root, 'new@example.test');
    assert.equal(h1(offer.root).textContent, 'Create an account?');
    assert.match(offer.root.textContent, /No account uses new@example\.test\./);
    button(offer.root, 'Sign up');
    button(offer.root, 'Back');
    const google = await mount({ adapter: baseAdapter({ discover: async () => UNKNOWN,
        attempt: async () => wizardState({ signup: { email: false, google: true }, methods: { ...ALL_METHODS, google: true } }) }) });
    await submitEmail(google.root, 'new@example.test');
    assert.equal(h1(google.root).textContent, 'Create an account with Google');
    assert.equal(google.root.querySelector('.google-button').textContent, 'Sign in with Google');
    const closed = await mount({ adapter: baseAdapter({ discover: async () => UNKNOWN, attempt: async () => wizardState({ registration: false, signup: { email: false, google: false } }) }) });
    await submitEmail(closed.root, 'ghost@example.test');
    assert.equal(h1(closed.root).textContent, 'No account found');
    assert.match(closed.root.textContent, /No account uses ghost@example\.test\.Registration is not available\./);
    assert.deepEqual(closed.root.querySelectorAll('button').map((node) => node.textContent), ['Back']);
});

// ==== S2 password ===========================================================

test('an unclaimed installation offers initial password setup without email delivery on the ordinary password screen', async () => {
    const calls = [];
    const mounted = await mount({ adapter: baseAdapter({
        attempt: async () => wizardState({ setupComplete: false, initialPasswordSetup: true, registration: false,
            signup: { email: false, google: false }, methods: { password: true } }),
        discover: async () => ({ ...UNKNOWN, initialPasswordSetup: true }),
        passwordLogin: async (args) => { calls.push(args); throw fail('authentication_failed'); },
    }) });
    await submitEmail(mounted.root, 'owner@example.test');
    assert.equal(h1(mounted.root).textContent, 'Enter your password');
    assert.match(mounted.root.textContent, /First-time setup: enter admin/);
    assert.equal(mounted.root.querySelector('[name="password"]').disabled, false);
    assert.equal(button(mounted.root, 'Log in').disabled, false);
    assert.equal(hasButton(mounted.root, 'Sign up'), false);
    assert.equal(hasButton(mounted.root, 'Administrator sign-in'), false);
    mounted.root.querySelector('[name="password"]').value = ' admin';
    await mounted.root.querySelector('form.password-panel').fire('submit');
    assert.deepEqual(calls, [{ email: 'owner@example.test', password: ' admin' }], 'the exact password reaches the server without trimming');
    assert.equal(mounted.root.querySelector('[name="password"]').value, '');
    assert.match(alertText(mounted.root), /That password is not correct/);
    await button(mounted.root, 'Back').fire('click');
    assert.equal(mounted.root.querySelector('[name="email"]').value, 'owner@example.test');
    assert.equal(mounted.root.querySelector('[name="password"]'), null);
});

test('the initial password choice keeps normal verified signup reachable when email signup is available', async () => {
    const starts = [];
    const { root } = await mount({ adapter: baseAdapter({
        attempt: async () => wizardState({ setupComplete: false, initialPasswordSetup: true }),
        discover: async () => ({ ...UNKNOWN, initialPasswordSetup: true }),
        passwordLogin: () => assert.fail('choosing Sign up must not claim initial password setup'),
        startSignup: async (args) => { starts.push(args); return { challenge: signupChallenge({ email: 'owner@example.test' }) }; },
    }) });
    await submitEmail(root, 'owner@example.test');
    await button(root, 'Sign up').fire('click');
    assert.equal(h1(root).textContent, 'Create your password');
    await createAccount(root, 'a separately chosen strong password');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].email, 'owner@example.test');
    assert.match(h1(root).textContent, /Enter the 6-digit code sent to owner@example/);
});

test('fresh discovery overrides boot and cached initial setup availability', async () => {
    for (const [bootFlag, discoveryFlag] of [[true, false], [false, true]]) {
        const { root } = await mount({ adapter: baseAdapter({
            attempt: async () => wizardState({ setupComplete: false, initialPasswordSetup: bootFlag }),
            discover: async () => ({ ...UNKNOWN, initialPasswordSetup: discoveryFlag }),
        }) });
        await submitEmail(root, 'owner@example.test');
        assert.equal(h1(root).textContent, discoveryFlag ? 'Enter your password' : 'Create an account?');
    }
    let calls = 0;
    const { root } = await mount({ adapter: baseAdapter({
        attempt: async () => wizardState({ setupComplete: false, initialPasswordSetup: true }),
        discover: async () => ({ ...UNKNOWN, initialPasswordSetup: ++calls === 1 }),
    }) });
    await submitEmail(root, 'owner@example.test');
    await button(root, 'Try another way').fire('click');
    assert.equal(calls, 2, 'unclaimed setup availability cannot be reused from cached discovery');
    await button(root, 'Use your password').fire('click');
    assert.equal(button(root, 'Log in').disabled, true);
    assert.doesNotMatch(root.textContent, /First-time setup/);
    await button(root, 'Back').fire('click');
    await submitEmail(root, 'later@example.test');
    assert.equal(h1(root).textContent, 'Create an account?');
});

test('an OIDC initial setup password failure restores the ordinary password screen without retaining the secret', async () => {
    const { root } = await mount({ adapter: baseAdapter({ flow: 'oidc', initialEmail: 'owner@example.test',
        initialFailure: { action: 'password-login', code: 'authentication_failed' },
        attempt: async () => wizardState({ setupComplete: false, initialPasswordSetup: true, signup: { email: false, google: true } }),
        discover: async () => ({ ...UNKNOWN, initialPasswordSetup: true }),
    }) });
    assert.equal(h1(root).textContent, 'Enter your password');
    assert.match(root.textContent, /First-time setup: enter admin/);
    assert.equal(root.querySelector('[name="password"]').value, '');
    assert.equal(button(root, 'Log in').disabled, false);
    assert.match(alertText(root), /That password is not correct/);
});

test('S2 shows the read-only email, a password without maxlength, Log in, Try another way and Back', async () => {
    const { root } = await toPassword();
    const emailField = root.querySelector('#auth-account-email');
    assert.deepEqual([emailField.value, emailField.readonly, emailField.autocomplete], ['member@example.test', true, 'username']);
    const password = root.querySelector('[name="password"]');
    assert.deepEqual([password.type, password.autocomplete, password.hasAttribute('maxlength'), password.disabled], ['password', 'current-password', false, false]);
    assert.deepEqual(['Log in', 'Try another way', 'Back'].map((label) => hasButton(root, label)), [true, true, true]);
    assertLabels(root);
    await button(root, 'Back').fire('click');
    assert.equal(h1(root).textContent, 'Sign in');
    assert.equal(root.querySelector('[name="email"]').value, 'member@example.test', 'Back keeps the email');
});

test('S2 disables password submission with neutral wording when the workspace or the account cannot use a password', async () => {
    for (const [state, discovered, copy] of [
        [wizardState({ methods: { ...ALL_METHODS, password: false } }), REGISTERED, 'Password sign-in is not available in this workspace.'],
        [wizardState(), { exists: true, methods: { password: false, emailCode: true, passkey: false, totp: false } }, 'Password sign-in is not available for this account here. Choose Try another way.'],
        // A blocked account reports no usable method; the wording is identical.
        [wizardState(), UNKNOWN_METHODS_FOR_EXISTING(), 'Password sign-in is not available for this account here. Choose Try another way.'],
    ]) {
        const calls = [];
        const { root } = await toPassword({ adapter: { attempt: async () => state, discover: async () => discovered, passwordLogin: async () => { calls.push('login'); } } });
        assert.equal(h1(root).textContent, 'Enter your password');
        assert.equal(root.querySelector('[name="password"]').disabled, true);
        assert.equal(button(root, 'Log in').disabled, true);
        assert.match(root.textContent, new RegExp(copy.replace(/\./g, '\\.')));
        assert.doesNotMatch(root.textContent, /blocked|Google account|linked/i);
        assert.equal(button(root, 'Try another way').focused, true);
        await root.querySelector('form.password-panel').fire('submit');
        assert.deepEqual(calls, []);
    }
});

function UNKNOWN_METHODS_FOR_EXISTING() {
    return { exists: true, methods: { password: false, emailCode: false, passkey: false, totp: false } };
}

test('S2 Log in captures and empties the password before the request, then signs in', async () => {
    let seen;
    let passwordDuringRequest;
    let completed;
    const mounted = await toPassword({ adapter: {
        passwordLogin: async (args) => { seen = args; passwordDuringRequest = mounted.root.querySelector('[name="password"]').value; return { code: 'handoff-code' }; },
        complete: (result) => { completed = result; },
    } });
    const { root } = mounted;
    await root.querySelector('form.password-panel').fire('submit');
    assert.equal(alertText(root), 'Enter your password.');
    assert.equal(seen, undefined, 'an empty password is not sent');
    root.querySelector('[name="password"]').value = 'correct horse battery staple';
    await root.querySelector('form.password-panel').fire('submit');
    assert.deepEqual(seen, { email: 'member@example.test', password: 'correct horse battery staple' });
    assert.equal(passwordDuringRequest, '', 'the input was emptied before the request was sent');
    assert.equal(h1(root).textContent, 'Signing you in…');
    assert.deepEqual(completed, { code: 'handoff-code' });
});

test('S2 failures keep the screen with neutral or wait copy and an empty password; expiry codes open S13', async () => {
    for (const [error, copy] of [
        [fail('authentication_failed'), 'That password is not correct. Try again or choose another way to sign in.'],
        [fail('rate_limited', { retryAfter: 42 }), 'Too many attempts. Wait 42 s and try again.'],
        [fail('auth_method_disabled'), 'This sign-in method is not available.'],
    ]) {
        const { root } = await toPassword({ adapter: { passwordLogin: async () => { throw error; } } });
        root.querySelector('[name="password"]').value = 'a submitted password';
        await root.querySelector('form.password-panel').fire('submit');
        assert.equal(h1(root).textContent, 'Enter your password');
        assert.equal(alertText(root), copy);
        assert.equal(root.querySelector('[name="password"]').value, '');
        assert.equal(button(root, 'Log in').disabled, false);
        assert.doesNotMatch(root.textContent, /attempts left|blocked/);
    }
    for (const code of ['login_request_expired', 'attempt_expired', 'login_request_invalid']) {
        const { root } = await toPassword({ adapter: { passwordLogin: async () => { throw fail(code); } } });
        root.querySelector('[name="password"]').value = 'a submitted password';
        await root.querySelector('form.password-panel').fire('submit');
        assert.equal(h1(root).textContent, 'This sign-in request expired', code);
    }
});

// ==== S2 forgot password =====================================================

test('S2 offers Forgot password only when the password is usable and reset delivery is configured', async () => {
    const enabled = await toPassword({ adapter: { attempt: async () => wizardState({ passwordReset: true }) } });
    assert.equal(hasButton(enabled.root, 'Forgot password?'), true);
    const disabled = await toPassword({ adapter: { attempt: async () => wizardState({ passwordReset: false }) } });
    assert.equal(hasButton(disabled.root, 'Forgot password?'), false);
    // Unusable password for this account: no disabled control, no reason text.
    const unusable = await toPassword({ adapter: { attempt: async () => wizardState({ passwordReset: true }),
        discover: async () => ({ exists: true, methods: { password: false, emailCode: true, passkey: false, totp: false } }) } });
    assert.equal(button(unusable.root, 'Log in').disabled, true);
    assert.equal(hasButton(unusable.root, 'Forgot password?'), false);
    assert.doesNotMatch(unusable.root.textContent, /Forgot password/);
});

test('S2 never offers Forgot password for an unknown address on an unclaimed installation', async () => {
    const { root } = await toPassword({ adapter: {
        attempt: async () => wizardState({ setupComplete: false, initialPasswordSetup: true, passwordReset: true }),
        discover: async () => ({ ...UNKNOWN, initialPasswordSetup: true }),
    } });
    assert.equal(h1(root).textContent, 'Enter your password');
    assert.equal(button(root, 'Log in').disabled, false, 'the initial admin password stays usable');
    assert.equal(hasButton(root, 'Forgot password?'), false);
});

test('S8 shows a refused Send again on the Check your email screen', async () => {
    let calls = 0;
    const mounted = await toPassword({ adapter: { attempt: async () => wizardState({ passwordReset: true }),
        forgotPassword: async () => { calls += 1; if (calls > 1) throw fail('rate_limited', { retryAfter: 42 }); return { ok: true }; } } });
    await button(mounted.root, 'Forgot password?').fire('click');
    await mounted.root.querySelector('form.forgot-email-panel').fire('submit');
    assert.equal(h1(mounted.root).textContent, 'Check your email');
    mounted.clock.advance(60_000);
    const sendAgain = mounted.root.querySelectorAll('button').find((node) => node.textContent.startsWith('Send again'));
    await sendAgain.fire('click');
    assert.equal(calls, 2);
    assert.equal(h1(mounted.root).textContent, 'Check your email');
    assert.equal(alertText(mounted.root), 'Too many attempts. Wait 42 s and try again.');
    assert.equal(sendAgain.disabled, false);
});

test('S7 sends the reset link for the read-only email and S8 waits with a 60-second Send again counter', async () => {
    const calls = [];
    const mounted = await toPassword({ adapter: { attempt: async () => wizardState({ passwordReset: true }),
        forgotPassword: async (args) => { calls.push(args); return { ok: true }; } } });
    await button(mounted.root, 'Forgot password?').fire('click');
    assert.equal(h1(mounted.root).textContent, 'Reset your password');
    const emailField = mounted.root.querySelector('#auth-forgot-email');
    assert.deepEqual([emailField.value, emailField.readonly, emailField.autocomplete], ['member@example.test', true, 'username']);
    assert.match(mounted.root.textContent, /We will email a link to choose a new password\./);
    await mounted.root.querySelector('form.forgot-email-panel').fire('submit');
    assert.deepEqual(calls, [{ email: 'member@example.test' }]);
    assert.equal(h1(mounted.root).textContent, 'Check your email');
    assert.match(mounted.root.textContent, /If member@example\.test can reset its password here, a link is on its way\. It expires in 30 minutes\./);
    const sendAgain = mounted.root.querySelectorAll('button').find((node) => node.textContent.startsWith('Send again'));
    assert.ok(sendAgain, 'Send again is rendered');
    assert.equal(sendAgain.disabled, true, 'the cooldown starts immediately');
    assert.match(sendAgain.textContent, /Send again in \d+ s/);
    mounted.clock.advance(60_000);
    assert.equal(sendAgain.disabled, false);
    assert.equal(sendAgain.textContent, 'Send again');
    await sendAgain.fire('click');
    assert.equal(calls.length, 2);
    assert.equal(h1(mounted.root).textContent, 'Check your email');
    await button(mounted.root, 'Back to sign in').fire('click');
    assert.equal(h1(mounted.root).textContent, 'Sign in');
});

test('S7 and S8 surface a delivery failure with the shared copy and keep the email', async () => {
    const mounted = await toPassword({ adapter: { attempt: async () => wizardState({ passwordReset: true }),
        forgotPassword: async () => { throw fail('delivery_failed'); } } });
    await button(mounted.root, 'Forgot password?').fire('click');
    await mounted.root.querySelector('form.forgot-email-panel').fire('submit');
    assert.equal(h1(mounted.root).textContent, 'Reset your password');
    assert.equal(alertText(mounted.root), 'We could not send the email. Try again later.');
    assert.equal(mounted.root.querySelector('#auth-forgot-email').value, 'member@example.test');
    assert.equal(button(mounted.root, 'Send reset link').disabled, false);
});

// ==== S3 alternatives =========================================================

test('S3 always lists the three alternatives in order with policy, browser and account reasons', async () => {
    const credentials = { get: async () => null };
    const cases = [
        [wizardState(), REGISTERED, credentials, ['', '', '']],
        [wizardState({ methods: { ...ALL_METHODS, emailCode: false, totp: false } }), REGISTERED, credentials,
            ['Not available in this workspace.', '', 'Not available in this workspace.']],
        [wizardState(), REGISTERED, undefined, ['', 'Not available in this browser or at this address.', '']],
        [wizardState(), { exists: true, methods: { password: true, emailCode: true, passkey: false, totp: false } }, credentials,
            ['', 'Not available for this account.', 'Not available for this account.']],
    ];
    for (const [state, discovered, browserCredentials, reasons] of cases) {
        let discoveries = 0;
        const { root } = await toPassword({ adapter: { attempt: async () => state, discover: async () => { discoveries += 1; return discovered; } }, credentials: browserCredentials });
        await button(root, 'Try another way').fire('click');
        assert.equal(discoveries, 1, 'Try another way reuses the discovery');
        assert.equal(h1(root).textContent, 'Try another way');
        const entries = root.querySelectorAll('.auth-method');
        assert.deepEqual(entries.map((entry) => entry.querySelector('button').textContent), ['Email me a code', 'Use a passkey', 'Use an authenticator app']);
        assert.deepEqual(entries.map((entry) => entry.querySelector('.auth-method-reason')?.textContent || ''), reasons);
        assert.deepEqual(entries.map((entry) => entry.querySelector('button').disabled), reasons.map(Boolean));
        assert.match(root.textContent, /Sign-in methods are managed from My Account after you sign in\./);
        assert.equal(hasButton(root, 'Use your password'), true);
    }
    const none = await toPassword({ adapter: { discover: async () => UNKNOWN_METHODS_FOR_EXISTING() } });
    await button(none.root, 'Try another way').fire('click');
    assert.match(none.root.textContent, /If this account uses Google, go back and choose Sign in with Google\. Otherwise contact your workspace administrator\./);
    await button(none.root, 'Use your password').fire('click');
    assert.equal(h1(none.root).textContent, 'Enter your password');
});

test('S3 email code starts a login code for S7, and a refused request stays on S3 with the error', async () => {
    const calls = [];
    const ok = await toPassword({ adapter: { startEmail: async (args) => { calls.push(args); return { challenge: challengeFor() }; } } });
    await button(ok.root, 'Try another way').fire('click');
    await button(ok.root, 'Email me a code').fire('click');
    assert.deepEqual(calls, [{ email: 'member@example.test', purpose: 'login', resend: false }]);
    assert.equal(h1(ok.root).textContent, 'Enter the 6-digit code sent to member@example.test');
    const refused = await toPassword({ adapter: { startEmail: async () => { throw fail('delivery_failed'); } } });
    await button(refused.root, 'Try another way').fire('click');
    await button(refused.root, 'Email me a code').fire('click');
    assert.equal(h1(refused.root).textContent, 'Try another way');
    assert.equal(alertText(refused.root), 'We could not send the code. Try again later.');
});

test('S7 Try another way cancels the code and returns to S3; Cancel returns to S1', async () => {
    for (const [label, heading] of [['Try another way', 'Try another way'], ['Cancel', 'Sign in']]) {
        const calls = [];
        const { root } = await toPassword({ adapter: { cancel: async () => { calls.push('cancel'); return { status: 'cancelled' }; } } });
        await button(root, 'Try another way').fire('click');
        await button(root, 'Email me a code').fire('click');
        const codeInput = root.querySelector('[name="code"]');
        codeInput.value = '123456';
        await button(root, label).fire('click');
        await settle();
        assert.deepEqual(calls, ['cancel']);
        assert.equal(codeInput.value, '');
        assert.equal(h1(root).textContent, heading);
    }
});

test('S8 and S9 return to S3 with Back', async () => {
    const credentials = { get: async () => { throw new Error('NotAllowedError'); } };
    const { root } = await toPassword({ credentials });
    await button(root, 'Try another way').fire('click');
    await button(root, 'Use an authenticator app').fire('click');
    assert.equal(h1(root).textContent, 'Sign in with an authenticator');
    await button(root, 'Back').fire('click');
    assert.equal(h1(root).textContent, 'Try another way');
    await button(root, 'Use a passkey').fire('click');
    await settle();
    assert.match(root.textContent, /Unable to use this passkey\./);
    button(root, 'Try again');
    await button(root, 'Back').fire('click');
    assert.equal(h1(root).textContent, 'Try another way');
});

// ==== S4 / S5 signup ========================================================

test('S5 asks for Password and Confirm password without maxlength and checks mismatch and length after NFKC', async () => {
    const calls = [];
    const { root } = await toSignupPassword({ startSignup: async (args) => { calls.push(args); return { challenge: signupChallenge() }; } });
    assert.equal(h1(root).textContent, 'Create your password');
    assert.equal(root.querySelector('#auth-signup-email').value, 'new@example.test');
    for (const name of ['password', 'passwordConfirmation']) {
        const input = root.querySelector(`[name="${name}"]`);
        assert.deepEqual([input.type, input.autocomplete, input.hasAttribute('maxlength')], ['password', 'new-password', false]);
    }
    assert.doesNotMatch(root.textContent, /Use at least \d+ characters\./, 'no length hint is rendered');
    assertLabels(root);
    await createAccount(root, 'a long enough password', 'a long enough passwore');
    assert.equal(alertText(root), 'The passwords do not match.');
    assert.equal(root.querySelector('[name="passwordConfirmation"]').value, '');
    assert.equal(root.querySelector('[name="passwordConfirmation"]').focused, true);
    for (const [password, copy] of [
        ['fourteen chars', 'Use at least 15 characters.'],
        ['x'.repeat(129), 'Use at most 128 characters.'],
        ['ﷺ'.repeat(8), 'Use at most 128 characters.'],
        ['fifteen characters', 'Remove control characters or unsupported symbols from the password.'],
        ['lone \ud800 surrogate password', 'Remove control characters or unsupported symbols from the password.'],
    ]) {
        await createAccount(root, password);
        assert.equal(alertText(root), copy, JSON.stringify(password).slice(0, 30));
    }
    assert.deepEqual(calls, [], 'client-side refusals send nothing');
    // Supplementary-plane characters count as code points, and normalization applies to both fields.
    const emoji = Array.from({ length: 15 }, (_, index) => String.fromCodePoint(0x1f600 + index)).join('');
    await createAccount(root, emoji);
    assert.equal(calls.length, 1);
    assert.equal(h1(root).textContent, 'Enter the 6-digit code sent to new@example.test');
});

test('S5 disables inputs in flight, empties them on the response and never keeps a password after a pre-staging refusal', async () => {
    let release;
    let stateDuringRequest;
    const adapterRef = {};
    const mounted = await toSignupPassword({ startSignup: (args) => new Promise((resolve, reject) => {
        adapterRef.args = args;
        stateDuringRequest = ['password', 'passwordConfirmation'].map((name) => mounted.root.querySelector(`[name="${name}"]`).disabled);
        release = { resolve, reject };
    }) });
    const { root } = mounted;
    const pending = createAccount(root, 'first chosen long password');
    await settle();
    assert.deepEqual(stateDuringRequest, [true, true]);
    assert.equal(button(root, 'Create account').disabled, true);
    assert.equal(button(root, 'Back').disabled, true);
    await button(root, 'Back').fire('click');
    assert.equal(h1(root).textContent, 'Create your password', 'Back cannot abandon a signup while staging is in flight');
    const passwordInput = root.querySelector('[name="password"]');
    release.reject(fail('rate_limited', { retryAfter: 9 }));
    await pending;
    await settle();
    assert.equal(h1(root).textContent, 'Create your password');
    assert.equal(alertText(root), 'Too many attempts. Wait 9 s and try again.');
    assert.deepEqual([passwordInput.value, root.querySelector('[name="passwordConfirmation"]').value, passwordInput.disabled], ['', '', false]);
    assert.equal(button(root, 'Back').disabled, false);
    assert.deepEqual(adapterRef.args, { email: 'new@example.test', password: 'first chosen long password', passwordConfirmation: 'first chosen long password' });
    for (const [code, heading] of [['account_exists', 'Log in instead?'], ['registration_disabled', 'Sign in']]) {
        const refused = await toSignupPassword({ startSignup: async () => { throw fail(code); } });
        await createAccount(refused.root, 'another chosen long password');
        assert.equal(h1(refused.root).textContent, heading, code);
        if (code === 'registration_disabled') assert.equal(alertText(refused.root), 'Registration is not available.');
        else assert.match(refused.root.textContent, /An account already uses new@example\.test\. Log in instead\./);
    }
    const policy = await toSignupPassword({ startSignup: async () => { throw fail('invalid_password', { reason: 'too_common' }); } });
    await createAccount(policy.root, 'passwordpassword1');
    assert.equal(alertText(policy.root), 'Choose a password that is harder to guess.');
});

// ==== S5 default (unverified) direct signup =================================

function directState() {
    return wizardState({ signup: { email: true, google: false, verification: 'none' } });
}

test('S5 in default mode explains that no verification is needed and Create account signs in directly', async () => {
    const calls = [];
    let completed = null;
    const mounted = await toSignupPassword({
        attempt: async () => directState(),
        createSignup: async (args) => { calls.push(args); return { code: 'handoff-code', redirectUri: 'https://workspace.example/auth/callback', state: 'state-1' }; },
        startSignup: async () => assert.fail('default mode must not stage a verified signup'),
        complete: (result) => { completed = result; },
    });
    assert.match(mounted.root.textContent, /No email verification is needed now\. You can verify your email later from My Account\./);
    await createAccount(mounted.root, 'a long enough password');
    assert.deepEqual(calls, [{ email: 'new@example.test', password: 'a long enough password', passwordConfirmation: 'a long enough password' }]);
    assert.equal(h1(mounted.root).textContent, 'Signing you in…');
    assert.deepEqual(completed, { code: 'handoff-code', redirectUri: 'https://workspace.example/auth/callback', state: 'state-1' });
});

test('S5 default mode uses the OIDC signup-create native completion and never shows the code screen', async () => {
    const completions = [];
    const mounted = await toSignupPassword({
        flow: 'oidc', clientName: 'Explorer', abort: () => {},
        attempt: async () => directState(),
        createSignup: ({ email, password, passwordConfirmation }) => ({ action: 'signup-create', fields: { email, password, passwordConfirmation } }),
        startSignup: async () => assert.fail('default mode must not stage a verified signup'),
        complete: (result) => { completions.push(result); },
    });
    assert.match(mounted.root.textContent, /No email verification is needed now\./);
    await createAccount(mounted.root, 'a long enough password');
    assert.equal(h1(mounted.root).textContent, 'Signing you in…');
    assert.deepEqual(completions, [{ action: 'signup-create', fields: {
        email: 'new@example.test', password: 'a long enough password', passwordConfirmation: 'a long enough password' } }]);
});

test('S5 in required mode keeps the verified code screen and no direct-completion line', async () => {
    const mounted = await toSignupPassword({ attempt: async () => wizardState({ signup: { email: true, google: false, verification: 'required' } }) });
    assert.doesNotMatch(mounted.root.textContent, /No email verification is needed/);
    await createAccount(mounted.root, 'a long enough password');
    assert.equal(h1(mounted.root).textContent, 'Enter the 6-digit code sent to new@example.test');
});

test('a policy change to required verification restores S5 with the copy without keeping the password', async () => {
    let attempts = 0;
    const mounted = await toSignupPassword({
        attempt: async () => (++attempts === 1 ? directState() : wizardState({ signup: { email: true, google: false, verification: 'required' } })),
        createSignup: async () => { throw fail('signup_verification_required'); },
    });
    await createAccount(mounted.root, 'a long enough password');
    assert.equal(h1(mounted.root).textContent, 'Create your password');
    assert.equal(alertText(mounted.root), 'Email verification is now required. Choose your password again to continue.');
    assert.doesNotMatch(mounted.root.textContent, /No email verification is needed/, 'the reloaded configuration shows required mode');
    assert.deepEqual([...mounted.root.querySelectorAll('input[type="password"]')].map((input) => input.value), ['', '']);
});

// ==== S6 verification and delivery states ==================================

test('a lost signup response resumes the staged challenge without another password submission', async () => {
    let reads = 0;
    let starts = 0;
    const { root } = await toSignupPassword({
        attempt: async () => wizardState(++reads === 1 ? {} : { attempt: { status: 'active', signupPending: true,
            locked: false, challenge: signupChallenge() } }),
        startSignup: async () => { starts++; throw new TypeError('Failed to fetch'); },
    });
    await createAccount(root);
    assert.match(h1(root).textContent, /Enter the 6-digit code sent to new@example/);
    assert.equal(root.querySelector('[name="password"]'), null);
    assert.equal(starts, 1);
    assert.equal(reads, 2);
});

test('signup verification and resend cannot overlap, while Cancel still suppresses a delayed resend', async () => {
    let finishVerification;
    let resends = 0;
    let completions = 0;
    const verified = await toSignupPassword({
        startSignup: async () => ({ challenge: signupChallenge({ resendAt: 0 }) }),
        verifySignup: () => new Promise((resolve) => { finishVerification = resolve; }),
        resendSignup: async () => { resends++; return { challenge: signupChallenge() }; },
        complete: () => { completions++; },
    });
    await createAccount(verified.root);
    verified.root.querySelector('[name="code"]').value = '123456';
    await verified.root.querySelector('form.signup-code-panel').fire('submit');
    assert.equal(button(verified.root, 'Resend code').disabled, true);
    assert.equal(button(verified.root, 'Change email').disabled, true);
    assert.equal(button(verified.root, 'Cancel').disabled, false);
    verified.clock.advance(1_000);
    await button(verified.root, 'Resend code').fire('click');
    await button(verified.root, 'Change email').fire('click');
    assert.equal(resends, 0);
    assert.match(h1(verified.root).textContent, /Enter the 6-digit code/);
    finishVerification({ code: 'handoff' });
    await settle();
    assert.equal(completions, 1);

    let finishResend;
    const resending = await toSignupPassword({
        startSignup: async () => ({ challenge: signupChallenge({ resendAt: 0 }) }),
        resendSignup: () => new Promise((resolve) => { finishResend = resolve; }),
        verifySignup: () => assert.fail('verification must wait for the current resend'),
    });
    await createAccount(resending.root);
    await button(resending.root, 'Resend code').fire('click');
    assert.equal(button(resending.root, 'Verify').disabled, true);
    assert.equal(button(resending.root, 'Change email').disabled, true);
    await button(resending.root, 'Cancel').fire('click');
    finishResend({ challenge: signupChallenge() });
    await settle();
    assert.equal(h1(resending.root).textContent, 'Sign in');
});

test('an unavailable signup status check retries only the read and keeps passwords off the page', async () => {
    let reads = 0;
    let starts = 0;
    const { root } = await toSignupPassword({
        attempt: async () => {
            if (++reads === 2) throw new TypeError('Failed to fetch');
            return wizardState(reads === 1 ? {} : { attempt: { status: 'active', signupPending: true,
                locked: false, challenge: signupChallenge() } });
        },
        startSignup: async () => { starts++; throw new TypeError('Failed to fetch'); },
    });
    await createAccount(root);
    assert.equal(h1(root).textContent, 'Check your sign-up status');
    assert.equal(root.querySelectorAll('input').length, 0);
    await button(root, 'Try again').fire('click');
    assert.match(h1(root).textContent, /Enter the 6-digit code/);
    assert.equal(starts, 1);
    assert.equal(reads, 3);
});

test('Back cannot restore the old code screen while an email change is being saved', async () => {
    let release;
    const { root } = await toSignupPassword({ changeSignupEmail: () => new Promise((resolve) => { release = resolve; }) });
    await createAccount(root);
    await button(root, 'Change email').fire('click');
    root.querySelector('[name="email"]').value = 'changed@example.test';
    await root.querySelector('form.signup-email-panel').fire('submit');
    assert.equal(root.querySelector('[name="email"]').disabled, true);
    assert.equal(button(root, 'Back').disabled, true);
    await button(root, 'Back').fire('click');
    assert.equal(h1(root).textContent, 'Change your email');
    release({ challenge: signupChallenge({ email: 'changed@example.test' }) });
    await settle();
    assert.match(h1(root).textContent, /Enter the 6-digit code sent to changed@example/);
});

test('a lost change-email response recovers the server address and a refused email change is correctable', async () => {
    let reads = 0;
    const { root } = await toSignupPassword({
        attempt: async () => wizardState(++reads === 1 ? {} : { attempt: { status: 'active', signupPending: true,
            locked: false, challenge: signupChallenge({ email: 'changed@example.test' }) } }),
        changeSignupEmail: async () => { throw new TypeError('Failed to fetch'); },
    });
    await createAccount(root);
    await button(root, 'Change email').fire('click');
    root.querySelector('[name="email"]').value = 'changed@example.test';
    await root.querySelector('form.signup-email-panel').fire('submit');
    assert.match(h1(root).textContent, /Enter the 6-digit code sent to changed@example/);
    assert.equal(root.querySelector('[name="password"]'), null);

    const refused = await toSignupPassword({ changeSignupEmail: async () => { throw fail('invalid_password', { reason: 'weak' }); } });
    await createAccount(refused.root);
    await button(refused.root, 'Change email').fire('click');
    refused.root.querySelector('[name="email"]').value = 'chosen-password@example.test';
    await refused.root.querySelector('form.signup-email-panel').fire('submit');
    assert.equal(h1(refused.root).textContent, 'Change your email');
    assert.match(alertText(refused.root), /Choose a password that is harder to guess\./);
    assert.equal(button(refused.root, 'Back').disabled, false);
    assert.equal(refused.root.querySelector('[name="email"]').disabled, false);
});

test('S6 renders the five delivery states and states that the account is created only after verification', async () => {
    const copy = {
        accepted: 'We sent a code to new@example.test.',
        unknown: 'We tried to send a code to new@example.test. If it does not arrive, request a new one.',
        'development-log': 'Development mode: the code was written to the server log.',
    };
    for (const delivery of ['accepted', 'unknown', 'development-log', 'failed', 'pending']) {
        const { root } = await toSignupPassword({ startSignup: async () => ({ challenge: signupChallenge({ delivery, resendAt: delivery === 'failed' || delivery === 'pending' ? Date.now() : Date.now() + 60_000 }) }) });
        await createAccount(root);
        const failed = delivery === 'failed' || delivery === 'pending';
        const code = root.querySelector('[name="code"]');
        if (failed) {
            assert.equal(h1(root).textContent, 'We could not send the code', delivery);
            assert.match(root.textContent, /The password you chose is kept for this sign-up\./);
            assert.deepEqual([code.disabled, button(root, 'Verify').disabled, button(root, 'Send again').disabled], [true, true, false]);
        } else {
            assert.equal(h1(root).textContent, 'Enter the 6-digit code sent to new@example.test', delivery);
            assert.match(root.textContent, new RegExp(copy[delivery].replace(/[.]/g, '\\.')));
            assert.match(root.textContent, /Your account is created only after you enter this code\./);
            assert.deepEqual([code.inputmode, code.autocomplete, code.maxlength, code.disabled], ['numeric', 'one-time-code', '6', false]);
            assert.match(root.querySelectorAll('button').find((node) => node.textContent.startsWith('Resend code')).textContent, /^Resend code in \d+ s$/);
        }
        assert.deepEqual(['Change email', 'Cancel'].map((label) => hasButton(root, label)), [true, true]);
        assertLabels(root);
    }
});

test('Send again and Resend code never ask for the password and follow the cooldown', async () => {
    const clock = fakeClock();
    const calls = [];
    let next = signupChallenge({ delivery: 'accepted', resendAt: clock.now() + 60_000 });
    const { root } = await toSignupPassword({
        attempt: async () => wizardState({ expiresAt: clock.now() + 5 * 60_000 }),
        startSignup: async () => ({ challenge: signupChallenge({ delivery: 'failed', resendAt: clock.now() }) }),
        resendSignup: async (...args) => { calls.push(args); return { challenge: next }; },
    }, { clock });
    await createAccount(root);
    await button(root, 'Send again').fire('click');
    assert.deepEqual(calls, [[]], 'resend carries no password or confirmation');
    const resend = root.querySelectorAll('button').find((node) => node.textContent.startsWith('Resend code'));
    assert.equal(resend.disabled, true);
    clock.advance(61_000);
    assert.deepEqual([resend.disabled, resend.textContent], [false, 'Resend code']);
    next = signupChallenge({ delivery: 'unknown', resendAt: clock.now() + 60_000 });
    await resend.fire('click');
    assert.equal(calls.length, 2);
    assert.match(root.textContent, /We tried to send a code/);
    assert.equal(root.querySelectorAll('input[type="password"]').length, 0);
});

test('S6 verification completes, reports attempts, locks after too many and handles late collisions and closed registration', async () => {
    let completed;
    const ok = await toSignupPassword({ verifySignup: async (code) => ({ code: `handoff-${code}` }), complete: (result) => { completed = result; } });
    await createAccount(ok.root);
    ok.root.querySelector('[name="code"]').value = '123456';
    await ok.root.querySelector('form.signup-code-panel').fire('submit');
    assert.equal(h1(ok.root).textContent, 'Signing you in…');
    assert.deepEqual(completed, { code: 'handoff-123456' });

    const wrong = await toSignupPassword({ verifySignup: async () => { throw fail('code_invalid', { attemptsRemaining: 3 }); } });
    await createAccount(wrong.root);
    wrong.root.querySelector('[name="code"]').value = '000000';
    await wrong.root.querySelector('form.signup-code-panel').fire('submit');
    assert.equal(alertText(wrong.root), 'That code is not correct. 3 attempts left.');
    assert.equal(wrong.root.querySelector('[name="code"]').value, '');

    const cancels = [];
    const lockedFlow = await toSignupPassword({ verifySignup: async () => { throw fail('too_many_attempts'); }, cancel: async () => { cancels.push('cancel'); return { status: 'cancelled' }; } });
    await createAccount(lockedFlow.root);
    lockedFlow.root.querySelector('[name="code"]').value = '000000';
    await lockedFlow.root.querySelector('form.signup-code-panel').fire('submit');
    assert.equal(alertText(lockedFlow.root), 'Too many incorrect codes. Start over.');
    assert.equal(button(lockedFlow.root, 'Verify').disabled, true);
    await button(lockedFlow.root, 'Start over').fire('click');
    await settle();
    assert.deepEqual([h1(lockedFlow.root).textContent, cancels], ['Sign in', ['cancel']]);

    const collided = await toSignupPassword({ verifySignup: async () => { throw fail('account_exists'); } });
    await createAccount(collided.root);
    collided.root.querySelector('[name="code"]').value = '123456';
    await collided.root.querySelector('form.signup-code-panel').fire('submit');
    await settle();
    assert.equal(h1(collided.root).textContent, 'Log in instead?');

    const closed = await toSignupPassword({ verifySignup: async () => { throw fail('registration_disabled'); } });
    await createAccount(closed.root);
    closed.root.querySelector('[name="code"]').value = '123456';
    await closed.root.querySelector('form.signup-code-panel').fire('submit');
    await settle();
    assert.deepEqual([h1(closed.root).textContent, alertText(closed.root)], ['Sign in', 'Registration is not available.']);

    const restart = await toSignupPassword({ verifySignup: async () => { throw fail('signup_restart_required'); } });
    await createAccount(restart.root);
    restart.root.querySelector('[name="code"]').value = '123456';
    await restart.root.querySelector('form.signup-code-panel').fire('submit');
    assert.deepEqual([h1(restart.root).textContent, alertText(restart.root)], ['Create your password', 'Choose your password again to continue.']);
    assert.equal(restart.root.querySelector('#auth-signup-email').value, 'new@example.test');
});

test('Change email keeps the password, sends to the new address and handles collisions and restarts', async () => {
    const calls = [];
    const { root } = await toSignupPassword({ changeSignupEmail: async (email, ...rest) => { calls.push([email, ...rest]); return { challenge: signupChallenge({ email }) }; } });
    await createAccount(root);
    await button(root, 'Change email').fire('click');
    assert.equal(h1(root).textContent, 'Change your email');
    assert.equal(root.querySelector('[name="email"]').value, 'new@example.test');
    assert.match(root.textContent, /The password you chose is kept\./);
    assert.equal(root.querySelectorAll('input[type="password"]').length, 0);
    await button(root, 'Back').fire('click');
    assert.equal(h1(root).textContent, 'Enter the 6-digit code sent to new@example.test');
    await button(root, 'Change email').fire('click');
    root.querySelector('[name="email"]').value = 'broken';
    await root.querySelector('form.signup-email-panel').fire('submit');
    assert.equal(alertText(root), 'Enter a valid email address.');
    root.querySelector('[name="email"]').value = 'fixed@example.test';
    await root.querySelector('form.signup-email-panel').fire('submit');
    assert.deepEqual(calls, [['fixed@example.test']]);
    assert.equal(h1(root).textContent, 'Enter the 6-digit code sent to fixed@example.test');

    for (const [code, heading] of [['account_exists', 'Log in instead?'], ['signup_restart_required', 'Create your password']]) {
        const flow = await toSignupPassword({ changeSignupEmail: async () => { throw fail(code); } });
        await createAccount(flow.root);
        await button(flow.root, 'Change email').fire('click');
        flow.root.querySelector('[name="email"]').value = 'taken@example.test';
        await flow.root.querySelector('form.signup-email-panel').fire('submit');
        await settle();
        assert.equal(h1(flow.root).textContent, heading, code);
        if (code === 'account_exists') assert.match(flow.root.textContent, /An account already uses taken@example\.test\./);
        else assert.equal(flow.root.querySelector('#auth-signup-email').value, 'taken@example.test', 'the new address is kept');
    }
});

test('Cancel on S6 cancels the staged signup and empties the code before returning to S1', async () => {
    const calls = [];
    const { root } = await toSignupPassword({ cancel: async () => { calls.push('cancel'); return { status: 'cancelled' }; } });
    await createAccount(root);
    const codeInput = root.querySelector('[name="code"]');
    codeInput.value = '111111';
    await button(root, 'Cancel').fire('click');
    await settle();
    assert.deepEqual(calls, ['cancel']);
    assert.equal(codeInput.value, '');
    assert.equal(h1(root).textContent, 'Sign in');
});

test('the send limit asks SSO users to start again and OIDC users to restart from the application', async () => {
    for (const flow of ['sso', 'oidc']) {
        let restarted = 0;
        const { root } = await toSignupPassword({ flow, clientName: 'Explorer', restart: () => { restarted += 1; },
            startSignup: async () => ({ challenge: signupChallenge({ delivery: 'failed', resendAt: Date.now() - 1 }) }),
            resendSignup: async () => { throw fail('rate_limited', { reason: 'send_limit' }); } });
        await createAccount(root);
        await button(root, 'Send again').fire('click');
        await button(root, 'Send again').fire('click');
        if (flow === 'sso') {
            assert.equal(alertText(root), 'Too many codes were requested. Start again.');
            assert.equal(root.querySelectorAll('button').filter((node) => node.textContent === 'Start again').length, 1);
            await button(root, 'Start again').fire('click');
            assert.equal(restarted, 1);
        } else {
            assert.equal(alertText(root), 'Too many codes were requested. Close this window and start again from Explorer.');
            assert.equal(hasButton(root, 'Start again'), false);
        }
    }
});

// ==== S12 collision ======================================================

test('S12 Log in rediscovers and opens S2', async () => {
    const calls = [];
    const { root } = await toSignupPassword({ startSignup: async () => { throw fail('account_exists'); },
        discover: async (email) => { calls.push(email); return calls.length === 1 ? UNKNOWN : REGISTERED; } });
    await createAccount(root);
    assert.equal(h1(root).textContent, 'Log in instead?');
    await root.querySelector('form.collision-panel').fire('submit');
    assert.deepEqual(calls, ['new@example.test', 'new@example.test']);
    assert.equal(h1(root).textContent, 'Enter your password');
});

// ==== reload, storage, stale responses, expiry ================================

test('reload resumes a staged signup on S6 without the password and an expired code offers Resend code', async () => {
    const live = await mount({ adapter: baseAdapter({ attempt: async () => wizardState({ attempt: { status: 'active', locked: false, signupPending: true,
        challenge: signupChallenge({ email: 'resumed@example.test' }) } }) }) });
    assert.equal(h1(live.root).textContent, 'Enter the 6-digit code sent to resumed@example.test');
    assert.equal(live.root.querySelectorAll('input[type="password"]').length, 0);
    const interrupted = await mount({ adapter: baseAdapter({ attempt: async () => wizardState({ attempt: { status: 'active', locked: false, signupPending: true,
        challenge: signupChallenge({ delivery: 'pending', resendAt: Date.now() }) } }) }) });
    assert.equal(h1(interrupted.root).textContent, 'We could not send the code');
    const clock = fakeClock();
    const expired = await mount({ clock, adapter: baseAdapter({ attempt: async () => wizardState({ expiresAt: clock.now() + 60_000, attempt: { status: 'active', locked: false, signupPending: true,
        challenge: signupChallenge({ expired: true, expiresAt: clock.now() - 1_000, resendAt: clock.now() - 240_000 }) } }) }) });
    assert.equal(alertText(expired.root), 'That code expired. Request a new code.');
    const resend = expired.root.querySelectorAll('button').find((node) => node.textContent.startsWith('Resend code'));
    assert.equal(resend.disabled, false);
    const login = await mount({ adapter: baseAdapter({ attempt: async () => wizardState({ attempt: { status: 'active', locked: false, signupPending: false, challenge: challengeFor({ email: 'code@example.test' }) } }) }) });
    assert.equal(h1(login.root).textContent, 'Enter the 6-digit code sent to code@example.test');
});

test('storage holds only the email, and a reload during S2 or S5 returns to S1 with that email', async () => {
    const storage = fakeStorage();
    const { root } = await toSignupPassword({}, { storage });
    root.querySelector('[name="password"]').value = 'typed but not submitted';
    assert.deepEqual(JSON.parse(storage.getItem('wizard-test')), { email: 'new@example.test' });
    assert.equal([...storage.data.values()].join('').includes('typed but not submitted'), false);
    const reloaded = await mount({ adapter: baseAdapter(), storage });
    assert.equal(h1(reloaded.root).textContent, 'Sign in');
    assert.equal(reloaded.root.querySelector('[name="email"]').value, 'new@example.test');
});

test('late responses after a transition never change the view', async () => {
    let releaseDiscover;
    const discovering = await mount({ adapter: baseAdapter({ discover: () => new Promise((resolve) => { releaseDiscover = resolve; }), abort: () => {}, flow: 'oidc' }) });
    discovering.root.querySelector('[name="email"]').value = 'member@example.test';
    const pendingDiscovery = discovering.root.querySelector('form.start-panel').fire('submit');
    await settle();
    discovering.instance.dispose();
    releaseDiscover(REGISTERED);
    await pendingDiscovery;
    assert.equal(h1(discovering.root).textContent, 'Sign in', 'a disposed wizard ignores discovery');

    const clock = fakeClock();
    let releaseLogin;
    let completions = 0;
    const loginFlow = await toPassword({ clock, adapter: { attempt: async () => wizardState({ expiresAt: clock.now() + 10_000 }),
        passwordLogin: () => new Promise((resolve) => { releaseLogin = resolve; }), complete: () => { completions += 1; } } });
    loginFlow.root.querySelector('[name="password"]').value = 'a late password response';
    const pendingLogin = loginFlow.root.querySelector('form.password-panel').fire('submit');
    await settle();
    clock.advance(11_000);
    releaseLogin({ code: 'late' });
    await pendingLogin;
    assert.equal(h1(loginFlow.root).textContent, 'This sign-in request expired');
    assert.equal(completions, 0);

    let releaseVerify;
    const signupFlow = await toSignupPassword({ verifySignup: () => new Promise((resolve) => { releaseVerify = resolve; }) });
    await createAccount(signupFlow.root);
    signupFlow.root.querySelector('[name="code"]').value = '123456';
    const pendingVerify = signupFlow.root.querySelector('form.signup-code-panel').fire('submit');
    await settle();
    await button(signupFlow.root, 'Cancel').fire('click');
    releaseVerify({ code: 'late' });
    await pendingVerify;
    await settle();
    assert.equal(h1(signupFlow.root).textContent, 'Sign in');
    assert.doesNotMatch(signupFlow.root.textContent, /Signing you in/);
});

test('the countdown reaches S13, SSO offers Start again and OIDC Close window', async () => {
    for (const flow of ['sso', 'oidc']) {
        const clock = fakeClock();
        let restarted = 0;
        const { root } = await toSignupPassword({ flow, clientName: 'Explorer', attempt: async () => wizardState({ expiresAt: clock.now() + 3_000 }), restart: () => { restarted += 1; } }, { clock });
        assert.match(root.querySelector('.auth-timer')?.textContent || '', /^Expires in 0:03$/);
        root.querySelector('[name="password"]').value = 'secret being typed';
        clock.advance(4_000);
        assert.equal(h1(root).textContent, 'This sign-in request expired');
        assert.equal(root.querySelector('.auth-timer'), null);
        await button(root, flow === 'sso' ? 'Start again' : 'Close window').fire('click');
        assert.equal(restarted, 1);
    }
});

test('every screen has one focused h1, labelled inputs and alerts with role=alert', async () => {
    const { root } = await toSignupPassword();
    for (const step of ['signupPassword', 'signupCode', 'signupEmail']) {
        assert.equal(root.querySelectorAll('h1').length, 1, step);
        assert.equal(h1(root).focused, true, step);
        assertLabels(root);
        if (step === 'signupPassword') await createAccount(root);
        if (step === 'signupCode') await button(root, 'Change email').fire('click');
    }
    const password = await toPassword({ adapter: { passwordLogin: async () => { throw fail('authentication_failed'); } } });
    password.root.querySelector('[name="password"]').value = 'wrong password';
    await password.root.querySelector('form.password-panel').fire('submit');
    assert.ok(password.root.querySelectorAll('[role="alert"]').some((node) => node.textContent.startsWith('That password is not correct')));
});

// ==== OIDC re-rendered failures ==============================================

test('OIDC failures reopen S2 for password-login and S6 for signup-verify with empty secret inputs', async () => {
    const password = await mount({ adapter: baseAdapter({ flow: 'oidc', initialEmail: 'member@example.test',
        initialFailure: { action: 'password-login', code: 'authentication_failed', message: 'nope' } }) });
    assert.equal(h1(password.root).textContent, 'Enter your password');
    assert.equal(password.root.querySelector('[name="password"]').value, '');
    assert.equal(alertText(password.root), 'That password is not correct. Try again or choose another way to sign in.');

    const signupFailure = await mount({ adapter: baseAdapter({ flow: 'oidc', initialEmail: 'new@example.test',
        initialFailure: { action: 'signup-verify', code: 'code_invalid', attemptsRemaining: 2, message: 'nope' },
        attempt: async () => wizardState({ attempt: { status: 'active', locked: false, signupPending: true, challenge: signupChallenge() } }) }) });
    assert.equal(h1(signupFailure.root).textContent, 'Enter the 6-digit code sent to new@example.test');
    assert.equal(signupFailure.root.querySelector('[name="code"]').value, '');
    assert.equal(alertText(signupFailure.root), 'That code is not correct. 2 attempts left.');

    const restart = await mount({ adapter: baseAdapter({ flow: 'oidc', initialEmail: 'new@example.test', initialFailure: { action: 'signup-verify', code: 'signup_restart_required' } }) });
    assert.equal(h1(restart.root).textContent, 'Create your password');
    const collision = await mount({ adapter: baseAdapter({ flow: 'oidc', initialEmail: 'late@example.test', initialFailure: { action: 'signup-verify', code: 'account_exists' } }) });
    assert.match(collision.root.textContent, /An account already uses late@example\.test\. Log in instead\./);
    const totp = await mount({ adapter: baseAdapter({ flow: 'oidc', initialEmail: 'member@example.test', initialFailure: { action: 'totp', code: 'authentication_failed' } }) });
    assert.equal(h1(totp.root).textContent, 'Sign in with an authenticator');
    assert.equal(alertText(totp.root), 'Unable to sign in. Check your details and try again.');
    await button(totp.root, 'Back').fire('click');
    assert.equal(h1(totp.root).textContent, 'Try another way');
});

test('an OIDC signup-create failure re-renders S5 with the attempted email and empty passwords', async () => {
    const mounted = await mount({ adapter: baseAdapter({ flow: 'oidc', initialEmail: 'stuck@example.test',
        initialFailure: { action: 'signup-create', code: 'password_mismatch', message: 'The passwords do not match.' },
        attempt: async () => directState() }) });
    assert.equal(h1(mounted.root).textContent, 'Create your password');
    assert.equal(mounted.root.querySelector('#auth-signup-email').value, 'stuck@example.test');
    assert.equal(alertText(mounted.root), 'The passwords do not match.');
    assert.deepEqual([...mounted.root.querySelectorAll('input[type="password"]')].map((input) => input.value), ['', '']);
    assertLabels(mounted.root);
});

test('a Google notice is a non-error status and the wizard stays usable', async () => {
    const { root } = await mount({ adapter: baseAdapter({ notice: 'google-denied', attempt: async () => wizardState({ methods: { ...ALL_METHODS, google: true } }) }) });
    const notice = root.querySelectorAll('.status').find((node) => node.textContent === 'Google did not complete sign-in.');
    assert.ok(notice);
    assert.notEqual(notice.getAttribute('role'), 'alert');
    button(root, 'Next');
});

// ============================================================================
// SSO adapter: request shapes, headers, completion URL building, replay
// ============================================================================

function ssoFixture({ search = '?requestId=req-1&state=state-1&returnTo=%2Fprivate', post } = {}) {
    const origin = 'https://workspace.example:9443';
    const location = { search, href: `${origin}/prefix/service/auth/${search}`, origin };
    const navigated = [];
    const calls = [];
    const fetchImpl = async (url, options) => {
        const call = { url, options, body: JSON.parse(options.body || '{}') };
        calls.push(call);
        const result = post ? await post(call) : { ok: true, code: 'one-use-code', redirectUri: `${origin}/auth/callback`, state: 'state-1' };
        return { ok: result.ok !== false, status: result.ok === false ? (result.status || 400) : 200, json: async () => result };
    };
    const adapter = createSsoAdapter({ location, fetch: fetchImpl, navigate: (url) => navigated.push(url) });
    return { adapter, calls, navigated, origin };
}

test('SSO adapter posts JSON with same-origin credentials to paths under the current service prefix', async () => {
    const { adapter, calls } = ssoFixture({ post: () => ({ ok: true, ...REGISTERED }) });
    await adapter.discover('member@example.test');
    assert.equal(calls[0].url, 'https://workspace.example:9443/prefix/service/auth/discover');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.deepEqual(calls[0].body, { requestId: 'req-1', email: 'member@example.test' });
});

test('SSO adapter request bodies match the documented shape for every operation', async () => {
    const { adapter, calls } = ssoFixture({ post: ({ url }) => (url.endsWith('/passkey/options')
        ? { ok: true, challengeKey: 'k', publicKey: { challenge: 'AQID', allowCredentials: [] } }
        : { ok: true, code: 'c', redirectUri: 'https://workspace.example:9443/auth/callback', state: 'state-1', challenge: signupChallenge() }) });
    await adapter.cancel();
    await adapter.passwordLogin({ email: 'a@example.test', password: 'a password value' });
    await adapter.forgotPassword({ email: 'a@example.test' });
    await adapter.startSignup({ email: 'a@example.test', password: 'a password value', passwordConfirmation: 'a password value' });
    await adapter.createSignup({ email: 'a@example.test', password: 'a password value', passwordConfirmation: 'a password value' });
    await adapter.resendSignup();
    await adapter.changeSignupEmail('b@example.test');
    await adapter.verifySignup('246810');
    await adapter.startEmail({ email: 'a@example.test', purpose: 'login', resend: false });
    await adapter.startEmail({ email: 'a@example.test', purpose: 'login', resend: true });
    await adapter.verifyEmail('123456');
    await adapter.passkeyOptions('a@example.test');
    await adapter.verifyTotp({ email: 'a@example.test', token: '654321' });
    const byPath = (path) => calls.filter((call) => new URL(call.url).pathname === `/prefix/service/auth/${path}`).map((call) => call.body);
    assert.deepEqual(byPath('attempt/cancel'), [{ requestId: 'req-1' }]);
    assert.deepEqual(byPath('password/login'), [{ requestId: 'req-1', state: 'state-1', email: 'a@example.test', password: 'a password value' }]);
    assert.deepEqual(byPath('password/forgot'), [{ requestId: 'req-1', email: 'a@example.test' }]);
    assert.deepEqual(byPath('signup/start'), [{ requestId: 'req-1', email: 'a@example.test', password: 'a password value', passwordConfirmation: 'a password value' }]);
    assert.deepEqual(byPath('signup/create'), [{ requestId: 'req-1', state: 'state-1', email: 'a@example.test', password: 'a password value', passwordConfirmation: 'a password value' }]);
    assert.deepEqual(byPath('signup/resend'), [{ requestId: 'req-1' }]);
    assert.deepEqual(byPath('signup/email'), [{ requestId: 'req-1', email: 'b@example.test' }]);
    assert.deepEqual(byPath('signup/verify'), [{ requestId: 'req-1', state: 'state-1', code: '246810' }]);
    assert.deepEqual(byPath('email-code/start'), [
        { requestId: 'req-1', email: 'a@example.test', purpose: 'login' },
        { requestId: 'req-1', email: 'a@example.test', purpose: 'login', resend: true },
    ]);
    assert.deepEqual(byPath('email-code/verify'), [{ requestId: 'req-1', state: 'state-1', code: '123456' }]);
    assert.deepEqual(byPath('passkey/options'), [{ requestId: 'req-1', email: 'a@example.test' }]);
    assert.deepEqual(byPath('totp/verify'), [{ requestId: 'req-1', state: 'state-1', email: 'a@example.test', token: '654321' }]);
    assert.equal(calls.some((call) => /admin/.test(call.url)), false);
    assert.equal(typeof adapter.adminLogin, 'undefined');
});

test('SSO adapter builds the completion URL, replays the same way and restarts at the Router login', async () => {
    const live = ssoFixture({ post: () => ({ ok: true, code: 'the-code', redirectUri: 'https://workspace.example:9443/auth/callback?x=1', state: 'state-1' }) });
    const result = await live.adapter.verifySignup('123456');
    assert.deepEqual(live.navigated, [], 'verifying only prepares the completion');
    live.adapter.complete(result);
    const url = new URL(live.navigated[0]);
    assert.deepEqual([url.origin, url.pathname, url.searchParams.get('state'), url.searchParams.get('code')], ['https://workspace.example:9443', '/auth/callback', 'state-1', 'the-code']);
    const replay = ssoFixture({ post: () => ({ ok: true, completed: true, handoff: { code: 'replayed-code', redirectUri: 'https://workspace.example:9443/auth/callback', state: 'state-1', replayed: true } }) });
    const attempt = await replay.adapter.attempt();
    replay.adapter.complete(attempt.handoff);
    assert.equal(new URL(replay.navigated[0]).searchParams.get('code'), 'replayed-code');
    const restart = ssoFixture({ search: '?requestId=req-1&state=state-1&returnTo=%2Fprivate%3Fx%3D1' });
    restart.adapter.restart();
    assert.equal(restart.navigated[0], '/auth/login?returnTo=%2Fprivate%3Fx%3D1&prompt=login');
});

test('SSO adapter errors carry code, status, retryAfter, attemptsRemaining and reason', async () => {
    const { adapter } = ssoFixture({ post: () => ({ ok: false, error: 'invalid_password', reason: 'too_short', retryAfter: 3, attemptsRemaining: 2 }) });
    await assert.rejects(adapter.startSignup({ email: 'a@example.test', password: 'x', passwordConfirmation: 'x' }), (error) => {
        assert.deepEqual([error.code, error.status, error.reason, error.retryAfter, error.attemptsRemaining], ['invalid_password', 400, 'too_short', 3, 2]);
        return true;
    });
});

// ============================================================================
// OIDC adapter: JSON actions vs. native form completions, abort
// ============================================================================

function oidcFixture({ config, post } = {}) {
    const { document, body } = createDocument();
    const navigated = [];
    let closed = 0;
    const calls = [];
    const fetchImpl = async (url, options) => {
        const call = { url, options, body: Object.fromEntries(new URLSearchParams(options.body)) };
        calls.push(call);
        const result = post ? await post(call) : { ok: true };
        return { ok: result.ok !== false, status: result.ok === false ? 400 : 200, json: async () => result };
    };
    const adapter = createOidcAdapter({
        config: { flow: 'oidc', base: 'https://issuer.example/service/oidc/interaction/abc123', csrf: 'csrf-token', client: { name: 'Explorer' }, screenHint: '', expiresAt: Date.now() + 60_000, notice: '', failure: null, email: '', ...config },
        document, fetch: fetchImpl, navigate: (url) => navigated.push(url), closeWindow: () => { closed += 1; },
    });
    return { adapter, calls, navigated, body, closedCount: () => closed };
}

const formFields = (form) => Object.fromEntries(form.children.map((input) => [input.getAttribute('name'), input.getAttribute('value')]));

test('OIDC adapter JSON actions post form-urlencoded bodies with the csrf token and never a retry password', async () => {
    const { adapter, calls } = oidcFixture({ post: () => ({ ok: true, ...UNKNOWN, challenge: signupChallenge() }) });
    await adapter.attempt();
    await adapter.cancel();
    await adapter.discover('a@example.test');
    await adapter.forgotPassword({ email: 'a@example.test' });
    await adapter.startSignup({ email: 'a@example.test', password: 'a password value', passwordConfirmation: 'a password value' });
    await adapter.resendSignup();
    await adapter.changeSignupEmail('b@example.test');
    await adapter.startEmail({ email: 'a@example.test', purpose: 'login', resend: true });
    await adapter.passkeyOptions('a@example.test');
    const byAction = (action) => calls.filter((call) => new URL(call.url).pathname.endsWith(`/${action}`)).map((call) => call.body);
    assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.deepEqual(byAction('attempt'), [{ csrf: 'csrf-token' }]);
    assert.deepEqual(byAction('attempt-cancel'), [{ csrf: 'csrf-token' }]);
    assert.deepEqual(byAction('discover'), [{ csrf: 'csrf-token', email: 'a@example.test' }]);
    assert.deepEqual(byAction('password-forgot'), [{ csrf: 'csrf-token', email: 'a@example.test' }]);
    assert.deepEqual(byAction('signup-start'), [{ csrf: 'csrf-token', email: 'a@example.test', password: 'a password value', passwordConfirmation: 'a password value' }]);
    assert.deepEqual(byAction('signup-resend'), [{ csrf: 'csrf-token' }]);
    assert.deepEqual(byAction('signup-email'), [{ csrf: 'csrf-token', email: 'b@example.test' }]);
    assert.deepEqual(byAction('email-start'), [{ csrf: 'csrf-token', email: 'a@example.test', purpose: 'login', resend: 'true' }]);
    assert.deepEqual(byAction('passkey-options'), [{ csrf: 'csrf-token', email: 'a@example.test' }]);
});

test('OIDC adapter native completions build real forms with the exact action and fields and never fetch', async () => {
    const { adapter, calls, body } = oidcFixture();
    const completion = adapter.passwordLogin({ email: 'a@example.test', password: 'a password value' });
    assert.equal(body.children.length, 0, 'preparing the completion must not submit the form');
    adapter.complete(completion);
    let form = body.children.at(-1);
    assert.deepEqual([form.tagName, form.getAttribute('method'), form.getAttribute('action'), form.submitted],
        ['FORM', 'post', 'https://issuer.example/service/oidc/interaction/abc123/password-login', true]);
    assert.deepEqual(formFields(form), { csrf: 'csrf-token', email: 'a@example.test', password: 'a password value' });
    adapter.complete(adapter.createSignup({ email: 'a@example.test', password: 'a password value', passwordConfirmation: 'a password value' }));
    form = body.children.at(-1);
    assert.equal(form.getAttribute('action'), 'https://issuer.example/service/oidc/interaction/abc123/signup-create');
    assert.deepEqual(formFields(form), { csrf: 'csrf-token', email: 'a@example.test', password: 'a password value', passwordConfirmation: 'a password value' });
    adapter.complete(adapter.verifySignup('246810'));
    form = body.children.at(-1);
    assert.equal(form.getAttribute('action'), 'https://issuer.example/service/oidc/interaction/abc123/signup-verify');
    assert.deepEqual(formFields(form), { csrf: 'csrf-token', code: '246810' });
    adapter.complete(adapter.verifyEmail('123456'));
    assert.deepEqual(formFields(body.children.at(-1)), { csrf: 'csrf-token', code: '123456' });
    adapter.complete(adapter.verifyTotp({ email: 'a@example.test', token: '654321' }));
    assert.deepEqual(formFields(body.children.at(-1)), { csrf: 'csrf-token', email: 'a@example.test', token: '654321' });
    const credential = { id: 'cred-1', rawId: Uint8Array.of(1).buffer, type: 'public-key', response: {
        clientDataJSON: Uint8Array.of(1).buffer, authenticatorData: Uint8Array.of(2).buffer, signature: Uint8Array.of(3).buffer, userHandle: null } };
    adapter.complete(adapter.verifyPasskey({ assertion: credential }));
    form = body.children.at(-1);
    assert.equal(form.getAttribute('action'), 'https://issuer.example/service/oidc/interaction/abc123/passkey-verify');
    assert.equal(JSON.parse(formFields(form).assertion).id, 'cred-1');
    assert.equal(calls.length, 0, 'a native completion never fetches');
    assert.equal(typeof adapter.adminLogin, 'undefined');
    adapter.abort();
    assert.deepEqual([body.children.at(-1).getAttribute('action'), formFields(body.children.at(-1))], ['https://issuer.example/service/oidc/interaction/abc123/abort', { csrf: 'csrf-token' }]);
});

test('OIDC adapter exposes initial failure state, restarts by closing and defers Google navigation', async () => {
    const withFailure = oidcFixture({ config: { failure: { code: 'code_invalid', message: 'nope', action: 'signup-verify' }, email: 'stuck@example.test' } }).adapter;
    assert.deepEqual([withFailure.initialFailure.action, withFailure.initialEmail], ['signup-verify', 'stuck@example.test']);
    const clean = oidcFixture();
    assert.deepEqual([clean.adapter.initialFailure, clean.adapter.initialEmail], [null, '']);
    clean.adapter.restart();
    assert.equal(clean.closedCount(), 1);
    const google = oidcFixture({ post: () => ({ ok: true, authorizationUrl: 'https://accounts.google.com/authorize?x=1' }) });
    const result = await google.adapter.startGoogle();
    assert.deepEqual(google.navigated, []);
    google.adapter.continueGoogle(result);
    assert.deepEqual([google.calls[0].url, google.navigated], ['https://issuer.example/service/oidc/interaction/abc123/google', ['https://accounts.google.com/authorize?x=1']]);
});

// ==== real adapters with the wizard ==========================================

test('the real SSO adapter never navigates a delayed successful credential response after Cancel, Back or expiry', async (t) => {
    for (const method of ['password', 'signup', 'email', 'totp', 'passkey']) {
        await t.test(method, async () => {
            const clock = fakeClock();
            let releaseVerify;
            let releaseCancel;
            const handoff = { ok: true, code: 'abandoned-code', redirectUri: 'https://workspace.example:9443/auth/callback' };
            const fixture = ssoFixture({ post: ({ url }) => {
                if (url.endsWith('/attempt')) return wizardState({ expiresAt: clock.now() + 10_000 });
                if (url.endsWith('/discover')) return method === 'signup' ? { ok: true, ...UNKNOWN } : { ok: true, ...REGISTERED };
                if (url.endsWith('/signup/start')) return { ok: true, challenge: signupChallenge() };
                if (url.endsWith('/email-code/start')) return { ok: true, challenge: challengeFor() };
                if (url.endsWith('/passkey/options')) return { ok: true, challengeKey: 'key', publicKey: { challenge: 'AQID', allowCredentials: [] } };
                if (url.endsWith('/attempt/cancel')) return new Promise((resolve) => { releaseCancel = resolve; });
                return new Promise((resolve) => { releaseVerify = resolve; });
            } });
            const credentials = { get: async () => ({ id: 'key', type: 'public-key', rawId: Uint8Array.of(1).buffer, response: {
                clientDataJSON: Uint8Array.of(1).buffer, authenticatorData: Uint8Array.of(2).buffer, signature: Uint8Array.of(3).buffer } }) };
            const { root } = await mount({ adapter: fixture.adapter, clock, credentials });
            await submitEmail(root, method === 'signup' ? 'new@example.test' : 'member@example.test');
            if (method === 'password') {
                root.querySelector('[name="password"]').value = 'a delayed password';
                await root.querySelector('form.password-panel').fire('submit');
            } else if (method === 'signup') {
                await root.querySelector('form.signup-offer-panel').fire('submit');
                await createAccount(root, 'a long enough password');
                root.querySelector('[name="code"]').value = '123456';
                await root.querySelector('form.signup-code-panel').fire('submit');
            } else {
                await button(root, 'Try another way').fire('click');
                if (method === 'email') {
                    await button(root, 'Email me a code').fire('click');
                    root.querySelector('[name="code"]').value = '123456';
                    await root.querySelector('form.code-panel').fire('submit');
                } else if (method === 'totp') {
                    await button(root, 'Use an authenticator app').fire('click');
                    root.querySelector('[name="token"]').value = '123456';
                    await root.querySelector('form.totp-panel').fire('submit');
                } else {
                    await button(root, 'Use a passkey').fire('click');
                }
            }
            assert.equal(typeof releaseVerify, 'function', 'the real adapter request is waiting for its response');
            if (method === 'email' || method === 'signup') await button(root, 'Cancel').fire('click');
            else if (method === 'totp') await button(root, 'Back').fire('click');
            else clock.advance(11_000);
            releaseVerify(handoff);
            await settle();
            assert.deepEqual(fixture.navigated, [], 'a late success must not call navigate');
            assert.doesNotMatch(root.textContent, /Signing you in/);
            if (method === 'email' || method === 'signup') {
                assert.equal(h1(root).textContent, 'Loading…', 'the pending Cancel already invalidated Verify');
                releaseCancel({ ok: true, status: 'cancelled' });
                await settle();
                assert.equal(h1(root).textContent, 'Sign in');
            }
        });
    }
});

test('both real adapters cancel only the abandoned Google transaction after a delayed start response', async (t) => {
    for (const flow of ['sso', 'oidc']) {
        for (const transition of ['next', 'expiry', 'dispose', ...(flow === 'oidc' ? ['abort'] : [])]) {
            await t.test(`${flow}: ${transition}`, async () => {
                const clock = fakeClock();
                let release;
                const factory = flow === 'sso' ? ssoFixture : oidcFixture;
                const fixture = factory({ post: ({ url }) => {
                    if (url.endsWith('/attempt')) return wizardState({ expiresAt: clock.now() + 10_000, methods: { ...ALL_METHODS, google: true } });
                    if (url.endsWith('/discover')) return { ok: true, ...REGISTERED };
                    if (url.endsWith('/google/start') || url.endsWith('/google')) return new Promise((resolve) => { release = resolve; });
                    return { ok: true };
                } });
                const { root, dispose } = await mount({ adapter: fixture.adapter, clock });
                const pending = button(root, 'Sign in with Google').fire('click');
                await settle();
                if (transition === 'next') await submitEmail(root);
                else if (transition === 'expiry') clock.advance(11_000);
                else if (transition === 'abort') await button(root, 'Cancel').fire('click');
                else dispose();
                release({ ok: true, authorizationUrl: 'https://accounts.google.com/authorize', transaction: 'abandoned-transaction' });
                await pending;
                assert.deepEqual(fixture.navigated, [], 'a stale Google response must never navigate');
                const cancellation = fixture.calls.at(-1);
                assert.match(cancellation.url, /attempt(?:\/|-)cancel$/);
                assert.equal(cancellation.body.googleTransaction, 'abandoned-transaction');
                if (transition === 'abort') assert.equal(fixture.body.children.at(-1).submitted, true, 'OIDC abort remains a native POST');
            });
        }
    }
});

test('the real OIDC adapter submits password and signup completions only after the wizard accepts the current operation', async (t) => {
    for (const action of ['password', 'signup', 'email', 'totp']) {
        await t.test(action, async () => {
            const fixture = oidcFixture({ post: ({ url }) => {
                if (url.endsWith('/attempt')) return wizardState();
                if (url.endsWith('/discover')) return { ok: true, ...(action === 'signup' ? UNKNOWN : REGISTERED) };
                if (url.endsWith('/signup-start')) return { ok: true, challenge: signupChallenge() };
                return { ok: true, challenge: challengeFor() };
            } });
            const { root } = await mount({ adapter: fixture.adapter });
            await submitEmail(root, action === 'signup' ? 'new@example.test' : 'member@example.test');
            let form;
            if (action === 'password') {
                root.querySelector('[name="password"]').value = 'a native password';
                form = root.querySelector('form.password-panel');
            } else if (action === 'signup') {
                await root.querySelector('form.signup-offer-panel').fire('submit');
                await createAccount(root, 'a long enough password');
                root.querySelector('[name="code"]').value = '123456';
                form = root.querySelector('form.signup-code-panel');
            } else {
                await button(root, 'Try another way').fire('click');
                await button(root, action === 'email' ? 'Email me a code' : 'Use an authenticator app').fire('click');
                root.querySelector(`[name="${action === 'email' ? 'code' : 'token'}"]`).value = '123456';
                form = root.querySelector('form');
            }
            assert.equal(fixture.body.children.length, 0);
            await form.fire('submit');
            assert.equal(h1(root).textContent, 'Signing you in…');
            assert.equal(fixture.body.children.length, 1);
            const submitted = fixture.body.children[0];
            assert.equal(submitted.submitted, true);
            const expected = { password: 'password-login', signup: 'signup-verify', email: 'email-verify', totp: 'totp' }[action];
            assert.match(submitted.getAttribute('action'), new RegExp(`/${expected}$`));
            if (action === 'password') assert.deepEqual(formFields(submitted), { csrf: 'csrf-token', email: 'member@example.test', password: 'a native password' });
        });
    }
});
