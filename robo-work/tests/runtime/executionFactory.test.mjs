import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ExecutionSetupError, createExecutionFactory, codeBinds, imageBinds, readManagedConfig } from '../../server/runtime/executionFactory.mjs';
import { resolveExecutionGrants } from '../../server/runtime/executionGrants.mjs';
import { MODEL_RELAY_PORT } from '../../server/runtime/modelChannel.mjs';
import { planAlaExecution } from '../../server/runtime/alaPlan.mjs';

// The production execution factory over FAKE supervisor, ledger, endpoint server and grant resolver: the publication order,
// what ALA is started with, descriptor custody and the end path. The real supervisor, ledger and endpoint server have their
// own tests (tests/sandbox, tests/execution); nothing here starts a process. The paths here (/ws/proj) do not exist, so the rig replaces
// the factory's grant helper as a unit with the REAL resolveExecutionGrants over a fake leaf resolver and an empty source list; the
// M-63 source rule itself is tested through the real helper AND the real resolver on a real tree (executionGrants.sources.test.mjs).

const SESSION = '0f8c2f1e-3b53-4a56-9b0f-6b1f0d5e9a11';
const spec = (overrides = {}) => ({
    version: 2, prompt: 'p', displayText: 'd', sessionId: SESSION, turnId: 't1', cwd: '/ws/proj', permissions: 'full-access',
    folders: [{ path: '/ws/skills', access: 'read' }], ...overrides
});

