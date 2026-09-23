import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { classifyChanges, createUpdateService, EXPLORER_SOURCE, freshLoopbackHttpGet, preSignalRestartFailure, recoverUnchangedAgentRoute,
    updateProductionAdapters } from '../../../.github/scripts/update-explorer-qa.mjs';

const OLD = 'a'.repeat(40), NEXT = 'b'.repeat(40), CORE = 'c'.repeat(40), LIB = 'd'.repeat(40);
const BOX = 'e'.repeat(64), IMAGE = 'f'.repeat(64);
const change = (file, options = {}) => ({ path: file, oldMode: '100644', newMode: '100644', ...options });
const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-update-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scope = { workspace: path.join(root, 'workspace'), box: 'fixture-qa-box' };
    const receipt = path.join(root, 'update.json');
    const sourcePins = {
        '.runtime/ploinky': { commit: CORE, branch: 'main', origin: 'https://github.com/AssistOS-AI/ploinky.git' },
        [EXPLORER_SOURCE]: { commit: OLD, branch: 'main', origin: 'https://github.com/AssistOS-AI/AssistOSExplorer.git' },
        '.ploinky/repos/AchillesCLI': { commit: LIB, branch: 'main', origin: 'https://github.com/AssistOS-AI/AchillesCLI.git' },
    };
    for (const relative of Object.keys(sourcePins)) fs.mkdirSync(path.join(scope.workspace, relative), { recursive: true });
    write(path.join(scope.workspace, '.runtime/ploinky/ploinky-box/dependencies.lock.json'), {
        repositories: { achillesAgentLib: { url: 'https://github.com/AssistOS-AI/AchillesAgentLib.git', commit: LIB } },
    });
    write(path.join(scope.workspace, '.ploinky/edge-desired.json'), {
        hosts: { 'explorer-qa.axiologic.dev': { agent: 'AchillesIDE/explorer' } },
        media: { publicIPv4: '45.136.70.141', addressMode: 'direct' },
        cloudflare: { tunnelId: '89dd05b5-05a7-4bd4-9626-ec4343b07c67',
            tunnelTokenSecret: 'publication/explorer-qa-tunnel', apiTokenSecret: 'publication/explorer-qa-api' },
    });
    write(path.join(scope.workspace, '.data/explorer/accounts'), 'durable operator content');
    write(path.join(scope.workspace, '.ploinky/.secrets'), 'opaque encrypted fixture');
    const boxes = [{ engine: 'podman', box: { id: BOX, name: scope.box, contract: 'immutable-contract', running: true,
        image: IMAGE, imageReference: `registry/box@sha256:${IMAGE}`, mounts: [
            { Source: path.join(scope.workspace, '.runtime/ploinky'), Destination: '/opt/ploinky' },
        ] } }];
    const agents = ['explorer', 'gitAgent', 'webmeetAgent', 'roboTeamAgent'].map((agent, index) => ({
        name: `runtime-${agent}`, repo: agent === 'roboTeamAgent' ? 'AchillesCLI' : 'AchillesIDE', agent,
        alias: '', profile: 'default', auth: 'sso', runMode: 'isolated', instanceId: `instance-${index}`,
        enableGeneration: `generation-${index}`, id: String(index + 1).repeat(64), image: `sha256:${IMAGE}`, ready: true, running: true,
        hostPath: path.join(scope.workspace, agent === 'roboTeamAgent' ? '.ploinky/repos/AchillesCLI' : EXPLORER_SOURCE, agent),
    }));
    for (const agent of agents) {
        agent.routeKey = agent.agent;
        agent.route = { container: agent.name, repo: agent.repo, agent: agent.agent, hostPath: agent.hostPath, hostPort: 42507 };
    }
    const state = { dirty: false, branch: 'main', commit: NEXT, local: true, fastForward: true,
        active: true, changes: [change('explorer/src/index.mjs')], generation: 'original-generation',
        upstream: 'origin/main', restartFailure: null, healthFailure: 0 };
    const events = [];
    let held = false, restarts = 0;
    const adapters = {
        assertHost() {}, machineId: () => 'machine', boxes: () => structuredClone(boxes),
        sourcePin(directory) {
            if (state.dirty) throw Object.assign(Error('dirty'), { code: 'QA_SOURCE_NOT_CLEAN' });
            return structuredClone(sourcePins[path.relative(scope.workspace, directory)]);
        },
        async verifyAgentLib(_item, expected) {
            assert.equal(expected, LIB); return { mode: 'image', commit: LIB, fingerprint: IMAGE };
        },
        runtime: async () => ({ agents: structuredClone(agents), active: state.active,
            generation: state.generation, activationId: 'original-activation' }),
        verifyBrowserFiles: async (_item, _repository, _commit, files) => {
            assert.equal(held, true); events.push('verify-browser'); return { files: files.length };
        },
        health: async () => {
            if (state.healthFailure > 0) { state.healthFailure -= 1; throw Error('health unavailable'); }
        },
        remoteDefault: () => ({ branch: state.branch, commit: state.commit }),
        upstream: () => state.upstream,
        hasCommit: () => state.local,
        isAncestor: () => state.fastForward,
        changes: () => structuredClone(state.changes), agentRoots: () => ['explorer', 'gitAgent', 'webmeetAgent'],
        fetch(_repo, branch, commit) {
            assert.equal(held, true); assert.equal(branch, 'main'); assert.equal(commit, state.commit);
            events.push('fetch'); state.local = true;
        },
        fastForward(_repo, commit) {
            assert.equal(held, true); events.push('fast-forward'); sourcePins[EXPLORER_SOURCE].commit = commit;
        },
        restore(_repo, commit) {
            assert.equal(held, true); events.push('restore'); sourcePins[EXPLORER_SOURCE].commit = commit;
        },
        async restart(_item, selection) {
            assert.equal(held, false); events.push(`restart:${selection.agent}`); restarts += 1;
            const agent = agents.find(row => row.name === selection.name);
            if (state.restartFailure?.(restarts, agent)) {
                agent.image = null; agent.ready = false;
                throw Object.assign(Error('private process output is never reported'), {
                    code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED', operation: `targeted-restart:AchillesIDE/${agent.agent}`,
                });
            }
            agent.id = (10 + restarts).toString(16).repeat(64);
            agent.image = `sha256:${IMAGE}`; agent.ready = true;
        },
        async recoverUnchangedAgent(_item, selected) {
            assert.equal(held, true); events.push(`recover-route:${selected.agent}`);
            const current = agents.find(agent => agent.name === selected.name);
            assert.equal(current.id, selected.id); assert.equal(current.image, selected.image);
            assert.deepEqual(current.route, { ...selected.route, draining: true });
            delete current.route.draining; current.ready = true;
        },
        async acquireWorkspaceLock(workspace) {
            assert.equal(workspace, scope.workspace); assert.equal(held, false); held = true; events.push('lock');
            return { release() { assert.equal(held, true); held = false; events.push('unlock'); } };
        },
    };
    const service = createUpdateService(adapters, scope);
    const unchangedData = () => {
        assert.equal(fs.readFileSync(path.join(scope.workspace, '.data/explorer/accounts'), 'utf8'), 'durable operator content');
        assert.equal(fs.readFileSync(path.join(scope.workspace, '.ploinky/.secrets'), 'utf8'), 'opaque encrypted fixture');
    };
    return { root, scope, receipt, state, sourcePins, boxes, agents, events, adapters, service, unchangedData };
}

