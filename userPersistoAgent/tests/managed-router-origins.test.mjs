import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyAgentEnvironment,
    isolatePloinkyWorkspace,
    resolvePloinkyRoot,
    useManagedRuntime,
    writeTopology,
} from './helpers/managedRouterRuntime.mjs';

process.env.PERSISTENCE_FOLDER = mkdtempSync(join(tmpdir(), 'userpersisto-managed-origins-'));
process.env.USERPERSISTO_SETTINGS_KEY = 'test-managed-origins-settings';
process.env.USERPERSISTO_RUNTIME_SECRET = 'test-managed-origins-runtime';
for (const name of ['USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_TRUST_ROUTER_ORIGINS']) {
    delete process.env[name];
}
const workspace = isolatePloinkyWorkspace();
const ploinkyRoot = resolvePloinkyRoot();

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { createUser } = await import('../lib/users.mjs');
const { getStore, resetStoreForTests } = await import('../lib/store.mjs');
const policy = await import('../lib/policy.mjs');
const sso = await import('../lib/sso.mjs');
const passkey = await import('../lib/auth/passkey.mjs');
const managed = await import('../lib/auth/managedRouterOrigins.mjs');
const { startService } = await import('../service/index.mjs');
const { createProvider } = await import('../runtime/index.mjs');

const PGX = 'http://pgx:3000';
const TAILSCALE = 'http://100.73.151.25:3000';
let member;

before(async () => {
    await ensureSeedData();
    member = await createUser({ email: 'managed-member@example.test', roles: ['user'] });
});