function rig({ grantRefusal = null, supervisorRuntimeDir = undefined, workloadActivity = undefined, timers = undefined, activityTickMs = undefined, managed = {}, modelUpstream = null, modelChannel = undefined, runtimeSources = { locations: async () => ({ ok: true, locations: [], authorizationGeneration: 'g', counts: {}, outsideWorkspace: 0, localRoots: 0 }) } } = {}) {
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
        resolveExecutionGrants: (entries, options) => resolveExecutionGrants(entries, {
            ...options,
            resolve: async (request, context) => {
                calls.push(['grant', request, context.workspaceRoot]);
                if (grantRefusal) return { ok: false, code: grantRefusal };
                return { ok: true, grant: { fd: nextFd++, access: request.access, close: async () => { closedGrants.push(request.relativePath); } } };
            }
        }),
        createExecutionSupervisor: (options) => {
            supervisorOptions = options;
            return {
                endpointSocket: { fake: 'endpoint' }, controlStreams: streams, providerSandbox: () => ({ fake: 'sandbox' }), runtimeDir: supervisorRuntimeDir,
                ...(workloadActivity ? { workloadActivity } : {}),
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
        imageBinds: () => ({ roBinds: [{ source: '/usr', dest: '/usr' }], symlinks: [{ target: 'usr/bin', dest: '/bin' }] }),
        readManagedConfig: () => managed,
        createModelChannel: modelChannel ?? (async (options) => {
            calls.push(['modelChannel', options]);
            return { close: async () => { calls.push(['modelChannel.close']); }, lastError: () => ({ status: 429, message: 'slow down' }) };
        }),
        ...(timers ? { timers } : {})
    };
    const factory = createExecutionFactory({
        store: {}, robots: { root: '/store', paths: (id) => ({ home: `/store/robots/${id}/home`, sessions: `/store/robots/${id}/sessions`, configDir: `/store/robots/${id}/config` }) },
        launcher: { fake: 'launcher' }, view: { fake: 'view' }, walker: { fake: 'walker' }, clock: { fake: 'clock' }, workspaceRoot: '/ws', runtimeDir: '/store/runtime',
        serverDir: '/code/server', alaRoot: '/Agent/linked/AdvancedLanguageAgent', nodePath: '/usr/local/bin/node', deps, runtimeSources,
        ...(activityTickMs ? { activityTickMs } : {}), ...(modelUpstream ? { modelUpstream } : {})
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
    assert.deepEqual(orchestration.env, { HOME: '/home/robot', ALA_EVENT_STREAM: '1', ALA_TASK_REPOSITORIES: '', ALA_SESSIONS: '/session' });
    assert.deepEqual(orchestration.anchored, [
        { name: 'session', path: '/store/robots/ROBOT/sessions', fd: 21, dest: '/session', mode: 'rw' },
        { name: 'config', path: '/store/robots/ROBOT/config', fd: 22, dest: '/config', mode: 'ro' }
    ]);
    assert.ok(orchestration.roBinds.some((bind) => bind.source === '/Agent/linked/AdvancedLanguageAgent' && bind.dest === '/opt/robo-work/ala'));
    assert.ok(!supervisorOptions.roles.workload.roBinds.some((bind) => bind.dest.startsWith('/opt/robo-work')), 'the workload sees no robo-work code or ALA');
    assert.deepEqual(supervisorOptions.roles.endpoint.argv, ['/usr/local/bin/node', '--import', '/opt/robo-work/fdTrim.mjs', '/opt/robo-work/execution/providerEndpointMain.mjs']);
    assert.equal(ledgerOptions.referenceId, null, 'the ledger must not read the owner\'s reference back with the adapter context');
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

test('imageBinds keeps the coding-agent tool tree apart: workloads only (F5: /usr/local/sbin/<agent> link into it)', () => {
    const binds = imageBinds({ exists: (target) => ['/usr', '/opt/robo-work-tools'].includes(target), readlink: () => null });
    assert.deepEqual(binds.toolBinds, [{ source: '/opt/robo-work-tools', dest: '/opt/robo-work-tools' }]);
    assert.equal(binds.roBinds.some((bind) => bind.dest === '/opt/robo-work-tools'), false, 'not in the binds orchestration and endpoint get');
});

// F11 (e2e): the production factory must host the task-failure and human-input channels with its OWN default
// createExecutionChannels; only injected fakes were tested before, and every workflow phase failed with a TypeError.
test('a workflow execution hosts its channels with the default channel factory (no injected fake)', async (t) => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-factory-channels-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'channels'));
    const { factory, item, context } = rig({ supervisorRuntimeDir: dir });
    item.specification = spec({ workflowExecution: true, humanInput: true });
    const plan = planAlaExecution({ specification: item.specification, workspaceRoot: '/ws' });
    const handler = async () => ({ ok: true });
    const execution = await factory.open({ item, plan, context, channels: { taskFailure: handler, humanInput: handler } });
    // start() hosts the channels right after the runtime directory is published; the rest of start() waits on fakes.
    let startError = null;
    execution.start().catch((error) => { startError = error; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const entries = fs.readdirSync(path.join(dir, 'channels')).sort();
    if (startError) throw startError;
    // end() closes the hosted channel servers; the sockets must be gone afterwards (no leaked handles).
    await execution.end({ classification: 'cancelled', outputText: '', data: null });
    assert.ok(entries.includes('task-failure') || entries.includes('task-failure.sock'), entries.join(','));
    assert.ok(entries.includes('human-input') || entries.includes('human-input.sock'), entries.join(','));
    const sockets = fs.readdirSync(path.join(dir, 'channels'), { recursive: true }).filter((name) => String(name).endsWith('.sock'));
    assert.deepEqual(sockets.filter((name) => fs.existsSync(path.join(dir, 'channels', String(name)))), [], 'channel sockets removed at end');
});

test('M-35: after start, each watchdog tick asks the supervisor for workload activity and touches the attempt only when there was some; the end clears the tick', async () => {
    const intervals = [];
    const cleared = [];
    const timers = { setInterval: (fn, ms) => { const handle = { fn, ms, unref() {} }; intervals.push(handle); return handle; }, clearInterval: (handle) => cleared.push(handle) };
    let busy = false;
    let asked = 0;
    const { factory, item, plan, context } = rig({ workloadActivity: () => { asked += 1; return busy; }, timers });
    const touched = [];
    const execution = await factory.open({ item, plan, context, activity: () => touched.push(asked) });
    assert.equal(intervals.length, 0, 'nothing ticks before the attempt starts');
    await execution.start();
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 60 * 1000, 'the 60 s watchdog tick');
    intervals[0].fn();
    assert.deepEqual([asked, touched.length], [1, 0], 'an idle tick asks and does not touch');
    busy = true;
    intervals[0].fn();
    assert.deepEqual([asked, touched.length], [2, 1], 'a busy tick touches');
    await execution.end({ classification: 'completed' });
    assert.deepEqual(cleared, [intervals[0]]);
});

test('M-35: a sampler that throws, or a supervisor without one, never breaks the attempt; the tick length is configurable', async () => {
    const timers = { setInterval: (fn, ms) => { timers.last = { fn, ms, unref() {} }; return timers.last; }, clearInterval: () => {} };
    const throwing = rig({ workloadActivity: () => { throw new Error('proc exploded'); }, timers, activityTickMs: 5000 });
    const touched = [];
    const execution = await throwing.factory.open({ item: throwing.item, plan: throwing.plan, context: throwing.context, activity: () => touched.push(1) });
    await execution.start();
    assert.equal(timers.last.ms, 5000);
    assert.doesNotThrow(() => timers.last.fn());
    assert.equal(touched.length, 0);
    timers.last = null;
    const without = rig({ timers });
    const plain = await without.factory.open({ item: without.item, plan: without.plan, context: without.context });
    await plain.start();
    assert.equal(timers.last, null, 'no sampler on the supervisor, no tick');
});

// ---- M-26: the Soul Gateway model channel ------------------------------------------------------------------------------------------

const gatewayRig = (specification, options = {}) => {
    const world = rig({ supervisorRuntimeDir: '/store/runtime/x/RID', modelUpstream: { fake: 'upstream' }, ...options });
    world.item.specification = spec(specification);
    world.plan = planAlaExecution({ specification: world.item.specification, workspaceRoot: '/ws' });
    return world;
};
const publishedEndpoint = (calls) => calls.find(([what, kind]) => what === 'publish' && kind === 'endpoint')[2];

test('M-26: an OpenCode robot with a gateway model gets the channel between the runtime directory and the network, a relay to model.sock and OPENCODE_CONFIG for workloads', async () => {
    const touched = [];
    const { factory, calls, item, plan, context, options } = gatewayRig({ codingAgent: 'opencode', model: 'Soul-Gateway/a', effort: 'default' });
    const execution = await factory.open({ item, plan, context, activity: () => touched.push(1) });
    assert.deepEqual(options().supervisorOptions.modelChannel, { directory: '/run/robo-work/model', configPath: '/run/robo-work/channels/opencode.json' });
    await execution.start();
    assert.deepEqual(calls.filter(([what, kind]) => what === 'modelChannel' || (what === 'publish' && ['runtime-dir', 'netns', 'endpoint'].includes(kind))).map(([what, kind]) => (what === 'modelChannel' ? what : kind)),
        ['runtime-dir', 'modelChannel', 'netns', 'endpoint']);
    const [, opened] = calls.find(([what]) => what === 'modelChannel');
    assert.equal(opened.socketDirectory, '/store/runtime/x/RID/model');
    assert.equal(opened.configDirectory, '/store/runtime/x/RID/channels');
    assert.equal(opened.allowed, 'a', 'the id without the prefix, whatever the prefix\'s case');
    assert.equal(opened.executionId, 'EXEC');
    assert.equal(opened.providerId, 'soul-gateway', 'an override is canonicalised by alaPlan');
    assert.deepEqual(opened.upstream, { fake: 'upstream' });
    opened.activity();
    assert.equal(touched.length, 1, 'the channel reports M-33 activity through the attempt\'s own callback');
    assert.deepEqual(publishedEndpoint(calls), { config: { streamDirectory: '/stream', relays: [{ port: MODEL_RELAY_PORT, target: { path: '/run/robo-work/model/model.sock' } }] } });
    assert.deepEqual(execution.lastModelError(), { status: 429, message: 'slow down' });
    await execution.end({ classification: 'completed', outputText: '', data: null });
    const order = calls.map(([what]) => what);
    assert.ok(order.indexOf('modelChannel.close') < order.indexOf('endExecution'), 'in-flight model requests are aborted before the process trees are ended');
});

test('M-44: without an override the channel\'s provider id is the stored prefix verbatim, so OpenCode resolves the unchanged managed model', async () => {
    const { factory, calls, item, plan, context } = gatewayRig({}, { managed: { codingAgent: 'opencode', models: { opencode: 'Soul-Gateway/stored-x' } } });
    const execution = await factory.open({ item, plan, context });
    await execution.start();
    const [, opened] = calls.find(([what]) => what === 'modelChannel');
    assert.deepEqual([opened.allowed, opened.providerId], ['stored-x', 'Soul-Gateway']);
    await execution.end({ classification: 'completed', outputText: '', data: null });
});

test('M-26: the channel allows the effective model: a managed gateway model, an override to another gateway model, and no channel for an override to a non-gateway model', async () => {
    const managed = { codingAgent: 'opencode', models: { opencode: 'soul-gateway/managed-a' } };
    const cases = [
        [{}, managed, 'managed-a'],
        [{ model: 'soul-gateway/override-b', effort: 'default' }, managed, 'override-b'],
        [{ model: 'opencode/glm-5.3-flash-free', effort: 'default' }, managed, null],
        [{ codingAgent: 'codex' }, managed, null],
        [{}, { codingAgent: 'codex', models: { opencode: 'soul-gateway/managed-a' } }, null],
        [{}, { codingAgent: 'opencode', models: { opencode: 'opencode/glm-5.3-flash-free' } }, null],
        [{}, {}, null]
    ];
    for (const [specification, config, expected] of cases) {
        const { factory, calls, item, plan, context, options } = gatewayRig(specification, { managed: config });
        const execution = await factory.open({ item, plan, context });
        await execution.start();
        assert.equal(calls.some(([what]) => what === 'modelChannel') ? calls.find(([what]) => what === 'modelChannel')[1].allowed : null, expected, JSON.stringify([specification, config]));
        assert.equal(options().supervisorOptions.modelChannel !== null, expected !== null);
        assert.deepEqual(publishedEndpoint(calls).config.relays.length, expected === null ? 0 : 1);
        if (expected === null) assert.equal(execution.lastModelError(), null);
        await execution.end({ classification: 'completed', outputText: '', data: null });
    }
});

test('M-26: a gateway robot on a worker without the upstream, and a channel that cannot be set up, fail start() with the bounded reason and still end cleanly', async () => {
    const without = gatewayRig({ codingAgent: 'opencode', model: 'soul-gateway/a', effort: 'default' }, { modelUpstream: null });
    const first = await without.factory.open({ item: without.item, plan: without.plan, context: without.context });
    await assert.rejects(first.start(), (error) => error instanceof ExecutionSetupError && error.reason === 'model_channel_unavailable');
    await first.end({ classification: 'failed', outputText: '', data: { reason: 'model_channel_unavailable' } });
    assert.ok(!without.calls.some(([what, kind]) => what === 'publish' && kind === 'endpoint'), 'nothing past the runtime directory was published');

    for (const reason of ['model_unavailable', 'model_channel_unavailable']) {
        const failing = gatewayRig({ codingAgent: 'opencode', model: 'soul-gateway/a', effort: 'default' }, { modelChannel: async () => { throw new ExecutionSetupError(reason); } });
        const execution = await failing.factory.open({ item: failing.item, plan: failing.plan, context: failing.context });
        await assert.rejects(execution.start(), (error) => error.reason === reason);
        await execution.end({ classification: 'failed', outputText: '', data: { reason } });
        assert.equal(failing.calls.filter(([what]) => what === 'endExecution').length, 1);
        assert.equal(failing.closedFds.length, 3, 'the descriptors are closed');
    }
});

test('readManagedConfig: the managed ALA configuration, or {} when it is missing, malformed or not an object', () => {
    assert.deepEqual(readManagedConfig('/x', { read: () => '{"codingAgent":"opencode","models":{"opencode":"soul-gateway/a"}}' }), { codingAgent: 'opencode', models: { opencode: 'soul-gateway/a' } });
    for (const text of ['', '{', '[]', '"x"', 'null', 'x'.repeat(70000)]) assert.deepEqual(readManagedConfig('/x', { read: () => text }), {}, text.slice(0, 10));
    assert.deepEqual(readManagedConfig('/x', { read: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }), {});
});

// --- M-63 through the REAL grant helper and the REAL anchored resolver on a real tree (no grant seam) ------------------------------

async function realRig(t, { sources = [], answer = undefined, skills = [], cwd = 'proj', folders = [] } = {}) {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createRuntimeSourceProvider } = await import('../../server/runtime/executionGrants.mjs');
    const { skillsSelectionDigest } = await import('../../server/stateProtocol.mjs');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-factory-sources-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const directory of ['proj', 'AchillesIDE/roboTeamAgent/copilot/src/skills/x', 'store']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'AchillesIDE/roboTeamAgent/copilot/src/skills/x/SKILL.md'), '---\nname: x\n---\n');
    const counter = { fetches: 0, supervisors: 0 };
    const runtimeSources = createRuntimeSourceProvider({
        workspaceRoot: root, timeoutMs: 50,
        fetch: async () => {
            counter.fetches += 1;
            if (answer !== undefined) return typeof answer === 'function' ? answer() : answer;
            return { schemaVersion: 1, authorizationGeneration: `sha256:${'c'.repeat(64)}`, activationId: SESSION, sources: counter.sources ?? sources, outsideWorkspace: 0 };
        }
    });
    const intervals = [];
    const timers = { setInterval: (fn, ms) => { const handle = { fn, ms, unref() {} }; intervals.push(handle); return handle; }, clearInterval: (handle) => { handle.cleared = true; } };
    let nextFd = 500;
    const factory = createExecutionFactory({
        store: {}, robots: { root: path.join(root, 'store'), paths: (id) => ({ home: `/store/${id}/home`, sessions: `/store/${id}/sessions`, configDir: `/store/${id}/config` }) },
        launcher: {}, view: {}, walker: {}, clock: {}, workspaceRoot: root, runtimeDir: '/store/runtime', serverDir: '/code/server', alaRoot: '/ala', nodePath: '/usr/local/bin/node',
        runtimeSources,
        deps: {
            openDirectory: () => nextFd++, closeFd: () => {}, timers,
            createExecutionSupervisor: () => {
                counter.supervisors += 1;
                return { endpointSocket: {}, controlStreams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }, providerSandbox: () => ({}), exit: async () => {} };
            },
            createExecutionLedger: () => ({ startKeeper: async () => {}, publish: async ({ kind }) => ({ handle: kind === 'process-tree' ? { wait: () => new Promise(() => {}) } : null }), endExecution: async () => ({}) }),
            createSupervisorEndpointServer: () => ({ end: () => {} }),
            imageBinds: () => ({ roBinds: [], symlinks: [] }),
            readManagedConfig: () => ({})
        }
    });
    const skillList = skills.map((rel) => ({ name: rel.split('/').pop(), path: path.join(root, rel) }));
    const specification = {
        version: 2, prompt: 'p', displayText: 'd', sessionId: SESSION, turnId: 't', permissions: 'full-access',
        ...(cwd ? { cwd: path.join(root, cwd) } : {}),
        ...(folders.length ? { folders: folders.map(([rel, access]) => ({ path: path.join(root, rel), access })) } : {}),
        ...(skillList.length ? { skills: skillList, skillsDigest: skillsSelectionDigest(skillList) } : {})
    };
    const plan = planAlaExecution({ specification, workspaceRoot: root });
    const item = { robotId: 'R', executionId: 'E', attemptId: 'A', specification };
    return { factory, plan, item, counter, intervals, root };
}

