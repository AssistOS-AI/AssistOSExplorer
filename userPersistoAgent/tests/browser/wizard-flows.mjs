import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as oidc from 'openid-client';
import { controlledGoogleProvider } from '../helpers/googleProvider.mjs';
import { startService } from '../../service/index.mjs';
import { ensureSeedData } from '../../lib/bootstrap.mjs';
import { getUserByEmail } from '../../lib/users.mjs';
import { getUserCapabilities } from '../../lib/authorization.mjs';
import { createLoginRequest, consumeAuthCode } from '../../lib/sso.mjs';
import { getInstallationSetup } from '../../lib/setup.mjs';
import { getStore, resetStoreForTests } from '../../lib/store.mjs';
import { createOidcClient } from '../../lib/oidc/clients.mjs';
import { resetOidcProviderForTests } from '../../lib/oidc/provider.mjs';
import { RESEND_COOLDOWN_MS, resetEmailAttemptLimitsForTests } from '../../lib/auth/emailAttempts.mjs';
import { resetKdfForTests } from '../../lib/auth/password.mjs';
import { resetPasswordLimitsForTests } from '../../lib/auth/userPassword.mjs';

// Opt-in browser regression for the email-first wizard on both renderers: the
// Router SSO page and an OIDC interaction in a popup opened by a cross-site
// application. Codes come from a construction-time delivery capture, Google from
// a controlled GIS SDK returning signed JWTs; this is not real Google account
// verification or real mail delivery. Hashing uses the production KDF profile.
// The whole scenario runs twice on fresh installations, without and with `PROD`,
// which must not change any screen or outcome.
const runtimePath = process.env.WIZARD_BROWSER_PLAYWRIGHT_MODULE || process.env.GOOGLE_BROWSER_PLAYWRIGHT_MODULE || '';
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
const artifactRoot = resolve(process.env.WIZARD_BROWSER_ARTIFACT_DIR || join(repoRoot, '.ploinky', 'test-artifacts', 'userpersisto-wizard', runId));
const environment = { ...process.env };
const output = console.log.bind(console);
const MANAGED_ENVIRONMENT = ['PROD', 'USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED',
    'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_DEV_BOOTSTRAP'];
let phase = 'loading the explicitly selected Playwright runtime';
let browser;
const installation = { folder: '', service: null, application: null, google: null };

async function closeServer(server) {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
}

function attachRouterCallback(server) {
    const handlers = server.listeners('request');
    assert.equal(handlers.length, 1, 'The fixture wraps one real UserPersisto request handler.');
    server.removeListener('request', handlers[0]);
    server.on('request', (req, res) => {
        if (req.method === 'GET' && new URL(req.url, 'http://fixture').pathname === '/auth/callback') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<h1>Router callback</h1>');
            return;
        }
        return handlers[0].call(server, req, res);
    });
}

// Screenshots are taken before a secret is typed; secret-bearing inputs are masked anyway.
async function screenshot(page, name) {
    await page.screenshot({ path: join(artifactRoot, `${name}.png`), fullPage: true,
        mask: [page.locator('input[type="password"], input[name="code"], input[name="token"]')] });
}

// Attributes and emptiness only; a secret value never leaves the page.
function inputFacts(page, selector) {
    return page.locator(selector).evaluate((input) => ({
        type: input.type, autocomplete: input.getAttribute('autocomplete'), maxlength: input.hasAttribute('maxlength'),
        empty: input.value === '', disabled: input.disabled, readOnly: input.readOnly,
    }));
}

function startControls(page) {
    return page.locator('form.start-panel').evaluate((form) => [...form.children]
        .filter((node) => ['BUTTON', 'LABEL', 'INPUT'].includes(node.tagName))
        .map((node) => node.tagName === 'INPUT' ? `input:${node.name}` : node.textContent.trim()));
}

function countPosts(page, pathname) {
    const counter = { count: 0 };
    page.on('request', (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === pathname) counter.count += 1;
    });
    return counter;
}

// Native OIDC completions are top-level form POSTs; record whether each carried
// the browser proof cookie without reading or keeping its value.
function trackNativePosts(page) {
    const pending = [];
    page.on('request', (request) => {
        if (request.method() !== 'POST' || !request.isNavigationRequest()) return;
        const action = new URL(request.url()).pathname.split('/').pop();
        pending.push(request.allHeaders().then((headers) => ({ action, carriesProof: /(?:^|;\s*)up_browser=/.test(headers.cookie || '') })));
    });
    return async (action) => (await Promise.all(pending)).filter((post) => post.action === action).map((post) => post.carriesProof);
}

