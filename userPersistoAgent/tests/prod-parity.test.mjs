import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import * as oidc from 'openid-client';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { getUserById } from '../lib/users.mjs';
import { environmentPolicyOverrides, getAuthPolicy, updateAuthPolicy, usableSignInMethods } from '../lib/policy.mjs';
import { getEnabledAuthMethods } from '../lib/auth/methods.mjs';
import { getGoogleStatus } from '../lib/auth/google.mjs';
import { wizardConfiguration } from '../lib/auth/wizardConfig.mjs';
import { reauthenticationMethods } from '../lib/auth/operationGrants.mjs';
import { createLoginRequest, consumeAuthCode } from '../lib/sso.mjs';
import { createOidcClient } from '../lib/oidc/clients.mjs';
import { resetOidcProviderForTests } from '../lib/oidc/provider.mjs';
import { startService } from '../service/index.mjs';
import { CookieBrowser, csrf } from './helpers/googleProvider.mjs';
import * as setup from './helpers/setup.mjs';

// `PROD` has no authentication, email-delivery or logging meaning. Every check
// runs with the variable absent and with present values that once selected a
// Google-only mode.
const PROD_VALUES = [undefined, '', 'false', '0', 'true', 'production'];
const agentRoot = fileURLToPath(new URL('..', import.meta.url));
let folder;
let previousEnvironment;
let server;

function setProd(value) {
    if (value === undefined) delete process.env.PROD;
    else process.env.PROD = value;
}

