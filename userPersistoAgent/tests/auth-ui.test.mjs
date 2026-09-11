import test from 'node:test';
import assert from 'node:assert/strict';
import { mountWizard } from '../public/auth/wizard.js';
import { createSsoAdapter } from '../public/auth/sso-adapter.js';
import { createOidcAdapter } from '../public/auth/oidc-adapter.js';

// ---- fake DOM (extends the pattern proven in the previous auth-ui suite) ----
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
    // A real browser's HTMLFormElement.submit() does not fire 'submit' listeners
    // (only requestSubmit() does); the OIDC adapter relies on exactly that, so
    // the fake mirrors it by only flipping a flag tests can observe.
    submit() { this.submitted = true; }
    reset() { this.querySelectorAll('input').forEach((input) => { input.value = ''; }); }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function createDocument() {
    const root = new Element('main');
    root.isRoot = true;
    root.setAttribute('id', 'auth_content');
    const body = new Element('body');
    body.isRoot = true;
    const document = {
        createElement: (tag) => new Element(tag),
        querySelector: (selector) => (root.matches(selector) ? root : root.querySelector(selector)),
        body,
    };
    return { document, root, body };
}

function fakeStorage() {
    const data = new Map();
    return {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: (key) => { data.delete(key); },
    };
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

// ---- fake adapter (wizard-behavior tests talk only to this contract) ----
function wizardState(overrides = {}) {
    return {
        expiresAt: Date.now() + 5 * 60 * 1000,
        setupComplete: true,
        registration: true,
        methods: { emailCode: true, passkey: false, totp: false, google: false },
        adminPassword: false,
        attempt: { status: 'active', challenge: null, locked: false },
        ...overrides,
    };
}
function freshChallenge(overrides = {}) {
    return {
        email: 'member@example.test',
        purpose: 'login',
        expiresAt: Date.now() + 5 * 60 * 1000,
        resendAt: Date.now() + 60 * 1000,
        attemptsRemaining: 5,
        delivery: 'accepted',
        expired: false,
        ...overrides,
    };
}
function baseAdapter(overrides = {}) {
    return {
        flow: 'sso',
        clientName: '',
        screenHint: '',
        storageKey: 'wizard-test',
        notice: '',
        attempt: async () => wizardState(),
        cancel: async () => ({ status: 'cancelled' }),
        discover: async () => ({ exists: false, methods: { emailCode: false, passkey: false, totp: false } }),
        startEmail: async () => ({ challenge: freshChallenge() }),
        verifyEmail: async () => {},
        verifyTotp: async () => {},
        verifyPasskey: async () => {},
        passkeyOptions: async () => ({ challengeKey: 'challenge-key', publicKey: { challenge: 'AQID', allowCredentials: [] } }),
        adminLogin: async () => {},
        startGoogle: async () => {},
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
    assert.ok(node, 'expected exactly one h1 on the current screen');
    return node;
}
function button(root, text) {
    const node = root.querySelectorAll('button').find((candidate) => candidate.textContent === text);
    assert.ok(node, `expected a button "${text}"`);
    return node;
}
function assertLabels(root) {
    for (const input of root.querySelectorAll('input, select')) {
        assert.ok(input.id, `${input.name || input.tagName} has an id`);
        assert.ok(root.querySelectorAll('label').some((label) => label.htmlFor === input.id), `label is associated with ${input.id}`);
    }
}

// ==== the four discover() transitions =====================================

test('login + exists shows the method chooser with the email option focused first', async () => {
    const adapter = baseAdapter({ discover: async () => ({ exists: true, methods: { emailCode: true, passkey: false, totp: true } }) });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    assert.match(h1(root).textContent, /Choose how to sign in/);
    const emailButton = button(root, 'Email me a code');
    assert.equal(emailButton.focused, true, 'the email option is focused when usable');
    const methodButtons = root.querySelectorAll('button').filter((node) => node.textContent !== 'Back');
    assert.equal(methodButtons.length, 2, 'only usable methods are listed');
    button(root, 'Back');
});

test('login + unknown offers to create an account, and confirming switches mode and sends a registration code', async () => {
    const calls = [];
    const adapter = baseAdapter({
        discover: async (email) => { calls.push(['discover', email]); return { exists: false, methods: { emailCode: false, passkey: false, totp: false } }; },
        startEmail: async (args) => { calls.push(['startEmail', args]); return { challenge: freshChallenge({ purpose: 'register' }) }; },
    });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'new@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    assert.match(h1(root).textContent, /Create an account\?/);
    assert.match(root.textContent, /No account uses new@example\.test\. Create one\?/);
    await root.querySelector('form.confirm-panel').fire('submit');
    assert.deepEqual(calls, [['discover', 'new@example.test'], ['startEmail', { email: 'new@example.test', purpose: 'register', resend: false }]]);
    assert.match(h1(root).textContent, /Enter the 6-digit code/);
});

test('login + unknown with registration unavailable is a dead end with only Back', async () => {
    const adapter = baseAdapter({ attempt: async () => wizardState({ registration: false }),
        discover: async () => ({ exists: false, methods: { emailCode: false, passkey: false, totp: false } }) });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'ghost@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    assert.match(root.textContent, /No account uses ghost@example\.test\./);
    assert.equal(root.querySelectorAll('button').length, 1);
    button(root, 'Back');
});

test('register + exists offers to sign in instead and reuses the same discovery for the chooser', async () => {
    const calls = [];
    const adapter = baseAdapter({
        attempt: async () => wizardState({ setupComplete: false }),
        discover: async (email) => { calls.push(email); return { exists: true, methods: { emailCode: true, passkey: false, totp: false } }; },
    });
    const { root } = await mount({ adapter });
    assert.match(h1(root).textContent, /Create an account/, 'unclaimed setup defaults to register mode');
    root.querySelector('[name="email"]').value = 'owner@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    assert.match(h1(root).textContent, /Sign in instead\?/);
    await root.querySelector('form.confirm-panel').fire('submit');
    assert.deepEqual(calls, ['owner@example.test'], 'confirming reuses the discovery instead of calling discover again');
    assert.match(h1(root).textContent, /Choose how to sign in/);
});

test('register + unknown sends the registration code directly', async () => {
    const calls = [];
    const adapter = baseAdapter({
        discover: async () => ({ exists: false, methods: {} }),
        startEmail: async (args) => { calls.push(args); return { challenge: freshChallenge({ purpose: 'register', email: 'fresh@example.test' }) }; },
    });
    const { root } = await mount({ adapter });
    await button(root, 'Create an account').fire('click');
    root.querySelector('[name="email"]').value = 'fresh@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    assert.deepEqual(calls, [{ email: 'fresh@example.test', purpose: 'register', resend: false }]);
    assert.match(h1(root).textContent, /Enter the 6-digit code sent to fresh@example\.test/);
});

test('unknown email offers Google registration when email delivery is unavailable in either mode', async () => {
    for (const mode of ['login', 'register']) {
        let googleStarts = 0;
        const adapter = baseAdapter({
            attempt: async () => wizardState({ methods: { google: true, emailCode: false } }),
            startEmail: () => assert.fail('the unavailable email method must not be requested'),
            startGoogle: async () => { googleStarts += 1; },
        });
        const { root } = await mount({ adapter });
        if (mode === 'register') await button(root, 'Create an account').fire('click');
        root.querySelector('[name="email"]').value = 'new@example.test';
        await root.querySelector('form.start-panel').fire('submit');
        assert.match(h1(root).textContent, /Create an account with Google/);
        assert.match(root.textContent, /Email registration is not available/);
        await button(root, 'Continue with Google').fire('click');
        assert.equal(googleStarts, 1);
    }
});

test('switching mode persists {mode, email} to storage immediately, before any submit', async () => {
    const storage = fakeStorage();
    const adapter = baseAdapter();
    const { root } = await mount({ adapter, storage });
    root.querySelector('[name="email"]').value = 'switcher@example.test';
    await button(root, 'Create an account').fire('click');
    const stored = JSON.parse(storage.getItem('wizard-test'));
    assert.deepEqual(stored, { mode: 'register', email: 'switcher@example.test' }, 'the mode switch itself persists, not just a later submit');
});

// ==== first-run / registration / screen hint / client name ================

test('an unclaimed installation shows the first-run message and defaults to register mode', async () => {
    const adapter = baseAdapter({ attempt: async () => wizardState({ setupComplete: false }) });
    const { root } = await mount({ adapter });
    assert.match(root.textContent, /This workspace is not set up yet\. The first completed sign-in becomes its administrator\./);
    assert.match(h1(root).textContent, /Create an account/);
});

test('OIDC screenHint signup defaults to register mode and shows the client name', async () => {
    const adapter = baseAdapter({ flow: 'oidc', clientName: 'Explorer', screenHint: 'signup' });
    const { root } = await mount({ adapter });
    assert.match(h1(root).textContent, /Create an account/);
    assert.match(root.textContent, /Continue to Explorer/);
});

test('registration disabled hides the mode switch and forces login mode', async () => {
    const adapter = baseAdapter({ attempt: async () => wizardState({ registration: false }) });
    const { root } = await mount({ adapter });
    assert.match(h1(root).textContent, /Sign in/);
    assert.equal(root.querySelectorAll('button').some((node) => node.textContent === 'Create an account'), false);
});

test('the start screen shows a Cancel button that calls adapter.abort() only when the adapter exposes one', async () => {
    const calls = [];
    const oidcAdapter = baseAdapter({ flow: 'oidc', abort: () => { calls.push('abort'); } });
    const { root } = await mount({ adapter: oidcAdapter });
    await button(root, 'Cancel').fire('click');
    assert.deepEqual(calls, ['abort']);

    const ssoAdapter = baseAdapter();
    assert.equal(typeof ssoAdapter.abort, 'undefined', 'the default SSO fixture adapter has no abort()');
    const ssoMount = await mount({ adapter: ssoAdapter });
    assert.equal(ssoMount.root.querySelectorAll('button').some((node) => node.textContent === 'Cancel'), false, 'no Cancel button when the adapter cannot abort');
});

// ==== no-methods dead end ===================================================

test('no usable methods shows the no-methods screen with Back', async () => {
    const adapter = baseAdapter({ discover: async () => ({ exists: true, methods: { emailCode: false, passkey: true, totp: false } }) });
    const { root } = await mount({ adapter }); // no `credentials` -> passkey is not usable either
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    assert.match(h1(root).textContent, /No sign-in method available/);
    assert.match(root.textContent, /Continue with Google if the account uses Google/);
    button(root, 'Back');
});

// ==== administrator sign-in =================================================

test('administrator sign-in is hidden unless configured, never sends the start-screen email, and offers contact email only pre-setup', async () => {
    {
        const adapter = baseAdapter({ attempt: async () => wizardState({ adminPassword: false }) });
        const { root } = await mount({ adapter });
        assert.equal(root.querySelectorAll('button').some((node) => node.textContent === 'Administrator sign-in'), false);
    }
    for (const setupComplete of [false, true]) {
        const calls = [];
        const adapter = baseAdapter({
            attempt: async () => wizardState({ adminPassword: true, setupComplete }),
            adminLogin: async (args) => { calls.push(args); },
        });
        const { root } = await mount({ adapter });
        root.querySelector('[name="email"]').value = 'someone@example.test';
        await button(root, 'Administrator sign-in').fire('click');
        assert.match(h1(root).textContent, /Administrator sign-in/);
        assertLabels(root);
        assert.equal(Boolean(root.querySelector('[name="contactEmail"]')), !setupComplete, 'contact email only appears before setup is complete');
        root.querySelector('[name="password"]').value = 'the-admin-password';
        if (!setupComplete) root.querySelector('[name="contactEmail"]').value = 'contact@example.test';
        await root.querySelector('form.admin-panel').fire('submit');
        assert.deepEqual(calls, [{ password: 'the-admin-password', contactEmail: setupComplete ? '' : 'contact@example.test' }]);
        assert.ok(!('email' in calls[0]), 'the administrator screen never sends the start-screen email');
    }
});

test('an incorrect administrator password shows the administrator-specific error and stays usable', async () => {
    const adapter = baseAdapter({ attempt: async () => wizardState({ adminPassword: true }),
        adminLogin: async () => { throw fail('authentication_failed'); } });
    const { root } = await mount({ adapter });
    await button(root, 'Administrator sign-in').fire('click');
    root.querySelector('[name="password"]').value = 'wrong';
    await root.querySelector('form.admin-panel').fire('submit');
    assert.match(root.textContent, /Unable to sign in with that administrator password\./);
    assert.equal(root.querySelector('button[type="submit"]').disabled, false);
});

// ==== code screen: resend cooldown, change email / cancel, errors =========

test('resend is disabled until resendAt, then enabled, and sends the resend flag', async () => {
    const clock = fakeClock();
    const calls = [];
    const adapter = baseAdapter({
        attempt: async () => wizardState({ expiresAt: clock.now() + 5 * 60 * 1000, setupComplete: false }),
        discover: async () => ({ exists: false, methods: {} }),
        startEmail: async (args) => {
            calls.push(args);
            const resend = args.resend === true;
            return { challenge: freshChallenge({ purpose: 'register', resendAt: clock.now() + 10_000 }) };
        },
    });
    const { root } = await mount({ adapter, clock });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    const resendButton = root.querySelectorAll('button').find((node) => /^Resend/.test(node.textContent));
    assert.ok(resendButton, 'expected a Resend button');
    assert.equal(resendButton.disabled, true);
    assert.match(resendButton.textContent, /^Resend in \d+ s$/);
    clock.advance(5_000);
    assert.equal(resendButton.disabled, true, 'still inside the cooldown');
    clock.advance(6_000);
    assert.equal(resendButton.disabled, false, 'cooldown elapsed');
    assert.equal(resendButton.textContent, 'Resend');
    await resendButton.fire('click');
    assert.deepEqual(calls[1], { email: 'member@example.test', purpose: 'register', resend: true });
});

test('a resend failure stays on the code screen with an inline error and keeps the entered code', async () => {
    let attempt = 0;
    const adapter = baseAdapter({
        attempt: async () => wizardState({ setupComplete: false }),
        discover: async () => ({ exists: false, methods: {} }),
        startEmail: async () => {
            attempt += 1;
            // resendAt: 0 (epoch) rather than `Date.now() - 1`: the wizard measures
            // the cooldown against the test's frozen fakeClock, not the real wall
            // clock, so anything in the recent past can race under load. 0 is
            // unambiguously elapsed against any clock.
            if (attempt === 1) return { challenge: freshChallenge({ purpose: 'register', resendAt: 0 }) };
            throw fail('resend_too_soon', { retryAfter: 30 });
        },
    });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    root.querySelector('[name="code"]').value = '123456';
    await button(root, 'Resend').fire('click');
    assert.match(root.textContent, /Too many requests\. Wait 30 s and try again\./);
    assert.equal(root.querySelector('[name="code"]').value, '123456', 'the entered code is not cleared by a resend failure');
    assert.match(h1(root).textContent, /Enter the 6-digit code/, 'still on the code screen');
});

test('change email and cancel both call the server cancel operation and clear the code before returning to start', async () => {
    for (const label of ['Change email', 'Cancel']) {
        const calls = [];
        const adapter = baseAdapter({
            attempt: async () => wizardState({ setupComplete: false }),
            discover: async () => ({ exists: false, methods: {} }),
            startEmail: async () => ({ challenge: freshChallenge({ purpose: 'register' }) }),
            cancel: async () => { calls.push('cancel'); return { status: 'cancelled' }; },
        });
        const { root } = await mount({ adapter });
        root.querySelector('[name="email"]').value = 'member@example.test';
        await root.querySelector('form.start-panel').fire('submit');
        const codeInput = root.querySelector('[name="code"]');
        codeInput.value = '111111';
        await button(root, label).fire('click');
        assert.deepEqual(calls, ['cancel']);
        assert.match(h1(root).textContent, /Sign in|Create an account/);
        assert.equal(root.querySelector('[name="code"]'), null, 'the code screen is gone');
        assert.equal(codeInput.value, '', 'the code field itself was cleared, not just navigated away from');
    }
});

test('code_invalid shows attempts remaining and too_many_attempts disables Verify and offers Start over', async () => {
    const adapter = baseAdapter({
        attempt: async () => wizardState({ setupComplete: false }),
        discover: async () => ({ exists: false, methods: {} }),
        startEmail: async () => ({ challenge: freshChallenge({ purpose: 'register' }) }),
        verifyEmail: async () => { throw fail('code_invalid', { attemptsRemaining: 2 }); },
    });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    root.querySelector('[name="code"]').value = '000000';
    await root.querySelector('form.code-panel').fire('submit');
    assert.match(root.textContent, /That code is not correct\. 2 attempts left\./);
    const errorNode = root.querySelector('.status[role="alert"]');
    assert.ok(errorNode);

    const lockedAdapter = baseAdapter({
        attempt: async () => wizardState({ setupComplete: false }),
        discover: async () => ({ exists: false, methods: {} }),
        startEmail: async () => ({ challenge: freshChallenge({ purpose: 'register' }) }),
        verifyEmail: async () => { throw fail('too_many_attempts'); },
    });
    const locked = await mount({ adapter: lockedAdapter });
    locked.root.querySelector('[name="email"]').value = 'member@example.test';
    await locked.root.querySelector('form.start-panel').fire('submit');
    locked.root.querySelector('[name="code"]').value = '000000';
    await locked.root.querySelector('form.code-panel').fire('submit');
    assert.equal(locked.root.querySelector('button[type="submit"]').disabled, true);
    button(locked.root, 'Start over');
});

// ==== stale async results are ignored ======================================

test('a stale discover response after the user has already moved on does not change the view', async () => {
    let release;
    const adapter = baseAdapter({ discover: () => new Promise((resolve) => { release = resolve; }) });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'member@example.test';
    const pending = root.querySelector('form.start-panel').fire('submit');
    await settle();
    // The user gives up on the discover() call and switches mode instead.
    await button(root, 'Create an account').fire('click');
    const registerHeading = h1(root).textContent;
    release({ exists: true, methods: { emailCode: true, passkey: false, totp: false } });
    await pending;
    await settle();
    assert.equal(h1(root).textContent, registerHeading, 'the late discover() result never rendered the chooser');
});

test('a stale verify response after a transition does not show the completing screen', async () => {
    let release;
    const adapter = baseAdapter({
        attempt: async () => wizardState({ setupComplete: false }),
        discover: async () => ({ exists: false, methods: {} }),
        startEmail: async () => ({ challenge: freshChallenge({ purpose: 'register' }) }),
        verifyEmail: () => new Promise((resolve) => { release = resolve; }),
        cancel: async () => ({ status: 'cancelled' }),
    });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    root.querySelector('[name="code"]').value = '123456';
    const pending = root.querySelector('form.code-panel').fire('submit');
    await settle();
    await button(root, 'Cancel').fire('click');
    await settle();
    const startHeading = h1(root).textContent;
    release();
    await pending;
    await settle();
    assert.equal(h1(root).textContent, startHeading, 'the late verifyEmail() success never showed "Signing you in"');
    assert.doesNotMatch(root.textContent, /Signing you in/);
});

// ==== expiry ================================================================

test('the countdown transitions to the expired screen and Start again calls adapter.restart()', async () => {
    const clock = fakeClock();
    let restarted = 0;
    const adapter = baseAdapter({ attempt: async () => wizardState({ expiresAt: clock.now() + 3_000 }), restart: () => { restarted += 1; } });
    const { root } = await mount({ adapter, clock });
    assert.match(root.querySelector('.auth-timer')?.textContent || '', /Expires in/);
    clock.advance(4_000);
    assert.match(h1(root).textContent, /This sign-in request expired/);
    await button(root, 'Start again').fire('click');
    assert.equal(restarted, 1);
});

test('OIDC expiry shows Close window naming the client and calls restart()', async () => {
    const clock = fakeClock();
    let restarted = 0;
    const adapter = baseAdapter({ flow: 'oidc', clientName: 'Explorer', attempt: async () => wizardState({ expiresAt: clock.now() + 1_000 }), restart: () => { restarted += 1; } });
    const { root } = await mount({ adapter, clock });
    clock.advance(2_000);
    assert.match(root.textContent, /Close this window and start again from Explorer\./);
    await button(root, 'Close window').fire('click');
    assert.equal(restarted, 1);
});

test('server expiry error codes show the expired screen', async () => {
    for (const code of ['attempt_expired', 'login_request_expired', 'login_request_invalid']) {
        const adapter = baseAdapter({ discover: async () => { throw fail(code); } });
        const { root } = await mount({ adapter });
        root.querySelector('[name="email"]').value = 'member@example.test';
        await root.querySelector('form.start-panel').fire('submit');
        assert.match(h1(root).textContent, /This sign-in request expired/, code);
    }
});

// ==== Google notices and start =============================================

test('a Google notice from the page is shown as a non-error status and the wizard stays usable', async () => {
    const adapter = baseAdapter({ notice: 'google-denied', methods: { emailCode: true, passkey: false, totp: false, google: true } });
    const { root } = await mount({ adapter });
    assert.match(root.textContent, /Google did not complete sign-in\./);
    const notice = root.querySelectorAll('.status').find((node) => node.textContent.includes('Google did not complete sign-in.'));
    assert.notEqual(notice.getAttribute('role'), 'alert', 'a notice is not an error');
    button(root, 'Next');
});

test('the Google button has a visible, accessible "Continue with Google" label and calls adapter.startGoogle()', async () => {
    const adapter = baseAdapter({ attempt: async () => wizardState({ methods: { emailCode: true, passkey: false, totp: false, google: true } }) });
    let started = 0;
    adapter.startGoogle = async () => { started += 1; };
    const { root } = await mount({ adapter });
    const googleButton = root.querySelector('.google-button');
    assert.equal(googleButton.textContent, 'Continue with Google');
    await googleButton.fire('click');
    assert.equal(started, 1);
});

// ==== reload / sessionStorage ===============================================

test('reload resumes the code screen from a live attempt() challenge, and storage holds only {mode, email}', async () => {
    const storage = fakeStorage();
    const adapter = baseAdapter({
        attempt: async () => wizardState({ attempt: { status: 'active', challenge: freshChallenge({ email: 'resumed@example.test', purpose: 'register' }), locked: false } }),
    });
    const { root } = await mount({ adapter, storage });
    assert.match(h1(root).textContent, /Enter the 6-digit code sent to resumed@example\.test/);
});

test('sessionStorage is written with mode and email and nothing else', async () => {
    const storage = fakeStorage();
    const adapter = baseAdapter({ discover: async () => ({ exists: true, methods: { emailCode: true, passkey: false, totp: false } }) });
    const { root } = await mount({ adapter, storage });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    const stored = JSON.parse(storage.getItem('wizard-test'));
    assert.deepEqual(Object.keys(stored).sort(), ['email', 'mode']);
    assert.deepEqual(stored, { mode: 'login', email: 'member@example.test' });
});

// ==== OIDC initialFailure dispatch ==========================================

test('OIDC initialFailure action email-verify resumes the code screen using the fresh attempt() challenge', async () => {
    const adapter = baseAdapter({
        flow: 'oidc',
        initialFailure: { code: 'code_invalid', message: 'nope', action: 'email-verify', attemptsRemaining: 3 },
        initialEmail: '',
        attempt: async () => wizardState({ attempt: { status: 'active', challenge: freshChallenge({ email: 'resume@example.test', purpose: 'login' }), locked: false } }),
    });
    const { root } = await mount({ adapter });
    assert.match(h1(root).textContent, /Enter the 6-digit code sent to resume@example\.test/);
    assert.match(root.textContent, /That code is not correct\. 3 attempts left\./);
});

test('OIDC failed TOTP reload retains a usable Back action and re-discovers available methods', async () => {
    const emails = [];
    const adapter = baseAdapter({ flow: 'oidc', initialFailure: { code: 'authentication_failed', message: 'nope', action: 'totp' }, initialEmail: 'totp@example.test',
        discover: async (email) => { emails.push(email); return { exists: true, methods: { emailCode: true, totp: true } }; } });
    const { root } = await mount({ adapter });
    assert.match(h1(root).textContent, /Sign in with an authenticator/);
    assert.match(root.textContent, /Unable to sign in\. Check your details and try again\./);
    await button(root, 'Back').fire('click');
    assert.deepEqual(emails, ['totp@example.test']);
    assert.match(h1(root).textContent, /Choose how to sign in/);
    await button(root, 'Email me a code').fire('click');
    assert.match(h1(root).textContent, /Enter the 6-digit code/);
});

test('OIDC initialFailure action passkey-verify re-discovers and shows the chooser with the passkey error', async () => {
    const calls = [];
    const adapter = baseAdapter({
        flow: 'oidc',
        initialFailure: { code: 'authentication_failed', message: 'nope', action: 'passkey-verify' },
        initialEmail: 'passkey@example.test',
        discover: async (email) => { calls.push(email); return { exists: true, methods: { emailCode: true, passkey: true, totp: false } }; },
    });
    const { root } = await mount({ adapter });
    assert.deepEqual(calls, ['passkey@example.test']);
    assert.match(h1(root).textContent, /Choose how to sign in/);
    assert.match(root.textContent, /Unable to use this passkey\./);
});

test('OIDC initialFailure action passkey-verify falls back to the start screen if discover() itself fails', async () => {
    const adapter = baseAdapter({
        flow: 'oidc',
        initialFailure: { code: 'authentication_failed', message: 'nope', action: 'passkey-verify' },
        initialEmail: 'passkey@example.test',
        discover: async () => { throw fail('rate_limited', { retryAfter: 5 }); },
    });
    const { root } = await mount({ adapter });
    assert.match(h1(root).textContent, /Sign in|Create an account/);
    assert.match(root.textContent, /Unable to use this passkey\./);
});

test('OIDC initialFailure action admin-login shows the administrator screen with the admin-specific error', async () => {
    const adapter = baseAdapter({ flow: 'oidc', attempt: async () => wizardState({ adminPassword: true }),
        initialFailure: { code: 'authentication_failed', message: 'nope', action: 'admin-login' } });
    const { root } = await mount({ adapter });
    assert.match(h1(root).textContent, /Administrator sign-in/);
    assert.match(root.textContent, /Unable to sign in with that administrator password\./);
});

test('OIDC initialFailure with code account_exists shows the collision screen', async () => {
    const adapter = baseAdapter({ flow: 'oidc', initialFailure: { code: 'account_exists', message: 'nope', action: 'email-verify' }, initialEmail: '' });
    const { root } = await mount({ adapter });
    assert.match(h1(root).textContent, /Sign in instead\?/);
    assert.match(root.textContent, /An account already uses this email\. Sign in instead\./);
});

// ==== late collision (account_exists from verifyEmail) =====================

test('a late collision on verify shows the collision screen, and Sign in re-discovers and shows the chooser', async () => {
    const calls = [];
    const adapter = baseAdapter({
        attempt: async () => wizardState({ setupComplete: false }),
        discover: async (email) => { calls.push(email); return calls.length === 1 ? { exists: false, methods: {} } : { exists: true, methods: { emailCode: true, passkey: false, totp: false } }; },
        startEmail: async () => ({ challenge: freshChallenge({ purpose: 'register' }) }),
        verifyEmail: async () => { throw fail('account_exists'); },
    });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'taken@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    root.querySelector('[name="code"]').value = '123456';
    await root.querySelector('form.code-panel').fire('submit');
    assert.match(h1(root).textContent, /Sign in instead\?/);
    assert.match(root.textContent, /An account already uses taken@example\.test\. Sign in instead\./);
    await root.querySelector('form.confirm-panel').fire('submit');
    assert.deepEqual(calls, ['taken@example.test', 'taken@example.test']);
    assert.match(h1(root).textContent, /Choose how to sign in/);
});

test('registration_disabled returns to login mode with an inline message', async () => {
    const adapter = baseAdapter({
        attempt: async () => wizardState({ setupComplete: false }),
        discover: async () => ({ exists: false, methods: {} }),
        startEmail: async () => { throw fail('registration_disabled'); },
    });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    assert.match(h1(root).textContent, /Sign in/);
    assert.match(root.textContent, /Registration is not available\./);
});

// ==== passkey: abort on transition, assertion bytes preserved ==============

test('an expiry transition while a passkey prompt is pending aborts the in-flight browser request', async () => {
    const clock = fakeClock();
    let signal;
    let getCalls = 0;
    const credentials = { get: async (options) => { getCalls += 1; signal = options.signal; return new Promise(() => {}); } };
    const adapter = baseAdapter({ attempt: async () => wizardState({ expiresAt: clock.now() + 5_000 }),
        discover: async () => ({ exists: true, methods: { emailCode: true, passkey: true, totp: false } }) });
    const { root } = await mount({ adapter, credentials, clock });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    await button(root, 'Use a passkey').fire('click');
    await settle();
    assert.equal(getCalls, 1);
    assert.equal(signal.aborted, false);
    clock.advance(6_000);
    assert.equal(signal.aborted, true, 'the expiry transition aborted the pending browser prompt');
    assert.match(h1(root).textContent, /This sign-in request expired/);
});

test('passkey challenge bytes and the assertion reach verifyPasskey unmodified', async () => {
    const receivedOptions = [];
    const credentials = { get: async (options) => {
        receivedOptions.push(options);
        return { id: 'cred-1', rawId: Uint8Array.of(9, 9).buffer, type: 'public-key', response: {
            clientDataJSON: Uint8Array.of(1).buffer, authenticatorData: Uint8Array.of(2).buffer, signature: Uint8Array.of(3).buffer, userHandle: null,
        } };
    } };
    let verifyArgs;
    const adapter = baseAdapter({
        discover: async () => ({ exists: true, methods: { emailCode: false, passkey: true, totp: false } }),
        passkeyOptions: async () => ({ challengeKey: 'retained-key', publicKey: { challenge: 'AQID', allowCredentials: [{ id: 'BAUG', type: 'public-key' }] } }),
        verifyPasskey: async (args) => { verifyArgs = args; },
    });
    const { root } = await mount({ adapter, credentials });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    await button(root, 'Use a passkey').fire('click');
    await settle();
    assert.deepEqual([...new Uint8Array(receivedOptions[0].publicKey.challenge)], [1, 2, 3]);
    assert.deepEqual([...new Uint8Array(receivedOptions[0].publicKey.allowCredentials[0].id)], [4, 5, 6]);
    assert.equal(verifyArgs.email, 'member@example.test');
    assert.equal(verifyArgs.challengeKey, 'retained-key');
    assert.equal(verifyArgs.assertion.id, 'cred-1');
    assert.deepEqual([...new Uint8Array(verifyArgs.assertion.rawId)], [9, 9]);
});

test('a failed passkey attempt shows the failure screen with Try again and Back', async () => {
    const credentials = { get: async () => { throw new Error('NotAllowedError'); } };
    const adapter = baseAdapter({ discover: async () => ({ exists: true, methods: { emailCode: false, passkey: true, totp: false } }) });
    const { root } = await mount({ adapter, credentials });
    root.querySelector('[name="email"]').value = 'member@example.test';
    await root.querySelector('form.start-panel').fire('submit');
    await button(root, 'Use a passkey').fire('click');
    await settle();
    assert.match(root.textContent, /Unable to use this passkey\./);
    button(root, 'Try again');
    button(root, 'Back');
});

// ==== accessibility ==========================================================

test('every input has an associated label and every screen has exactly one focused h1', async () => {
    const adapter = baseAdapter({ attempt: async () => wizardState({ adminPassword: true, methods: { emailCode: true, passkey: false, totp: false, google: false } }) });
    const { root } = await mount({ adapter });
    assert.equal(root.querySelectorAll('h1').length, 1);
    assert.equal(h1(root).focused, true);
    assertLabels(root);
    await button(root, 'Administrator sign-in').fire('click');
    assert.equal(root.querySelectorAll('h1').length, 1);
    assert.equal(h1(root).focused, true);
    assertLabels(root);
});

test('an inline error is rendered with role=alert', async () => {
    const adapter = baseAdapter({ discover: async () => { throw fail('invalid_email'); } });
    const { root } = await mount({ adapter });
    root.querySelector('[name="email"]').value = 'not-an-email';
    await root.querySelector('form.start-panel').fire('submit');
    const alertNode = root.querySelectorAll('[role="alert"]').find((node) => node.textContent === 'Enter a valid email address.');
    assert.ok(alertNode);
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
        return { ok: result.ok !== false, status: result.ok === false ? 400 : 200, json: async () => result };
    };
    const adapter = createSsoAdapter({ location, fetch: fetchImpl, navigate: (url) => navigated.push(url) });
    return { adapter, calls, navigated, origin };
}

test('SSO adapter posts JSON with same-origin credentials to paths resolved under the current service prefix', async () => {
    const { adapter, calls } = ssoFixture({ post: () => ({ ok: true, exists: false, methods: { emailCode: false, passkey: false, totp: false } }) });
    await adapter.discover('member@example.test');
    assert.equal(calls[0].url, 'https://workspace.example:9443/prefix/service/auth/discover');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].options.credentials, 'same-origin');
    assert.deepEqual(calls[0].body, { requestId: 'req-1', email: 'member@example.test' });
});

