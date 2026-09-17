import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as oidc from 'openid-client';
import { controlledGoogleProvider } from '../helpers/googleProvider.mjs';
import { startService } from '../../service/index.mjs';
import { ensureSeedData } from '../../lib/bootstrap.mjs';
import { getUserByEmail, getUserById } from '../../lib/users.mjs';
import { createLoginRequest, consumeAuthCode } from '../../lib/sso.mjs';
import { getInstallationSetup } from '../../lib/setup.mjs';
import { getStore, resetStoreForTests } from '../../lib/store.mjs';
import { createOidcClient } from '../../lib/oidc/clients.mjs';
import { resetOidcProviderForTests } from '../../lib/oidc/provider.mjs';
import { setupStart as startTotpSetup, setupVerify as verifyTotpSetup, generateToken } from '../../lib/auth/totp.mjs';

// Opt-in browser regression for the shared sign-in wizard on both renderers:
// the Router SSO page and an OIDC interaction in a popup opened by a cross-site
// application. Codes come from a construction-time delivery capture, Google from
// a controlled GIS SDK returning signed JWTs; this is not real Google account verification.
const runtimePath = process.env.WIZARD_BROWSER_PLAYWRIGHT_MODULE || process.env.GOOGLE_BROWSER_PLAYWRIGHT_MODULE || '';
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const artifactRoot = resolve(process.env.WIZARD_BROWSER_ARTIFACT_DIR || join(repoRoot, '.ploinky', 'test-artifacts', 'userpersisto-wizard', runId));
const environment = { ...process.env };
const output = console.log.bind(console);
const mail = [];
let phase = 'loading the explicitly selected Playwright runtime';
let folder;
let google;
let service;
let application;
let browser;

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

function latestCode(address) {
    const message = [...mail].reverse().find((entry) => entry.to === address);
    assert.ok(message, `A code must have been delivered to ${address}.`);
    return message.code;
}

async function screenshot(page, name) {
    // Taken before any code or password is typed, so no secret is captured.
    await page.screenshot({ path: join(artifactRoot, `${name}.png`), fullPage: true });
}

