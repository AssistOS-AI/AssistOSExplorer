import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { controlledGoogleProvider } from '../helpers/googleProvider.mjs';
import { createRouterSigner } from '../helpers/router-fixture.mjs';
import { startService } from '../../service/index.mjs';
import { ensureSeedData } from '../../lib/bootstrap.mjs';
import { createLoginRequest, consumeAuthCode } from '../../lib/sso.mjs';
import { updateAuthPolicy } from '../../lib/policy.mjs';
import { getStore, resetStoreForTests } from '../../lib/store.mjs';
import { generateToken } from '../../lib/auth/totp.mjs';

// A loopback Router derives its session from the real SSO handoff after a
// controlled GIS SDK submits signed fixture credentials. Dashboard requests are
// signed; no identity, mail service or browser storage grant is pre-injected.
const runtimePath = process.env.GOOGLE_BROWSER_PLAYWRIGHT_MODULE || '';
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const artifacts = resolve(process.env.GOOGLE_ENROLLMENT_ARTIFACT_DIR || join(repoRoot, '.ploinky', 'test-artifacts', 'google-enrollment', Date.now().toString()));
const environment = { ...process.env };
let folder, provider, service, router, browser;
let phase = 'initialization';
const sessions = new Map();
let userId;

async function closeServer(server) {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

try {
    assert.ok(isAbsolute(runtimePath), 'GOOGLE_BROWSER_PLAYWRIGHT_MODULE must name the existing absolute Playwright module.');
    const { chromium } = await import(pathToFileURL(runtimePath).href);
    await mkdir(artifacts, { recursive: true });
    folder = await mkdtemp(join(tmpdir(), 'google-enrollment-browser-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'google-enrollment-browser-settings';
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
    for (const key of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_DEV_BOOTSTRAP']) delete process.env[key];
    const sign = await createRouterSigner();
    await ensureSeedData();
    provider = await controlledGoogleProvider();
    service = startService({ port: 0, host: '127.0.0.1' }, { google: { protocol: provider.protocol } });
    if (!service.listening) await once(service, 'listening');
    const upstream = `http://127.0.0.1:${service.address().port}`;
    let origin;
    const loginParents = new Map();
    router = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, origin);
            if (url.pathname === '/start') {
                const request = await createLoginRequest({ redirectUri: `${origin}/auth/callback` });
                const state = randomBytes(24).toString('base64url');
                loginParents.set(state, request.providerState);
                res.writeHead(303, { Location: `/service/auth/?${new URLSearchParams({ requestId: request.providerState, state })}` });
                return res.end();
            }
            if (url.pathname === '/auth/callback') {
                const state = url.searchParams.get('state');
                const providerState = loginParents.get(state);
                assert.ok(providerState, 'callback needs its retained parent');
                loginParents.delete(state);
                const session = await consumeAuthCode({ code: url.searchParams.get('code'), providerState });
                userId = session.user.id;
                const id = randomBytes(24).toString('base64url');
                sessions.set(id, userId);
                res.writeHead(303, { Location: '/service/dashboard/', 'Set-Cookie': `fixture_session=${id}; Path=/; HttpOnly; SameSite=Lax` });
                return res.end();
            }
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            const id = /(?:^|;\s*)fixture_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
            const actor = sessions.get(id);
            const headers = { ...req.headers, host: new URL(upstream).host,
                'x-forwarded-proto': 'http', 'x-forwarded-host': new URL(origin).host };
            delete headers['content-length'];
            if (url.pathname.startsWith('/service/dashboard') && actor) Object.assign(headers,
                sign({ method: req.method, path: `${url.pathname}${url.search}`, rawBody: body, userId: actor, origin }));
            const response = await fetch(`${upstream}${url.pathname}${url.search}`, {
                method: req.method, headers, redirect: 'manual', ...(req.method === 'POST' ? { body } : {}),
            });
            const outgoing = Object.fromEntries(response.headers);
            delete outgoing['content-length'];
            delete outgoing['content-encoding'];
            if (response.headers.getSetCookie().length) outgoing['set-cookie'] = response.headers.getSetCookie();
            res.writeHead(response.status, outgoing);
            res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
            res.writeHead(500); res.end('Fixture request failed');
            console.error(`Fixture request failed: ${error.code || error.message}`);
        }
    });
    router.listen(0, '127.0.0.1');
    await once(router, 'listening');
    origin = `http://localhost:${router.address().port}`;
    process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${origin}/service/auth/google/callback`;
    process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS = origin;
    await updateAuthPolicy({ enabledAuthMethods: ['password', 'google', 'passkey', 'totp'] });
    browser = await chromium.launch({ headless: true,
        ...(process.env.GOOGLE_BROWSER_EXECUTABLE ? { executablePath: process.env.GOOGLE_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext();
    await provider.installBrowserSdk(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    phase = 'Google-only initial administrator through a controlled signed GIS credential';
    await page.goto(`${origin}/start`);
    await page.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await page.getByRole('button', { name: 'Continue with test identity' }).click();
    await page.waitForURL(`${origin}/service/dashboard/`);
    await page.getByRole('button', { name: 'Set up authenticator', exact: true }).waitFor();
    assert.ok(userId);
    await page.screenshot({ path: join(artifacts, 'google-only-account.png'), fullPage: true });

    async function confirmGoogle() {
        provider.state.claims = { auth_time: Math.floor(Date.now() / 1000) };
        await page.locator('[data-reauth-method]').selectOption('google');
        const opened = context.waitForEvent('page');
        await page.getByRole('button', { name: 'Confirm with Google', exact: true }).click();
        const popup = await opened;
        await popup.getByRole('button', { name: 'Continue with test identity' }).click();
        await page.locator('[data-reauth]').waitFor({ state: 'hidden' });
    }

    phase = 'Google confirmation and authenticator enrollment without a mail service';
    await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
    await confirmGoogle();
    await page.locator('[data-totp-secret]').waitFor({ state: 'visible' });
    const secret = await page.locator('[data-totp-secret]').inputValue();
    await page.locator('[data-totp-token]').fill(generateToken(secret));
    await page.getByRole('button', { name: 'Confirm authenticator', exact: true }).click();
    await page.getByText('Authenticator configured. You can use its codes to sign in.', { exact: true }).waitFor();

    phase = 'Google confirmation and browser-verified passkey enrollment';
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.getByRole('button', { name: 'Add a passkey', exact: true }).click();
    await confirmGoogle();
    await page.getByText('Passkey added. You can use it the next time you sign in.', { exact: true }).waitFor();
    // Per-run fixture passwords, never printed; screenshots mask password inputs.
    const firstPassword = `fixture ${randomBytes(12).toString('base64url')}`;
    const changedPassword = `fixture ${randomBytes(12).toString('base64url')}`;
    const passwordMask = () => ({ mask: [page.locator('input[type="password"]')] });
    const savePassword = async (value) => {
        for (const label of ['New password', 'Confirm new password']) {
            const facts = await page.getByLabel(label, { exact: true }).evaluate((input) => [input.type, input.autocomplete, input.hasAttribute('maxlength')]);
            assert.deepEqual(facts, ['password', 'new-password', false], label);
            await page.getByLabel(label, { exact: true }).fill(value);
        }
        await page.getByRole('button', { name: 'Save password', exact: true }).click();
    };

    phase = 'Google confirmation and a first account password without a mail service';
    await page.getByRole('button', { name: 'Set a password', exact: true }).click();
    await confirmGoogle();
    await page.locator('[data-password-setup]').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(artifacts, 'google-account-password-form.png'), fullPage: true, ...passwordMask() });
    await savePassword(firstPassword);
    await page.getByText('Password set. You can use it to sign in.', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-password-setup]').isHidden(), true);
    assert.deepEqual(await page.locator('[data-password-new], [data-password-confirm]').evaluateAll((inputs) => inputs.map((input) => input.value === '')), [true, true]);

    phase = 'confirming with the current password and changing it';
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await page.locator('[data-reauth]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-reauth-method]').inputValue(), 'password', 'The account password is the first confirmation method.');
    await page.locator('[data-reauth-password]').fill(firstPassword);
    await page.locator('[data-reauth-submit]').click();
    await page.locator('[data-password-setup]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-reauth-password]').inputValue() === '', true, 'The confirmation password is cleared.');
    await savePassword(changedPassword);
    await page.getByText('Password changed. Every session is signed out, including this one; sign in again with your new password when asked.', { exact: true }).waitFor();

    const methods = await (await getStore()).getAuthMethodsObjectsByUserId(userId);
    assert.ok(methods.some((method) => method.enabled && method.type === 'totp'));
    assert.ok(methods.some((method) => method.enabled && method.type === 'passkey'));
    assert.ok(methods.some((method) => method.enabled && method.type === 'password'));
    assert.deepEqual(failures, []);
    await page.screenshot({ path: join(artifacts, 'google-enrolled-methods.png'), fullPage: true, ...passwordMask() });

    phase = 'the Google-created account signs in with its changed password in a fresh browser';
    const fresh = await browser.newContext();
    const signIn = await fresh.newPage();
    signIn.setDefaultTimeout(15_000);
    signIn.on('pageerror', (error) => failures.push(error.message));
    await signIn.goto(`${origin}/start`);
    await signIn.getByRole('textbox', { name: 'Email', exact: true }).fill(provider.state.email);
    await signIn.getByRole('button', { name: 'Next', exact: true }).click();
    await signIn.getByRole('heading', { name: 'Enter your password', exact: true }).waitFor();
    await signIn.getByLabel('Password', { exact: true }).fill(firstPassword);
    await signIn.getByRole('button', { name: 'Log in', exact: true }).click();
    await signIn.getByText('That password is not correct. Try again or choose another way to sign in.', { exact: true }).waitFor();
    await signIn.getByLabel('Password', { exact: true }).fill(changedPassword);
    await signIn.getByRole('button', { name: 'Log in', exact: true }).click();
    await signIn.waitForURL(`${origin}/service/dashboard/`);
    await signIn.getByRole('button', { name: 'Change password', exact: true }).waitFor();
    assert.deepEqual(failures, []);
    await fresh.close();
    console.log(`PASS Chromium ${browser.version()}: controlled signed GIS credential, Google-only real SSO handoff, signed My Account requests, isolated Google popup, TOTP, passkey and first password enrollment without mail, password change confirmed by the current password, and password sign-in with only the changed password; artifacts ${artifacts}`);
} catch (error) {
    console.error(`FAIL during ${phase}: ${error.message}`);
    process.exitCode = 1;
} finally {
    await Promise.allSettled([browser?.close(), closeServer(router), closeServer(service), provider?.close()]);
    await resetStoreForTests();
    if (folder) await rm(folder, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(environment, key)) delete process.env[key];
    Object.assign(process.env, environment);
}