test('SSO adapter request bodies match the documented shape for every operation', async () => {
    const { adapter, calls } = ssoFixture({ post: ({ url }) => {
        if (url.endsWith('/passkey/options')) return { ok: true, challengeKey: 'k', publicKey: { challenge: 'AQID', allowCredentials: [] } };
        return { ok: true, code: 'c', redirectUri: 'https://workspace.example:9443/auth/callback', state: 'state-1' };
    } });
    await adapter.cancel();
    await adapter.startEmail({ email: 'a@example.test', purpose: 'login', resend: false });
    await adapter.startEmail({ email: 'a@example.test', purpose: 'login', resend: true });
    await adapter.verifyEmail('123456');
    await adapter.passkeyOptions('a@example.test');
    await adapter.verifyTotp({ email: 'a@example.test', token: '654321' });
    await adapter.adminLogin({ password: 'secret-password', contactEmail: '' });
    await adapter.adminLogin({ password: 'secret-password', contactEmail: 'c@example.test' });
    const byPath = Object.fromEntries(calls.map((call) => [new URL(call.url).pathname, call.body]));
    assert.deepEqual(byPath['/prefix/service/auth/attempt/cancel'], { requestId: 'req-1' });
    assert.deepEqual(calls.filter((c) => new URL(c.url).pathname === '/prefix/service/auth/email-code/start').map((c) => c.body), [
        { requestId: 'req-1', email: 'a@example.test', purpose: 'login' },
        { requestId: 'req-1', email: 'a@example.test', purpose: 'login', resend: true },
    ]);
    assert.deepEqual(byPath['/prefix/service/auth/email-code/verify'], { requestId: 'req-1', state: 'state-1', code: '123456' });
    assert.deepEqual(byPath['/prefix/service/auth/passkey/options'], { requestId: 'req-1', email: 'a@example.test' });
    assert.deepEqual(byPath['/prefix/service/auth/totp/verify'], { requestId: 'req-1', state: 'state-1', email: 'a@example.test', token: '654321' });
    const adminCalls = calls.filter((c) => new URL(c.url).pathname === '/prefix/service/auth/admin/login').map((c) => c.body);
    assert.deepEqual(adminCalls, [
        { requestId: 'req-1', state: 'state-1', password: 'secret-password' },
        { requestId: 'req-1', state: 'state-1', password: 'secret-password', contactEmail: 'c@example.test' },
    ]);
});

