import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as oidc from 'openid-client';
import { controlledGoogleProvider } from '../helpers/googleProvider.mjs';
import * as setup from '../helpers/setup.mjs';
import { startService } from '../../service/index.mjs';
import { ensureSeedData } from '../../lib/bootstrap.mjs';
import { getStore, flush, resetStoreForTests } from '../../lib/store.mjs';
import * as totp from '../../lib/auth/totp.mjs';
import { updateAuthPolicy } from '../../lib/policy.mjs';
import { createOidcClient } from '../../lib/oidc/clients.mjs';
import { resetOidcProviderForTests } from '../../lib/oidc/provider.mjs';

// Opt-in browser regression. Load an existing Playwright installation explicitly;
// the default Node test suite does not launch browsers or install browser tools.
const runtimePath = process.env.GOOGLE_BROWSER_PLAYWRIGHT_MODULE || '';
const environment = { ...process.env };
const output = console.log.bind(console);
let phase = 'loading the explicitly selected Playwright runtime';
let folder;
let google;
let service;
let application;
let proxy;
let browser;
const httpsMode = process.env.GOOGLE_BROWSER_HTTPS === 'true';
const linkMethod = process.env.GOOGLE_BROWSER_LINK_METHOD || 'emailCode';
const mail = [];
const browserHost = process.env.GOOGLE_BROWSER_HOST || (linkMethod === 'passkey' ? 'localhost' : '127.0.0.1');

