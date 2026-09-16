// Cross-component flow on a bound workspace origin with an empty manual
// allow-list: the real Ploinky edge generation, public Router auth handler,
// private runtime-origins operation and provider bridge, and the real
// UserPersisto provider runtime, service and wizard endpoints with isolated
// persistence and captured email delivery.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    USERPERSISTO_IDENTITY,
    createManagedAgentEnvironment,
    isolatePloinkyWorkspace,
    resolvePloinkyRoot,
} from './helpers/managedRouterRuntime.mjs';

const explorerRoot = fileURLToPath(new URL('../..', import.meta.url));
const persistence = mkdtempSync(join(tmpdir(), 'userpersisto-router-origins-integration-'));
process.env.PERSISTENCE_FOLDER = persistence;
process.env.USERPERSISTO_SETTINGS_KEY = 'router-origins-integration-settings';
for (const name of ['USERPERSISTO_ALLOWED_REDIRECT_ORIGINS', 'USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_TRUST_ROUTER_ORIGINS',
    'USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_GOOGLE_REDIRECT_URI', 'USERPERSISTO_RUNTIME_SECRET']) {
    delete process.env[name];
}
const workspace = isolatePloinkyWorkspace();
const ploinkyRoot = resolvePloinkyRoot();
const ploinkyDir = join(workspace, '.ploinky');
const TAILSCALE_HOST = '100.73.151.25:3000';
const PGX_HOST = 'pgx:3000';

function bindBox(hosts) {
    process.env.PLOINKY_PUBLIC_ROUTER_HOSTS = JSON.stringify(hosts);
    process.env.PLOINKY_ROUTER_HOST_PORT = '3000';
    process.env.PLOINKY_MEDIA_HOST_PORT = '7882';
}

function writeWorkspace(ssoConfig = null) {
    const portalDir = join(ploinkyDir, 'repos', 'fixtures', 'portal');
    const providerDir = join(ploinkyDir, 'repos', 'AssistOSExplorer', 'userPersistoAgent');
    writeFileSync(join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'portal', port: 7777 },
        routes: {
            portal: { repo: 'fixtures', agent: 'portal', container: 'portal-container', hostPath: portalDir },
            userPersistoAgent: {
                repo: 'AssistOSExplorer', agent: 'userPersistoAgent', container: 'userpersisto-container', hostPath: providerDir,
            },
        },
    }, null, 2));
    writeFileSync(join(ploinkyDir, 'agents.json'), JSON.stringify({
        'portal-container': {
            type: 'agent', repoName: 'fixtures', agentName: 'portal', auth: { mode: 'sso' },
            instanceId: '9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b', enableGeneration: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        },
        'userpersisto-container': {
            type: 'agent', repoName: 'AssistOSExplorer', agentName: 'userPersistoAgent',
            instanceId: USERPERSISTO_IDENTITY.instanceId, enableGeneration: USERPERSISTO_IDENTITY.enableGeneration,
        },
        ...(ssoConfig ? { _config: { sso: ssoConfig } } : {}),
    }, null, 2));
}

function prepareWorkspaceFiles() {
    mkdirSync(join(ploinkyDir, 'repos', 'fixtures', 'portal'), { recursive: true });
    writeFileSync(join(ploinkyDir, 'repos', 'fixtures', 'portal', 'manifest.json'), JSON.stringify({ ploinky: 'sso enable' }));
    symlinkSync(explorerRoot, join(ploinkyDir, 'repos', 'AssistOSExplorer'), 'dir');
    mkdirSync(join(ploinkyDir, 'data', 'edge-routing'), { recursive: true });
    mkdirSync(join(ploinkyDir, 'data', 'router-security'), { recursive: true });
    writeFileSync(join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), JSON.stringify({ hosts: {} }));
    writeFileSync(join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), JSON.stringify({
        schema: 'router-policy', httpRoutes: [], mcpTools: [],
    }));
    writeWorkspace();
}

bindBox(['100.73.151.25', 'pgx']);
prepareWorkspaceFiles();