test('plan discovers default branch without fetching, locks, receipts or runtime mutations', async t => {
    const f = fixture(t); f.state.local = false;
    const result = await f.service.plan();
    assert.equal(result.result, 'planned'); assert.equal(result.mutations, false);
    assert.equal(result.changeValidation, 'requires-fetch');
    assert.equal(result.previousCommit, OLD); assert.equal(result.candidateCommit, NEXT);
    assert.deepEqual(f.events, []); assert.equal(fs.existsSync(f.receipt), false); f.unchangedData();
});

test('healthy update fast-forwards only Explorer and restarts only affected enabled agents', async t => {
    const f = fixture(t), prior = structuredClone(f.agents);
    f.state.changes.push(change('gitAgent/src/index.mjs'), change('webmeetAgent/docs/readme.md'));
    const result = await f.service.execute(f.receipt);
    assert.equal(result.status, 'updated'); assert.equal(result.boxId, BOX);
    assert.deepEqual(result.agents, ['AchillesIDE/explorer', 'AchillesIDE/gitAgent']);
    assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, NEXT); assert.equal(f.sourcePins['.runtime/ploinky'].commit, CORE);
    assert.deepEqual(f.agents.slice(2), prior.slice(2));
    assert.deepEqual(f.events, ['lock', 'fetch', 'fast-forward', 'unlock', 'restart:explorer', 'lock',
        'unlock', 'restart:gitAgent', 'lock', 'unlock']);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt)).status, 'updated'); f.unchangedData();
});