async function closeServer(server) {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

async function startHttpsProxy(port) {
    const keyPath = join(folder, 'fixture-key.pem');
    const certificatePath = join(folder, 'fixture-certificate.pem');
    await promisify(execFile)(process.env.GOOGLE_BROWSER_OPENSSL || 'openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', keyPath, '-out', certificatePath, '-subj', `/CN=${browserHost}`,
        '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ], { timeout: 15_000 });
    const certificate = await readFile(certificatePath);
    proxy = https.createServer({ key: await readFile(keyPath), cert: certificate }, (req, res) => {
        const upstream = http.request({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (response) => {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(upstream);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const origin = `https://${browserHost}:${proxy.address().port}`;
    // Trust only this fixture certificate and origin for the Node relying party.
    // Production transport and global NODE_TLS_REJECT_UNAUTHORIZED are untouched.
    const trustedFetch = async (input, options) => {
        const request = new Request(input, options);
        const target = new URL(request.url);
        assert.equal(target.origin, origin, 'Fixture TLS trust must not escape the local provider origin.');
        const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
        return new Promise((resolve, reject) => {
            const transport = https.request(target, {
                method: request.method, headers: Object.fromEntries(request.headers), ca: certificate, signal: request.signal,
            }, (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('error', reject);
                response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
                    status: response.statusCode, headers: response.headers,
                })));
            });
            transport.on('error', reject);
            transport.end(body);
        });
    };
    return { origin, trustedFetch };
}

async function verify() {
    assert.ok(['emailCode', 'adminPassword', 'totp', 'passkey'].includes(linkMethod), 'GOOGLE_BROWSER_LINK_METHOD must be emailCode, adminPassword, totp or passkey.');
    assert.ok(['127.0.0.1', 'localhost'].includes(browserHost), 'GOOGLE_BROWSER_HOST must be 127.0.0.1 or localhost.');
    assert.ok(isAbsolute(runtimePath), 'GOOGLE_BROWSER_PLAYWRIGHT_MODULE must name an absolute existing module path.');
    const { chromium } = await import(pathToFileURL(runtimePath).href);
    assert.ok(chromium?.launch, 'The selected module must export Playwright chromium.');
    phase = 'initializing isolated provider and persistence';
    folder = await mkdtemp(join(tmpdir(), 'google-browser-resume-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'browser-fixture-settings-key';
    process.env.USERPERSISTO_GOOGLE_CLIENT_ID = 'controlled-google-client';
    process.env.USERPERSISTO_GOOGLE_CLIENT_SECRET = 'controlled-google-secret';
    delete process.env.USERPERSISTO_AUTH_METHODS;
    delete process.env.USERPERSISTO_SELF_REGISTRATION_ENABLED;
    delete process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS;
    await ensureSeedData();
    // The installation owner claims setup through the real verified-email path;
    // a random administrator password makes it the designated administrator too.
    const adminPassword = setup.configureAdministratorPassword();
    const { user: owner } = await setup.registerWithEmailCode('browser-owner@example.test');
    const store = await getStore();
    let totpSecret;
    if (linkMethod === 'totp') {
        const enrollment = await totp.setupStart({ userId: owner.id });
        totpSecret = enrollment.secret;
        assert.equal((await totp.setupVerify({ userId: owner.id, token: totp.generateToken(totpSecret), setupId: enrollment.setupId })).ok, true, 'Fixture TOTP enrollment must succeed before the Google attempt.');
    }
    google = await controlledGoogleProvider();
    google.state.email = owner.email;
    service = startService({ port: 0, host: '127.0.0.1' }, {
        google: { protocol: google.protocol },
        deliverEmail: async (message) => { mail.push(message); return { delivered: true, providerMessageId: 'browser-fixture' }; },
    });
    if (!service.listening) await once(service, 'listening');
    const secure = httpsMode ? await startHttpsProxy(service.address().port) : null;
    const serviceOrigin = secure?.origin || `http://${browserHost}:${service.address().port}`;
    process.env.USERPERSISTO_GOOGLE_REDIRECT_URI = `${serviceOrigin}/service/auth/google/callback`;
    const issuer = `${serviceOrigin}/service/oidc`;
    process.env.USERPERSISTO_OIDC_ISSUER = issuer;
    await updateAuthPolicy({ enabledAuthMethods: [...new Set(['emailCode', 'google', ...(linkMethod === 'adminPassword' ? [] : [linkMethod])])] });

    let config;
    let callbackUri;
    let successfulCallbacks = 0;
    let callbackFailed = false;
    const attempts = new Map();
    application = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, callbackUri);
            if (!['/start', '/callback'].includes(url.pathname)) {
                res.writeHead(404);
                return res.end();
            }
            if (url.pathname === '/start') {
                const state = oidc.randomState();
                const nonce = oidc.randomNonce();
                const verifier = oidc.randomPKCECodeVerifier();
                attempts.set(state, { nonce, verifier });
                const target = oidc.buildAuthorizationUrl(config, {
                    redirect_uri: callbackUri, scope: 'openid email roles', prompt: 'login', state, nonce,
                    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
                });
                res.writeHead(302, { Location: target.href });
                return res.end();
            }
            assert.equal(url.pathname, '/callback', 'Application route must be the exact callback.');
            assert.equal(url.searchParams.getAll('state').length, 1, 'The downstream state must occur once.');
            const state = url.searchParams.get('state');
            const attempt = attempts.get(state);
            assert.ok(attempt, 'The downstream callback must own a live attempt.');
            attempts.delete(state);
            const tokens = await oidc.authorizationCodeGrant(config, url, {
                pkceCodeVerifier: attempt.verifier, expectedState: state, expectedNonce: attempt.nonce,
            });
            assert.equal(tokens.claims().sub, owner.id, 'Downstream subject must remain the existing local user ID.');
            const info = await oidc.fetchUserInfo(config, tokens.access_token, owner.id);
            assert.deepEqual(info.roles, ['admin'], 'Linking must preserve current local roles.');
            successfulCallbacks += 1;
            res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            res.end('<h1>Client completed</h1>');
        } catch {
            callbackFailed = true;
            res.writeHead(400, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            res.end('<h1>Client verification failed</h1>');
        }
    });
    application.listen(0, '127.0.0.1');
    await once(application, 'listening');
    const applicationOrigin = `http://127.0.0.1:${application.address().port}`;
    callbackUri = `${applicationOrigin}/callback`;
    await createOidcClient({
        client_id: 'google-browser-regression', client_name: 'Browser regression application', redirect_uris: [callbackUri],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], scope: 'openid email roles',
    }, { actorId: owner.id });
    config = await oidc.discovery(new URL(issuer), 'google-browser-regression', undefined, oidc.None(), {
        execute: [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks],
        ...(secure ? { [oidc.customFetch]: secure.trustedFetch } : {}),
    });
    phase = 'launching Chromium';
    browser = await chromium.launch({
        headless: process.env.GOOGLE_BROWSER_HEADED !== 'true',
        ...(process.env.GOOGLE_BROWSER_EXECUTABLE ? { executablePath: process.env.GOOGLE_BROWSER_EXECUTABLE } : {}),
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: httpsMode });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    let passkeyCredentialKey;
    let passkeyAssertions = 0;
    if (linkMethod === 'passkey') {
        phase = 'enrolling a fixture credential in the Chromium virtual authenticator';
        await page.addInitScript(() => {
            const get = navigator.credentials.get.bind(navigator.credentials);
            navigator.credentials.get = async (options) => {
                try { return await get(options); } catch (error) {
                    // Preserve the real result while exposing only the browser's
                    // error category to this fixture's bounded failure report.
                    window.fixturePasskeyError = /domain/i.test(error.message) ? 'rp-domain-rejected'
                        : /certificate|ssl/i.test(error.message) ? 'certificate-rejected' : error.name;
                    throw error;
                }
            };
        });
        const credentialId = randomBytes(24);
        const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const cdp = await context.newCDPSession(page);
        await cdp.send('WebAuthn.enable');
        const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
            protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
            automaticPresenceSimulation: true, isUserVerified: true,
        } });
        await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: {
            credentialId: credentialId.toString('base64'), isResidentCredential: true, rpId: new URL(serviceOrigin).hostname,
            privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
            userHandle: Buffer.from(owner.id).toString('base64'), signCount: 0,
        } });
        cdp.on('WebAuthn.credentialAsserted', () => { passkeyAssertions += 1; });
        const publicCredentialId = credentialId.toString('base64url');
        passkeyCredentialKey = `${owner.id}:passkey:${publicCredentialId}`;
        await store.createAuthMethod({ key: passkeyCredentialKey, userId: owner.id, type: 'passkey', enabled: true,
            credential: { credentialId: publicCredentialId, publicKeyJwk: publicKey.export({ format: 'jwk' }), alg: -7, counter: 0, transports: ['internal'] } });
        await flush();
    }
    let cspErrors = 0;
    page.on('console', (message) => {
        if (message.type() === 'error' && message.text().includes('Content Security Policy')) cspErrors += 1;
    });
    phase = 'establishing passwordless email-code login and existing application consent';
    await page.goto(`${applicationOrigin}/start`);
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(owner.email);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Email me a code', exact: true }).click();
    await page.getByRole('textbox', { name: 'Code', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Code', exact: true }).fill(mail.at(-1).code);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();
    await page.getByRole('button', { name: 'Allow access', exact: true }).click();
    await page.getByRole('heading', { name: 'Client completed', exact: true }).waitFor();
    assert.equal(successfulCallbacks, 1, 'Ordinary login must establish a verified application session.');

    phase = 'holding the wizard module before the first possible click';
    let releaseWizardScript;
    let observeWizardScript;
    const scriptGate = new Promise((resolve) => { releaseWizardScript = resolve; });
    const scriptHeld = new Promise((resolve) => { observeWizardScript = resolve; });
    const wizardScriptPattern = '**/service/auth/oidc-main.js';
    const holdWizardScript = async (route) => {
        observeWizardScript();
        await scriptGate;
        await route.continue();
    };
    let prematureGooglePosts = 0;
    const observeGooglePost = (request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/google')) prematureGooglePosts += 1;
    };
    await page.route(wizardScriptPattern, holdWizardScript);
    page.on('request', observeGooglePost);
    try {
        await page.goto(`${applicationOrigin}/start`, { waitUntil: 'commit' });
        await scriptHeld;
        // The server shell renders no Google control; only the loaded wizard does.
        assert.equal(await page.getByRole('button', { name: 'Continue with Google', exact: true }).count(), 0, 'Google must not be offered before the wizard module loads.');
        assert.equal(prematureGooglePosts, 0, 'No Google request can start before the wizard module loads.');
    } finally {
        releaseWizardScript();
        page.off('request', observeGooglePost);
    }
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
    await page.unroute(wizardScriptPattern, holdWizardScript);
    phase = 'completing controlled Google authorization into the collision page';
    const googleStart = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/google'));
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click();
    const proofHeader = (await (await googleStart).allHeaders())['set-cookie'];
    assert.ok(proofHeader && !/;\s*Domain=/i.test(proofHeader), 'Google attempt cookie must remain host-only.');
    const resumeResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/google-resume'));
    await page.getByRole('button', { name: 'Continue with test identity', exact: true }).click();
    const resumeHeaders = (await resumeResponse).headers();
    assert.equal(resumeHeaders['referrer-policy'], 'same-origin', 'Google resume forms must preserve native same-origin POST Origin.');
    assert.ok(resumeHeaders['content-security-policy'].includes(`form-action 'self' ${applicationOrigin};`), 'Google OIDC resume CSP must permit its validated callback redirect chain.');
    const proofCookies = (await context.cookies(`${serviceOrigin}/service/`)).filter((cookie) => /^(?:__Secure-)?up_google_/.test(cookie.name));
    assert.equal(proofCookies.length, 1, 'This attempt must own one independent Google proof cookie.');
    const proofCookie = proofCookies[0];
    assert.equal(proofCookie.domain, browserHost, 'Proof cookie must be bound to the configured host.');
    assert.equal(proofCookie.path, '/service/', 'Proof cookie must cover the configured service prefix.');
    assert.equal(proofCookie.httpOnly, true, 'Google proof must not be readable by page JavaScript.');
    assert.equal(proofCookie.sameSite, 'Lax', 'Top-level Google callback requires SameSite=Lax.');
    assert.equal(proofCookie.secure, httpsMode, 'HTTPS proof cookie must require Secure.');
    assert.equal(proofCookie.name.startsWith('__Secure-'), httpsMode, 'Secure prefix must follow configured HTTPS.');
    phase = `submitting native ${linkMethod} reauthentication with its browser-generated Origin`;
    if (linkMethod === 'emailCode') {
        const sent = mail.length;
        await page.getByRole('button', { name: 'Email me a code', exact: true }).click();
        await page.getByRole('textbox', { name: 'Email code', exact: true }).waitFor();
        assert.equal(mail.length, sent + 1, 'A link-specific code must be sent to the verified mailbox.');
        assert.ok(mail.at(-1).correlationId.startsWith('google-link-email:'), 'The link code must be bound to the Google transaction.');
        await page.getByRole('textbox', { name: 'Email code', exact: true }).fill(mail.at(-1).code);
    }
    if (linkMethod === 'adminPassword') await page.getByLabel('Administrator password', { exact: true }).fill(adminPassword);
    if (linkMethod === 'totp') await page.getByRole('textbox', { name: 'Authenticator code', exact: true }).fill(totp.generateToken(totpSecret));
    const completionPath = linkMethod === 'emailCode' ? '/google-resume/verify-link-code' : '/google-resume/authenticate';
    const authenticationResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(completionPath));
    const button = { emailCode: 'Verify code', adminPassword: 'Confirm with administrator password', totp: 'Confirm with authenticator', passkey: 'Confirm with passkey' }[linkMethod];
    await page.getByRole('button', { name: button, exact: true }).click();
    let authenticated;
    try { authenticated = await authenticationResponse; } catch (error) {
        if (linkMethod === 'passkey') {
            const category = await page.evaluate(() => window.fixturePasskeyError || 'no-browser-error');
            assert.equal((await store.select('externalIdentity', {}, { start: 0, pageSize: 10 })).objects.length, 0, 'An unsuccessful passkey ceremony must not create a binding.');
            assert.equal(successfulCallbacks, 1, 'An unsuccessful passkey ceremony must not complete a Google application login.');
            assert.fail(`Passkey assertion was not submitted (${String(category).replace(/[^A-Za-z-]/g, '')}; assertions=${passkeyAssertions}).`);
        }
        throw error;
    }
    assert.equal(await authenticated.request().headerValue('origin'), serviceOrigin, 'Native credential POST must carry the exact service origin.');
    assert.equal(authenticated.status(), 200, 'Native credential authentication must succeed.');
    await page.getByRole('button', { name: 'Link Google and continue', exact: true }).waitFor();
    if (linkMethod === 'passkey') {
        assert.equal(passkeyAssertions, 1, 'The real Chromium WebAuthn ceremony must use the virtual credential once.');
        assert.equal((await store.getAuthMethodByKey(passkeyCredentialKey)).credential.counter, 1, 'Server verification must advance the enrolled passkey counter.');
    }
    if (linkMethod === 'totp') {
        assert.ok((await store.getAuthMethodByKey(`${owner.id}:totp`)).credential.lastUsedCounter > 0, 'Server verification must consume the enrolled TOTP counter.');
    }
    assert.equal(successfulCallbacks, 1, 'Reauthentication must await explicit linking confirmation before application success.');
    assert.equal((await store.select('externalIdentity', {}, { start: 0, pageSize: 10 })).objects.length, 0, 'Reauthentication alone must not link Google.');
    phase = 'confirming Google linking through the previously consented cross-origin callback';
    await page.getByRole('button', { name: 'Link Google and continue', exact: true }).click();
    await page.getByRole('heading', { name: 'Client completed', exact: true }).waitFor();
    assert.equal(new URL(page.url()).origin, applicationOrigin, 'Final navigation must reach the registered application origin.');
    assert.equal(successfulCallbacks, 2, 'Google linking must complete signed downstream token and UserInfo verification.');
    assert.equal(callbackFailed, false, 'Neither callback may fail verification.');
    assert.equal(cspErrors, 0, 'Native Google form navigation must not trigger a CSP violation.');
    const bindings = (await store.select('externalIdentity', {}, { start: 0, pageSize: 10 })).objects;
    assert.equal(bindings.length, 1, 'Confirmation must create exactly one Google binding.');
    assert.equal(bindings[0].userId, owner.id, 'The binding must belong to the authenticated local user.');
    assert.equal((await context.cookies(`${serviceOrigin}/service/`)).filter((cookie) => /^(?:__Secure-)?up_google_/.test(cookie.name)).length, 0, 'Successful completion must clear the attempt proof cookie.');
    output(`PASS Chromium ${browser.version()} ${httpsMode ? 'HTTPS' : 'HTTP'} ${browserHost} ${linkMethod}: passwordless wizard sign-in, no Google control before the wizard loads, native form Origin, explicit linking, consented callback CSP, local subject and roles, scoped host-only proof cookie.`);
}

try {
    await verify();
} catch (error) {
    // Browser diagnostics may contain callback queries or request bodies. Keep
    // this opt-in runner's output free of codes, cookies, passwords and tokens.
    console.error(`FAIL during ${phase}: ${error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'browser or fixture operation failed'}`);
    process.exitCode = 1;
} finally {
    await Promise.allSettled([browser?.close(), closeServer(application), closeServer(proxy), closeServer(service), google?.close()]);
    setup.clearAdministratorPassword();
    resetOidcProviderForTests();
    await resetStoreForTests();
    if (folder) await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(environment, name)) delete process.env[name];
    Object.assign(process.env, environment);
}