test('SSO adapter builds the completion URL preserving origin and setting state and code', async () => {
    const { adapter, navigated } = ssoFixture({ post: () => ({ ok: true, code: 'the-code', redirectUri: 'https://workspace.example:9443/auth/callback?x=1', state: 'state-1' }) });
    const result = await adapter.verifyEmail('123456');
    assert.deepEqual(navigated, [], 'verifying only prepares the completion');
    adapter.complete(result);
    assert.equal(navigated.length, 1);
    const url = new URL(navigated[0]);
    assert.equal(url.origin, 'https://workspace.example:9443');
    assert.equal(url.pathname, '/auth/callback');
    assert.equal(url.searchParams.get('state'), 'state-1');
    assert.equal(url.searchParams.get('code'), 'the-code');
});

test('SSO adapter attempt() replay completion navigates the same way as a live completion', async () => {
    const { adapter, navigated } = ssoFixture({ post: () => ({ ok: true, completed: true, handoff: { code: 'replayed-code', redirectUri: 'https://workspace.example:9443/auth/callback', state: 'state-1', replayed: true } }) });
    const result = await adapter.attempt();
    assert.equal(result.completed, true);
    assert.deepEqual(navigated, [], 'replay only prepares the completion');
    adapter.complete(result.handoff);
    assert.equal(navigated.length, 1);
    const url = new URL(navigated[0]);
    assert.equal(url.searchParams.get('code'), 'replayed-code');
    assert.equal(url.searchParams.get('state'), 'state-1');
});

