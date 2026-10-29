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

test('E14: the grant-bearing /api/worker/* route is declared before the broad route, which mints nothing', () => {
    const manifest = readManifest();
    const routes = manifest.routerAccess.httpRoutes;
    const narrow = routes.findIndex((route) => route.path === `${PREFIX}/api/worker/*`);
    const broad = routes.findIndex((route) => route.path === `${PREFIX}/*`);
    assert.ok(narrow >= 0 && broad >= 0);
    assert.ok(narrow < broad, 'the narrow route comes first');
    assert.deepEqual(routes[narrow], { path: `${PREFIX}/api/worker/*`, access: 'authenticated', delegations: [PROVIDER_ADMISSION] });
    assert.equal(Object.hasOwn(routes[broad], 'delegations'), false);
    // The Router's first-match selection: worker paths get exactly one grant, every other path none.
    for (const pathname of ['/api/worker/admissions', '/api/worker/lookup', `/api/worker/references/${'r'.repeat(22)}/control`, '/api/worker/bindings']) {
        const definition = routeDefinition(`${PREFIX}${pathname}`);
        assert.deepEqual(definition.delegations.map((entry) => [entry.key, entry.targetAgentId, entry.tools, entry.scope, entry.ttlSeconds]),
            [['providerAdmission', 'agent:AchillesIDE/robo-work', ['__coordinator_admission__'], ['execution:owner'], 30]], pathname);
        const grants = authInfoOf(routedHeaders({ id: 'alice', roles: ['user'] }, 'POST', pathname, '{}')).delegations;
        assert.deepEqual(Object.keys(grants), ['providerAdmission'], pathname);
    }
    // The Router's trailing `/*` also matches the bare prefix; RoboTeam answers it 404.
    assert.equal(routeDefinition(`${PREFIX}/api/worker`).delegations.length, 1);
    for (const pathname of ['/api/robots', '/api/roboflow/schedules', '/api/workers', '/api/worker-x/admissions', '/']) {
        assert.deepEqual(routeDefinition(`${PREFIX}${pathname}`).delegations, [], pathname);
        assert.equal(Object.hasOwn(authInfoOf(routedHeaders({ id: 'alice', roles: ['user'] }, 'GET', pathname)), 'delegations'), false, pathname);
    }
    // Negative control: with the narrow route after the broad one, worker paths mint nothing.
    const reordered = { ...manifest, routerAccess: { httpRoutes: [routes[broad], routes[narrow]] } };
    assert.deepEqual(routeDefinition(`${PREFIX}/api/worker/admissions`, reordered).delegations, []);
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