test('default-tip redeploy is idempotent without fetch or restart', async t => {
    const f = fixture(t); f.state.commit = OLD; f.state.changes = [];
    const result = await f.service.execute(f.receipt);
    assert.equal(result.status, 'unchanged'); assert.deepEqual(f.events, ['lock', 'unlock']); f.unchangedData();
});

test('documentation-only changes fast-forward without runtime restarts', async t => {
    const f = fixture(t); f.state.changes = [change('docs/architecture.html'), change('explorer/tests/unit/sample.test.js')];
    const result = await f.service.execute(f.receipt);
    assert.equal(result.status, 'updated'); assert.deepEqual(result.agents, []);
    assert.deepEqual(f.events, ['lock', 'fetch', 'fast-forward', 'unlock']);
});

test('reviewed browser assets update live sources without restarting any runtime', async t => {
    const f = fixture(t), previous = structuredClone(f.agents);
    f.state.changes = [change('explorer/services/infrastructure/explorerApi.js'), change('explorer/shared/ui/ui-common.css'),
        change('gitAgent/IDE-plugins/git-tool-button/components/panel.js'),
        change('webmeetAgent/IDE-plugins/webmeet-tool-button/components/panel.html'), change('docs/architecture.html')];
    const result = await f.service.execute(f.receipt);
    assert.equal(result.status, 'updated'); assert.deepEqual(result.agents, []);
    assert.deepEqual(result.browserAgents, ['explorer', 'gitAgent', 'webmeetAgent']);
    assert.equal(result.browserPaths.length, 4); assert.deepEqual(result.browserVerification, { files: 4 });
    assert.deepEqual(f.agents, previous); assert.deepEqual(f.events, ['lock', 'fetch', 'fast-forward', 'verify-browser', 'unlock']);
    f.unchangedData();
});

test('mixed browser and server changes restart only the server owner', async t => {
    const f = fixture(t);
    f.state.changes = [change('explorer/services/infrastructure/explorerApi.js'), change('gitAgent/src/index.mjs')];
    const result = await f.service.execute(f.receipt);
    assert.deepEqual(result.agents, ['AchillesIDE/gitAgent']); assert.deepEqual(result.browserAgents, ['explorer']);
    assert.equal(result.browserVerification.files, 1);
});

test('browser fast path rejects a route rooted in a different source', async t => {
    const f = fixture(t); f.state.changes = [change('explorer/services/infrastructure/explorerApi.js')];
    f.agents[0].hostPath = '/another/checkout/explorer';
    await assert.rejects(f.service.execute(f.receipt), { code: 'QA_UPDATE_STATIC_SOURCE_UNPROVEN' });
    assert.deepEqual(f.events, ['lock', 'unlock']);
});

test('browser source verification failure rolls back code without changing runtime IDs', async t => {
    const f = fixture(t), previous = structuredClone(f.agents);
    f.state.changes = [change('explorer/shared/ui/ui-common.css')];
    f.adapters.verifyBrowserFiles = async () => { throw Object.assign(Error('mismatch'), {
        code: 'QA_UPDATE_PUBLIC_ASSET_MISMATCH', operation: 'public-browser-asset',
    }); };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'passed'
        && error.receipt.operation === 'public-browser-asset');
    assert.deepEqual(f.agents, previous); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
    assert.equal(f.events.some(event => event.startsWith('restart:')), false);
});

test('browser-only update cannot silently change the active route generation', async t => {
    const f = fixture(t), fastForward = f.adapters.fastForward;
    f.state.changes = [change('explorer/shared/ui/ui-common.css')];
    f.adapters.fastForward = (...args) => { fastForward(...args); f.state.generation = 'unexpected-generation'; };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'failed'
        && error.receipt.code === 'QA_UPDATE_ROUTING_CHANGED');
});

