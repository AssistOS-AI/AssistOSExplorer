import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { siblingPath } from '../../tests/helpers/sibling-roots.mjs';

// The robo-work manifest, checked with the sibling Ploinky checkout's own provider-declaration code.
const MANIFEST_URL = new URL('../manifest.json', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(MANIFEST_URL, 'utf8'));
process.env.PLOINKY_AGENTLIB_DIR ||= siblingPath('ploinky', 'node_modules', 'achillesAgentLib');
const load = (relative) => import(pathToFileURL(siblingPath('ploinky', relative)).href);
const { readExecutionProviderDeclaration, coordinatorRouteMatches } = await load('cli/server/executionProvider/declaration.mjs');
const { assertExecutionProviderPublication } = await load('cli/server/executionProvider/publication.mjs');
const { exactCoordinatorRoute } = await load('cli/server/executionProvider/coordinatorRoutes.mjs');
const { planRuntimeResources } = await load('cli/utils/runtime/runtimeResourcePlanner.js');

const ROUTE_KEY = 'robo-work';

test('the executionProvider declaration is valid and its coordinator route names the routed root port and RoboTeam alone', () => {
    const read = readExecutionProviderDeclaration(manifest, { routeKey: ROUTE_KEY });
    assert.equal(read.present, true);
    assert.equal(read.valid, true, read.reason);
    const { declaration } = read;
    assert.equal(declaration.port, 7300);
    assert.equal(declaration.taskReferences.path, '/v1/task-refs');
    assert.equal(declaration.terminals, undefined, 'terminals are not declared before their own landing (M-8)');
    assert.equal(declaration.coordinatorRoutes.length, 1);
    assert.deepEqual(declaration.coordinatorRoutes[0].callers, ['agent:AchillesIDE/roboTeamAgent']);
    assert.equal(declaration.coordinatorRoutes[0].port, 7000);
    for (const operation of ['admissions', 'lookup', 'bindings', 'robots/provision', 'robots/get', 'operations/get', 'references/abc/events']) {
        const suffixPath = `/v1/coordinator/${operation}`;
        assert.equal(coordinatorRouteMatches(declaration, { port: 7000, suffixPath }), true, suffixPath);
        assert.notEqual(exactCoordinatorRoute(declaration, { port: 7000, suffixPath }), null, suffixPath);
    }
    assert.equal(coordinatorRouteMatches(declaration, { port: 7000, suffixPath: '/other' }), false);
    assert.equal(coordinatorRouteMatches(declaration, { port: 7300, suffixPath: '/v1/coordinator/admissions' }), false);
});

test('Ploinky accepts the publication: the provider port is in no openPorts, env.PORT or route, and the agent port is 7000', () => {
    const declaration = assertExecutionProviderPublication({
        manifest, routeKey: ROUTE_KEY, profileConfig: manifest.profiles.default, agentServerPort: 7000, networkMode: 'bridge'
    });
    assert.equal(declaration.port, 7300);
    assert.equal(manifest.profiles.default.openPorts, undefined, 'no box-side publish: RoboTeam already publishes box port 7000; the Router relays container port 7000');
    assert.deepEqual(manifest.routerAccess, { agentPorts: [7000] }, 'only the coordinator port is relayable');
    assert.throws(() => assertExecutionProviderPublication({
        manifest: { ...manifest, profiles: { default: { ...manifest.profiles.default, openPorts: ['7000:7000', '7300:7300'] } } },
        routeKey: ROUTE_KEY, agentServerPort: 7000
    }), /openPorts/);
    assert.throws(() => assertExecutionProviderPublication({ manifest, routeKey: ROUTE_KEY, agentServerPort: 7001 }), /routed root port/);
});

test('the worker store is Ploinky persistent storage mounted at /var/lib/robo-work and handed to main.mjs', () => {
    const plan = planRuntimeResources(manifest, { agentName: 'robo-work', repoName: 'AchillesIDE' });
    assert.equal(plan.persistentStorage.key, 'robo-work');
    assert.equal(plan.persistentStorage.containerPath, '/var/lib/robo-work');
    assert.match(plan.persistentStorage.hostPath, /\/\.data\/robo-work$/u);
    assert.equal(plan.env.ROBO_WORK_DATA_DIR, '/var/lib/robo-work');
    assert.equal(Object.hasOwn(manifest, 'volumes'), false, 'RoboTeam data is never mounted into the worker (M-10)');
});

test('image, security and start command', () => {
    assert.match(manifest.container, /^docker\.io\/assistos\/robo-work-worker@sha256:[0-9a-f]{64}$/, 'pinned by digest');
    assert.deepEqual(manifest.containerSecurity, { nestedPodman: true });
    assert.equal(manifest.agent, 'node /code/server/main.mjs');
    // An on-demand enable sends no run mode, and the grants need the workspace at its canonical path (global mode, not isolated).
    assert.deepEqual(manifest.enableModes, ['global']);
    assert.equal(manifest.readiness.protocol, 'tcp');
    assert.equal(manifest.readiness.port, 7000);
    assert.deepEqual(manifest['link-install'], ['https://github.com/AssistOS-AI/AdvancedLanguageAgent.git']);
});
