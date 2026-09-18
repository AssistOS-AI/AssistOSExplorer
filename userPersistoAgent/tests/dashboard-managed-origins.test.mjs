import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRouterSigner } from './helpers/router-fixture.mjs';
import { isolatePloinkyWorkspace, useManagedRuntime } from './helpers/managedRouterRuntime.mjs';

const ORIGIN = 'https://account.example.test';
const PREFIX = '/service/dashboard';
const MANAGED = ['http://100.73.151.25:3000', 'http://pgx:3000'];
const workspace = isolatePloinkyWorkspace();
let folder, server, base, sign, admin;
let ensureSeedData, createUser, getStore, resetStoreForTests, startService, UserpersistoSettings;

before(async () => {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-dashboard-managed-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-dashboard-managed-settings';
    for (const key of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_TRUST_ROUTER_ORIGINS',
        'USERPERSISTO_SELF_REGISTRATION_ENABLED', 'USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_GOOGLE_REDIRECT_URI']) {
        delete process.env[key];
    }
    ({ ensureSeedData } = await import('../lib/bootstrap.mjs'));
    ({ createUser } = await import('../lib/users.mjs'));
    ({ getStore, resetStoreForTests } = await import('../lib/store.mjs'));
    ({ startService } = await import('../service/index.mjs'));
    ({ UserpersistoSettings } = await import('../public/dashboard/management.mjs'));
    sign = await createRouterSigner();
    await ensureSeedData();
    admin = await createUser({ email: 'managed-admin@example.test', roles: ['admin'], emailVerified: true });
    server = startService({ port: 0, host: '127.0.0.1' }, { emailStatus: async () => ({ available: true }) });
    if (!server.listening) await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await resetStoreForTests();
    await rm(folder, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
});

async function admin_(endpoint, body = {}) {
    const path = `${PREFIX}/api/admin/${endpoint}`;
    const rawBody = JSON.stringify(body);
    const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: sign({ method: 'POST', path, rawBody, userId: admin.id, origin: ORIGIN }),
        body: rawBody,
    });
    return { status: response.status, data: await response.json() };
}

async function storedPolicy() {
    return (await (await getStore()).getSystemSettingByKey('auth.policy'))?.value || null;
}

function panelFor() {
    const panel = new UserpersistoSettings({ getAttribute: () => 'policy' }, () => {});
    panel.state.activePanel = 'policy';
    panel.state.authProfile = { roles: ['admin'], capabilities: ['admin.agentSettings.manage'] };
    panel.authMethodInputs = Object.fromEntries(['emailCode', 'passkey', 'totp', 'google'].map((method) => [method, { checked: false }]));
    panel.selfRegistrationInput = { checked: true };
    panel.signupVerificationInput = { checked: false };
    panel.allowedRedirectOriginsInput = { value: '' };
    panel.authPolicySourceEl = {};
    panel.googleStatusEl = {};
    panel.managedOriginStatusEl = {};
    panel.managedOriginsEl = {};
    panel.refreshAuthProfile = async () => {};
    const calls = [];
    const routes = { userpersisto_auth_policy_get: 'policy/get', userpersisto_auth_policy_set: 'policy/set', userpersisto_google_status: 'google/status' };
    panel.callTool = async (name, args = {}) => {
        calls.push({ name, args });
        const { status, data } = await admin_(routes[name], args);
        if (status !== 200) throw Object.assign(new Error(data.error), { statusCode: status, code: data.error });
        return data.result;
    };
    return { panel, calls };
}