test('shared code restarts all enabled same-repository agents and retains sibling repositories', async t => {
    const f = fixture(t); f.state.changes = [change('shared/network.mjs')];
    const result = await f.service.execute(f.receipt);
    assert.deepEqual(result.agents, ['AchillesIDE/explorer', 'AchillesIDE/gitAgent', 'AchillesIDE/webmeetAgent']);
});

for (const [name, changeFixture, code] of [
    ['dirty source', f => { f.state.dirty = true; }, 'QA_SOURCE_NOT_CLEAN'],
    ['nondefault branch', f => { f.sourcePins[EXPLORER_SOURCE].branch = 'topic'; }, 'QA_UPDATE_DEFAULT_BRANCH_REQUIRED'],
    ['detached HEAD', f => { f.sourcePins[EXPLORER_SOURCE].branch = 'HEAD'; }, 'QA_UPDATE_DEFAULT_BRANCH_REQUIRED'],
    ['wrong upstream', f => { f.state.upstream = 'other/main'; }, 'QA_UPDATE_DEFAULT_UPSTREAM_REQUIRED'],
    ['wrong origin', f => { f.sourcePins[EXPLORER_SOURCE].origin = 'https://github.com/other/repo'; }, 'QA_UPDATE_DEFAULT_BRANCH_REQUIRED'],
    ['wrong Box', f => { f.boxes[0].box.name = 'production'; }, 'QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED'],
    ['stopped Box', f => { f.boxes[0].box.running = false; }, 'QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED'],
    ['ambiguous Box', f => { f.boxes.push(structuredClone(f.boxes[0])); }, 'QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED'],
    ['unready runtime', f => { f.agents[0].ready = false; }, 'QA_UPDATE_RUNTIME_NOT_READY'],
    ['divergent history', f => { f.state.fastForward = false; }, 'QA_UPDATE_NOT_FAST_FORWARD'],
    ['manifest change', f => { f.state.changes.push(change('explorer/manifest.json')); }, 'QA_UPDATE_REQUIRES_RECONFIGURATION'],
    ['dependency change', f => { f.state.changes.push(change('explorer/package-lock.json')); }, 'QA_UPDATE_REQUIRES_RECONFIGURATION'],
    ['lifecycle hook', f => { f.state.changes.push(change('explorer/hooks/postinstall.mjs')); }, 'QA_UPDATE_REQUIRES_RECONFIGURATION'],
    ['image change', f => { f.state.changes.push(change('explorer/Dockerfile')); }, 'QA_UPDATE_REQUIRES_RECONFIGURATION'],
    ['symlink source', f => { f.state.changes.push(change('explorer/src/link.js', { newMode: '120000' })); }, 'QA_UPDATE_FILE_TYPE_CHANGED'],
    ['aliased target', f => { f.agents[0].alias = 'alias'; }, 'QA_UPDATE_TARGET_NOT_UNAMBIGUOUS'],
]) {
    test(`${name} is rejected before source or runtime changes`, async t => {
        const f = fixture(t); changeFixture(f);
        await assert.rejects(f.service.execute(f.receipt), { code });
        assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
        assert.deepEqual(f.events, ['lock', 'unlock']); assert.equal(fs.existsSync(f.receipt), false); f.unchangedData();
    });
}

test('uncached unsafe candidate is fetched for inspection but never checked out', async t => {
    const f = fixture(t); f.state.local = false; f.state.changes = [change('explorer/package.json')];
    await assert.rejects(f.service.execute(f.receipt), { code: 'QA_UPDATE_REQUIRES_RECONFIGURATION' });
    assert.deepEqual(f.events, ['lock', 'fetch', 'unlock']); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
});

test('default branch moving during fetch fails before checkout', async t => {
    const f = fixture(t), fetch = f.adapters.fetch;
    f.adapters.fetch = (...args) => { fetch(...args); f.state.commit = '9'.repeat(40); };
    await assert.rejects(f.service.execute(f.receipt), { code: 'QA_UPDATE_REMOTE_MOVED' });
    assert.deepEqual(f.events, ['lock', 'fetch', 'unlock']); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
});