async function runInitialPasswordSetup({ label, prefix, prod }) {
    phase = `${label}: initializing first-user password setup without email delivery`;
    installation.folder = await mkdtemp(join(tmpdir(), 'userpersisto-initial-password-browser-'));
    for (const name of MANAGED_ENVIRONMENT) delete process.env[name];
    if (prod !== undefined) process.env.PROD = prod;
    process.env.PERSISTENCE_FOLDER = installation.folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'initial-password-browser-fixture-settings-key';
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
    resetEmailAttemptLimitsForTests();
    resetPasswordLimitsForTests();
    resetKdfForTests();
    await ensureSeedData();
    let emailRequests = 0;
    const service = installation.service = startService({ port: 0, host: '127.0.0.1' }, {
        emailStatus: async () => ({ available: false }),
        deliverEmail: async () => { emailRequests++; throw new Error('Email delivery is unavailable in this fixture'); },
    });
    attachRouterCallback(service);
    if (!service.listening) await once(service, 'listening');
    const origin = `http://localhost:${service.address().port}`;
    process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${origin}/service/auth/google/callback`;
    const browserErrors = [];
    async function open() {
        const request = await createLoginRequest({ redirectUri: `${origin}/auth/callback` });
        const context = await browser.newContext();
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.on('pageerror', (error) => browserErrors.push(error.message));
        await page.goto(`${origin}/service/auth/?requestId=${encodeURIComponent(request.providerState)}&state=initial-setup-state`);
        await page.locator('form.start-panel').waitFor();
        return { request, context, page };
    }
    async function complete(flow) {
        await flow.page.getByRole('heading', { name: 'Router callback', exact: true }).waitFor();
        const callback = new URL(flow.page.url());
        assert.equal(callback.origin, origin);
        assert.equal(callback.pathname, '/auth/callback');
        assert.equal(callback.searchParams.get('state'), 'initial-setup-state');
        return consumeAuthCode({ providerState: flow.request.providerState, code: callback.searchParams.get('code') });
    }
    const first = await open();
    const waiting = await open(); // Its boot configuration predates the first claim.
    assert.deepEqual(await startControls(first.page), ['Sign in with Google', 'Email', 'input:email', 'Next']);
    await first.page.getByRole('textbox', { name: 'Email', exact: true }).fill('initial-owner@example.test');
    await first.page.getByRole('button', { name: 'Next', exact: true }).click();
    await first.page.getByRole('heading', { name: 'Enter your password', exact: true }).waitFor();
    await first.page.getByText('First-time setup: enter admin to create this workspace’s first administrator.', { exact: true }).waitFor();
    assert.equal(await first.page.getByRole('button', { name: 'Sign up', exact: true }).count(), 0);
    assert.equal(await first.page.getByRole('button', { name: 'Administrator sign-in', exact: true }).count(), 0);
    await screenshot(first.page, `${prefix}-00-initial-password-no-email`);

    phase = `${label}: first-user setup rejects nonexact admin and creates an unverified administrator with exact admin`;
    await first.page.getByLabel('Password', { exact: true }).fill('Admin');
    await first.page.getByRole('button', { name: 'Log in', exact: true }).click();
    await first.page.getByText('That password is not correct. Try again or choose another way to sign in.', { exact: true }).waitFor();
    assert.equal((await inputFacts(first.page, '#auth-password')).empty, true);
    assert.equal((await getInstallationSetup()).complete, false);
    assert.equal(await getUserByEmail('initial-owner@example.test'), null);
    await first.page.getByLabel('Password', { exact: true }).fill('admin');
    await first.page.getByRole('button', { name: 'Log in', exact: true }).click();
    const administrator = await complete(first);
    assert.deepEqual(administrator.roles, ['admin']);
    assert.equal(administrator.user.email, 'initial-owner@example.test');
    assert.equal(Boolean((await getUserByEmail(administrator.user.email)).emailVerifiedAt), false);
    await first.context.close();

    phase = `${label}: a stale first-run page cannot offer bootstrap to the second email`;
    await waiting.page.getByRole('textbox', { name: 'Email', exact: true }).fill('second-unknown@example.test');
    await waiting.page.getByRole('button', { name: 'Next', exact: true }).click();
    await waiting.page.getByRole('heading', { name: 'Create an account with Google', exact: true }).waitFor();
    assert.equal(await waiting.page.locator('input[type="password"]').count(), 0);
    assert.equal(await getUserByEmail('second-unknown@example.test'), null);
    await waiting.context.close();

    phase = `${label}: the first administrator returns through ordinary account password login`;
    const returning = await open();
    await returning.page.getByRole('textbox', { name: 'Email', exact: true }).fill(administrator.user.email);
    await returning.page.getByRole('button', { name: 'Next', exact: true }).click();
    await returning.page.getByRole('heading', { name: 'Enter your password', exact: true }).waitFor();
    assert.equal(await returning.page.getByText('First-time setup:', { exact: false }).count(), 0);
    await returning.page.getByLabel('Password', { exact: true }).fill('admin');
    await returning.page.getByRole('button', { name: 'Log in', exact: true }).click();
    assert.equal((await complete(returning)).user.id, administrator.user.id);
    assert.equal(emailRequests, 0);
    assert.deepEqual(browserErrors, []);
    assert.equal((await (await getStore()).select('user')).totalCount, 1);
    await returning.context.close();
}

async function runInstallation({ label, prefix, prod, waitForCooldown }) {
    const mail = [];
    const rejectNextDelivery = new Set();
    const browserErrors = [];
    // Per-run fixture passwords, never printed or captured. The owner's contains
    // supplementary-plane characters, one of which NFKC maps to a Latin letter.
    const secret = () => randomBytes(12).toString('base64url');
    const passwords = { owner: `fixture ${secret()} \u{1F98A}\u{1D4B3}`, member: `fixture ${secret()}`, oidcMember: `fixture ${secret()}` };
    const shot = (page, name) => screenshot(page, `${prefix}-${name}`);
    const watch = (page, name) => page.on('pageerror', (error) => browserErrors.push(`${name}: ${error.message}`));
    const latestCode = (address) => {
        const message = [...mail].reverse().find((entry) => entry.to === address && entry.delivered);
        assert.ok(message, `A code must have been delivered to ${address}.`);
        return message.code;
    };
    const wrongCode = (address) => latestCode(address) === '000000' ? '111111' : '000000';

    phase = `${label}: initializing isolated provider and persistence`;
    installation.folder = await mkdtemp(join(tmpdir(), 'userpersisto-wizard-browser-'));
    for (const name of MANAGED_ENVIRONMENT) delete process.env[name];
    if (prod !== undefined) process.env.PROD = prod;
    process.env.PERSISTENCE_FOLDER = installation.folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'wizard-browser-fixture-settings-key';
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
    resetEmailAttemptLimitsForTests();
    resetPasswordLimitsForTests();
    resetKdfForTests();
    await ensureSeedData();
    const google = installation.google = await controlledGoogleProvider();
    const service = installation.service = startService({ port: 0, host: '127.0.0.1' }, {
        google: { protocol: google.protocol },
        deliverEmail: async (message) => {
            const rejected = rejectNextDelivery.delete(message.to);
            mail.push({ ...message, delivered: !rejected });
            return rejected ? { delivered: false, result: 'rejected' } : { delivered: true, providerMessageId: 'browser-fixture' };
        },
    });
    // Google completes through an HTTP redirect chain. Playwright route hooks
    // only intercept its first URL, so the fixture serves the Router callback.
    attachRouterCallback(service);
    if (!service.listening) await once(service, 'listening');
    // The identity service is `localhost`; the application is `127.0.0.1`, a different site.
    const providerOrigin = `http://localhost:${service.address().port}`;
    process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${providerOrigin}/service/auth/google/callback`;
    const issuer = `${providerOrigin}/service/oidc`;
    process.env.USERPERSISTO_OIDC_ISSUER = issuer;

    // ---- Router SSO renderer -------------------------------------------------
    async function ssoPage({ clock = false } = {}) {
        const request = await createLoginRequest({ redirectUri: `${providerOrigin}/auth/callback` });
        const context = await browser.newContext();
        await google.installBrowserSdk(context);
        const callbacks = new Map();
        const open = async () => {
            const page = await context.newPage();
            page.setDefaultTimeout(15_000);
            watch(page, 'sso');
            // Observe the handoff for both direct navigation and HTTP redirects.
            page.on('request', (navigation) => {
                const target = new URL(navigation.url());
                if (navigation.isNavigationRequest() && target.origin === providerOrigin && target.pathname === '/auth/callback') callbacks.set(page, target);
            });
            return page;
        };
        const page = await open();
        if (clock) await page.clock.install();
        const url = `${providerOrigin}/service/auth/?requestId=${encodeURIComponent(request.providerState)}&state=router-core-state`;
        await page.goto(url);
        return { request, context, page, url, open, callbacks };
    }
    async function reachCallback(flow, page) {
        await page.getByRole('heading', { name: 'Router callback' }).waitFor();
        const target = flow.callbacks.get(page);
        assert.ok(target, 'The wizard must navigate to the stored Router callback.');
        assert.equal(target.origin, providerOrigin);
        assert.equal(target.pathname, '/auth/callback');
        assert.equal(target.searchParams.get('state'), 'router-core-state', 'The Router state must be preserved.');
        return target;
    }
    const consume = (flow, target) => consumeAuthCode({ providerState: flow.request.providerState, code: target.searchParams.get('code') });
    const next = (page) => page.getByRole('button', { name: 'Next', exact: true }).click();
    const heading = (page, name) => page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
    const alert = (page, text) => page.locator('[role="alert"]').filter({ hasText: text }).first().waitFor();
    const resendButton = (page) => page.locator('form.signup-code-panel button.auth-secondary');
    async function createPassword(page, password, confirmation = password) {
        await page.getByLabel('Password', { exact: true }).fill(password);
        await page.getByLabel('Confirm password', { exact: true }).fill(confirmation);
        await page.getByRole('button', { name: 'Create account', exact: true }).click();
    }

    phase = `${label}: SSO start screen offers Google, Email and Next only`;
    let flow = await ssoPage();
    await flow.page.locator('form.start-panel').waitFor();
    await heading(flow.page, 'Sign in');
    await flow.page.getByText('This workspace is not set up yet. The first completed sign-in becomes its administrator.').waitFor();
    assert.deepEqual(await startControls(flow.page), ['Sign in with Google', 'Email', 'input:email', 'Next']);
    assert.equal(await flow.page.locator('input[type="password"]').count(), 0, 'The start screen has no password field.');
    assert.equal(await flow.page.getByRole('button', { name: /Administrator|Create an account|Register|Log in/ }).count(), 0,
        'The start screen has no administrator control or mode switch.');
    await shot(flow.page, '01-sso-start-first-run');

    phase = `${label}: SSO unknown email offers signup and a new-password form`;
    const signupStarts = countPosts(flow.page, '/service/auth/signup/start');
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('owner@example.test');
    await next(flow.page);
    await heading(flow.page, 'Enter your password');
    await flow.page.getByText('First-time setup: enter admin to create this workspace’s first administrator.', { exact: true }).waitFor();
    await shot(flow.page, '02-sso-first-setup-choice');
    await flow.page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await heading(flow.page, 'Create your password');
    for (const selector of ['#auth-new-password', '#auth-confirm-password']) {
        const facts = await inputFacts(flow.page, selector);
        assert.deepEqual([facts.type, facts.autocomplete, facts.maxlength, facts.empty], ['password', 'new-password', false, true], `${selector} attributes`);
    }
    const signupAccount = await inputFacts(flow.page, '#auth-signup-email');
    assert.deepEqual([signupAccount.autocomplete, signupAccount.readOnly], ['username', true]);
    assert.equal(await flow.page.locator('#auth-signup-email').inputValue(), 'owner@example.test');
    await shot(flow.page, '03-sso-create-password');

    phase = `${label}: SSO password creation refuses a mismatch and a short password locally`;
    await createPassword(flow.page, passwords.owner, `${passwords.owner}!`);
    await alert(flow.page, 'The passwords do not match.');
    assert.equal((await inputFacts(flow.page, '#auth-confirm-password')).empty, true, 'A mismatched confirmation is emptied.');
    assert.equal(await flow.page.evaluate(() => document.activeElement?.id), 'auth-confirm-password');
    await createPassword(flow.page, 'short value', 'short value');
    await alert(flow.page, 'Use at least 15 characters.');
    assert.equal(signupStarts.count, 0, 'Predictable password errors never reach the server.');

    phase = `${label}: SSO a lost response resumes the staged password after a failed first delivery`;
    rejectNextDelivery.add('owner@example.test');
    let releaseSignupStart;
    let receivedSignupStart;
    const staged = new Promise((resolve) => { receivedSignupStart = resolve; });
    const heldSignup = new Promise((resolve) => { releaseSignupStart = resolve; });
    await flow.page.route('**/service/auth/signup/start', async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await response.body();
        receivedSignupStart();
        await heldSignup;
        await route.abort('failed');
    });
    try {
        await createPassword(flow.page, passwords.owner);
        await staged;
        assert.equal(await flow.page.getByRole('button', { name: 'Back', exact: true }).isDisabled(), true);
    } finally { releaseSignupStart(); }
    await heading(flow.page, 'We could not send the code');
    assert.equal(signupStarts.count, 1);
    assert.equal(await flow.page.getByRole('textbox', { name: 'Code' }).isDisabled(), true);
    assert.equal(await flow.page.getByRole('button', { name: 'Verify', exact: true }).isDisabled(), true);
    assert.equal(await flow.page.getByRole('button', { name: 'Send again', exact: true }).isEnabled(), true);
    assert.equal(await flow.page.locator('input[type="password"]').count(), 0, 'No password input remains after staging.');
    assert.equal(await getUserByEmail('owner@example.test'), null, 'A staged signup creates no account.');
    assert.equal((await getInstallationSetup()).complete, false);
    await shot(flow.page, '04-sso-send-failed');
    await flow.page.getByRole('button', { name: 'Send again', exact: true }).click();
    await heading(flow.page, 'Enter the 6-digit code sent to owner@example.test');
    await flow.page.getByText('We sent a code to owner@example.test.').waitFor();
    assert.equal(signupStarts.count, 1, 'Send again does not submit the password again.');
    assert.deepEqual(mail.filter((message) => message.to === 'owner@example.test').map((message) => [message.purpose, message.delivered]),
        [['signup-verification', false], ['signup-verification', true]]);
    assert.match(await resendButton(flow.page).textContent(), /^Resend code in \d+ s$/);
    assert.equal(await resendButton(flow.page).isDisabled(), true, 'Resend waits for the cooldown.');
    await shot(flow.page, '05-sso-signup-code');

    phase = `${label}: SSO reloading during verification resumes without a password prompt`;
    await flow.page.reload();
    await heading(flow.page, 'Enter the 6-digit code sent to owner@example.test');
    assert.equal(await flow.page.locator('input[type="password"]').count(), 0);

    phase = `${label}: SSO a wrong signup code, then the right one signs the first administrator in`;
    await flow.page.getByRole('textbox', { name: 'Code' }).fill(wrongCode('owner@example.test'));
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await alert(flow.page, 'That code is not correct. 4 attempts left.');
    assert.equal((await inputFacts(flow.page, '#auth-code')).empty, true, 'A refused code is cleared.');
    assert.equal(await getUserByEmail('owner@example.test'), null);
    await flow.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('owner@example.test'));
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    const owner = await consume(flow, await reachCallback(flow, flow.page));
    assert.deepEqual(owner.roles, ['admin']);
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.user.id);
    await flow.context.close();

    phase = `${label}: SSO a second signup changes its email without a password prompt`;
    flow = await ssoPage();
    await flow.page.locator('form.start-panel').waitFor();
    assert.equal(await flow.page.getByText('This workspace is not set up yet.', { exact: false }).count(), 0, 'The first-run notice ends once claimed.');
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('first.member@example.test');
    await next(flow.page);
    await flow.page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await createPassword(flow.page, passwords.member);
    await heading(flow.page, 'Enter the 6-digit code sent to first.member@example.test');
    await flow.page.getByRole('button', { name: 'Change email', exact: true }).click();
    await heading(flow.page, 'Change your email');
    assert.equal(await flow.page.getByRole('textbox', { name: 'Email' }).inputValue(), 'first.member@example.test');
    assert.equal(await flow.page.locator('input[type="password"]').count(), 0, 'Changing the email never asks for the password.');
    await flow.page.getByText('The password you chose is kept.').waitFor();
    await shot(flow.page, '06-sso-change-email');
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('member@example.test');
    let releaseEmailChange;
    let receivedEmailChange;
    const changed = new Promise((resolve) => { receivedEmailChange = resolve; });
    const held = new Promise((resolve) => { releaseEmailChange = resolve; });
    await flow.page.route('**/service/auth/signup/email', async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await response.body();
        receivedEmailChange();
        await held;
        await route.abort('failed'); // The browser must recover the server's new address.
    });
    try {
        await flow.page.getByRole('button', { name: 'Send code', exact: true }).click();
        await changed;
        assert.equal(await flow.page.getByRole('button', { name: 'Back', exact: true }).isDisabled(), true);
        assert.equal(await flow.page.getByRole('textbox', { name: 'Email' }).isDisabled(), true);
    } finally { releaseEmailChange(); }
    await heading(flow.page, 'Enter the 6-digit code sent to member@example.test');
    const staleCode = latestCode('first.member@example.test');
    if (staleCode !== latestCode('member@example.test')) {
        await flow.page.getByRole('textbox', { name: 'Code' }).fill(staleCode);
        await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
        await alert(flow.page, 'That code is not correct.');
    }

    phase = `${label}: SSO a second tab resumes the same pending signup`;
    const secondTab = await flow.open();
    await secondTab.goto(flow.url);
    await heading(secondTab, 'Enter the 6-digit code sent to member@example.test');
    assert.equal(await secondTab.locator('input[type="password"]').count(), 0);
    await shot(secondTab, '07-sso-second-tab');

    phase = `${label}: SSO resend honors its cooldown`;
    const resend = resendButton(flow.page);
    if (waitForCooldown) {
        await flow.page.waitForFunction(() => {
            const button = document.querySelector('form.signup-code-panel button.auth-secondary');
            return Boolean(button && !button.disabled && button.textContent === 'Resend code');
        }, null, { timeout: RESEND_COOLDOWN_MS + 20_000, polling: 500 });
        const resent = flow.page.waitForResponse((response) => new URL(response.url()).pathname === '/service/auth/signup/resend');
        await resend.click();
        assert.equal((await resent).status(), 200);
        await flow.page.locator('form.signup-code-panel button.auth-secondary:disabled').waitFor();
        assert.equal(mail.filter((message) => message.to === 'member@example.test' && message.delivered).length, 2);
    } else {
        assert.match(await resend.textContent(), /^Resend code in \d+ s$/);
        assert.equal(await resend.isDisabled(), true);
    }

    phase = `${label}: SSO the second tab completes and the first tab replays the same sign-in`;
    const memberCode = latestCode('member@example.test');
    await secondTab.getByRole('textbox', { name: 'Code' }).fill(memberCode);
    await secondTab.getByRole('button', { name: 'Verify', exact: true }).click();
    const memberCallback = await reachCallback(flow, secondTab);
    await flow.page.getByRole('textbox', { name: 'Code' }).fill(memberCode);
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    const replayedCallback = await reachCallback(flow, flow.page);
    assert.equal(replayedCallback.searchParams.get('code') === memberCallback.searchParams.get('code'), true, 'Both tabs receive the one staged handoff.');
    const member = await consume(flow, memberCallback);
    assert.deepEqual(member.roles, ['selfRegistered']);
    assert.equal((await getUserCapabilities(member.user.id)).includes('explorer.access'), false,
        'Without explorer.access the Router sends this account to My Account.');
    assert.equal(await getUserByEmail('first.member@example.test'), null, 'The abandoned address never became an account.');
    await flow.context.close();

    phase = `${label}: SSO a registered email opens the password screen`;
    flow = await ssoPage();
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('owner@example.test');
    await next(flow.page);
    await heading(flow.page, 'Enter your password');
    const current = await inputFacts(flow.page, '#auth-password');
    assert.deepEqual([current.type, current.autocomplete, current.maxlength, current.disabled, current.empty], ['password', 'current-password', false, false, true]);
    const passwordAccount = await inputFacts(flow.page, '#auth-account-email');
    assert.deepEqual([passwordAccount.autocomplete, passwordAccount.readOnly], ['username', true]);
    await shot(flow.page, '08-sso-password');

    phase = `${label}: SSO transitions empty the password input`;
    await flow.page.getByLabel('Password', { exact: true }).fill(passwords.owner);
    await flow.page.getByRole('button', { name: 'Try another way', exact: true }).click();
    await heading(flow.page, 'Try another way');
    await flow.page.getByRole('button', { name: 'Use your password', exact: true }).click();
    await heading(flow.page, 'Enter your password');
    assert.equal((await inputFacts(flow.page, '#auth-password')).empty, true, 'Returning to the password screen shows an empty input.');
    await flow.page.getByLabel('Password', { exact: true }).fill(passwords.owner);
    await flow.page.getByRole('button', { name: 'Back', exact: true }).click();
    await flow.page.locator('form.start-panel').waitFor();
    assert.equal(await flow.page.getByRole('textbox', { name: 'Email' }).inputValue(), 'owner@example.test', 'Back keeps the email.');
    assert.equal(await flow.page.locator('input[type="password"]').count(), 0);
    await next(flow.page);
    await heading(flow.page, 'Enter your password');
    assert.equal((await inputFacts(flow.page, '#auth-password')).empty, true);

    phase = `${label}: SSO a wrong password is refused neutrally and cleared`;
    await flow.page.getByLabel('Password', { exact: true }).fill(`fixture incorrect ${randomBytes(6).toString('hex')}`);
    await flow.page.getByRole('button', { name: 'Log in', exact: true }).click();
    await alert(flow.page, 'That password is not correct. Try again or choose another way to sign in.');
    assert.equal((await inputFacts(flow.page, '#auth-password')).empty, true, 'A refused password is cleared.');

    phase = `${label}: SSO password login with supplementary-plane characters signs the administrator in`;
    await flow.page.getByLabel('Password', { exact: true }).fill(passwords.owner);
    await flow.page.getByRole('button', { name: 'Log in', exact: true }).click();
    assert.equal((await consume(flow, await reachCallback(flow, flow.page))).user.id, owner.user.id);
    await flow.context.close();

    phase = `${label}: SSO Try another way lists three alternatives and signs in with an email code`;
    flow = await ssoPage();
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('member@example.test');
    await next(flow.page);
    await heading(flow.page, 'Enter your password');
    await flow.page.getByRole('button', { name: 'Try another way', exact: true }).click();
    await heading(flow.page, 'Try another way');
    const entries = await flow.page.locator('.auth-method').evaluateAll((nodes) => nodes.map((node) => ({
        label: node.querySelector('button').textContent, disabled: node.querySelector('button').disabled,
        reason: node.querySelector('.auth-method-reason')?.textContent || '',
    })));
    assert.deepEqual(entries.map((entry) => entry.label), ['Email me a code', 'Use a passkey', 'Use an authenticator app']);
    assert.deepEqual([entries[0].disabled, entries[0].reason], [false, '']);
    for (const entry of entries.slice(1)) {
        assert.equal(entry.disabled, true, entry.label);
        assert.ok(['Not available for this account.', 'Not available in this browser or at this address.'].includes(entry.reason), entry.label);
    }
    await flow.page.getByText('Sign-in methods are managed from My Account after you sign in.').waitFor();
    await shot(flow.page, '09-sso-try-another-way');
    await flow.page.getByRole('button', { name: 'Email me a code', exact: true }).click();
    await heading(flow.page, 'Enter the 6-digit code sent to member@example.test');
    await flow.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('member@example.test'));
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    assert.equal((await consume(flow, await reachCallback(flow, flow.page))).user.id, member.user.id);
    await flow.context.close();

    phase = `${label}: SSO Google cancellation returns to the start screen with its notice`;
    flow = await ssoPage();
    await flow.page.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await flow.page.getByRole('button', { name: 'Back to sign-in', exact: true }).click();
    await flow.page.getByText('Google sign-in was cancelled.').waitFor();
    await flow.page.locator('form.start-panel').waitFor();
    await shot(flow.page, '10-sso-google-cancelled');
    // Narrow phones keep the whole panel inside the viewport, and Tab reaches the controls in order.
    await flow.page.setViewportSize({ width: 360, height: 740 });
    assert.equal(await flow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow at 360 px.');
    await shot(flow.page, '10b-sso-narrow');
    await flow.page.getByRole('textbox', { name: 'Email' }).focus();
    await flow.page.keyboard.press('Tab');
    assert.equal(await flow.page.evaluate(() => document.activeElement?.textContent), 'Next', 'Tab moves from the email field to Next.');

    phase = `${label}: SSO controlled Google sign-in creates a selfRegistered account`;
    await flow.page.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await flow.page.getByRole('button', { name: 'Continue with test identity', exact: true }).click();
    const googleAccount = await consume(flow, await reachCallback(flow, flow.page));
    assert.equal(googleAccount.user.email, google.state.email);
    assert.deepEqual(googleAccount.roles, ['selfRegistered']);
    await flow.context.close();

    phase = `${label}: SSO an account without a password sees the neutral unavailable state`;
    flow = await ssoPage();
    await flow.page.getByRole('textbox', { name: 'Email' }).fill(google.state.email);
    await next(flow.page);
    await heading(flow.page, 'Enter your password');
    assert.equal((await inputFacts(flow.page, '#auth-password')).disabled, true);
    assert.equal(await flow.page.getByRole('button', { name: 'Log in', exact: true }).isDisabled(), true);
    await flow.page.getByText('Password sign-in is not available for this account here. Choose Try another way.').waitFor();
    assert.equal(await flow.page.evaluate(() => document.activeElement?.textContent), 'Try another way', 'Focus moves to Try another way.');
    assert.doesNotMatch(await flow.page.locator('#auth_content').innerText(), /Google|blocked/i, 'Nothing discloses Google linkage or status.');
    await shot(flow.page, '11-sso-password-unavailable');
    await flow.context.close();

    phase = `${label}: SSO the countdown reaches expiry and offers Start again`;
    flow = await ssoPage({ clock: true });
    await flow.page.locator('form.start-panel').waitFor();
    assert.match(await flow.page.locator('.auth-timer').textContent(), /^Expires in [0-5]:\d\d$/);
    let restart = null;
    await flow.page.route('**/auth/login?**', async (route) => {
        restart = new URL(route.request().url());
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Router login</h1>' });
    });
    await flow.page.clock.fastForward('05:30');
    await heading(flow.page, 'This sign-in request expired');
    assert.equal(await flow.page.locator('.auth-timer').count(), 0, 'The expired screen has no countdown.');
    await shot(flow.page, '12-sso-expired');
    await flow.page.getByRole('button', { name: 'Start again', exact: true }).click();
    await flow.page.getByRole('heading', { name: 'Router login' }).waitFor();
    assert.equal(restart?.pathname, '/auth/login');
    assert.equal(restart.searchParams.get('prompt'), 'login');
    await flow.context.close();

    // ---- OIDC renderer in a popup opened by a cross-site application --------
    phase = `${label}: OIDC preparing the cross-site relying party`;
    let config;
    let callbackUri;
    const completions = [];
    const attempts = new Map();
    installation.application = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, callbackUri);
            if (url.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end('<h1>Application</h1><button id="open">Sign in with UserPersisto</button><script>document.getElementById("open").onclick = () => window.open("/start" + location.search, "userpersisto", "width=520,height=720");</script>');
            }
            if (url.pathname === '/start') {
                const state = oidc.randomState();
                const nonce = oidc.randomNonce();
                const verifier = oidc.randomPKCECodeVerifier();
                attempts.set(state, { nonce, verifier });
                const target = oidc.buildAuthorizationUrl(config, { redirect_uri: callbackUri, scope: 'openid email roles', prompt: 'login', state, nonce,
                    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
                    ...(url.searchParams.get('hint') === 'signup' ? { screen_hint: 'signup' } : {}) });
                res.writeHead(302, { Location: target.href });
                return res.end();
            }
            if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }
            const state = url.searchParams.get('state');
            const attempt = attempts.get(state);
            attempts.delete(state);
            const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: attempt.verifier, expectedState: state, expectedNonce: attempt.nonce });
            completions.push({ sub: tokens.claims().sub });
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<h1>Client completed</h1>');
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            return res.end('<h1>Client verification failed</h1>');
        }
    });
    installation.application.listen(0, '127.0.0.1');
    await once(installation.application, 'listening');
    const applicationOrigin = `http://127.0.0.1:${installation.application.address().port}`;
    callbackUri = `${applicationOrigin}/callback`;
    await createOidcClient({ client_id: 'wizard-browser-regression', client_name: 'Wizard regression application', redirect_uris: [callbackUri],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], scope: 'openid email roles' }, { actorId: owner.user.id });
    config = await oidc.discovery(new URL(issuer), 'wizard-browser-regression', undefined, oidc.None(), { execute: [oidc.allowInsecureRequests] });

    async function popup({ hint = '' } = {}) {
        const context = await browser.newContext();
        await google.installBrowserSdk(context);
        const opener = await context.newPage();
        watch(opener, 'application');
        await opener.goto(hint ? `${applicationOrigin}/?hint=${hint}` : applicationOrigin);
        const [page] = await Promise.all([context.waitForEvent('page'), opener.click('#open')]);
        page.setDefaultTimeout(15_000);
        watch(page, 'oidc');
        const nativePosts = trackNativePosts(page);
        await page.locator('form.start-panel').waitFor();
        return { context, page, nativePosts };
    }

    phase = `${label}: OIDC screen_hint=signup opens Create your account with a strict browser proof`;
    let session = await popup({ hint: 'signup' });
    await heading(session.page, 'Create your account');
    await session.page.getByText('Wizard regression application').first().waitFor();
    assert.deepEqual(await startControls(session.page), ['Sign in with Google', 'Email', 'input:email', 'Next', 'Cancel']);
    const binding = (await session.context.cookies(`${providerOrigin}/service/`)).find((cookie) => cookie.name === 'up_browser');
    assert.ok(binding, 'The wizard must bind the attempt to this browser.');
    assert.deepEqual([binding.httpOnly, binding.sameSite, binding.path], [true, 'Strict', '/service/'], 'The browser proof is HttpOnly, SameSite=Strict and scoped to the service.');
    await shot(session.page, '13-oidc-signup-start');

    phase = `${label}: OIDC signup verification re-renders a wrong code, then completes before consent`;
    await session.page.getByRole('textbox', { name: 'Email' }).fill('oidc.member@example.test');
    await next(session.page);
    await session.page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await createPassword(session.page, passwords.oidcMember);
    await heading(session.page, 'Enter the 6-digit code sent to oidc.member@example.test');
    await session.page.getByRole('textbox', { name: 'Code' }).fill(wrongCode('oidc.member@example.test'));
    await session.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await alert(session.page, 'That code is not correct.');
    await heading(session.page, 'Enter the 6-digit code sent to oidc.member@example.test');
    assert.equal((await inputFacts(session.page, '#auth-code')).empty, true);
    await shot(session.page, '14-oidc-signup-wrong-code');
    await session.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('oidc.member@example.test'));
    await session.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await session.page.getByRole('button', { name: 'Allow access', exact: true }).waitFor();
    const oidcMember = await getUserByEmail('oidc.member@example.test');
    assert.ok(oidcMember, 'Verification creates the account before application consent.');
    await session.page.getByRole('button', { name: 'Allow access', exact: true }).click();
    await session.page.getByRole('heading', { name: 'Client completed' }).waitFor();
    assert.equal(completions.at(-1).sub, oidcMember.id, 'The application receives the local account id.');
    assert.deepEqual(await session.nativePosts('signup-verify'), [true, true], 'Both native signup-verify POSTs carried the browser proof.');
    await session.context.close();

    phase = `${label}: OIDC a wrong password re-renders the password screen`;
    session = await popup();
    await heading(session.page, 'Sign in');
    await session.page.getByRole('textbox', { name: 'Email' }).fill('owner@example.test');
    await next(session.page);
    await heading(session.page, 'Enter your password');
    await session.page.getByLabel('Password', { exact: true }).fill(`fixture incorrect ${randomBytes(6).toString('hex')}`);
    await session.page.getByRole('button', { name: 'Log in', exact: true }).click();
    await alert(session.page, 'That password is not correct. Try again or choose another way to sign in.');
    await heading(session.page, 'Enter your password');
    assert.equal((await inputFacts(session.page, '#auth-password')).empty, true, 'The re-rendered password input is empty.');
    await shot(session.page, '15-oidc-wrong-password');

    phase = `${label}: OIDC password login by the administrator account still requires separate consent`;
    await session.page.getByLabel('Password', { exact: true }).fill(passwords.owner);
    await session.page.getByRole('button', { name: 'Log in', exact: true }).click();
    await session.page.getByRole('button', { name: 'Allow access', exact: true }).waitFor();
    await shot(session.page, '16-oidc-consent-after-password');
    await session.page.getByRole('button', { name: 'Allow access', exact: true }).click();
    await session.page.getByRole('heading', { name: 'Client completed' }).waitFor();
    assert.equal(completions.at(-1).sub, owner.user.id);
    assert.deepEqual(await session.nativePosts('password-login'), [true, true], 'Both native password-login POSTs carried the browser proof.');
    await session.context.close();

    const store = await getStore();
    assert.equal((await store.select('user')).totalCount, 4, 'Only the four completed sign-ups created accounts.');
    assert.deepEqual(browserErrors, [], 'No page may raise an uncaught error.');
}

