import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ExecutionSetupError, createExecutionFactory, codeBinds, imageBinds } from '../../server/runtime/executionFactory.mjs';
import { planAlaExecution } from '../../server/runtime/alaPlan.mjs';

// The production execution factory over FAKE supervisor, ledger, endpoint server and grant resolver: the publication order,
// what ALA is started with, descriptor custody and the end path. The real supervisor, ledger and endpoint server have their
// own tests (tests/sandbox, tests/execution); nothing here starts a process.

const SESSION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';
const spec = (overrides = {}) => ({
    version: 2, prompt: 'p', displayText: 'd', sessionId: SESSION, turnId: 't1', cwd: '/ws/proj', permissions: 'full-access',
    folders: [{ path: '/ws/skills', access: 'read' }], ...overrides
});

function rig({ grantRefusal = null } = {}) {
    const calls = [];
    const closedFds = [];
    const closedGrants = [];
    let nextFd = 20;
    const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
    let supervisorOptions = null;
    let ledgerOptions = null;
    const exitedWait = { resolve: null };
    const deps = {
        openDirectory: (target) => { calls.push(['open', target]); return nextFd++; },
        closeFd: (fd) => closedFds.push(fd),
        resolveGrant: async (request, context) => {
            calls.push(['grant', request, context.workspaceRoot]);
            if (grantRefusal) return { ok: false, code: grantRefusal };
            return { ok: true, grant: { fd: nextFd++, close: async () => { closedGrants.push(request.relativePath); } } };
        },
        createExecutionSupervisor: (options) => {
            supervisorOptions = options;
            return {
                endpointSocket: { fake: 'endpoint' }, controlStreams: streams, providerSandbox: () => ({ fake: 'sandbox' }),
                exit: async () => { calls.push(['supervisor.exit']); }
            };
        },
        createExecutionLedger: (options) => {
            ledgerOptions = options;
            return {
                startKeeper: async () => { calls.push(['publish', 'keeper']); },
                publish: async ({ kind, spec: published }) => {
                    calls.push(['publish', kind, published ?? null]);
                    return { handle: kind === 'process-tree' ? { wait: () => new Promise((resolve) => { exitedWait.resolve = resolve; }) } : null };
                },
                endExecution: async (outcome) => { calls.push(['endExecution', outcome]); return {}; }
            };
        },
        createSupervisorEndpointServer: (options) => {
            calls.push(['endpointServer', options.socket]);
            return { end: (reason) => calls.push(['endpointServer.end', reason]), onEnd: options.onEnd };
        },
        imageBinds: () => ({ roBinds: [{ source: '/usr', dest: '/usr' }], symlinks: [{ target: 'usr/bin', dest: '/bin' }] })
    };
    const factory = createExecutionFactory({
        store: {}, robots: { root: '/store', paths: (id) => ({ home: `/store/robots/${id}/home`, sessions: `/store/robots/${id}/sessions`, configDir: `/store/robots/${id}/config` }) },
        launcher: { fake: 'launcher' }, view: { fake: 'view' }, walker: { fake: 'walker' }, clock: { fake: 'clock' }, workspaceRoot: '/ws', runtimeDir: '/store/runtime',
        serverDir: '/code/server', alaRoot: '/Agent/linked/AdvancedLanguageAgent', nodePath: '/usr/local/bin/node', deps
    });
    const item = { robotId: 'ROBOT', executionId: 'EXEC', attemptId: 'ATT', referenceId: 'REF', specification: spec() };
    const plan = planAlaExecution({ specification: item.specification, workspaceRoot: '/ws' });
    return { factory, calls, closedFds, closedGrants, streams, item, plan, context: { fake: 'context' }, options: () => ({ supervisorOptions, ledgerOptions }), exitedWait };
}