const SKILL_REL = 'AchillesIDE/roboTeamAgent/copilot/src/skills/x';
const AGENT_REPO_SOURCE = { kind: 'agent-repository', relativePath: 'AchillesIDE' };

test('M-63 F4: a write entry on a listed source is refused for open with grant_inside_active_source, and no supervisor is created', async (t) => {
    const world = await realRig(t, { cwd: 'AchillesIDE/roboTeamAgent', sources: [AGENT_REPO_SOURCE] });
    await assert.rejects(world.factory.open({ item: world.item, plan: world.plan, context: {} }),
        (error) => error instanceof ExecutionSetupError && error.reason === 'grant_inside_active_source');
    assert.equal(world.counter.supervisors, 0);
    assert.equal(world.counter.fetches, 1);
});

test('M-63 AC4: sources unavailable: a writable launch is refused runtime_sources_unavailable and createExecutionSupervisor is called 0 times', async (t) => {
    for (const answer of [() => { throw new Error('router down'); }, { schemaVersion: 1 }, () => new Promise(() => {})]) {
        const world = await realRig(t, { answer });
        await assert.rejects(world.factory.open({ item: world.item, plan: world.plan, context: {} }),
            (error) => error instanceof ExecutionSetupError && error.reason === 'runtime_sources_unavailable');
        assert.equal(world.counter.supervisors, 0);
    }
    // Read-only work does not need the list: a skill-only launch opens with 0 fetches even while the list is unavailable.
    const readOnly = await realRig(t, { answer: () => { throw new Error('router down'); }, cwd: null, skills: [SKILL_REL] });
    const execution = await readOnly.factory.open({ item: readOnly.item, plan: readOnly.plan, context: {} });
    assert.equal(readOnly.counter.fetches, 0);
    assert.equal(readOnly.counter.supervisors, 1);
    await execution.end({ classification: 'completed' });
});