beforeEach(async () => {
    previousEnvironment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-prod-parity-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'prod-parity-fixture-settings';
    for (const name of ['PROD', 'USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_ADMIN_PASSWORD', 'USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_DEV_BOOTSTRAP',
        'USERPERSISTO_GOOGLE_REDIRECT_URI', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_OIDC_ISSUER', 'USERPERSISTO_SELF_REGISTRATION_ENABLED']) delete process.env[name];
    setup.resetAuthLimitsForTests();
    await ensureSeedData();
});

afterEach(async () => {
    if (server?.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    server = undefined;
    resetOidcProviderForTests();
    await resetStoreForTests();
    await rm(folder, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, name)) delete process.env[name];
    Object.assign(process.env, previousEnvironment);
});

async function startHttp(options = {}) {
    const mail = [];
    server = startService({ port: 0, host: '127.0.0.1' }, {
        deliverEmail: async (message) => { mail.push(message); return { delivered: true, providerMessageId: 'parity-fixture' }; },
        ...options,
    });
    if (!server.listening) await once(server, 'listening');
    return { base: `http://127.0.0.1:${server.address().port}`, mail };
}

test('policy, configuration, usable methods and confirmation methods are identical for every PROD value', async () => {
    const owner = await setup.signUpWithPassword('owner@example.test');
    const snapshot = async () => {
        const user = await getUserById(owner.user.id);
        return {
            policy: await getAuthPolicy(),
            methods: await getEnabledAuthMethods(),
            overrides: environmentPolicyOverrides(),
            configuration: await wizardConfiguration({ emailAvailable: true }),
            google: await getGoogleStatus(),
            usable: await usableSignInMethods(user, { emailAvailable: true }),
            confirmation: await reauthenticationMethods(user),
        };
    };
    const baseline = await snapshot();
    assert.deepEqual(baseline.policy.enabledAuthMethods, ['password', 'emailCode', 'passkey', 'totp', 'google']);
    assert.deepEqual(baseline.overrides, []);
    assert.equal(baseline.google.policySource, 'stored-or-default');
    assert.deepEqual(baseline.usable.slice(0, 2), ['password', 'emailCode']);
    for (const value of PROD_VALUES) {
        setProd(value);
        assert.deepEqual(await snapshot(), baseline, JSON.stringify(value));
    }
    // Explicit restrictions are respected the same way whatever PROD says.
    process.env.USERPERSISTO_AUTH_METHODS = 'emailCode,google';
    for (const value of PROD_VALUES) {
        setProd(value);
        const configuration = await wizardConfiguration({ emailAvailable: true });
        assert.deepEqual([configuration.methods.password, configuration.signup.email], [false, false], JSON.stringify(value));
        assert.deepEqual(environmentPolicyOverrides(), ['USERPERSISTO_AUTH_METHODS']);
    }
    delete process.env.USERPERSISTO_AUTH_METHODS;
    await updateAuthPolicy({ enabledAuthMethods: ['password'] }, { actorId: owner.user.id, emailStatus: async () => ({ available: false }) });
    for (const value of PROD_VALUES) {
        setProd(value);
        assert.deepEqual((await getAuthPolicy()).enabledAuthMethods, ['password'], JSON.stringify(value));
    }
});

test('SSO signup, password login, email-code login and public readiness behave identically with PROD present', async () => {
    const { base, mail } = await startHttp();
    const results = [];
    for (const value of PROD_VALUES) {
        setProd(value);
        setup.resetAuthLimitsForTests();
        const label = JSON.stringify(value);
        const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
        const browser = new CookieBrowser();
        const post = (path, body) => browser.json(`${base}/service/auth/${path}`, { requestId: request.providerState, state: 'parity', ...body });
        const attempt = await (await post('attempt')).json();
        const { expiresAt, attempt: status, ...configuration } = attempt;
        assert.ok(expiresAt > Date.now());
        assert.equal(status.status, 'active');
        const email = `parity-${results.length}@example.test`;
        const password = setup.newTestPassword();
        const staged = await post('signup/start', { email, password, passwordConfirmation: password });
        assert.equal(staged.status, 200, label);
        const created = await post('signup/verify', { code: mail.at(-1).code });
        assert.equal(created.status, 200, label);
        await consumeAuthCode({ providerState: request.providerState, code: (await created.json()).code });
        const loginRequest = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
        const login = await new CookieBrowser().json(`${base}/service/auth/password/login`, { requestId: loginRequest.providerState, state: 'parity', email, password });
        assert.equal(login.status, 200, label);
        const codeRequest = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
        const codeBrowser = new CookieBrowser();
        const discovered = await (await codeBrowser.json(`${base}/service/auth/discover`, { requestId: codeRequest.providerState, email })).json();
        assert.deepEqual(discovered.methods, { password: true, emailCode: true, passkey: false, totp: false }, label);
        const sent = await codeBrowser.json(`${base}/service/auth/email-code/start`, { requestId: codeRequest.providerState, email, purpose: 'login' });
        assert.equal(sent.status, 200, label);
        const signedIn = await codeBrowser.json(`${base}/service/auth/email-code/verify`, { requestId: codeRequest.providerState, state: 'parity', code: mail.at(-1).code });
        assert.equal(signedIn.status, 200, label);
        const readiness = await (await fetch(`${base}/service/auth/setup`)).json();
        const methods = await (await fetch(`${base}/service/auth/methods`)).json();
        assert.equal(configuration.initialPasswordSetup, results.length === 0, 'only the first unclaimed installation offers setup');
        assert.equal(readiness.initialPasswordSetup, false, 'completed signup permanently closes the exception');
        results.push({ configuration: { ...configuration, setupComplete: undefined, initialPasswordSetup: undefined },
            readiness: { ...readiness, setupComplete: undefined }, methods });
    }
    for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
    assert.equal(results[0].configuration.methods.password, true);
    assert.equal(Object.hasOwn(results[0].configuration, 'googleOnly'), false);
});

test('the OIDC wizard configuration and native password login are identical with PROD present', async () => {
    const owner = await setup.signUpWithPassword('oidc-owner@example.test');
    const { base } = await startHttp();
    const issuer = `${base}/service/oidc`;
    process.env.USERPERSISTO_OIDC_ISSUER = issuer;
    const callback = 'https://parity-client.example.test/callback';
    await createOidcClient({ client_id: 'parity-client', redirect_uris: [callback], token_endpoint_auth_method: 'none', scope: 'openid email' }, { actorId: owner.user.id });
    const config = await oidc.discovery(new URL(issuer), 'parity-client', undefined, oidc.None(), { execute: [oidc.allowInsecureRequests] });
    const shells = [];
    for (const value of PROD_VALUES) {
        setProd(value);
        setup.resetAuthLimitsForTests();
        const authorization = oidc.buildAuthorizationUrl(config, { redirect_uri: callback, scope: 'openid email', state: oidc.randomState(), nonce: oidc.randomNonce(),
            code_challenge: await oidc.calculatePKCECodeChallenge(oidc.randomPKCECodeVerifier()), code_challenge_method: 'S256' });
        const browser = new CookieBrowser();
        const interaction = new URL((await browser.fetch(authorization)).headers.get('location'), base).href;
        const html = await (await browser.fetch(interaction)).text();
        const { base: shellBase, csrf: token, expiresAt, ...shell } = JSON.parse(html.match(/<script type="application\/json" id="userpersisto-wizard-config">([^<]+)<\/script>/)[1]);
        assert.ok(shellBase && token && expiresAt);
        shells.push(shell);
        const submitted = await browser.post(`${interaction}/password-login`, { csrf: csrf(html), email: owner.user.email, password: owner.password });
        assert.equal(submitted.status, 303, `${JSON.stringify(value)}: ${await submitted.clone().text()}`);
    }
    for (const shell of shells.slice(1)) assert.deepEqual(shell, shells[0]);
    assert.deepEqual([shells[0].methods.password, shells[0].signup.email], [true, true]);
});

test('USERPERSISTO_DEV_BOOTSTRAP keeps its development-only delivery meaning with and without PROD', async () => {
    const { base } = await startHttp({ deliverEmail: async () => ({ delivered: false }), emailStatus: undefined });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...parts) => { warnings.push(parts.join(' ')); };
    try {
        for (const value of [undefined, 'true']) {
            setProd(value);
            setup.resetAuthLimitsForTests();
            process.env.USERPERSISTO_DEV_BOOTSTRAP = 'true';
            const request = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
            const browser = new CookieBrowser();
            const password = setup.newTestPassword();
            const email = `development-${warnings.length}@example.test`;
            const staged = await browser.json(`${base}/service/auth/signup/start`, { requestId: request.providerState, email, password, passwordConfirmation: password });
            assert.equal(staged.status, 200);
            assert.equal((await staged.json()).challenge.delivery, 'development-log', JSON.stringify(value));
            assert.ok(warnings.at(-1).startsWith(`[userPersisto] DEVELOPMENT email code for ${email}: `));
            assert.equal(warnings.some((warning) => warning.includes(password)), false);
            delete process.env.USERPERSISTO_DEV_BOOTSTRAP;
            const next = await createLoginRequest({ redirectUri: `${base}/auth/callback` });
            const failed = await new CookieBrowser().json(`${base}/service/auth/signup/start`, { requestId: next.providerState,
                email: `${email}.failed`, password, passwordConfirmation: password });
            assert.equal(failed.status, 200);
            assert.equal((await failed.json()).challenge.delivery, 'failed', 'without the flag a failed provider stays a failure');
        }
    } finally {
        console.warn = originalWarn;
    }
});

async function sourceFiles(path) {
    const entries = [];
    for (const entry of await readdir(path)) {
        if (['node_modules', 'external', 'tests', '.git'].includes(entry)) continue;
        const full = join(path, entry);
        if ((await stat(full)).isDirectory()) entries.push(...await sourceFiles(full));
        else if (/\.(mjs|js|json|html|css|sh|md)$/.test(entry)) entries.push(full);
    }
    return entries;
}

test('no source, manifest, tool definition or page reads PROD or retains a shared administrator password', async () => {
    const retired = /\bPROD\b|googleOnly|production\.mjs|productionSuspended|adminPassword|admin-login|admin\/login|USERPERSISTO_ADMIN_PASSWORD|DEFAULT_ADMIN_PASSWORD|Admin password|Administrator password/;
    const offenders = [];
    for (const file of await sourceFiles(agentRoot)) {
        const text = await readFile(file, 'utf8');
        const match = text.match(retired);
        if (match) offenders.push(`${relative(agentRoot, file)}: ${match[0]}`);
    }
    assert.deepEqual(offenders, []);
    const manifest = JSON.parse(await readFile(join(agentRoot, 'manifest.json'), 'utf8'));
    for (const profile of Object.values(manifest.profiles)) {
        for (const name of ['PROD', 'USERPERSISTO_ADMIN_PASSWORD']) assert.equal(Object.hasOwn(profile.env || {}, name), false, name);
    }
    const tools = JSON.parse(await readFile(join(agentRoot, 'mcp-config.json'), 'utf8')).tools;
    assert.equal(tools.some((tool) => /password/i.test(tool.name) || Object.keys(tool.inputSchema?.properties || {}).some((name) => /password/i.test(name))), false,
        'no MCP tool accepts or manages a password');
    assert.equal((await (await getStore()).select('systemSetting')).objects.some((setting) => /adminPassword/.test(setting.key)), false);
});