after(async () => {
    await resetStoreForTests();
    rmSync(process.env.PERSISTENCE_FOLDER, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
});

function withEnv(t, values) {
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    t.after(() => {
        for (const [name, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

async function rejectsWithCode(promise, code, statusCode) {
    await assert.rejects(promise, (error) => {
        assert.equal(error.code, code, error.message);
        assert.equal(error.statusCode, statusCode);
        return true;
    });
}

test('the trust switch is strict: unset or empty enables, only true or false are valid', () => {
    for (const value of [undefined, '', '   ', 'true', 'TRUE', ' True ']) {
        assert.deepEqual(managed.readTrustRouterOriginsSetting({ USERPERSISTO_TRUST_ROUTER_ORIGINS: value }), { enabled: true, valid: true }, String(value));
    }
    for (const value of ['false', 'FALSE', ' false ']) {
        assert.deepEqual(managed.readTrustRouterOriginsSetting({ USERPERSISTO_TRUST_ROUTER_ORIGINS: value }), { enabled: false, valid: true }, value);
    }
    for (const value of ['1', '0', 'yes', 'no', 'off', 'on', 'enabled', 'true,false']) {
        assert.deepEqual(managed.readTrustRouterOriginsSetting({ USERPERSISTO_TRUST_ROUTER_ORIGINS: value }), { enabled: false, valid: false }, value);
    }
});

test('managed runtimes are identified by the generated descriptor contract, not by agent identity alone', () => {
    assert.equal(managed.isManagedRuntime({}), false);
    assert.equal(managed.isManagedRuntime({ PLOINKY_AGENT_ID: 'agent:x/y', PLOINKY_AGENT_SECRET: 'a'.repeat(64) }), false);
    for (const env of [
        { PLOINKY_ROUTER_DESCRIPTOR_FILE: '/run/ploinky/router-descriptor.json' },
        { PLOINKY_EDGE_TOPOLOGY_FILE: '/run/ploinky-edge-topology/current.json' },
        { PLOINKY_INTERNAL_ROUTER_URL: 'http://host.containers.internal:8081' },
        { PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64) },
        { PLOINKY_ENV_SOURCE_PLOINKY_AGENT_ID: 'generated' },
    ]) {
        assert.equal(managed.isManagedRuntime(env), true, JSON.stringify(env));
    }
});

test('an empty manual policy accepts exactly the freshly verified managed hostname and address', async (t) => {
    const { listener } = await useManagedRuntime(t, { workspace, origins: [TAILSCALE, PGX] });
    assert.equal((await policy.getAuthPolicy()).allowedRedirectOrigins.length, 0);
    assert.equal(await policy.assertRedirectUriAllowed(`${PGX}/auth/callback`), `${PGX}/auth/callback`);
    assert.equal(await policy.assertRedirectUriAllowed(`${TAILSCALE}/auth/callback`), `${TAILSCALE}/auth/callback`);
    assert.equal(await policy.assertBrowserOriginAllowed(PGX), PGX);
    for (const uri of ['http://pgx:3001/auth/callback', 'https://pgx:3000/auth/callback', 'http://pgx.local:3000/auth/callback',
        'http://100.73.151.26:3000/auth/callback', 'http://attacker.example/auth/callback']) {
        await rejectsWithCode(policy.assertRedirectUriAllowed(uri), 'redirect_origin_not_allowed', 403);
    }
    await rejectsWithCode(policy.assertBrowserOriginAllowed('http://pgx:3001'), 'browser_origin_not_allowed', 403);
    const readsBefore = listener.state.requests.length;
    assert.ok(readsBefore >= 8, 'every managed decision performed its own read');

    // Loopback and configured origins never need Router metadata.
    listener.fail(503, 'EDGE_GENERATION_INACTIVE');
    assert.equal(await policy.assertRedirectUriAllowed('http://localhost:3000/auth/callback'), 'http://localhost:3000/auth/callback');
    assert.equal(await policy.assertBrowserOriginAllowed('http://[::1]:3000'), 'http://[::1]:3000');
    withEnv(t, { USERPERSISTO_ALLOWED_REDIRECT_ORIGINS: 'https://workspace.example.test' });
    assert.equal(await policy.assertRedirectUriAllowed('https://workspace.example.test/auth/callback'), 'https://workspace.example.test/auth/callback');
    assert.equal(listener.state.requests.length, readsBefore);

    for (const uri of ['not a url', 'javascript:alert(1)', 'ftp://pgx:3000/auth/callback', 'http://user:pass@pgx:3000/auth/callback']) {
        await rejectsWithCode(policy.assertRedirectUriAllowed(uri), 'invalid_redirect_uri', 400);
    }
    await rejectsWithCode(policy.assertBrowserOriginAllowed('http://pgx:3000/path'), 'invalid_browser_origin', 400);
});

test('manual additions and environment precedence are retained while managed origins are never persisted', async (t) => {
    await useManagedRuntime(t, { workspace, origins: [PGX] });
    await policy.updateAuthPolicy({ allowedRedirectOrigins: ['https://stored.example.test'] }, { emailStatus: async () => ({ available: true }) });
    assert.equal(await policy.assertRedirectUriAllowed('https://stored.example.test/auth/callback'), 'https://stored.example.test/auth/callback');
    withEnv(t, { USERPERSISTO_ALLOWED_REDIRECT_ORIGINS: 'https://override.example.test' });
    assert.deepEqual((await policy.getAuthPolicy()).allowedRedirectOrigins, ['https://override.example.test']);
    await rejectsWithCode(policy.assertRedirectUriAllowed('https://stored.example.test/auth/callback'), 'redirect_origin_not_allowed', 403);
    assert.equal(await policy.assertRedirectUriAllowed(`${PGX}/auth/callback`), `${PGX}/auth/callback`);
    const stored = await (await getStore()).getSystemSettingByKey('auth.policy');
    assert.deepEqual(stored.value.allowedRedirectOrigins, ['https://stored.example.test']);
    assert.equal(JSON.stringify(stored).includes('pgx'), false);

    for (const field of ['managedRedirectOrigins', 'effectiveRedirectOrigins', 'managedOriginStatus', 'environmentOverrides']) {
        await rejectsWithCode(policy.updateAuthPolicy({ [field]: [PGX] }), 'read_only_policy_field', 400);
    }
    await policy.updateAuthPolicy({ allowedRedirectOrigins: [] }, { emailStatus: async () => ({ available: true }) });
});

test('opting out or running standalone never reads or imports managed runtime metadata', async (t) => {
    const { listener } = await useManagedRuntime(t, { workspace, origins: [PGX] });
    withEnv(t, { USERPERSISTO_TRUST_ROUTER_ORIGINS: 'false' });
    await rejectsWithCode(policy.assertRedirectUriAllowed(`${PGX}/auth/callback`), 'redirect_origin_not_allowed', 403);
    assert.equal(listener.state.requests.length, 0);
    assert.deepEqual(await managed.describeManagedRouterOrigins(), { enabled: false, status: 'disabled', origins: [], generation: '' });

    process.env.USERPERSISTO_TRUST_ROUTER_ORIGINS = 'maybe';
    assert.equal(await policy.assertRedirectUriAllowed('http://127.0.0.1:8080/auth/callback'), 'http://127.0.0.1:8080/auth/callback');
    await rejectsWithCode(policy.assertRedirectUriAllowed(`${PGX}/auth/callback`), 'auth_origin_topology_invalid', 503);
    assert.equal((await managed.describeManagedRouterOrigins()).status, 'invalid-setting');
    assert.equal(listener.state.requests.length, 0);
    delete process.env.USERPERSISTO_TRUST_ROUTER_ORIGINS;

    // Standalone: no descriptor contract at all, and no reachable runtime tree.
    applyAgentEnvironment(t, { PLOINKY_AGENT_RUNTIME_ROOT: join(workspace, 'missing-runtime') });
    await rejectsWithCode(policy.assertRedirectUriAllowed(`${PGX}/auth/callback`), 'redirect_origin_not_allowed', 403);
    assert.equal(await policy.assertRedirectUriAllowed('http://localhost:8080/auth/callback'), 'http://localhost:8080/auth/callback');
    assert.equal((await managed.describeManagedRouterOrigins()).status, 'standalone');
    assert.equal(listener.state.requests.length, 0);
});

test('an older runtime without the capability keeps manual-only behavior without inferring support', async (t) => {
    // An older runtime tree has the generic topology reader but no Router-origin helper.
    const oldRuntime = join(workspace, 'old-agent-runtime');
    mkdirSync(join(oldRuntime, 'lib'), { recursive: true });
    for (const file of ['edgeTopology.mjs', 'routerOrigins.mjs']) {
        copyFileSync(join(ploinkyRoot, 'Agent/lib', file), join(oldRuntime, 'lib', file));
    }
    const legacy = await useManagedRuntime(t, { workspace, omitRouterOrigins: true, agentRuntimeRoot: oldRuntime });
    await rejectsWithCode(policy.assertRedirectUriAllowed(`${PGX}/auth/callback`), 'redirect_origin_not_allowed', 403);
    assert.equal((await managed.describeManagedRouterOrigins()).status, 'unsupported');
    assert.equal(legacy.listener.state.requests.length, 0);

    // The advisory field present with no working helper is invalid, not legacy.
    writeTopology(legacy.topologyFile, { routerOrigins: [PGX] });
    await rejectsWithCode(policy.assertRedirectUriAllowed(`${PGX}/auth/callback`), 'auth_origin_topology_invalid', 503);
    assert.equal(legacy.listener.state.requests.length, 0);
});

test('missing, malformed, unreachable, or rejected metadata never expands trust', async (t) => {
    const runtime = await useManagedRuntime(t, { workspace, origins: [PGX] });
    const denied = async (code, statusCode) => {
        await rejectsWithCode(policy.assertRedirectUriAllowed(`${PGX}/auth/callback`), code, statusCode);
        await rejectsWithCode(policy.assertBrowserOriginAllowed(PGX), code, statusCode);
    };

    runtime.listener.fail(503, 'EDGE_GENERATION_INACTIVE');
    await denied('auth_origin_topology_unavailable', 503);
    assert.equal((await managed.describeManagedRouterOrigins()).status, 'unavailable');
    runtime.listener.fail(404, 'PRIVATE_ROUTE_SURFACE_DENIED');
    await denied('auth_origin_topology_invalid', 503);
    runtime.listener.fail(401, 'PRIVATE_ASSERTION_REJECTED');
    await denied('auth_origin_topology_invalid', 503);
    runtime.listener.setOrigins([PGX]);
    assert.equal(await policy.assertBrowserOriginAllowed(PGX), PGX);

    for (const raw of ['{', JSON.stringify({ routerOrigins: [PGX] }), JSON.stringify({
        configurationGeneration: `sha256:${'d'.repeat(64)}`, authorizationGeneration: `sha256:${'c'.repeat(64)}`,
        publicationGeneration: 1, state: 'ready', routerOrigins: 'http://pgx:3000',
    })]) {
        writeTopology(runtime.topologyFile, { raw });
        await denied('auth_origin_topology_invalid', 503);
    }
    rmSync(runtime.topologyFile);
    await denied('auth_origin_topology_unavailable', 503);
    writeTopology(runtime.topologyFile, { routerOrigins: [PGX] });

    // Router-side identity rejection is covered with the real private pipeline;
    // an unusable local private secret must fail before any request.
    const readsBeforeIdentity = runtime.listener.state.requests.length;
    process.env.PLOINKY_AGENT_PRIVATE_SECRET = 'not-a-private-secret';
    await denied('auth_origin_topology_invalid', 503);
    assert.equal(runtime.listener.state.requests.length, readsBeforeIdentity);
    process.env.PLOINKY_AGENT_PRIVATE_SECRET = runtime.env.PLOINKY_AGENT_PRIVATE_SECRET;
    delete process.env.PLOINKY_EDGE_TOPOLOGY_FILE;
    await denied('auth_origin_topology_invalid', 503);
    process.env.PLOINKY_EDGE_TOPOLOGY_FILE = runtime.topologyFile;
    assert.equal(await policy.assertBrowserOriginAllowed(PGX), PGX);
});

test('removal is observed by the next decision and denies a pending SSO request before any code is issued', async (t) => {
    const runtime = await useManagedRuntime(t, { workspace, origins: [TAILSCALE, PGX] });
    withEnv(t, { USERPERSISTO_ALLOWED_REDIRECT_ORIGINS: 'https://workspace.example.test' });
    const pending = await sso.createLoginRequest({ redirectUri: `${TAILSCALE}/auth/callback` });
    const manual = await sso.createLoginRequest({ redirectUri: 'https://workspace.example.test/auth/callback' });
    const loopback = await sso.createLoginRequest({ redirectUri: 'http://127.0.0.1:3000/auth/callback' });

    runtime.listener.setOrigins([PGX]);
    await rejectsWithCode(sso.getLoginRequest(pending.providerState), 'redirect_origin_not_allowed', 403);
    await rejectsWithCode(sso.issueAuthCode({ providerState: pending.providerState, userId: member.id }), 'redirect_origin_not_allowed', 403);
    const codes = await (await getStore()).select('ssoAuthCode');
    assert.equal(codes.objects.some((code) => code.providerState === pending.providerState), false);

    assert.ok((await sso.issueAuthCode({ providerState: manual.providerState, userId: member.id })).code, 'unrelated manual origins survive');
    runtime.listener.fail(503, 'EDGE_GENERATION_INACTIVE');
    assert.ok((await sso.issueAuthCode({ providerState: loopback.providerState, userId: member.id })).code);

    // A port change is the same removal from the consumer's view.
    runtime.listener.setOrigins(['http://pgx:3001']);
    await rejectsWithCode(sso.createLoginRequest({ redirectUri: `${PGX}/auth/callback` }), 'redirect_origin_not_allowed', 403);
    assert.ok(await sso.createLoginRequest({ redirectUri: 'http://pgx:3001/auth/callback' }));
});

test('passkey options use the effective origin set while relying-party checks stay exact', async (t) => {
    const runtime = await useManagedRuntime(t, { workspace, origins: ['http://pgx.example.lan:3000'] });
    const user = await createUser({ email: 'managed-passkey@example.test', roles: ['user'] });
    const options = await passkey.registrationOptions({ userId: user.id, origin: 'http://pgx.example.lan:3000', rpId: 'pgx.example.lan' });
    assert.equal(options.ok, true);
    assert.equal(options.publicKey.rp.id, 'pgx.example.lan');
    await assert.rejects(passkey.registrationOptions({ userId: user.id, origin: 'http://pgx.example.lan:3000', rpId: 'attacker.example' }),
        (error) => error.code === 'invalid_webauthn_rp_id');
    runtime.listener.setOrigins([]);
    await rejectsWithCode(passkey.registrationOptions({ userId: user.id, origin: 'http://pgx.example.lan:3000', rpId: 'pgx.example.lan' }),
        'browser_origin_not_allowed', 403);
});

test('provider runtime and service preserve exact typed login rejections without reading metadata at startup', async (t) => {
    const runtime = await useManagedRuntime(t, { workspace, origins: [PGX] });
    const server = startService({ port: 0, host: '127.0.0.1' }, { emailStatus: async () => ({ available: true }) });
    if (!server.listening) await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['/service/auth/setup', '/service/auth/methods']) {
        assert.equal((await fetch(`${base}${path}`)).status, 200, path);
    }
    assert.equal(runtime.listener.state.requests.length, 0, 'startup and readiness never depend on active Router metadata');

    const provider = createProvider({ getConfig: async () => ({
        routerBaseUrl: base, runtimePath: '/service/runtime', loginPath: '/service/auth/',
        runtimeSecret: process.env.USERPERSISTO_RUNTIME_SECRET,
    }) });
    const started = await provider.sso_begin_login({ redirectUri: `${PGX}/auth/callback`, supportsCanonicalLoginOrigin: true });
    assert.equal(new URL(started.authorizationUrl).origin, PGX);
    assert.equal(runtime.listener.state.requests.length, 1, 'one login start shares one fresh read across its checks');

    const expectations = [
        [() => runtime.listener.setOrigins([]), `${PGX}/auth/callback`, 'redirect_origin_not_allowed', 403],
        [() => runtime.listener.fail(503, 'EDGE_GENERATION_INACTIVE'), `${PGX}/auth/callback`, 'auth_origin_topology_unavailable', 503],
        [() => runtime.listener.fail(400, 'RUNTIME_ORIGINS_REQUEST_INVALID'), `${PGX}/auth/callback`, 'auth_origin_topology_invalid', 503],
        [() => {}, 'http://user:secret@pgx:3000/auth/callback', 'invalid_redirect_uri', 400],
    ];
    for (const [arrange, redirectUri, code, status] of expectations) {
        arrange();
        const response = await fetch(`${base}/service/runtime/sso-login-request`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-userpersisto-runtime-secret': process.env.USERPERSISTO_RUNTIME_SECRET },
            body: JSON.stringify({ redirectUri, supportsCanonicalLoginOrigin: true }),
        });
        assert.equal(response.status, status, code);
        assert.deepEqual(await response.json(), { ok: false, error: code });
        if (code !== 'invalid_redirect_uri') {
            await assert.rejects(provider.sso_begin_login({ redirectUri }), (error) => error.code === code && error.statusCode === status);
        }
    }
    const requests = await (await getStore()).select('ssoLoginRequest');
    assert.equal(requests.objects.filter((request) => request.redirectUri.startsWith(PGX)).length, 1, 'rejections create no login requests');
});