test('a command error after completed fast-forward still attempts guarded rollback', async t => {
    const f = fixture(t), fastForward = f.adapters.fastForward;
    f.adapters.fastForward = (...args) => { fastForward(...args); throw Error('command result uncertain'); };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'passed');
    assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
    assert.deepEqual(f.events, ['lock', 'fetch', 'fast-forward', 'restore', 'unlock']);
});

test('startup failure restores clean previous code and restarts successful and failed touched targets', async t => {
    const f = fixture(t); f.state.changes.push(change('gitAgent/src/index.mjs'));
    f.state.restartFailure = count => count === 2;
    await assert.rejects(f.service.execute(f.receipt), error => {
        assert.equal(error.receipt.status, 'failed'); assert.equal(error.receipt.rollback, 'passed');
        assert.equal(error.receipt.code, 'QA_UPDATE_EXTERNAL_COMMAND_FAILED');
        assert.equal(JSON.stringify(error.receipt).includes('private process output'), false); return true;
    });
    assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
    assert.deepEqual(f.events.filter(event => event.startsWith('restart:') || event === 'restore'),
        ['restart:explorer', 'restart:gitAgent', 'restore', 'restart:explorer', 'restart:gitAgent']);
    f.unchangedData();
});

test('failure before physical replacement recovers the exact running predecessor route without another restart', async t => {
    const f = fixture(t), prior = structuredClone(f.agents);
    f.adapters.restart = async (_item, agent) => {
        f.events.push(`restart:${agent.agent}`);
        f.agents[0].ready = false; f.agents[0].route.draining = true;
        throw Object.assign(Error('target still running'), {
            code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED', operation: 'targeted-restart:AchillesIDE/explorer',
            predecessorUntouched: agent.name,
        });
    };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'passed'
        && error.receipt.operation === 'targeted-restart:AchillesIDE/explorer');
    assert.deepEqual(f.agents, prior); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
    assert.deepEqual(f.events.filter(event => /^(?:restart:|recover-route:|restore$)/.test(event)),
        ['restart:explorer', 'restore', 'recover-route:explorer']);
});

test('generic signal timeout with the same running ID cannot undrain the predecessor', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    let calls = 0;
    f.adapters.restart = async (...args) => {
        if (++calls === 1) {
            f.events.push('restart:explorer'); f.agents[0].ready = false; f.agents[0].route.draining = true;
            throw Object.assign(Error('SIGTERM timeout but process is still running'), { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' });
        }
        await restart(...args); delete f.agents[0].route.draining;
    };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'passed');
    assert.equal(f.events.some(event => event.startsWith('recover-route:')), false);
    assert.equal(f.events.filter(event => event === 'restart:explorer').length, 2);
});

test('readiness failure after restart rolls back and remains a failed deployment', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    let count = 0;
    f.adapters.restart = async (...args) => { await restart(...args); if (++count === 1) f.agents[0].ready = false; };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'passed'
        && error.receipt.code === 'QA_UPDATE_RUNTIME_NOT_READY');
    assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
});

test('dirty candidate refuses automatic source rollback', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    f.adapters.restart = async (...args) => { await restart(...args); f.state.dirty = true; throw Error('failed'); };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'failed');
    assert.equal(f.events.includes('restore'), false); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, NEXT);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt)).rollbackCode, 'QA_SOURCE_NOT_CLEAN');
});

test('identity drift refuses rollback and never mutates an unrelated source', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    f.adapters.restart = async (...args) => { await restart(...args); f.sourcePins['.runtime/ploinky'].commit = NEXT; };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'failed'
        && error.receipt.code === 'QA_UPDATE_SOURCE_IDENTITY_CHANGED');
    assert.equal(f.events.includes('restore'), false);
});

test('unexpected target image replacement cannot be accepted or trigger blind recovery', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    f.adapters.restart = async (...args) => { await restart(...args); f.agents[0].image = `sha256:${'0'.repeat(64)}`; };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'failed'
        && error.receipt.code === 'QA_UPDATE_AGENT_IMAGE_CHANGED');
    assert.equal(f.events.includes('restore'), false);
});

test('changed logical target identity cannot be mistaken for the selected agent', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    f.adapters.restart = async (...args) => { await restart(...args); f.agents[0].instanceId = 'unexpected-selection'; };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'failed'
        && error.receipt.code === 'QA_UPDATE_SELECTION_CHANGED');
    assert.equal(f.events.includes('restore'), false);
});