test('policy reads report managed Router origins beside, never inside, the writable explicit list', async (t) => {
    const runtime = await useManagedRuntime(t, { workspace, origins: MANAGED });
    const saved = await admin_('policy/set', { enabledAuthMethods: ['emailCode', 'passkey'], allowedRedirectOrigins: ['https://workspace.example.test'] });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual(saved.data.result.allowedRedirectOrigins, ['https://workspace.example.test']);

    const read = await admin_('policy/get');
    assert.equal(read.status, 200);
    const result = read.data.result;
    assert.deepEqual(result.allowedRedirectOrigins, ['https://workspace.example.test']);
    assert.equal(result.allowedRedirectOriginsSource, 'policy');
    assert.equal(result.loopbackOriginsAllowed, true);
    assert.equal(result.managedOriginTrustEnabled, true);
    assert.equal(result.managedOriginStatus, 'verified');
    assert.match(result.managedOriginGeneration, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(result.managedRedirectOrigins, MANAGED);
    assert.deepEqual(result.effectiveRedirectOrigins, [...MANAGED, 'https://workspace.example.test'].sort());

    // Reads are fresh: a removed binding disappears without any write.
    runtime.listener.setOrigins(['http://pgx:3000']);
    assert.deepEqual((await admin_('policy/get')).data.result.managedRedirectOrigins, ['http://pgx:3000']);
    runtime.listener.fail(503, 'EDGE_GENERATION_INACTIVE');
    const unavailable = (await admin_('policy/get')).data.result;
    assert.equal(unavailable.managedOriginStatus, 'unavailable');
    assert.deepEqual(unavailable.managedRedirectOrigins, []);
    assert.deepEqual(unavailable.effectiveRedirectOrigins, ['https://workspace.example.test']);
    assert.equal(JSON.stringify(await storedPolicy()).includes('pgx'), false);
});

test('setters refuse read-only managed metadata instead of silently persisting or dropping it', async (t) => {
    await useManagedRuntime(t, { workspace, origins: MANAGED });
    const before = JSON.stringify(await storedPolicy());
    for (const field of ['managedRedirectOrigins', 'effectiveRedirectOrigins', 'managedOriginTrustEnabled', 'managedOriginStatus',
        'managedOriginGeneration', 'allowedRedirectOriginsSource', 'loopbackOriginsAllowed', 'environmentOverrides', 'registrationRole',
        'emailDeliveryAvailable']) {
        const rejected = await admin_('policy/set', { enabledAuthMethods: ['emailCode'], [field]: MANAGED });
        assert.equal(rejected.status, 400, field);
        assert.equal(rejected.data.error, 'read_only_policy_field', field);
    }
    assert.equal(JSON.stringify(await storedPolicy()), before);
    // Unrelated unknown fields keep the existing whitelist behavior.
    assert.equal((await admin_('policy/set', { enabledAuthMethods: ['emailCode', 'passkey'], defaultRegistrationRole: 'admin' })).status, 200);
});

test('loading and saving the authentication page cannot register managed Router origins', async (t) => {
    await useManagedRuntime(t, { workspace, origins: MANAGED });
    await admin_('policy/set', { enabledAuthMethods: ['emailCode', 'passkey'], allowedRedirectOrigins: ['https://workspace.example.test'] });
    const { panel, calls } = panelFor();
    await panel.refreshAuthPolicy();
    assert.equal(panel.state.policyLoaded, true);
    assert.equal(panel.allowedRedirectOriginsInput.value, 'https://workspace.example.test');
    assert.equal(panel.managedOriginsEl.textContent, MANAGED.join('\n'));
    assert.match(panel.managedOriginStatusEl.textContent, /Trusted automatically from the active workspace Router binding/);

    await panel.saveAuthPolicy();
    const save = calls.find((call) => call.name === 'userpersisto_auth_policy_set');
    assert.deepEqual(Object.keys(save.args).sort(), ['allowedRedirectOrigins', 'enabledAuthMethods', 'selfRegistrationEnabled', 'signupEmailVerificationRequired']);
    assert.equal(save.args.signupEmailVerificationRequired, false);
    assert.deepEqual(save.args.allowedRedirectOrigins, ['https://workspace.example.test']);
    const stored = await storedPolicy();
    assert.deepEqual(stored.allowedRedirectOrigins, ['https://workspace.example.test']);
    assert.equal(JSON.stringify(stored).includes('pgx') || JSON.stringify(stored).includes('100.73'), false);

    panel.clearAuthPolicy();
    assert.equal(panel.managedOriginsEl.textContent, '');
    assert.equal(panel.managedOriginStatusEl.textContent, '');
});

test('administrators can tell disabled, standalone, unsupported, unavailable, and environment-sourced states apart', async (t) => {
    const runtime = await useManagedRuntime(t, { workspace, origins: MANAGED });
    const { panel } = panelFor();
    const statusFor = async () => {
        await panel.refreshAuthPolicy();
        return panel.managedOriginStatusEl.textContent;
    };
    process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS = 'https://override.example.test';
    t.after(() => { delete process.env.USERPERSISTO_ALLOWED_REDIRECT_ORIGINS; delete process.env.USERPERSISTO_TRUST_ROUTER_ORIGINS; });
    const overridden = (await admin_('policy/get')).data.result;
    assert.equal(overridden.allowedRedirectOriginsSource, 'environment');
    assert.ok(overridden.environmentOverrides.includes('USERPERSISTO_ALLOWED_REDIRECT_ORIGINS'));
    assert.match(await statusFor(), /Trusted automatically/);
    assert.match(panel.authPolicySourceEl.textContent, /USERPERSISTO_ALLOWED_REDIRECT_ORIGINS/);

    runtime.listener.fail(503, 'EDGE_GENERATION_INACTIVE');
    assert.match(await statusFor(), /temporarily unavailable/);
    runtime.listener.fail(404, 'PRIVATE_ROUTE_SURFACE_DENIED');
    assert.match(await statusFor(), /metadata is invalid/);
    process.env.USERPERSISTO_TRUST_ROUTER_ORIGINS = 'false';
    assert.match(await statusFor(), /disabled/);
    process.env.USERPERSISTO_TRUST_ROUTER_ORIGINS = 'sometimes';
    assert.match(await statusFor(), /must be true or false/);
    delete process.env.USERPERSISTO_TRUST_ROUTER_ORIGINS;

    const legacy = await useManagedRuntime(t, { workspace, omitRouterOrigins: true });
    assert.match(await statusFor(), /does not publish Router addresses/);
    assert.equal(legacy.listener.state.requests.length, 0);
    assert.equal(panel.managedOriginsEl.textContent, '');
    // Standalone: remove the generated descriptor contract, keeping only what
    // this dashboard fixture needs to verify its own signed requests.
    for (const name of Object.keys(legacy.env)) {
        if (!['PLOINKY_AGENT_ID', 'PLOINKY_AGENT_RUNTIME_ROOT'].includes(name)) delete process.env[name];
    }
    assert.match(await statusFor(), /Not running under a managed workspace Router/);
});

test('the authentication page explains missing email delivery and reflects the verification switch', async (t) => {
    await useManagedRuntime(t, { workspace, origins: MANAGED });
    await admin_('policy/set', { enabledAuthMethods: ['password', 'emailCode'], signupEmailVerificationRequired: true });
    const { panel } = panelFor();
    const nodes = [];
    const deliveryStatus = {
        _text: '',
        get textContent() { return this._text + nodes.filter((node) => typeof node === 'string').join(''); },
        set textContent(value) { nodes.length = 0; this._text = String(value); },
        replaceChildren() { nodes.length = 0; this._text = ''; },
        append(...children) { for (const child of children) nodes.push(child); },
    };
    panel.emailDeliveryStatusEl = deliveryStatus;
    panel.element.ownerDocument = { createElement: () => ({ href: '', target: '', rel: '', textContent: '' }) };
    await panel.refreshAuthPolicy();
    assert.equal(panel.state.policyLoaded, true);
    assert.equal(panel.signupVerificationInput.checked, true);
    assert.match(deliveryStatus.textContent, /Email delivery is not configured\. Unavailable: email codes, password reset, email sign-up\. /);
    const link = nodes.find((node) => node && node.href);
    assert.deepEqual([link.href, link.textContent, link.rel], ['/admin/settings.html', 'Open Settings → Email Agent', 'noopener noreferrer']);

    process.env.USERPERSISTO_DEV_BOOTSTRAP = 'true';
    t.after(() => { delete process.env.USERPERSISTO_DEV_BOOTSTRAP; });
    await panel.refreshAuthPolicy();
    assert.equal(deliveryStatus.textContent, 'Email delivery is configured.');

    await admin_('policy/set', { signupEmailVerificationRequired: false });
    process.env.USERPERSISTO_DEV_BOOTSTRAP = 'true';
    await panel.refreshAuthPolicy();
    assert.equal(panel.signupVerificationInput.checked, false);
});
