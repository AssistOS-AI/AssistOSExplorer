import assert from 'node:assert/strict';
import test from 'node:test';
import { authInfoOf, readManifest, routeDefinition, routedHeaders } from './helpers/router-worker.mjs';
import { MANIFEST_RUNTIME_SCOPE } from '../copilot/src/lib/webchat/webchatEnvelope.mjs';
import { COORDINATOR_BASE_ENV } from '../server/worker-coordinator/hop.mjs';

// Manifest pins for the worker coordinator carriers (design S3c §5, E14, E12), checked with the
// sibling Ploinky checkout's real route selection and manifest normalizers.
const PLOINKY_ROOT = new URL('../../../ploinky/', import.meta.url);
const load = (relative) => import(new URL(relative, PLOINKY_ROOT).href);
const { normalizeWebchatDelegations } = await load('cli/server/mcp-proxy/mcpDelegations.js');
const { extractManifestWebchatOptions } = await load('cli/server/webchat/commandResolver.js');

const PREFIX = '/base-agent-additional-server/roboTeamAgent/3001';
const PROVIDER_ADMISSION = Object.freeze({ key: 'providerAdmission', targetAgentId: 'agent:./robo-work', tools: ['__coordinator_admission__'],
    scopes: ['execution:owner'], ttlSeconds: 30 });

// The exact set of paths whose routed requests the Router mints `providerAdmission` for (decisions
// M-13 and the base section 8.2): the worker coordinator API, robot create and update, flow start and
// schedule run-now. `/api/robots/*` is the narrowest grammar for `/api/robots/<id>/coding-agents`
// (a path ends in one `/*`), and the Router's trailing `/*` also matches the bare prefix.
const MINTING = ['/api/worker/*', '/api/robots/*', '/api/roboflow/flows', '/api/roboflow/schedules/*'];

test('E14: the grant-bearing routes are exactly the declared set, each before the broad route, which mints nothing', () => {
    const manifest = readManifest();
    const routes = manifest.routerAccess.httpRoutes;
    const broad = routes.findIndex((route) => route.path === `${PREFIX}/*`);
    assert.ok(broad >= 0);
    assert.equal(broad, routes.length - 1, 'the broad route is last, so every declaration above it wins');
    assert.deepEqual(routes.slice(0, broad).map((route) => route.path), MINTING.map((path) => `${PREFIX}${path}`), 'the minting set is pinned exactly');
    for (const route of routes.slice(0, broad)) {
        assert.deepEqual(route, { path: route.path, access: 'authenticated', delegations: [PROVIDER_ADMISSION] });
    }
    assert.equal(Object.hasOwn(routes[broad], 'delegations'), false);
    // The Router's first-match selection: these paths get exactly one grant.
    const minting = ['/api/worker/admissions', '/api/worker/lookup', `/api/worker/references/${'r'.repeat(22)}/control`, '/api/worker/bindings', '/api/worker/robots/ensure',
        '/api/robots', '/api/robots/import-emails', '/api/robots/default-ab12cd/coding-agents',
        '/api/roboflow/flows', '/api/roboflow/schedules', `/api/roboflow/schedules/cron_${'0f'.repeat(12)}/run-now`];
    for (const pathname of minting) {
        const definition = routeDefinition(`${PREFIX}${pathname}`);
        assert.deepEqual(definition.delegations.map((entry) => [entry.key, entry.targetAgentId, entry.tools, entry.scope, entry.ttlSeconds]),
            [['providerAdmission', 'agent:AchillesIDE/robo-work', ['__coordinator_admission__'], ['execution:owner'], 30]], pathname);
        const method = pathname === '/api/robots/default-ab12cd/coding-agents' ? 'PATCH' : 'POST';
        const grants = authInfoOf(routedHeaders({ id: 'alice', roles: ['user'] }, method, pathname, '{}')).delegations;
        assert.deepEqual(Object.keys(grants), ['providerAdmission'], pathname);
    }
    assert.equal(routeDefinition(`${PREFIX}/api/worker`).delegations.length, 1);
    // Every other path mints nothing, including the flow endpoints that do not start a flow.
    const silent = ['/api/roboflow/schedules-x', '/api/roboflow/flows/flow_aaaaaaaaaaaaaaaaaaaaaaaa', '/api/roboflow/flows/flow_aaaaaaaaaaaaaaaaaaaaaaaa/pause',
        '/api/roboflow/workflows', '/api/roboflow/generate', '/api/roboflow', '/api/roboflow/validate', '/api/workers', '/api/worker-x/admissions', '/api/robot',
        '/api/robots-x', '/api/control', '/api/live-sessions', '/api/terminal-profiles/resolve', '/status', '/flows', '/'];
    for (const pathname of silent) {
        assert.deepEqual(routeDefinition(`${PREFIX}${pathname}`).delegations, [], pathname);
        assert.equal(Object.hasOwn(authInfoOf(routedHeaders({ id: 'alice', roles: ['user'] }, 'GET', pathname)), 'delegations'), false, pathname);
    }
    // Negative control: with the narrow routes after the broad one, nothing mints.
    const reordered = { ...manifest, routerAccess: { httpRoutes: [routes[broad], ...routes.slice(0, broad)] } };
    for (const pathname of minting) assert.deepEqual(routeDefinition(`${PREFIX}${pathname}`, reordered).delegations, [], pathname);
});

test('WebChat declares principal runtime scope and the providerAdmission grant for every envelope', () => {
    const manifest = readManifest();
    assert.deepEqual(manifest.webchat, { auth: 'static', forwardEnvelope: true, runtimeScope: 'principal', delegations: [PROVIDER_ADMISSION] });
    const normalized = normalizeWebchatDelegations(manifest, { repoName: 'AchillesIDE', agentName: 'roboTeamAgent' });
    assert.deepEqual(normalized.map((entry) => [entry.key, entry.targetAgentId, entry.tools, entry.scope, entry.ttlSeconds, entry.sourceAgentId]),
        [['providerAdmission', 'agent:AchillesIDE/robo-work', ['__coordinator_admission__'], ['execution:owner'], 30, 'agent:AchillesIDE/roboTeamAgent']]);
});

test('E12: the shim scope and the Router scope come from the same manifest value and agree', () => {
    const manifest = readManifest();
    assert.equal(MANIFEST_RUNTIME_SCOPE, 'principal');
    assert.equal(extractManifestWebchatOptions(manifest).runtimeScope, MANIFEST_RUNTIME_SCOPE);
    assert.equal(MANIFEST_RUNTIME_SCOPE, manifest.webchat.runtimeScope === 'principal' ? 'principal' : null);
});

test('the coordinator selector base is a declared profile variable whose value the integrator sets', () => {
    const manifest = readManifest();
    assert.ok(manifest.profiles.default.env.includes(COORDINATOR_BASE_ENV));
    assert.equal(JSON.stringify(manifest).includes('/v1/coordinator'), false, 'no coordinator route value is hard-coded here');
});