test('rollback failure is explicit and retains the original failed status', async t => {
    const f = fixture(t); f.state.restartFailure = () => true;
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.status === 'failed' && error.receipt.rollback === 'failed'
        && error.receipt.rollbackCode === 'QA_UPDATE_EXTERNAL_COMMAND_FAILED'
        && error.receipt.rollbackOperation === 'targeted-restart:AchillesIDE/explorer');
    assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
});

function routeRecoveryFixture() {
    const expected = { name: 'runtime-explorer', repo: 'AchillesIDE', agent: 'explorer', alias: '', profile: 'default',
        auth: 'sso', runMode: 'isolated', instanceId: 'original-instance', enableGeneration: 'original-enable',
        id: BOX, image: `sha256:${IMAGE}`, hostPath: '/workspace/.ploinky/repos/AchillesIDE/explorer', routeKey: 'explorer' };
    expected.predecessorUntouched = expected.name;
    expected.route = { container: expected.name, repo: expected.repo, agent: expected.agent, hostPath: expected.hostPath, hostPort: 42507 };
    const state = { route: { ...expected.route, draining: true }, active: true,
        record: { repoName: expected.repo, agentName: expected.agent, containerId: expected.id,
            instanceId: expected.instanceId, enableGeneration: expected.enableGeneration, auth: { mode: 'sso' } },
        container: { Id: expected.id, Image: expected.image, State: { Running: true } } };
    const events = [];
    const adapters = {
        readActive: () => ({ selector: { state: state.active ? 'active' : 'inactive', publicationState: 'ready' },
            generation: { routing: { routes: { explorer: structuredClone(state.route) } } } }),
        readRouting: () => ({ routes: { explorer: structuredClone(state.route) } }),
        readRegistry: () => ({ [expected.name]: structuredClone(state.record) }),
        inspectContainer: () => structuredClone(state.container),
        withWorkspaceLease: async (_options, callback) => { events.push('lease'); return callback(); },
        withMaintenance: async (name, _options, callback) => { assert.equal(name, expected.name); events.push('maintenance'); return callback(); },
        withNetwork: async callback => { events.push('network'); return callback('network-capability'); },
        async mergeRouting(mutator, options) {
            assert.equal(options.networkLifecycleCapability, 'network-capability');
            options.validateActiveGeneration();
            // The real coordinator inactivates before calling the mutator.
            state.active = false;
            const routing = mutator({ routes: { explorer: structuredClone(state.route) } });
            state.route = routing.routes.explorer; state.active = true; events.push('route-restored');
        },
    };
    return { expected, state, events, adapters };
}

test('coordinated route recovery validates the live predecessor before inactivation', async () => {
    const f = routeRecoveryFixture();
    const result = await recoverUnchangedAgentRoute(f.expected, f.adapters);
    assert.deepEqual(result, { result: 'restored', containerId: BOX });
    assert.deepEqual(f.state.route, f.expected.route);
    assert.deepEqual(f.events, ['lease', 'maintenance', 'network', 'route-restored']);
});

test('already restored exact predecessor needs no routing mutation', async () => {
    const f = routeRecoveryFixture(); delete f.state.route.draining;
    assert.equal((await recoverUnchangedAgentRoute(f.expected, f.adapters)).result, 'unchanged');
    assert.deepEqual(f.events, ['lease', 'maintenance', 'network']);
});

test('predecessor recovery requires positive evidence that the exact target was never signalled', async () => {
    const f = routeRecoveryFixture(); delete f.expected.predecessorUntouched;
    await assert.rejects(recoverUnchangedAgentRoute(f.expected, f.adapters), { code: 'QA_UPDATE_UNCHANGED_ROUTE_RECOVERY_REJECTED' });
    assert.deepEqual(f.events, []);
});