const ploinky = (relativePath) => import(pathToFileURL(join(ploinkyRoot, relativePath)).href);
const { applyEdgeRoutingGeneration, inactivateEdgeRoutingGeneration } = await ploinky('cli/sandbox/edgeGeneration.js');
const { resolveEdgeRoutePlan } = await ploinky('cli/server/edgeRoutePlan.js');
const privateRouter = await ploinky('cli/server/privateRouter.js');
const { createProviderConfigReader } = await ploinky('cli/server/auth/providerConfigValues.js');
const { handleAuthRoutes } = await ploinky('cli/server/authHandlers/authRoutes.js');
const { authService } = await ploinky('cli/server/authHandlers/shared.js');

// The Router resolves the provider's shared generated runtime secret; the
// agent service receives the same manifest value.
process.env.USERPERSISTO_RUNTIME_SECRET = createProviderConfigReader('AssistOSExplorer/userPersistoAgent', () => '')('USERPERSISTO_RUNTIME_SECRET');
assert.match(process.env.USERPERSISTO_RUNTIME_SECRET, /^\S{16,}$/);

const { ensureSeedData } = await import('../lib/bootstrap.mjs');
const { resetStoreForTests, getStore } = await import('../lib/store.mjs');
const { resetAuthLimitsForTests } = await import('./helpers/setup.mjs');
const { startService } = await import('../service/index.mjs');

const deliveries = [];
let service;
let serviceBase;
let privateListener;
let privateOutage = false;
const privateRequests = [];

before(async () => {
    await ensureSeedData();
    service = startService({ port: 0, host: '127.0.0.1' }, {
        deliverEmail: async (message) => {
            deliveries.push(message);
            return { delivered: true, providerMessageId: 'integration-capture' };
        },
    });
    if (!service.listening) await once(service, 'listening');
    serviceBase = `http://127.0.0.1:${service.address().port}`;
    writeWorkspace({
        enabled: true,
        providerAgent: 'AssistOSExplorer/userPersistoAgent',
        providerConfig: { routerBaseUrl: serviceBase, runtimePath: '/service/runtime' },
    });
    authService.reloadConfig();

    // Box-private Router listener running the production operation pipeline.
    privateListener = http.createServer(async (req, res) => {
        privateRequests.push(req.url);
        if (privateOutage) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'EDGE_GENERATION_INACTIVE' }));
            return;
        }
        req.ploinkyListenerClass = 'private';
        const plan = resolveEdgeRoutePlan({ req, parsedUrl: new URL(req.url, `http://${req.headers.host}`), listener: 'private' });
        if (!plan.ok) {
            res.writeHead(plan.status || 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: plan.code || 'private_route_denied' }));
            return;
        }
        try {
            const body = await privateRouter.readPrivateRequestBody(req);
            privateRouter.authorizePrivateRoutePlan({ req, plan, body });
            privateRouter.sendRuntimeRouterOrigins(res, { plan, body, callerIdentity: req.privateAgentIdentity });
        } catch (error) {
            privateRouter.sendPrivateError(res, error);
        }
    });
    await new Promise((resolve) => privateListener.listen(0, '127.0.0.1', resolve));

    // The provider agent receives the generated descriptor contract.
    Object.assign(process.env, await createManagedAgentEnvironment({
        workspace,
        internalRouterUrl: `http://127.0.0.1:${privateListener.address().port}`,
        edgeTopologyFile: join(ploinkyDir, 'run', 'edge-topology', 'current.json'),
        ploinkyRoot,
    }));
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'router-origins-integration', publicationState: 'ready' });
});

beforeEach(() => {
    resetAuthLimitsForTests();
    delete process.env.USERPERSISTO_TRUST_ROUTER_ORIGINS;
});