async function teardownInstallation() {
    await Promise.allSettled([closeServer(installation.application), closeServer(installation.service), installation.google?.close()]);
    installation.application = null;
    installation.service = null;
    installation.google = null;
    resetOidcProviderForTests();
    await resetStoreForTests();
    if (installation.folder) await rm(installation.folder, { recursive: true, force: true });
    installation.folder = '';
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
    Object.assign(process.env, environment);
}

async function verify() {
    assert.ok(isAbsolute(runtimePath), 'WIZARD_BROWSER_PLAYWRIGHT_MODULE (or GOOGLE_BROWSER_PLAYWRIGHT_MODULE) must name an absolute Playwright module path.');
    const { chromium } = await import(pathToFileURL(runtimePath).href);
    assert.ok(chromium?.launch, 'The selected module must export Playwright chromium.');
    await mkdir(artifactRoot, { recursive: true });

    phase = 'launching Chromium';
    browser = await chromium.launch({
        headless: process.env.WIZARD_BROWSER_HEADED !== 'true',
        ...(process.env.WIZARD_BROWSER_EXECUTABLE ? { executablePath: process.env.WIZARD_BROWSER_EXECUTABLE } : {}),
    });
    const runs = [
        { label: 'PROD absent', prefix: 'a', prod: undefined, waitForCooldown: true },
        { label: 'PROD present', prefix: 'b', prod: 'true', waitForCooldown: false },
    ];
    // A failure leaves the installation open so its pages can be captured first.
    for (const run of runs) {
        await runInitialPasswordSetup(run);
        await teardownInstallation();
        await runInstallation(run);
        await teardownInstallation();
    }
    output(`PASS Chromium ${browser.version()}: on fresh installations without and with PROD, SSO shows Google/Email/Next, recovers lost signup and change-email responses without another password, blocks Back during an email change, handles a failed delivery, Send again, reload, a wrong code, two tabs and the resend cooldown, claims the first administrator and a selfRegistered member, signs in with a password containing supplementary-plane characters and through Try another way, shows the neutral no-password state, expires with Start again, handles Google cancellation and controlled sign-in, and completes OIDC signup and password login through native POSTs carrying the strict browser proof with separate consent. Screenshots: ${artifactRoot}`);
}

try {
    await verify();
} catch (error) {
    let index = 0;
    for (const context of browser?.contexts() || []) {
        for (const page of context.pages()) {
            if (page.isClosed()) continue;
            await page.screenshot({ path: join(artifactRoot, `failure-page-${index++}.png`), fullPage: true,
                mask: [page.locator('input, textarea')] }).catch(() => {});
        }
    }
    // Browser diagnostics may contain callback queries or form bodies; keep
    // this runner's output free of codes, passwords, cookies and tokens.
    console.error(`FAIL during ${phase}: ${error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : error.name || 'browser or fixture operation failed'}`);
    process.exitCode = 1;
} finally {
    await browser?.close().catch(() => {});
    await teardownInstallation();
}