async function verifyDefaultAdministrator(browserErrors) {
    const previousEnvironment = { ...process.env };
    const persistence = await mkdtemp(join(tmpdir(), 'userpersisto-first-admin-browser-'));
    let server;
    let context;
    try {
        process.env.PERSISTENCE_FOLDER = persistence;
        process.env.USERPERSISTO_SETTINGS_KEY = 'first-admin-browser-fixture-settings-key';
        for (const name of ['PROD', 'USERPERSISTO_ADMIN_PASSWORD', 'USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS']) delete process.env[name];
        await ensureSeedData();
        server = startService({ port: 0, host: '127.0.0.1' });
        if (!server.listening) await once(server, 'listening');
        const origin = `http://127.0.0.1:${server.address().port}`;
        let administratorId;
        for (const firstRun of [true, false]) {
            phase = firstRun ? 'SSO: fresh installation uses the default administrator password and optional email' : 'SSO: default administrator signs back in';
            const request = await createLoginRequest({ redirectUri: `${origin}/auth/callback` });
            context = await browser.newContext();
            const page = await context.newPage();
            page.setDefaultTimeout(15_000);
            page.on('pageerror', (error) => browserErrors.push(`administrator: ${error.message}`));
            let callback;
            await page.route('**/auth/callback?**', async (route) => {
                callback = new URL(route.request().url());
                await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Router callback</h1>' });
            });
            await page.goto(`${origin}/service/auth/?requestId=${encodeURIComponent(request.providerState)}`);
            await page.getByLabel('Admin password', { exact: true }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Administrator sign-in', exact: true }).count(), 0);
            assert.equal(await page.locator('[name="contactEmail"]').count(), 0);
            assert.equal(await page.locator('form').count(), 1);
            const order = await page.locator('form.start-panel').evaluate((form) => [...form.children]
                .filter((node) => ['BUTTON', 'LABEL', 'INPUT'].includes(node.tagName))
                .map((node) => node.tagName === 'INPUT' ? node.name : node.textContent));
            assert.deepEqual(order, ['Continue with Google', 'Email', 'email', 'Admin password', 'password', 'Sign in']);
            if (firstRun) {
                await screenshot(page, '00-first-run-administrator');
                await page.getByLabel('Email', { exact: true }).fill('operator@example.test');
                await page.getByLabel('Admin password', { exact: true }).fill('incorrect');
                await page.locator('form.start-panel').getByRole('button', { name: 'Sign in', exact: true }).click();
                await page.getByText('Unable to sign in with that administrator password.', { exact: true }).waitFor();
                assert.equal(await page.getByLabel('Admin password', { exact: true }).inputValue(), '');
                assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'operator@example.test');
                assert.equal((await getInstallationSetup()).complete, false);
            }
            await page.getByLabel('Admin password', { exact: true }).fill('admin');
            await page.locator('form.start-panel').getByRole('button', { name: 'Sign in', exact: true }).click();
            await page.getByRole('heading', { name: 'Router callback' }).waitFor();
            const signedIn = await consumeAuthCode({ providerState: request.providerState, code: callback.searchParams.get('code') });
            assert.deepEqual(signedIn.roles, ['admin']);
            if (firstRun) administratorId = signedIn.user.id;
            else assert.equal(signedIn.user.id, administratorId);
            const user = await getUserById(signedIn.user.id);
            assert.equal(user.username, 'administrator');
            assert.equal(user.email, '');
            assert.equal(user.contactEmail, 'operator@example.test');
            assert.equal(user.emailVerifiedAt, '');
            await context.close();
            context = null;
        }
    } finally {
        await context?.close();
        await closeServer(server);
        await resetStoreForTests();
        await rm(persistence, { recursive: true, force: true });
        for (const name of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, name)) delete process.env[name];
        Object.assign(process.env, previousEnvironment);
    }
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
    const browserErrors = [];
    await verifyDefaultAdministrator(browserErrors);

    phase = 'initializing isolated provider and persistence';
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-wizard-browser-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'wizard-browser-fixture-settings-key';
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
    for (const name of ['PROD', 'USERPERSISTO_ADMIN_PASSWORD', 'USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_DEV_BOOTSTRAP']) delete process.env[name];
    await ensureSeedData();
    google = await controlledGoogleProvider();
    service = startService({ port: 0, host: '127.0.0.1' }, {
        google: { protocol: google.protocol },
        deliverEmail: async (message) => { mail.push(message); return { delivered: true, providerMessageId: 'browser-fixture' }; },
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
    async function ssoPage() {
        const request = await createLoginRequest({ redirectUri: `${providerOrigin}/auth/callback` });
        const context = await browser.newContext();
        await google.installBrowserSdk(context);
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.on('pageerror', (error) => browserErrors.push(`sso: ${error.message}`));
        let callback = null;
        // Observe the handoff for both direct navigation and HTTP redirects.
        page.on('request', (request) => {
            const target = new URL(request.url());
            if (request.isNavigationRequest() && target.origin === providerOrigin && target.pathname === '/auth/callback') callback = target;
        });
        await page.goto(`${providerOrigin}/service/auth/?requestId=${encodeURIComponent(request.providerState)}&state=router-core-state`);
        return { request, context, page, callback: () => callback };
    }
    async function finishSso(flow) {
        await flow.page.getByRole('heading', { name: 'Router callback' }).waitFor();
        const target = flow.callback();
        assert.ok(target, 'The wizard must navigate to the stored Router callback.');
        assert.equal(target.origin, providerOrigin);
        assert.equal(target.pathname, '/auth/callback');
        assert.equal(target.searchParams.get('state'), 'router-core-state', 'The Router state must be preserved.');
        const consumed = await consumeAuthCode({ providerState: flow.request.providerState, code: target.searchParams.get('code') });
        await flow.context.close();
        return consumed;
    }

    phase = 'SSO: first verified email signup claims the installation';
    let flow = await ssoPage();
    await flow.page.getByText('The first completed sign-in becomes its administrator').waitFor();
    assert.equal(await flow.page.getByRole('button', { name: 'Administrator sign-in' }).count(), 0);
    assert.equal(await flow.page.getByLabel('Admin password', { exact: true }).isVisible(), true);
    await screenshot(flow.page, '01-sso-first-run');
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('owner@example.test');
    await flow.page.locator('form.start-panel').getByRole('button', { name: 'Sign in', exact: true }).click();
    await flow.page.getByRole('textbox', { name: 'Code' }).waitFor();
    assert.equal((await getInstallationSetup()).complete, false, 'Requesting a code does not claim the installation.');
    assert.equal(await flow.page.getByRole('button', { name: /^Resend/ }).isDisabled(), true, 'Resend waits for the cooldown.');
    await screenshot(flow.page, '02-sso-code');
    await flow.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('owner@example.test'));
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    const owner = await finishSso(flow);
    assert.deepEqual(owner.roles, ['admin']);
    assert.equal((await getInstallationSetup()).initialAdministratorId, owner.user.id);

    phase = 'SSO: Login with an unknown email asks before registering';
    flow = await ssoPage();
    assert.equal(await flow.page.locator('input[type="password"]').count(), 0, 'email-first accounts do not gain the default administrator password');
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('member@example.test');
    await flow.page.getByRole('button', { name: 'Next', exact: true }).click();
    await flow.page.getByRole('button', { name: 'Create account', exact: true }).waitFor();
    assert.equal(await getUserByEmail('member@example.test'), null);
    await screenshot(flow.page, '03-sso-confirm-register');
    await flow.page.getByRole('button', { name: 'Create account', exact: true }).click();
    await flow.page.getByRole('textbox', { name: 'Code' }).waitFor();
    await flow.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('member@example.test'));
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    const member = await finishSso(flow);
    assert.deepEqual(member.roles, ['selfRegistered']);

    phase = 'SSO: Cancel wins over a delayed successful verification response';
    flow = await ssoPage();
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('member@example.test');
    await flow.page.getByRole('button', { name: 'Next', exact: true }).click();
    await flow.page.getByRole('button', { name: 'Email me a code', exact: true }).click();
    await flow.page.getByRole('textbox', { name: 'Code' }).waitFor();
    let releaseVerification;
    let verificationReceived;
    const verificationReady = new Promise((resolve) => { verificationReceived = resolve; });
    const verificationHeld = new Promise((resolve) => { releaseVerification = resolve; });
    await flow.page.route('**/service/auth/email-code/verify', async (route) => {
        const response = await route.fetch();
        verificationReceived();
        await verificationHeld;
        await route.fulfill({ response });
    });
    await flow.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('member@example.test'));
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await verificationReady;
    await flow.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await flow.page.getByRole('textbox', { name: 'Email' }).waitFor();
    const verificationDelivered = flow.page.waitForResponse('**/service/auth/email-code/verify');
    releaseVerification();
    await verificationDelivered;
    // Flush the response handler and the next rendering task without an arbitrary sleep.
    await flow.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(flow.callback(), null, 'A canceled verification must not navigate to the Router callback.');
    assert.equal(await flow.page.getByRole('textbox', { name: 'Email' }).isVisible(), true);
    await screenshot(flow.page, '03b-sso-cancel-delayed-verification');
    await flow.context.close();

    phase = 'SSO: Register with an existing email asks before signing in';
    flow = await ssoPage();
    await flow.page.getByRole('button', { name: 'Create an account', exact: true }).click();
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('member@example.test');
    await flow.page.getByRole('button', { name: 'Next', exact: true }).click();
    await flow.page.getByRole('heading', { name: /Sign in instead/ }).waitFor();
    await screenshot(flow.page, '04-sso-confirm-sign-in');
    await flow.page.locator('#auth_content').getByRole('button', { name: 'Sign in', exact: true }).click();
    await flow.page.getByRole('button', { name: 'Email me a code', exact: true }).click();
    await flow.page.getByRole('textbox', { name: 'Code' }).fill('000000');
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await flow.page.getByText(/not correct/).waitFor();
    await flow.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('member@example.test'));
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    assert.equal((await finishSso(flow)).user.id, member.user.id);

    phase = 'SSO: the installation administrator uses the same email-code sign-in as other accounts';
    flow = await ssoPage();
    await flow.page.getByRole('textbox', { name: 'Email' }).fill('owner@example.test');
    await flow.page.getByRole('button', { name: 'Next', exact: true }).click();
    await flow.page.getByRole('button', { name: 'Email me a code', exact: true }).click();
    await flow.page.getByRole('textbox', { name: 'Code' }).waitFor();
    await screenshot(flow.page, '05-sso-administrator-email');
    await flow.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('owner@example.test'));
    await flow.page.getByRole('button', { name: 'Verify', exact: true }).click();
    assert.equal((await finishSso(flow)).user.id, owner.user.id);

    phase = 'SSO: GIS cancellation returns to the live wizard';
    flow = await ssoPage();
    await flow.page.getByRole('button', { name: /Continue with Google/ }).click();
    await flow.page.getByRole('button', { name: 'Back to sign-in', exact: true }).click();
    await flow.page.getByText('Google sign-in was cancelled.').waitFor();
    await screenshot(flow.page, '06-sso-google-cancelled');
    // Narrow phones keep the whole panel inside the viewport, and Tab reaches the controls in order.
    await flow.page.setViewportSize({ width: 360, height: 740 });
    assert.equal(await flow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'No horizontal overflow at 360 px.');
    await screenshot(flow.page, '06b-sso-narrow');
    await flow.page.getByRole('textbox', { name: 'Email' }).focus();
    await flow.page.keyboard.press('Tab');
    assert.equal(await flow.page.evaluate(() => document.activeElement?.textContent), 'Next', 'Tab moves from the email field to Next.');
    await flow.context.close();

    // ---- OIDC renderer in a popup opened by a cross-site application --------
    phase = 'OIDC: preparing the cross-site relying party';
    let config;
    let callbackUri;
    const completions = [];
    const attempts = new Map();
    application = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, callbackUri);
            if (url.pathname === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                return res.end('<h1>Application</h1><button id="open">Sign in with UserPersisto</button><script>document.getElementById("open").onclick = () => window.open("/start", "userpersisto", "width=520,height=720");</script>');
            }
            if (url.pathname === '/start') {
                const state = oidc.randomState();
                const nonce = oidc.randomNonce();
                const verifier = oidc.randomPKCECodeVerifier();
                attempts.set(state, { nonce, verifier });
                const target = oidc.buildAuthorizationUrl(config, { redirect_uri: callbackUri, scope: 'openid email roles', prompt: 'login', state, nonce,
                    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
                res.writeHead(302, { Location: target.href });
                return res.end();
            }
            if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }
            const state = url.searchParams.get('state');
            const attempt = attempts.get(state);
            attempts.delete(state);
            const tokens = await oidc.authorizationCodeGrant(config, url, { pkceCodeVerifier: attempt.verifier, expectedState: state, expectedNonce: attempt.nonce });
            completions.push({ sub: tokens.claims().sub, amr: tokens.claims().amr || [] });
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<h1>Client completed</h1>');
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            return res.end('<h1>Client verification failed</h1>');
        }
    });
    application.listen(0, '127.0.0.1');
    await once(application, 'listening');
    const applicationOrigin = `http://127.0.0.1:${application.address().port}`;
    callbackUri = `${applicationOrigin}/callback`;
    await createOidcClient({ client_id: 'wizard-browser-regression', client_name: 'Wizard regression application', redirect_uris: [callbackUri],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], scope: 'openid email roles' }, { actorId: owner.user.id });
    config = await oidc.discovery(new URL(issuer), 'wizard-browser-regression', undefined, oidc.None(), { execute: [oidc.allowInsecureRequests] });

    async function popup({ googleOnly = false } = {}) {
        const context = await browser.newContext();
        await google.installBrowserSdk(context);
        const opener = await context.newPage();
        opener.on('pageerror', (error) => browserErrors.push(`application: ${error.message}`));
        await opener.goto(applicationOrigin);
        const [page] = await Promise.all([context.waitForEvent('page'), opener.click('#open')]);
        page.setDefaultTimeout(15_000);
        page.on('pageerror', (error) => browserErrors.push(`oidc: ${error.message}`));
        if (googleOnly) await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
        else await page.getByRole('textbox', { name: 'Email' }).waitFor();
        return { context, page };
    }

    phase = 'OIDC: email-code sign-in completes through native POSTs in a cross-site popup';
    let session = await popup();
    await session.page.getByText('Wizard regression application').first().waitFor();
    await screenshot(session.page, '07-oidc-start');
    await session.page.getByRole('textbox', { name: 'Email' }).fill('member@example.test');
    await session.page.getByRole('button', { name: 'Next', exact: true }).click();
    await session.page.getByRole('button', { name: 'Email me a code', exact: true }).click();
    await session.page.getByRole('textbox', { name: 'Code' }).waitFor();
    const cookies = await session.context.cookies(`${providerOrigin}/service/`);
    const binding = cookies.find((cookie) => cookie.name === 'up_browser');
    assert.ok(binding, 'The wizard must bind the attempt to this browser.');
    assert.deepEqual([binding.httpOnly, binding.sameSite, binding.path], [true, 'Strict', '/service/'], 'The browser proof is HttpOnly, SameSite=Strict and scoped to the service.');
    await session.page.getByRole('textbox', { name: 'Code' }).fill('000000');
    await session.page.getByRole('button', { name: 'Verify', exact: true }).click();
    // A wrong code re-renders the interaction with a visible error and the same attempt.
    await session.page.getByText(/not correct/).waitFor();
    await screenshot(session.page, '08-oidc-wrong-code');
    await session.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('member@example.test'));
    await session.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await session.page.getByRole('button', { name: 'Allow access', exact: true }).click();
    await session.page.getByRole('heading', { name: 'Client completed' }).waitFor();
    assert.equal(completions.at(-1).sub, member.user.id, 'The application receives the local account id.');
    await session.context.close();

    phase = 'OIDC: wrong authenticator code re-render keeps Back and email sign-in usable';
    const totpSetup = await startTotpSetup({ userId: member.user.id });
    assert.equal((await verifyTotpSetup({ userId: member.user.id, setupId: totpSetup.setupId, token: generateToken(totpSetup.secret) })).ok, true);
    session = await popup();
    await session.page.getByRole('textbox', { name: 'Email' }).fill('member@example.test');
    await session.page.getByRole('button', { name: 'Next', exact: true }).click();
    await session.page.getByRole('button', { name: 'Use an authenticator app', exact: true }).click();
    // Select a guaranteed-invalid six-digit token for every accepted clock window.
    const counter = Math.floor(Date.now() / 30_000);
    const validTotpTokens = new Set([-1, 0, 1].map((offset) => generateToken(totpSetup.secret, counter + offset)));
    let incorrectToken = '000000';
    while (validTotpTokens.has(incorrectToken)) incorrectToken = String(Number(incorrectToken) + 1).padStart(6, '0');
    await session.page.getByRole('textbox', { name: 'Code' }).fill(incorrectToken);
    await session.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await session.page.getByText('Unable to sign in. Check your details and try again.').waitFor();
    await session.page.getByRole('button', { name: 'Back', exact: true }).click();
    await session.page.getByRole('button', { name: 'Email me a code', exact: true }).click();
    await session.page.getByRole('textbox', { name: 'Code' }).waitFor();
    await screenshot(session.page, '08b-oidc-totp-back-to-email');
    await session.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('member@example.test'));
    await session.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await session.page.getByRole('button', { name: 'Allow access', exact: true }).click();
    await session.page.getByRole('heading', { name: 'Client completed' }).waitFor();
    assert.equal(completions.at(-1).sub, member.user.id);
    await session.context.close();

    phase = 'OIDC: administrator email-code sign-in never approves scopes by itself';
    session = await popup();
    await session.page.getByRole('textbox', { name: 'Email' }).fill('owner@example.test');
    await session.page.getByRole('button', { name: 'Next', exact: true }).click();
    await session.page.getByRole('button', { name: 'Email me a code', exact: true }).click();
    await session.page.getByRole('textbox', { name: 'Code' }).waitFor();
    await session.page.getByRole('textbox', { name: 'Code' }).fill(latestCode('owner@example.test'));
    await session.page.getByRole('button', { name: 'Verify', exact: true }).click();
    await session.page.getByRole('button', { name: 'Allow access', exact: true }).waitFor();
    await screenshot(session.page, '09-oidc-consent-after-administrator');
    await session.page.getByRole('button', { name: 'Allow access', exact: true }).click();
    await session.page.getByRole('heading', { name: 'Client completed' }).waitFor();
    assert.equal(completions.at(-1).sub, owner.user.id);
    await session.context.close();

    const store = await getStore();
    assert.equal((await store.select('user')).totalCount, 2, 'Only the two completed sign-ups created accounts.');

    async function assertProductionStart(page, { googleAvailable = true } = {}) {
        await page.locator('#auth_content h1').waitFor();
        assert.equal(await page.locator('#auth_content input, #auth_content select, #auth_content form').count(), 0);
        assert.equal(await page.locator('#auth_content button[type="submit"], #auth_content .auth-switch').count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Continue with Google', exact: true }).count(), googleAvailable ? 1 : 0);
        assert.equal(await page.getByRole('button', { name: 'Create an account', exact: true }).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Administrator sign-in', exact: true }).count(), 0);
    }

    phase = 'PROD: refreshing an active email flow exposes only Google';
    flow = await ssoPage();
    const pendingAddress = 'pending-production@example.test';
    await flow.page.getByRole('textbox', { name: 'Email' }).fill(pendingAddress);
    await flow.page.getByRole('button', { name: 'Next', exact: true }).click();
    const pendingEmailResponse = flow.page.waitForResponse((response) => new URL(response.url()).pathname === '/service/auth/email-code/start'
        && response.request().method() === 'POST');
    await flow.page.getByRole('button', { name: 'Create account', exact: true }).click();
    const pendingSent = await pendingEmailResponse;
    assert.equal(pendingSent.status(), 200, `Pending production fixture email request returned HTTP ${pendingSent.status()}`);
    await flow.page.getByRole('textbox', { name: 'Code' }).waitFor();
    assert.equal(await getUserByEmail(pendingAddress), null, 'the pending registration creates no account');
    process.env.PROD = 'false'; // Presence selects production, regardless of its text value.
    await flow.page.reload();
    await flow.page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
    await assertProductionStart(flow.page);
    assert.equal(await flow.page.locator('#auth_content').innerText().then((text) => text.includes(pendingAddress)), false);
    await screenshot(flow.page, '10-prod-google-only');
    await flow.page.reload();
    await flow.page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
    await assertProductionStart(flow.page);

    phase = 'PROD: Google cancellation keeps the Google-only screen and Google sign-in completes';
    await flow.page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    phase = 'PROD: cancelling the live Google prompt';
    await flow.page.getByRole('button', { name: 'Back to sign-in', exact: true }).click();
    phase = 'PROD: displaying the Google cancellation notice';
    await flow.page.getByText('Google sign-in was cancelled.').waitFor();
    await assertProductionStart(flow.page);
    phase = 'PROD: starting Google again after cancellation';
    await flow.page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    phase = 'PROD: submitting the controlled Google credential';
    await flow.page.getByRole('button', { name: 'Continue with test identity', exact: true }).click();
    phase = 'PROD: completing the Google SSO callback';
    const googleAccount = await finishSso(flow);
    assert.equal(googleAccount.user.email, google.state.email);
    assert.deepEqual(googleAccount.roles, ['selfRegistered']);

    phase = 'PROD: OIDC uses Google only and still requires application consent';
    session = await popup({ googleOnly: true });
    await assertProductionStart(session.page);
    await screenshot(session.page, '11-prod-oidc-google-only');
    await session.page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    await session.page.getByRole('button', { name: 'Continue with test identity', exact: true }).click();
    await session.page.getByRole('button', { name: 'Allow access', exact: true }).click();
    await session.page.getByRole('heading', { name: 'Client completed' }).waitFor();
    assert.equal(completions.at(-1).sub, googleAccount.user.id);
    await session.context.close();

    phase = 'PROD: unavailable Google exposes no fallback credentials';
    process.env.PROD = '';
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = '';
    flow = await ssoPage();
    await flow.page.getByText('Google sign-in is not available right now.', { exact: true }).waitFor();
    await assertProductionStart(flow.page, { googleAvailable: false });
    await screenshot(flow.page, '12-prod-google-unavailable');
    await flow.context.close();
    assert.equal((await store.select('user')).totalCount, 3, 'Only the completed email and Google sign-ups create accounts.');
    assert.deepEqual(browserErrors, [], 'No page may raise an uncaught error.');
    output(`PASS Chromium ${browser.version()}: PROD absent exposes the combined Google/email/admin-password form and preserves SSO/OIDC email, password and authenticator flows; PROD present suppresses pending local flows after refresh, allows only Google through SSO and OIDC with separate consent, preserves cancellation errors, and exposes no fallback when Google is unavailable. Screenshots: ${artifactRoot}`);
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
    // this runner's output free of codes, cookies and tokens.
    console.error(`FAIL during ${phase}: ${error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : error.name || 'browser or fixture operation failed'}`);
    process.exitCode = 1;
} finally {
    await Promise.allSettled([browser?.close(), closeServer(application), closeServer(service), google?.close()]);
    resetOidcProviderForTests();
    await resetStoreForTests();
    if (folder) await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
    Object.assign(process.env, environment);
}