test('publication order, ALA command line, descriptor custody and the end path', async () => {
    const { factory, calls, closedFds, closedGrants, streams, item, plan, context, options, exitedWait } = rig();
    const execution = await factory.open({ item, plan, context });
    const { supervisorOptions, ledgerOptions } = options();
    // HOME, sessions and the config directory are opened by name from the robot's own storage; each project grant is resolved anchored.
    assert.deepEqual(calls.filter(([what]) => what === 'open').map(([, target]) => target),
        ['/store/robots/ROBOT/home', '/store/robots/ROBOT/sessions', '/store/robots/ROBOT/config']);
    assert.deepEqual(calls.filter(([what]) => what === 'grant').map(([, request]) => request),
        [{ role: 'project', access: 'write', relativePath: 'proj' }, { role: 'project', access: 'read', relativePath: 'skills' }]);
    assert.deepEqual(supervisorOptions.home, { path: '/store/robots/ROBOT/home', fd: 20 });
    assert.deepEqual(supervisorOptions.grants.map(({ name, path, hostPath, access }) => [name, path, hostPath, access]), [['g0', '/projects/g0', '/ws/proj', 'write'], ['g1', '/projects/g1', '/ws/skills', 'read']]);
    assert.deepEqual(supervisorOptions.admission.grants.map((grant) => grant.path), ['/projects/g0', '/projects/g1']);
    assert.equal(supervisorOptions.admission.streamDirectory, '/stream');
    const orchestration = supervisorOptions.roles.orchestration;
    assert.deepEqual(orchestration.argv.slice(0, 4), ['/usr/local/bin/node', '--import', '/opt/robo-work/fdTrim.mjs', '/opt/robo-work/ala/bin/ala.mjs']);
    assert.deepEqual(orchestration.argv.slice(4), [...plan.argv]);
    assert.deepEqual(orchestration.env, { ALA_EVENT_STREAM: '1', ALA_TASK_REPOSITORIES: '', ALA_SESSIONS: '/session' });
    assert.deepEqual(orchestration.anchored, [
        { name: 'session', path: '/store/robots/ROBOT/sessions', fd: 21, dest: '/session', mode: 'rw' },
        { name: 'config', path: '/store/robots/ROBOT/config', fd: 22, dest: '/config', mode: 'ro' }
    ]);
    assert.ok(orchestration.roBinds.some((bind) => bind.source === '/Agent/linked/AdvancedLanguageAgent' && bind.dest === '/opt/robo-work/ala'));
    assert.ok(!supervisorOptions.roles.workload.roBinds.some((bind) => bind.dest.startsWith('/opt/robo-work')), 'the workload sees no robo-work code or ALA');
    assert.deepEqual(supervisorOptions.roles.endpoint.argv, ['/usr/local/bin/node', '--import', '/opt/robo-work/fdTrim.mjs', '/opt/robo-work/execution/providerEndpointMain.mjs']);
    assert.equal(ledgerOptions.referenceId, 'REF');
    assert.deepEqual(ledgerOptions.layout, { runtimeDir: '/store/runtime', cgroupSubtree: '/store/runtime/cgroup' });

    const opened = await execution.start();
    assert.equal(opened, streams);
    assert.deepEqual(calls.filter(([what]) => what === 'publish').map(([, kind, published]) => [kind, published?.role ?? null]),
        [['keeper', null], ['runtime-dir', null], ['netns', null], ['endpoint', null], ['process-tree', 'orchestration']]);
    assert.deepEqual(calls.find(([what, kind]) => what === 'publish' && kind === 'endpoint')[2], { config: { streamDirectory: '/stream', relays: [] } });
    assert.deepEqual(calls.find(([what]) => what === 'endpointServer')[1], { fake: 'endpoint' }, 'the endpoint server reads the supervisor end of the frame channel');
    exitedWait.resolve({ exitCode: 0, signal: null });
    assert.deepEqual(await execution.exited, { exitCode: 0, signal: null });

    const outcome = { classification: 'completed', outputText: 'x', data: null };
    await Promise.all([execution.end(outcome), execution.end(outcome)]);
    assert.equal(calls.filter(([what]) => what === 'endExecution').length, 1, 'the end path runs once');
    assert.deepEqual(calls.find(([what]) => what === 'endExecution')[1], outcome);
    assert.deepEqual(closedGrants.sort(), ['proj', 'skills']);
    assert.deepEqual(closedFds.sort((a, b) => a - b), [20, 21, 22]);
    assert.ok(calls.findIndex(([what]) => what === 'endpointServer.end') < calls.findIndex(([what]) => what === 'endExecution'));
});

test('a refused grant fails the open with a bounded reason and closes what was opened', async () => {
    const { factory, closedFds, item, plan, context } = rig({ grantRefusal: 'protected_component' });
    await assert.rejects(factory.open({ item, plan, context }), (error) => error instanceof ExecutionSetupError && error.reason === 'grant_protected_component');
    assert.deepEqual(closedFds.sort((a, b) => a - b), [20, 21, 22]);
});

test('an endpoint that ends before the end path, and an anchor loss, resolve `lost`; an endpoint ending at the end path does not', async () => {
    const early = rig();
    const first = await early.factory.open({ item: early.item, plan: early.plan, context: early.context });
    await first.start();
    const loss = early.options().supervisorOptions.onInfrastructureLoss;
    loss('anchor_lost');
    assert.equal(await first.lost, 'infrastructure_lost:anchor_lost');

    const late = rig();
    const second = await late.factory.open({ item: late.item, plan: late.plan, context: late.context });
    let reason = null;
    second.lost.then((value) => { reason = value; });
    await second.start();
    await second.end({ classification: 'completed', outputText: '', data: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reason, null, 'closing the endpoint at the end is not a loss');
});

test('image and code binds: merged-usr symlinks, a Node outside /usr is bound, ALA is bound read-only at /opt/robo-work/ala', () => {
    const merged = imageBinds({ exists: (target) => ['/usr', '/etc/ssl'].includes(target), readlink: (target) => ({ '/bin': 'usr/bin', '/sbin': 'usr/sbin', '/lib': 'usr/lib' })[target] ?? null });
    assert.deepEqual(merged.roBinds, [{ source: '/usr', dest: '/usr' }, { source: '/etc/ssl', dest: '/etc/ssl' }]);
    assert.deepEqual(merged.symlinks.map((link) => [link.target, link.dest]), [['usr/bin', '/bin'], ['usr/sbin', '/sbin'], ['usr/lib', '/lib']]);
    const classic = imageBinds({ exists: (target) => ['/usr', '/bin', '/lib'].includes(target), readlink: () => null });
    assert.deepEqual(classic.roBinds.map((bind) => bind.dest), ['/usr', '/bin', '/lib']);
    const local = codeBinds({ serverDir: '/code/server', alaRoot: '/ala', nodePath: '/opt/node-24/bin/node' });
    assert.equal(local.node, '/opt/robo-work/node/bin/node');
    assert.deepEqual(local.roBinds.find((bind) => bind.dest === '/opt/robo-work/node'), { source: '/opt/node-24', dest: '/opt/robo-work/node' });
    assert.deepEqual(local.alaBinds, [{ source: '/ala', dest: '/opt/robo-work/ala' }]);
    assert.equal(codeBinds({ serverDir: '/code/server', alaRoot: '/ala', nodePath: '/usr/bin/node' }).node, '/usr/bin/node');
});