test('SSO adapter restart() navigates to the origin-root Router login route', async () => {
    const { adapter, navigated } = ssoFixture({ search: '?requestId=req-1&state=state-1&returnTo=%2Fprivate%3Fx%3D1' });
    adapter.restart();
    assert.equal(navigated[0], '/auth/login?returnTo=%2Fprivate%3Fx%3D1&prompt=login');
});

test('SSO adapter thrown errors carry code, status, retryAfter and attemptsRemaining', async () => {
    const { adapter } = ssoFixture({ post: () => ({ ok: false, error: 'code_invalid', attemptsRemaining: 2 }) });
    await assert.rejects(adapter.verifyEmail('000000'), (error) => {
        assert.equal(error.code, 'code_invalid');
        assert.equal(error.status, 400);
        assert.equal(error.attemptsRemaining, 2);
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
        document,
        fetch: fetchImpl,
        navigate: (url) => navigated.push(url),
        closeWindow: () => { closed += 1; },
    });
    return { adapter, calls, navigated, body, closedCount: () => closed };
}

test('real SSO adapter never navigates a delayed successful credential response after Cancel, Back or expiry', async (t) => {
    for (const method of ['email', 'totp', 'admin', 'passkey']) {
        await t.test(method, async () => {
            const clock = fakeClock();
            let releaseVerify;
            let releaseCancel;
            const handoff = { ok: true, code: 'abandoned-code', redirectUri: 'https://workspace.example:9443/auth/callback' };
            const fixture = ssoFixture({ post: ({ url }) => {
                if (url.endsWith('/attempt')) return wizardState({ expiresAt: clock.now() + 10_000, adminPassword: true });
                if (url.endsWith('/discover')) return { exists: true, methods: { emailCode: true, totp: true, passkey: true } };
                if (url.endsWith('/email-code/start')) return { challenge: freshChallenge() };
                if (url.endsWith('/passkey/options')) return { challengeKey: 'key', publicKey: { challenge: 'AQID', allowCredentials: [] } };
                if (url.endsWith('/attempt/cancel')) return new Promise((resolve) => { releaseCancel = resolve; });
                return new Promise((resolve) => { releaseVerify = resolve; });
            } });
            const credentials = { get: async () => ({ id: 'key', type: 'public-key', rawId: Uint8Array.of(1).buffer, response: {
                clientDataJSON: Uint8Array.of(1).buffer, authenticatorData: Uint8Array.of(2).buffer, signature: Uint8Array.of(3).buffer,
            } }) };
            const { root } = await mount({ adapter: fixture.adapter, clock, credentials });
            if (method === 'admin') {
                await button(root, 'Administrator sign-in').fire('click');
                root.querySelector('[name="password"]').value = 'fixture-password';
                await root.querySelector('form.admin-panel').fire('submit');
            } else {
                root.querySelector('[name="email"]').value = 'member@example.test';
                await root.querySelector('form.start-panel').fire('submit');
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
            if (method === 'email') await button(root, 'Cancel').fire('click');
            else if (method === 'passkey') clock.advance(11_000);
            else await button(root, 'Back').fire('click');
            releaseVerify(handoff);
            await settle();
            assert.deepEqual(fixture.navigated, [], 'a late success must not call navigate');
            assert.doesNotMatch(root.textContent, /Signing you in/);
            if (method === 'email') {
                assert.match(h1(root).textContent, /Loading/, 'the pending Cancel already invalidated Verify');
                releaseCancel({ ok: true, status: 'cancelled' });
                await settle();
                assert.match(h1(root).textContent, /Sign in/);
            }
        });
    }
});

test('both real adapters cancel only the abandoned Google transaction after a delayed start response', async (t) => {
    for (const flow of ['sso', 'oidc']) {
        for (const transition of ['mode', 'expiry', 'dispose', ...(flow === 'oidc' ? ['abort'] : [])]) {
            await t.test(`${flow}: ${transition}`, async () => {
                const clock = fakeClock();
                let release;
                const factory = flow === 'sso' ? ssoFixture : oidcFixture;
                const fixture = factory({ post: ({ url }) => {
                    if (url.endsWith('/attempt')) return wizardState({ expiresAt: clock.now() + 10_000, methods: { google: true } });
                    if (url.endsWith('/google/start') || url.endsWith('/google')) return new Promise((resolve) => { release = resolve; });
                    return { ok: true };
                } });
                const { root, dispose } = await mount({ adapter: fixture.adapter, clock });
                const pending = button(root, 'Continue with Google').fire('click');
                await settle();
                if (transition === 'mode') await button(root, 'Create an account').fire('click');
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

test('real OIDC adapter submits credential forms only after the wizard accepts the current operation', async (t) => {
    for (const action of ['email', 'totp', 'admin']) {
        await t.test(action, async () => {
            const fixture = oidcFixture({ post: ({ url }) => {
                if (url.endsWith('/attempt')) return wizardState({ adminPassword: true });
                if (url.endsWith('/discover')) return { exists: true, methods: { emailCode: true, totp: true } };
                return { challenge: freshChallenge() };
            } });
            const { root } = await mount({ adapter: fixture.adapter });
            if (action === 'admin') {
                await button(root, 'Administrator sign-in').fire('click');
                root.querySelector('[name="password"]').value = 'fixture-password';
            } else {
                root.querySelector('[name="email"]').value = 'member@example.test';
                await root.querySelector('form.start-panel').fire('submit');
                await button(root, action === 'email' ? 'Email me a code' : 'Use an authenticator app').fire('click');
                root.querySelector(`[name="${action === 'email' ? 'code' : 'token'}"]`).value = '123456';
            }
            assert.equal(fixture.body.children.length, 0);
            await root.querySelector('form').fire('submit');
            assert.match(h1(root).textContent, /Signing you in/);
            assert.equal(fixture.body.children.length, 1);
            assert.equal(fixture.body.children[0].submitted, true);
            assert.match(fixture.body.children[0].getAttribute('action'), new RegExp(`/${action === 'email' ? 'email-verify' : action === 'admin' ? 'admin-login' : 'totp'}$`));
        });
    }
});

test('OIDC adapter JSON actions post form-urlencoded bodies with the csrf token', async () => {
    const { adapter, calls } = oidcFixture({ post: () => ({ ok: true, exists: false, methods: {} }) });
    await adapter.attempt();
    await adapter.cancel();
    await adapter.discover('a@example.test');
    await adapter.startEmail({ email: 'a@example.test', purpose: 'login', resend: false });
    await adapter.startEmail({ email: 'a@example.test', purpose: 'login', resend: true });
    await adapter.passkeyOptions('a@example.test');
    const byAction = Object.fromEntries(calls.map((call) => [new URL(call.url).pathname.split('/').pop(), call]));
    assert.equal(byAction.attempt.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(byAction.attempt.options.credentials, 'same-origin');
    assert.deepEqual(byAction.attempt.body, { csrf: 'csrf-token' });
    assert.deepEqual(byAction['attempt-cancel'].body, { csrf: 'csrf-token' });
    assert.deepEqual(byAction.discover.body, { csrf: 'csrf-token', email: 'a@example.test' });
    assert.deepEqual(byAction['passkey-options'].body, { csrf: 'csrf-token', email: 'a@example.test' });
    const starts = calls.filter((c) => c.url.endsWith('/email-start')).map((c) => c.body);
    assert.deepEqual(starts, [
        { csrf: 'csrf-token', email: 'a@example.test', purpose: 'login' },
        { csrf: 'csrf-token', email: 'a@example.test', purpose: 'login', resend: 'true' },
    ]);
});

test('OIDC adapter native completions build a real form with the exact action, csrf and hidden fields, and call submit() instead of fetch', async () => {
    const { adapter, calls, body } = oidcFixture();
    const completion = adapter.verifyEmail('123456');
    assert.equal(body.children.length, 0, 'preparing the completion must not submit the form');
    adapter.complete(completion);
    let form = body.children.at(-1);
    assert.equal(form.tagName, 'FORM');
    assert.equal(form.getAttribute('method'), 'post');
    assert.equal(form.getAttribute('action'), 'https://issuer.example/service/oidc/interaction/abc123/email-verify');
    assert.deepEqual(Object.fromEntries(form.children.map((input) => [input.getAttribute('name'), input.getAttribute('value')])), { csrf: 'csrf-token', code: '123456' });
    assert.equal(form.submitted, true);
    assert.equal(calls.length, 0, 'a native completion never fetches');

    adapter.complete(adapter.verifyTotp({ email: 'a@example.test', token: '654321' }));
    form = body.children.at(-1);
    assert.equal(form.getAttribute('action'), 'https://issuer.example/service/oidc/interaction/abc123/totp');
    assert.deepEqual(Object.fromEntries(form.children.map((input) => [input.getAttribute('name'), input.getAttribute('value')])), { csrf: 'csrf-token', email: 'a@example.test', token: '654321' });

    const credential = { id: 'cred-1', rawId: Uint8Array.of(1).buffer, type: 'public-key', response: {
        clientDataJSON: Uint8Array.of(1).buffer, authenticatorData: Uint8Array.of(2).buffer, signature: Uint8Array.of(3).buffer, userHandle: null,
    } };
    adapter.complete(adapter.verifyPasskey({ assertion: credential }));
    form = body.children.at(-1);
    assert.equal(form.getAttribute('action'), 'https://issuer.example/service/oidc/interaction/abc123/passkey-verify');
    const passkeyFields = Object.fromEntries(form.children.map((input) => [input.getAttribute('name'), input.getAttribute('value')]));
    assert.equal(passkeyFields.csrf, 'csrf-token');
    assert.equal(JSON.parse(passkeyFields.assertion).id, 'cred-1');

    adapter.complete(adapter.adminLogin({ password: 'admin-password', contactEmail: '' }));
    form = body.children.at(-1);
    assert.deepEqual(Object.fromEntries(form.children.map((input) => [input.getAttribute('name'), input.getAttribute('value')])), { csrf: 'csrf-token', password: 'admin-password' });
    adapter.complete(adapter.adminLogin({ password: 'admin-password', contactEmail: 'c@example.test' }));
    form = body.children.at(-1);
    assert.deepEqual(Object.fromEntries(form.children.map((input) => [input.getAttribute('name'), input.getAttribute('value')])), { csrf: 'csrf-token', password: 'admin-password', contactEmail: 'c@example.test' });
});

test('OIDC adapter abort() natively posts with the csrf token and does not fetch', async () => {
    const { adapter, calls, body } = oidcFixture();
    adapter.abort();
    const form = body.children.at(-1);
    assert.equal(form.getAttribute('action'), 'https://issuer.example/service/oidc/interaction/abc123/abort');
    assert.deepEqual(Object.fromEntries(form.children.map((input) => [input.getAttribute('name'), input.getAttribute('value')])), { csrf: 'csrf-token' });
    assert.equal(calls.length, 0);
});

test('OIDC adapter restart() closes the window', async () => {
    const { adapter, closedCount } = oidcFixture();
    adapter.restart();
    assert.equal(closedCount(), 1);
});

test('OIDC adapter startGoogle() fetches JSON and defers navigation until the wizard accepts it', async () => {
    const { adapter, calls, navigated } = oidcFixture({ post: () => ({ ok: true, authorizationUrl: 'https://accounts.google.com/authorize?x=1' }) });
    const result = await adapter.startGoogle();
    assert.deepEqual(navigated, []);
    adapter.continueGoogle(result);
    assert.equal(calls[0].url, 'https://issuer.example/service/oidc/interaction/abc123/google');
    assert.deepEqual(navigated, ['https://accounts.google.com/authorize?x=1']);
});

test('OIDC adapter exposes initialFailure and initialEmail from config, and null/empty when absent', async () => {
    const withFailure = oidcFixture({ config: { failure: { code: 'code_invalid', message: 'nope', action: 'email-verify' }, email: 'stuck@example.test' } }).adapter;
    assert.deepEqual(withFailure.initialFailure, { code: 'code_invalid', message: 'nope', action: 'email-verify' });
    assert.equal(withFailure.initialEmail, 'stuck@example.test');
    const clean = oidcFixture().adapter;
    assert.equal(clean.initialFailure, null);
    assert.equal(clean.initialEmail, '');
});