after(async () => {
    privateListener?.closeAllConnections();
    await new Promise((resolve) => (privateListener ? privateListener.close(resolve) : resolve()));
    if (service?.listening) {
        service.closeAllConnections();
        await new Promise((resolve) => service.close(resolve));
    }
    await resetStoreForTests();
    rmSync(persistence, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
});

class RouterResponse {
    constructor() { this.statusCode = 200; this.headers = new Map(); this.body = ''; }
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
    getHeader(name) { return this.headers.get(name.toLowerCase()); }
    writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    end(chunk = '') { this.body += chunk ? String(chunk) : ''; }
    cookies() {
        const value = this.getHeader('set-cookie');
        return (Array.isArray(value) ? value : value ? [value] : []).map((cookie) => cookie.split(';')[0]);
    }
}

// The public Router request path up to its /auth/* dispatch.
async function router(host, url, { cookie = '', accept = 'text/html' } = {}) {
    const req = Object.assign(Readable.from([]), {
        method: 'GET', url, headers: { host, accept, ...(cookie ? { cookie } : {}) }, socket: { encrypted: false },
    });
    const parsedUrl = new URL(url, `http://${host}`);
    const res = new RouterResponse();
    const routePlan = resolveEdgeRoutePlan({ req, parsedUrl, listener: 'public' });
    const controlMiss = !routePlan.ok && routePlan.code === 'ROUTE_NOT_FOUND' && routePlan.hostSelection?.kind === 'control';
    if (!routePlan.ok && !controlMiss) {
        res.writeHead(routePlan.status || 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: routePlan.code }));
        return res;
    }
    assert.equal(await handleAuthRoutes(req, res, parsedUrl, { routePlan }), true);
    return res;
}

// Wizard calls as the Router forwards them from the browser's public origin.
function wizardBrowser(host) {
    let proof = '';
    return async (path, body) => {
        const response = await fetch(`${serviceBase}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin: `http://${host}`,
                'x-forwarded-proto': 'http',
                'x-forwarded-host': host,
                'x-forwarded-prefix': '/base-agent-additional-server/userPersistoAgent/7000',
                ...(proof ? { cookie: proof } : {}),
            },
            body: JSON.stringify(body),
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie?.startsWith('up_browser=')) proof = setCookie.split(';')[0];
        return { status: response.status, body: await response.json() };
    };
}

async function beginLogin(host, returnTo = '/portal/') {
    const login = await router(host, `/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    assert.equal(login.statusCode, 200, login.body);
    const [binding] = login.cookies();
    assert.match(binding, /^ploinky_sso_login_[A-Za-z0-9_-]{22}=/);
    const redirect = new URL(JSON.parse(login.body.match(/window\.location\.replace\(("[^"]*")\)/)[1]));
    assert.equal(redirect.origin, `http://${host}`, 'the wizard stays on the bound origin');
    return {
        binding,
        state: redirect.searchParams.get('state'),
        requestId: redirect.searchParams.get('requestId'),
    };
}

async function emailCode(wizard, requestId, email, purpose) {
    const before = deliveries.length;
    assert.equal((await wizard('/service/auth/attempt', { requestId })).status, 200);
    const started = await wizard('/service/auth/email-code/start', { requestId, email, purpose });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(deliveries.length, before + 1);
    return deliveries.at(-1).code;
}

test('a bound Tailscale origin completes login, callback, and session with an empty manual allow-list', async () => {
    assert.deepEqual((await (await import('../lib/policy.mjs')).getAuthPolicy()).allowedRedirectOrigins, []);
    const readsBefore = privateRequests.length;
    const { binding, state, requestId } = await beginLogin(TAILSCALE_HOST, '/portal/files');
    assert.ok(privateRequests.length > readsBefore, 'the login decision read the active Router origins');

    const wizard = wizardBrowser(TAILSCALE_HOST);
    const code = await emailCode(wizard, requestId, 'owner@example.test', 'register');
    const verified = await wizard('/service/auth/email-code/verify', { requestId, code, state });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.redirectUri, `http://${TAILSCALE_HOST}/auth/callback`);
    assert.equal(verified.body.state, state);

    const callback = await router(TAILSCALE_HOST, `/auth/callback?code=${encodeURIComponent(verified.body.code)}&state=${state}`, { cookie: binding });
    assert.equal(callback.statusCode, 302, callback.body);
    assert.equal(callback.getHeader('location'), '/portal/files');
    const session = callback.cookies().find((cookie) => cookie.startsWith('ploinky_sso='));
    assert.ok(session, 'the Router issued its SSO session cookie');

    const token = await router(TAILSCALE_HOST, '/auth/token', { cookie: session, accept: 'application/json' });
    assert.equal(token.statusCode, 200, token.body);
    const tokenBody = JSON.parse(token.body);
    assert.equal(tokenBody.user.email, 'owner@example.test');
    assert.equal(tokenBody.browserMutation.origin, `http://${TAILSCALE_HOST}`);
    const stored = await (await getStore()).getSystemSettingByKey('auth.policy');
    assert.equal(JSON.stringify(stored || {}).includes('100.73.151.25'), false, 'managed trust was not persisted');
});