test('only an exact completed pre-signal rejection supplies untouched-target evidence', () => {
    const target = 'ploinky_AchillesIDE_explorer_explorerQaWorkspace_7a31ab77';
    const stderr = `❌ Error: Failed to restart container ${target}: managed restart failed: affected selectors remain active for targeted drain of '${target}'\n`;
    assert.equal(preSignalRestartFailure({ status: 1, stderr }, target), true);
    assert.equal(preSignalRestartFailure({ status: 1, stderr: `${stderr}ploinky: In-box restart failed with status 1\n` }, target), true);
    for (const result of [
        { status: 0, stderr }, { status: null, stderr }, { status: 1, stderr, signal: 'SIGTERM' },
        { status: 1, stderr, error: Error('timeout') }, { status: 1, stderr: `prefix ${stderr}` },
        { status: 1, stderr: stderr.replace(target, 'another-container') },
        { status: 1, stderr: 'targeted drain timed out after SIGTERM' },
        { status: 1, stdout: stderr, stderr: '❌ Error: targeted drain exceeded its deadline after SIGTERM' },
        { status: 1, stderr: `${stderr}❌ Error: targeted drain exceeded its deadline after SIGTERM\n` },
    ]) assert.equal(preSignalRestartFailure(result, target), false);
});

for (const [label, drift] of [
    ['route ownership', f => { f.state.route.hostPort += 1; }],
    ['physical container', f => { f.state.container.Id = '0'.repeat(64); }],
    ['running state', f => { f.state.container.State.Running = false; }],
    ['image', f => { f.state.container.Image = `sha256:${'0'.repeat(64)}`; }],
    ['logical instance', f => { f.state.record.instanceId = 'replacement'; }],
    ['selection policy', f => { f.state.record.auth.mode = 'none'; }],
]) {
    test(`coordinated predecessor recovery rejects changed ${label}`, async () => {
        const f = routeRecoveryFixture(); drift(f);
        await assert.rejects(recoverUnchangedAgentRoute(f.expected, f.adapters), { code: 'QA_UPDATE_UNCHANGED_ROUTE_RECOVERY_REJECTED' });
        assert.equal(f.events.includes('route-restored'), false); assert.equal(f.state.active, true);
    });
}

test('path and lifecycle admission also rejects unknown runtime files and executable-bit changes', () => {
    for (const file of ['../explorer/src/a.js', 'explorer//a.js', '/tmp/a.js', 'explorer\\a.js']) {
        assert.throws(() => classifyChanges([change(file)], ['explorer']), { code: 'QA_UPDATE_CHANGE_PATH_INVALID' });
    }
    assert.throws(() => classifyChanges([change('unexpected/code.mjs')], ['explorer']), { code: 'QA_UPDATE_UNKNOWN_RUNTIME_PATH' });
    assert.throws(() => classifyChanges([change('explorer/src/a.js', { newMode: '100755' })], ['explorer']), { code: 'QA_UPDATE_FILE_TYPE_CHANGED' });
});

test('production runtime probes select the deployed Router and media ports inside the Box', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-update-engine-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const engine = path.join(root, 'engine.mjs');
    const scope = { workspace: '/home/admin/explorerQaWorkspace' };
    write(engine, `#!${process.execPath}
        import fs from 'node:fs';
        const args = process.argv.slice(2);
        const environment = Object.fromEntries(args.flatMap((value, index) => {
            if (value !== '--env') return [];
            const entry = args[index + 1], separator = entry.indexOf('=');
            return [[entry.slice(0, separator), entry.slice(separator + 1)]];
        }));
        const script = fs.readFileSync(0, 'utf8');
        const active = environment.PLOINKY_WORKSPACE_ROOT === '/home/admin/explorerQaWorkspace'
            && environment.PLOINKY_ROUTER_HOST_PORT === '8097' && environment.PLOINKY_MEDIA_HOST_PORT === '7882';
        process.stdout.write(JSON.stringify({active, agents: [], scriptProvided: script.includes('loadActiveEdgeRoutingGeneration')}));
    `);
    fs.chmodSync(engine, 0o700);
    const result = await updateProductionAdapters(scope).runtime({ engine, box: { id: BOX } });
    assert.deepEqual(result, { active: true, agents: [], scriptProvided: true });
});