test('M-63: a write project plus a read-only skill view of an active source opens with exactly one fetch per launch', async (t) => {
    const world = await realRig(t, { sources: [AGENT_REPO_SOURCE], skills: [SKILL_REL], folders: [['AchillesIDE/roboTeamAgent', 'read']] });
    const execution = await world.factory.open({ item: world.item, plan: world.plan, context: {} });
    assert.equal(world.counter.fetches, 1);
    assert.equal(world.counter.supervisors, 1);
    await execution.end({ classification: 'completed' });
});

test('M-67 Q2: on the shared tick a running writable attempt whose grant now lies in an active source is revoked with source_activated; the end stops the tick', async (t) => {
    const world = await realRig(t, { cwd: 'AchillesIDE/roboTeamAgent', sources: [] });
    const execution = await world.factory.open({ item: world.item, plan: world.plan, context: {} });
    let revoked = null;
    execution.revoked.then((reason) => { revoked = reason; });
    assert.equal(world.intervals.length, 0, 'nothing ticks before the attempt starts');
    await execution.start();
    const tick = world.intervals.find((handle) => handle.ms === 60 * 1000 && !handle.cleared);
    assert.ok(tick, 'the 60 s recheck tick runs while the writable attempt runs');
    tick.fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(revoked, null, 'nothing active: nothing happens');
    world.counter.sources = [AGENT_REPO_SOURCE];
    tick.fn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(revoked, 'source_activated');
    assert.equal(world.counter.fetches, 3, 'the launch fetch plus one per tick');
    await execution.end({ classification: 'failed', data: { reason: 'source_activated' } });
    assert.ok(world.intervals.every((handle) => handle.cleared), 'no tick is left after the end');
});

test('M-67 Q2: a read-only attempt starts no recheck tick and makes no fetch', async (t) => {
    const world = await realRig(t, { cwd: null, skills: [SKILL_REL] });
    const execution = await world.factory.open({ item: world.item, plan: world.plan, context: {} });
    await execution.start();
    assert.equal(world.intervals.length, 0);
    assert.equal(world.counter.fetches, 0);
    await execution.end({ classification: 'completed' });
});