test('unknown, opted-out, and unavailable origins are rejected with clear safe responses', async () => {
    const unknown = await router('192.168.1.99:3000', '/auth/login');
    assert.equal(unknown.statusCode, 421, 'the Router itself rejects an unbound Host');

    const requestsBefore = (await (await getStore()).select('ssoLoginRequest')).objects.length;
    process.env.USERPERSISTO_TRUST_ROUTER_ORIGINS = 'false';
    const denied = await router(PGX_HOST, '/auth/login?returnTo=%2Fportal%2F');
    assert.equal(denied.statusCode, 403);
    assert.match(String(denied.getHeader('content-type')), /^text\/html/);
    assert.match(denied.body, /Sign-in is not enabled for this address\. Use a configured workspace address or contact the workspace administrator\./);
    assert.match(denied.body, /Address: http:\/\/pgx:3000/);
    assert.deepEqual(denied.cookies(), []);
    const deniedJson = await router(PGX_HOST, '/auth/login', { accept: 'application/json' });
    assert.equal(deniedJson.statusCode, 403);
    assert.deepEqual(JSON.parse(deniedJson.body), {
        ok: false,
        error: 'redirect_origin_not_allowed',
        detail: 'Sign-in is not enabled for this address. Use a configured workspace address or contact the workspace administrator.',
    });
    assert.equal((await (await getStore()).select('ssoLoginRequest')).objects.length, requestsBefore);
    // Loopback keeps working without Router metadata or configuration.
    assert.equal((await router('127.0.0.1:3000', '/auth/login')).statusCode, 200);
    delete process.env.USERPERSISTO_TRUST_ROUTER_ORIGINS;

    // The Router's private metadata listener is temporarily not serving.
    privateOutage = true;
    try {
        const unavailable = await router(PGX_HOST, '/auth/login?returnTo=%2Fportal%2F');
        assert.equal(unavailable.statusCode, 503);
        assert.match(unavailable.body, /The workspace authentication addresses are temporarily unavailable\. Try again after the workspace is ready\./);
        assert.match(unavailable.body, /href="\/auth\/login\?returnTo=%2Fportal%2F">Try again/);
        assert.doesNotMatch(unavailable.body, /EDGE_GENERATION|stack|Error:|runtime-origins/);
        const unavailableJson = await router(PGX_HOST, '/auth/login', { accept: 'application/json' });
        assert.equal(JSON.parse(unavailableJson.body).error, 'auth_origin_topology_unavailable');
    } finally {
        privateOutage = false;
    }
    assert.equal((await router(PGX_HOST, '/auth/login')).statusCode, 200);

    // An inactive routing generation is refused by the Router before auth.
    inactivateEdgeRoutingGeneration('integration-maintenance', { workspaceRoot: workspace });
    try {
        assert.equal((await router(PGX_HOST, '/auth/login')).statusCode, 503);
    } finally {
        applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'integration-maintenance-complete', publicationState: 'ready' });
    }
});

test('removing a bound origin denies its pending login at the next origin check while remaining origins work', async (t) => {
    const pending = await beginLogin(TAILSCALE_HOST);
    const wizard = wizardBrowser(TAILSCALE_HOST);
    const code = await emailCode(wizard, pending.requestId, 'pending-member@example.test', 'register');

    // Rebind to one address: the Box is recreated and the graph re-applied.
    bindBox(['pgx']);
    t.after(() => {
        bindBox(['100.73.151.25', 'pgx']);
        applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'integration-restore-binding', publicationState: 'ready' });
    });
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'integration-rebind', publicationState: 'ready' });

    const rejected = await wizard('/service/auth/email-code/verify', { requestId: pending.requestId, code, state: pending.state });
    assert.equal(rejected.status, 403);
    assert.deepEqual(rejected.body, { ok: false, error: 'redirect_origin_not_allowed' });
    const codes = await (await getStore()).select('ssoAuthCode');
    assert.equal(codes.objects.some((entry) => entry.providerState === pending.requestId), false, 'no handoff code was issued');
    assert.equal((await router(TAILSCALE_HOST, '/auth/login')).statusCode, 421);

    const current = await beginLogin(PGX_HOST);
    assert.ok(current.requestId);
});