test('fresh health connections survive synchronous probes after the server closes its idle socket', async t => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import http from 'node:http';
        const server = http.createServer((req, res) => {
            res.writeHead(401, {'Content-Type':'application/json', 'Connection':'keep-alive', 'Keep-Alive':'timeout=60'});
            res.end(JSON.stringify({ok:false,error:{code:'AUTH_REQUIRED'}}));
        });
        server.keepAliveTimeout = 100; server.keepAliveTimeoutBuffer = 0;
        server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
    const [portChunk] = await once(child.stdout, 'data');
    const port = Number(portChunk.toString().trim());
    const probe = get => new Promise((resolve, reject) => {
        get({ hostname: '127.0.0.1', port, path: '/health' }, response => {
            let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body }));
        }).on('error', reject);
    });
    const blockEventLoop = () => {
        const result = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { timeout: 3000 });
        assert.equal(result.status, 0);
    };
    const pooledAgent = new http.Agent({ keepAlive: true });
    t.after(() => pooledAgent.destroy());
    const pooledGet = (options, callback) => http.get({ ...options, agent: pooledAgent }, callback);
    assert.equal((await probe(pooledGet)).status, 401);
    await new Promise(resolve => setImmediate(resolve));
    blockEventLoop();
    await assert.rejects(probe(pooledGet), error => ['ECONNRESET', 'EPIPE'].includes(error.code));
    assert.equal((await probe(freshLoopbackHttpGet)).status, 401);
    blockEventLoop();
    assert.deepEqual(await probe(freshLoopbackHttpGet), { status: 401, body: '{"ok":false,"error":{"code":"AUTH_REQUIRED"}}' });
});

test('production health retains strict readiness and reports a safe loopback phase and runtime code', async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-update-health-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(path.join(root, '.runtime/ploinky/ploinky-box/supervisor.mjs'), `
        import assert from 'node:assert/strict';
        export async function checkBoxHealth(port, options) {
            assert.equal(port, 8097); assert.equal(options.timeoutMs, 5000); assert.equal(options.readinessTimeoutMs, 0);
            assert.equal(options.httpGet.name, 'freshLoopbackHttpGet');
            throw Object.assign(new Error('private response body'), {code:'PLOINKY_BOX_SUPERVISOR_FAILED'});
        }
    `);
    await assert.rejects(updateProductionAdapters({ workspace: root }).health(), error => {
        assert.equal(error.code, 'PLOINKY_BOX_SUPERVISOR_FAILED'); assert.equal(error.operation, 'loopback-health');
        assert.equal(error.message.includes('private response body'), false); return true;
    });
});

test('post-update health failure preserves the safe runtime code through source rollback', async t => {
    const f = fixture(t); let checks = 0;
    f.adapters.health = async () => {
        if (++checks === 2) throw Object.assign(Error('private runtime detail'), {
            code: 'PLOINKY_BOX_SUPERVISOR_FAILED', operation: 'loopback-health',
        });
    };
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.rollback === 'passed'
        && error.receipt.code === 'PLOINKY_BOX_SUPERVISOR_FAILED' && error.receipt.operation === 'loopback-health');
});

test('Git adapter parses real additions, deletions and moves, fast-forwards, and restores with keep', t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-update-git-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = args => {
        const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
    write(path.join(root, 'explorer/manifest.json'), '{}'); write(path.join(root, 'explorer/assets/old.svg'), '<svg/>');
    git(['add', '.']); git(['commit', '-m', 'Initial source']); const previous = git(['rev-parse', 'HEAD']);
    fs.renameSync(path.join(root, 'explorer/assets/old.svg'), path.join(root, 'explorer/assets/new.svg'));
    write(path.join(root, 'explorer/src/a.mjs'), 'export const value = 1;');
    git(['add', '.']); git(['commit', '-m', 'Update source']); const candidate = git(['rev-parse', 'HEAD']);
    git(['reset', '--keep', previous]);
    const adapters = updateProductionAdapters();
    assert.deepEqual(adapters.agentRoots(root, previous), ['explorer']);
    const classified = classifyChanges(adapters.changes(root, previous, candidate), adapters.agentRoots(root, previous));
    assert.deepEqual(classified, { affected: ['explorer'], shared: false, browserPaths: [] });
    assert.equal(adapters.hasCommit(root, candidate), true); assert.equal(adapters.isAncestor(root, previous, candidate), true);
    adapters.fastForward(root, candidate); assert.equal(git(['rev-parse', 'HEAD']), candidate);
    adapters.restore(root, previous); assert.equal(git(['rev-parse', 'HEAD']), previous);
    assert.equal(fs.existsSync(path.join(root, 'explorer/assets/old.svg')), true);
});
