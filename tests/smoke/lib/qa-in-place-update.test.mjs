import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { assertHostLockHeld, assertRuntimeReady, classifyChanges, createUpdateService, EXPLORER_SOURCE, freshLoopbackHttpGet, main,
    parseArguments, platformConfigDigest, preSignalRestartFailure, recoverUnchangedAgentRoute,
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
        '.ploinky/repos/webmeet': { commit: LIB, branch: 'main', origin: 'https://github.com/AssistOS-AI/webmeet.git' },
        'AdvancedLanguageAgent': { commit: '1'.repeat(40), branch: 'main', origin: 'https://github.com/AssistOS-AI/AdvancedLanguageAgent.git' },
        // Image-owned AgentLib sources: present on disk, never compared with a remote.
        'achillesAgentLib': { commit: '2'.repeat(40), branch: 'main', origin: 'https://github.com/AssistOS-AI/achillesAgentLib.git' },
        '.ploinky/agentlib/generations/gen-1': { commit: '3'.repeat(40), branch: 'main', origin: 'https://github.com/AssistOS-AI/achillesAgentLib.git' },
    };
    for (const relative of Object.keys(sourcePins)) fs.mkdirSync(path.join(scope.workspace, relative), { recursive: true });
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
        name: `runtime-${agent}`, repo: agent === 'webmeetAgent' ? 'webmeet' : 'AchillesIDE', agent,
        alias: '', profile: 'default', auth: 'sso', runMode: 'isolated', instanceId: `instance-${index}`,
        enableGeneration: `generation-${index}`, id: String(index + 1).repeat(64), image: `sha256:${IMAGE}`, ready: true, running: true,
        hostPath: path.join(scope.workspace, agent === 'webmeetAgent' ? '.ploinky/repos/webmeet' : EXPLORER_SOURCE, agent),
    }));
    for (const agent of agents) {
        agent.routeKey = agent.agent;
        agent.route = { container: agent.name, repo: agent.repo, agent: agent.agent, hostPath: agent.hostPath, hostPort: 42507 };
    }
    const state = { dirty: false, branch: 'main', commit: NEXT, local: true, fastForward: true,
        active: true, changes: [change('explorer/src/index.mjs')], generation: 'original-generation',
        upstream: 'origin/main', restartFailure: null, healthFailure: 0,
        // Per-path overrides for the remote default of a non-Explorer repo; an Error value is thrown.
        remote: {}, remoteImage: { reference: 'docker.io/assistos/ploinky-box:latest', configDigest: IMAGE } };
    const events = [], calls = [];
    const excludedFromDrift = new Set(['achillesAgentLib', '.ploinky/agentlib/generations/gen-1']);
    let held = false, restarts = 0;
    const adapters = {
        assertHost() {}, machineId: () => 'machine', boxes: () => structuredClone(boxes),
        sourcePin(directory) {
            if (state.dirty) throw Object.assign(Error('dirty'), { code: 'QA_SOURCE_NOT_CLEAN' });
            return structuredClone(sourcePins[path.relative(scope.workspace, directory)]);
        },
        async verifyAgentLib(item, ...rest) {
            // The Box image is the only AchillesAgentLib identity; nothing is pinned.
            assert.equal(item.box.id, BOX); assert.deepEqual(rest, []);
            return { mode: 'image', contract: 'image-owned', imageId: `sha256:${IMAGE}`, sourceId: LIB.repeat(2).slice(0, 64),
                sourceRelativePath: 'image', packageName: 'ploinky-agent-lib', packageVersion: '1.0.0', provenance: null };
        },
        runtime: async () => ({ agents: structuredClone(agents), active: state.active,
            generation: state.generation, activationId: 'original-activation' }),
        verifyBrowserFiles: async (_item, _repository, _commit, files) => {
            assert.equal(held, true); events.push('verify-browser'); return { files: files.length };
        },
        health: async () => {
            if (state.healthFailure > 0) { state.healthFailure -= 1; throw Error('health unavailable'); }
        },
        remoteDefault(repo) {
            const relative = path.relative(scope.workspace, repo);
            calls.push(`remote:${relative}`);
            if (excludedFromDrift.has(relative)) throw Error(`image-owned source ${relative} must never be queried`);
            const override = state.remote[relative];
            if (override instanceof Error) throw override;
            if (relative === EXPLORER_SOURCE) return { branch: state.branch, commit: state.commit };
            return { branch: sourcePins[relative].branch, commit: sourcePins[relative].commit, ...override };
        },
        async remoteBoxImage() {
            calls.push('image');
            if (state.remoteImage instanceof Error) throw state.remoteImage;
            return structuredClone(state.remoteImage);
        },
        upstream: () => state.upstream,
        hasCommit: () => state.local,
        isAncestor: () => state.fastForward,
        changes: () => structuredClone(state.changes), agentRoots: () => ['explorer', 'gitAgent', 'roboTeamAgent'],
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
    return { root, scope, receipt, state, sourcePins, boxes, agents, events, calls, adapters, service, unchangedData };
}

test('plan discovers default branch without fetching, locks, receipts or runtime mutations', async t => {
    const f = fixture(t); f.state.local = false;
    const result = await f.service.plan();
    assert.equal(result.result, 'planned'); assert.equal(result.mutations, false);
    assert.equal(result.changeValidation, 'requires-fetch');
    assert.equal(result.previousCommit, OLD); assert.equal(result.candidateCommit, NEXT);
    assert.deepEqual(f.events, []); assert.equal(fs.existsSync(f.receipt), false); f.unchangedData();
});

test('the update verifies the image-supplied AgentLib without any Ploinky dependency lock', async t => {
    const f = fixture(t);
    assert.equal(fs.existsSync(path.join(f.scope.workspace, '.runtime/ploinky/ploinky-box/dependencies.lock.json')), false);
    assert.equal((await f.service.plan()).result, 'planned');
    const rejected = fixture(t);
    rejected.adapters.verifyAgentLib = async () => {
        throw Object.assign(Error('QA_AGENTLIB_IMAGE_MODE_REQUIRED: the QA Box uses local mode.'), { code: 'QA_AGENTLIB_IMAGE_MODE_REQUIRED' });
    };
    await assert.rejects(rejected.service.plan(), { code: 'QA_AGENTLIB_IMAGE_MODE_REQUIRED' });
    assert.deepEqual(rejected.events, [], 'planning takes no lock');
    await assert.rejects(rejected.service.execute(rejected.receipt, { expectedCommit: rejected.state.commit }), { code: 'QA_AGENTLIB_IMAGE_MODE_REQUIRED' });
    assert.deepEqual(rejected.events, ['lock', 'unlock'], 'refused under the workspace lock before any fetch, fast-forward or restart');
    assert.equal(rejected.sourcePins[EXPLORER_SOURCE].commit, OLD);
    rejected.unchangedData();
});

test('healthy update fast-forwards only Explorer and restarts only affected enabled agents', async t => {
    const f = fixture(t), prior = structuredClone(f.agents);
    f.state.changes.push(change('gitAgent/src/index.mjs'), change('roboTeamAgent/docs/readme.md'));
    const result = await f.service.execute(f.receipt, { expectedCommit: f.state.commit });
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
    const result = await f.service.execute(f.receipt, { expectedCommit: f.state.commit });
    assert.equal(result.status, 'unchanged'); assert.deepEqual(f.events, ['lock', 'unlock']); f.unchangedData();
});

test('documentation-only changes fast-forward without runtime restarts', async t => {
    const f = fixture(t); f.state.changes = [change('docs/architecture.html'), change('explorer/tests/unit/sample.test.js')];
    const result = await f.service.execute(f.receipt, { expectedCommit: f.state.commit });
    assert.equal(result.status, 'updated'); assert.deepEqual(result.agents, []);
    assert.deepEqual(f.events, ['lock', 'fetch', 'fast-forward', 'unlock']);
});

test('reviewed browser assets update live sources without restarting any runtime', async t => {
    const f = fixture(t), previous = structuredClone(f.agents);
    f.state.changes = [change('explorer/services/infrastructure/explorerApi.js'), change('explorer/shared/ui/ui-common.css'),
        change('gitAgent/IDE-plugins/git-tool-button/components/panel.js'),
        change('docs/architecture.html')];
    const result = await f.service.execute(f.receipt, { expectedCommit: f.state.commit });
    assert.equal(result.status, 'updated'); assert.deepEqual(result.agents, []);
    assert.deepEqual(result.browserAgents, ['explorer', 'gitAgent']);
    assert.equal(result.browserPaths.length, 3); assert.deepEqual(result.browserVerification, { files: 3 });
    assert.deepEqual(f.agents, previous); assert.deepEqual(f.events, ['lock', 'fetch', 'fast-forward', 'verify-browser', 'unlock']);
    f.unchangedData();
});

test('plugin assets of agents outside the reviewed browser set restart their owner, and a moved agent is not a runtime path', async t => {
    const moved = fixture(t);
    moved.state.changes = [change('roboTeamAgent/IDE-plugins/roboteam-tool-button/roboteam-tool-button.js')];
    const result = await moved.service.execute(moved.receipt, { expectedCommit: moved.state.commit });
    assert.deepEqual(result.agents, ['AchillesIDE/roboTeamAgent']); assert.deepEqual(result.browserAgents, []);
    const unknown = fixture(t);
    unknown.state.changes = [change('webmeetAgent/IDE-plugins/webmeet-tool-button/components/panel.html')];
    await assert.rejects(unknown.service.execute(unknown.receipt, { expectedCommit: unknown.state.commit }), { code: 'QA_UPDATE_UNKNOWN_RUNTIME_PATH' });
});

test('mixed browser and server changes restart only the server owner', async t => {
    const f = fixture(t);
    f.state.changes = [change('explorer/services/infrastructure/explorerApi.js'), change('gitAgent/src/index.mjs')];
    const result = await f.service.execute(f.receipt, { expectedCommit: f.state.commit });
    assert.deepEqual(result.agents, ['AchillesIDE/gitAgent']); assert.deepEqual(result.browserAgents, ['explorer']);
    assert.equal(result.browserVerification.files, 1);
});

test('browser fast path rejects a route rooted in a different source', async t => {
    const f = fixture(t); f.state.changes = [change('explorer/services/infrastructure/explorerApi.js')];
    f.agents[0].hostPath = '/another/checkout/explorer';
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), { code: 'QA_UPDATE_STATIC_SOURCE_UNPROVEN' });
    assert.deepEqual(f.events, ['lock', 'unlock']);
});

test('browser source verification failure rolls back code without changing runtime IDs', async t => {
    const f = fixture(t), previous = structuredClone(f.agents);
    f.state.changes = [change('explorer/shared/ui/ui-common.css')];
    f.adapters.verifyBrowserFiles = async () => { throw Object.assign(Error('mismatch'), {
        code: 'QA_UPDATE_PUBLIC_ASSET_MISMATCH', operation: 'public-browser-asset',
    }); };
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'passed'
        && error.receipt.operation === 'public-browser-asset');
    assert.deepEqual(f.agents, previous); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
    assert.equal(f.events.some(event => event.startsWith('restart:')), false);
});

test('browser-only update cannot silently change the active route generation', async t => {
    const f = fixture(t), fastForward = f.adapters.fastForward;
    f.state.changes = [change('explorer/shared/ui/ui-common.css')];
    f.adapters.fastForward = (...args) => { fastForward(...args); f.state.generation = 'unexpected-generation'; };
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'failed'
        && error.receipt.code === 'QA_UPDATE_ROUTING_CHANGED');
});

test('shared code restarts all enabled same-repository agents and retains sibling repositories', async t => {
    const f = fixture(t); f.state.changes = [change('shared/network.mjs')];
    const result = await f.service.execute(f.receipt, { expectedCommit: f.state.commit });
    assert.deepEqual(result.agents, ['AchillesIDE/explorer', 'AchillesIDE/gitAgent', 'AchillesIDE/roboTeamAgent']);
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
        await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), { code });
        assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
        assert.deepEqual(f.events, ['lock', 'unlock']); assert.equal(fs.existsSync(f.receipt), false); f.unchangedData();
    });
}

const retiredBox = (f, suffix, overrides = {}) => {
    const retired = structuredClone(f.boxes[0]);
    retired.box = { ...retired.box, id: 'd'.repeat(64), name: `${f.scope.box}${suffix}`, running: false, ...overrides };
    f.boxes.push(retired);
};

test('an update succeeds beside the stopped Boxes a preserving redeploy retained for rollback', async t => {
    const f = fixture(t);
    retiredBox(f, '-rollback-redeploy-AbCd1234');
    retiredBox(f, '-failed-redeploy-AbCd1234', { id: 'c'.repeat(64) });
    const result = await f.service.execute(f.receipt, { expectedCommit: f.state.commit });
    assert.equal(result.status, 'updated');
    f.unchangedData();
});

for (const [name, suffix, overrides] of [
    ['an arbitrary stopped Box', '-old', {}],
    ['a retained Box that is running', '-rollback-redeploy-AbCd1234', { running: true }],
    ['a retained name with a short backup id', '-rollback-redeploy-AbCd123', {}],
]) {
    test(`an update refuses ${name} next to the exact running Box`, async t => {
        const f = fixture(t);
        retiredBox(f, suffix, overrides);
        await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), { code: 'QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED' });
        assert.deepEqual(f.events, ['lock', 'unlock']);
        f.unchangedData();
    });
}

test('uncached unsafe candidate is fetched for inspection but never checked out', async t => {
    const f = fixture(t); f.state.local = false; f.state.changes = [change('explorer/package.json')];
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), { code: 'QA_UPDATE_REQUIRES_RECONFIGURATION' });
    assert.deepEqual(f.events, ['lock', 'fetch', 'unlock']); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
});

test('default branch moving during fetch fails before checkout', async t => {
    const f = fixture(t), fetch = f.adapters.fetch;
    f.adapters.fetch = (...args) => { fetch(...args); f.state.commit = '9'.repeat(40); };
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), { code: 'QA_UPDATE_REMOTE_MOVED' });
    assert.deepEqual(f.events, ['lock', 'fetch', 'unlock']); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
});

test('a command error after completed fast-forward still attempts guarded rollback', async t => {
    const f = fixture(t), fastForward = f.adapters.fastForward;
    f.adapters.fastForward = (...args) => { fastForward(...args); throw Error('command result uncertain'); };
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'passed');
    assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
    assert.deepEqual(f.events, ['lock', 'fetch', 'fast-forward', 'restore', 'unlock']);
});

test('startup failure restores clean previous code and restarts successful and failed touched targets', async t => {
    const f = fixture(t); f.state.changes.push(change('gitAgent/src/index.mjs'));
    f.state.restartFailure = count => count === 2;
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => {
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
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'passed'
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
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'passed');
    assert.equal(f.events.some(event => event.startsWith('recover-route:')), false);
    assert.equal(f.events.filter(event => event === 'restart:explorer').length, 2);
});

test('readiness failure after restart rolls back and remains a failed deployment', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    let count = 0;
    f.adapters.restart = async (...args) => { await restart(...args); if (++count === 1) f.agents[0].ready = false; };
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'passed'
        && error.receipt.code === 'QA_UPDATE_RUNTIME_NOT_READY');
    assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
});

test('dirty candidate refuses automatic source rollback', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    f.adapters.restart = async (...args) => { await restart(...args); f.state.dirty = true; throw Error('failed'); };
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'failed');
    assert.equal(f.events.includes('restore'), false); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, NEXT);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt)).rollbackCode, 'QA_SOURCE_NOT_CLEAN');
});

test('identity drift refuses rollback and never mutates an unrelated source', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    f.adapters.restart = async (...args) => { await restart(...args); f.sourcePins['.runtime/ploinky'].commit = NEXT; };
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'failed'
        && error.receipt.code === 'QA_UPDATE_SOURCE_IDENTITY_CHANGED');
    assert.equal(f.events.includes('restore'), false);
});

test('unexpected target image replacement cannot be accepted or trigger blind recovery', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    f.adapters.restart = async (...args) => { await restart(...args); f.agents[0].image = `sha256:${'0'.repeat(64)}`; };
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'failed'
        && error.receipt.code === 'QA_UPDATE_AGENT_IMAGE_CHANGED');
    assert.equal(f.events.includes('restore'), false);
});

test('changed logical target identity cannot be mistaken for the selected agent', async t => {
    const f = fixture(t), restart = f.adapters.restart;
    f.adapters.restart = async (...args) => { await restart(...args); f.agents[0].instanceId = 'unexpected-selection'; };
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'failed'
        && error.receipt.code === 'QA_UPDATE_SELECTION_CHANGED');
    assert.equal(f.events.includes('restore'), false);
});

test('rollback failure is explicit and retains the original failed status', async t => {
    const f = fixture(t); f.state.restartFailure = () => true;
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.status === 'failed' && error.receipt.rollback === 'failed'
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
    await assert.rejects(f.service.execute(f.receipt, { expectedCommit: f.state.commit }), error => error.receipt.rollback === 'passed'
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

// ---------------------------------------------------------------------------
// Pinned Explorer commit, automatic selection and the Box image comparison.
// ---------------------------------------------------------------------------

const select = (f, options = {}) => f.service.select({ expectedCommit: f.state.commit, ...options });
const noMutation = f => {
    assert.equal(fs.existsSync(f.receipt), false, 'select writes no receipt');
    assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD, 'select never moves the Explorer checkout');
    assert.equal(f.events.some(event => event === 'fast-forward' || event === 'restore' || event.startsWith('restart:')), false);
    f.unchangedData();
};

test('assertRuntimeReady is exported and keeps the readiness contract', () => {
    const agent = { ready: true, id: '1'.repeat(64), image: `sha256:${IMAGE}` };
    assertRuntimeReady({ runtime: { active: true, agents: [agent] } });
    for (const runtime of [
        { active: false, agents: [agent] }, { active: true, agents: [{ ...agent, ready: false }] },
        { active: true, agents: [{ ...agent, id: 'short' }] }, { active: true, agents: [{ ...agent, image: null }] },
    ]) assert.throws(() => assertRuntimeReady({ runtime }), { code: 'QA_UPDATE_RUNTIME_NOT_READY' });
    const adapters = updateProductionAdapters({ workspace: '/nonexistent' });
    for (const name of ['runtime', 'health', 'remoteBoxImage', 'remoteDefault']) assert.equal(typeof adapters[name], 'function', name);
});

test('select chooses in-place for an asset-only Explorer change and records no mutation', async t => {
    const f = fixture(t); f.state.changes = [change('explorer/shared/ui/ui-common.css'), change('docs/architecture.html')];
    const result = await select(f);
    assert.deepEqual(result, { result: 'selected', mode: 'in-place', mutations: 'git-objects-only', expectedCommit: NEXT,
        previousCommit: OLD, boxImage: { reference: 'docker.io/assistos/ploinky-box:latest', current: IMAGE, remote: IMAGE }, reasons: [] });
    assert.deepEqual(f.events, ['lock', 'fetch', 'unlock']);
    noMutation(f);
});

test('select with an unchanged Explorer pin takes the lock but fetches nothing', async t => {
    const f = fixture(t); f.state.commit = OLD; f.state.changes = [];
    const result = await select(f);
    assert.equal(result.mode, 'in-place'); assert.equal(result.mutations, false); assert.deepEqual(result.reasons, []);
    assert.deepEqual(f.events, ['lock', 'unlock']); noMutation(f);
});

test('select proves the pinned Explorer head before the image or any other repository is consulted', async t => {
    const f = fixture(t);
    await select(f);
    assert.deepEqual(f.calls, [`remote:${EXPLORER_SOURCE}`, 'image', 'remote:.ploinky/repos/webmeet', 'remote:.runtime/ploinky',
        'remote:AdvancedLanguageAgent', `remote:${EXPLORER_SOURCE}`, `remote:${EXPLORER_SOURCE}`],
    'pin, image, sources, then the Explorer candidate before and after the fetch');
    const moved = fixture(t);
    await assert.rejects(moved.service.select({ expectedCommit: '9'.repeat(40) }), { code: 'QA_UPDATE_REMOTE_MOVED' });
    assert.deepEqual(moved.calls, [`remote:${EXPLORER_SOURCE}`], 'no image or sibling lookup after a moved Explorer head');
    assert.deepEqual(moved.events, []); noMutation(moved);
});

test('select requires a full pinned commit', async t => {
    for (const expectedCommit of [undefined, '', 'B'.repeat(40), 'b'.repeat(39), `${NEXT}\n`, [NEXT]]) {
        const f = fixture(t);
        await assert.rejects(f.service.select({ expectedCommit }), { code: 'QA_UPDATE_USAGE_INVALID' });
        assert.deepEqual(f.calls, []); assert.deepEqual(f.events, []);
    }
    await assert.rejects(fixture(t).service.select(), { code: 'QA_UPDATE_USAGE_INVALID' });
});

for (const relative of ['.runtime/ploinky', '.ploinky/repos/webmeet', 'AdvancedLanguageAgent']) {
    test(`select redeploys on ${relative} commit drift without fetching`, async t => {
        const f = fixture(t); const pinned = f.sourcePins[relative];
        f.state.remote[relative] = { commit: '8'.repeat(40) };
        const result = await select(f);
        assert.equal(result.mode, 'redeploy'); assert.equal(result.mutations, false);
        assert.deepEqual(result.reasons, [{ source: relative, kind: 'commit', from: pinned.commit, to: '8'.repeat(40) }]);
        assert.deepEqual(f.events, []); noMutation(f);
    });
    test(`select redeploys on ${relative} branch drift without fetching`, async t => {
        const f = fixture(t); const pinned = f.sourcePins[relative];
        f.state.remote[relative] = { branch: 'master' };
        const result = await select(f);
        assert.equal(result.mode, 'redeploy');
        assert.deepEqual(result.reasons, [{ source: relative, kind: 'branch', from: pinned.branch, to: 'master' }]);
        assert.deepEqual(f.events, []); noMutation(f);
    });
}

test('select reports every drifted source, plus the image, and still fetches nothing', async t => {
    const f = fixture(t);
    f.state.remote['.runtime/ploinky'] = { commit: '8'.repeat(40), branch: 'next' };
    f.state.remote.AdvancedLanguageAgent = { commit: '7'.repeat(40) };
    f.state.remoteImage = { reference: 'docker.io/assistos/ploinky-box:latest', configDigest: `sha256:${'9'.repeat(64)}` };
    f.state.changes = [change('explorer/manifest.json')];
    const result = await select(f);
    assert.equal(result.mode, 'redeploy');
    assert.deepEqual(result.reasons.map(reason => `${reason.kind}:${reason.source}`), [
        'image:docker.io/assistos/ploinky-box:latest', 'branch:.runtime/ploinky', 'commit:.runtime/ploinky', 'commit:AdvancedLanguageAgent']);
    assert.deepEqual(result.boxImage, { reference: 'docker.io/assistos/ploinky-box:latest', current: IMAGE, remote: '9'.repeat(64) });
    assert.deepEqual(f.events, [], 'drift wins before the Explorer change is fetched or classified'); noMutation(f);
});

test('select redeploys when the registry config digest differs from the running Box image ID', async t => {
    const f = fixture(t); f.state.remoteImage = { reference: 'docker.io/assistos/ploinky-box:latest', configDigest: '9'.repeat(64) };
    const result = await select(f);
    assert.equal(result.mode, 'redeploy');
    assert.deepEqual(result.reasons, [{ source: 'docker.io/assistos/ploinky-box:latest', kind: 'image', from: IMAGE, to: '9'.repeat(64) }]);
    assert.deepEqual(f.events, []); noMutation(f);
    const same = fixture(t); same.state.remoteImage = { reference: 'docker.io/assistos/ploinky-box:latest', configDigest: `sha256:${IMAGE}` };
    assert.deepEqual((await select(same)).reasons, [], 'a sha256: prefix does not create drift');
});

test('select never queries or compares image-owned AgentLib sources', async t => {
    const f = fixture(t);
    f.state.remote.achillesAgentLib = Error('must not be consulted');
    await select(f);
    assert.deepEqual(f.calls.filter(call => /achillesAgentLib|agentlib/.test(call)), []);
    assert.equal(f.calls.includes('remote:.ploinky/repos/webmeet'), true);
    assert.equal(f.calls.includes('remote:AdvancedLanguageAgent'), true);
    assert.equal(f.calls.includes('remote:.runtime/ploinky'), true);
});

for (const [name, changes, code] of [
    ['a manifest change', [change('explorer/manifest.json')], 'QA_UPDATE_REQUIRES_RECONFIGURATION'],
    ['a dependency change', [change('gitAgent/package-lock.json')], 'QA_UPDATE_REQUIRES_RECONFIGURATION'],
    ['a file outside every agent', [change('unexpected/code.mjs')], 'QA_UPDATE_UNKNOWN_RUNTIME_PATH'],
    ['a file type change', [change('explorer/src/link.js', { newMode: '120000' })], 'QA_UPDATE_FILE_TYPE_CHANGED'],
]) {
    for (const local of [true, false]) {
        test(`select redeploys on ${code} after ${name}${local ? ' (candidate cached)' : ' (objects-only fetch)'}`, async t => {
            const f = fixture(t); f.state.changes = changes; f.state.local = local;
            const result = await select(f);
            assert.equal(result.mode, 'redeploy'); assert.equal(result.mutations, local ? false : 'git-objects-only');
            assert.deepEqual(result.reasons, [{ source: EXPLORER_SOURCE, kind: 'explorer-reconfiguration', from: OLD, to: NEXT, code }]);
            assert.deepEqual(f.events, local ? ['lock', 'unlock'] : ['lock', 'fetch', 'unlock']);
            noMutation(f);
        });
    }
}

for (const [name, setup, code] of [
    ['a non-fast-forward Explorer history', f => { f.state.fastForward = false; }, 'QA_UPDATE_NOT_FAST_FORWARD'],
    ['a non-default Explorer branch', f => { f.sourcePins[EXPLORER_SOURCE].branch = 'topic'; }, 'QA_UPDATE_DEFAULT_BRANCH_REQUIRED'],
    ['a foreign Explorer origin', f => { f.sourcePins[EXPLORER_SOURCE].origin = 'https://github.com/other/repo'; }, 'QA_UPDATE_DEFAULT_BRANCH_REQUIRED'],
    ['a wrong Explorer upstream', f => { f.state.upstream = 'other/main'; }, 'QA_UPDATE_DEFAULT_UPSTREAM_REQUIRED'],
    ['a dirty source', f => { f.state.dirty = true; }, 'QA_SOURCE_NOT_CLEAN'],
    ['a stopped Box', f => { f.boxes[0].box.running = false; }, 'QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED'],
    ['an unrelated stopped Box', f => { retiredBox(f, '-old'); }, 'QA_UPDATE_EXACT_RUNNING_BOX_REQUIRED'],
    ['an ambiguous target', f => { f.agents[0].alias = 'alias'; }, 'QA_UPDATE_TARGET_NOT_UNAMBIGUOUS'],
    ['an unresolvable Box image', f => { f.state.remoteImage = Object.assign(Error('registry'), { code: 'QA_SELECT_IMAGE_UNRESOLVED' }); }, 'QA_SELECT_IMAGE_UNRESOLVED'],
    ['an unsupported Box image reference', f => { f.state.remoteImage = Object.assign(Error('ref'), { code: 'QA_SELECT_IMAGE_REFERENCE_UNSUPPORTED' }); }, 'QA_SELECT_IMAGE_REFERENCE_UNSUPPORTED'],
    ['a malformed registry answer', f => { f.state.remoteImage = { reference: 'docker.io/a/b:c', configDigest: 'not-a-digest' }; }, 'QA_SELECT_IMAGE_UNRESOLVED'],
    ['a failing remote lookup for a non-Explorer repository', f => {
        f.state.remote['.ploinky/repos/webmeet'] = Object.assign(Error('ls-remote'), { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' });
    }, 'QA_UPDATE_EXTERNAL_COMMAND_FAILED'],
    ['a malformed remote default for a non-Explorer repository', f => { f.state.remote.AdvancedLanguageAgent = { commit: 'nothex' }; }, 'QA_UPDATE_REMOTE_DEFAULT_INVALID'],
]) {
    test(`select rejects ${name} instead of choosing a mode`, async t => {
        const f = fixture(t); setup(f);
        await assert.rejects(select(f), { code });
        assert.equal(fs.existsSync(f.receipt), false); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
        assert.equal(f.events.some(event => event === 'fast-forward' || event === 'restore' || event.startsWith('restart:')), false);
        f.unchangedData();
    });
}

test('a failing remote lookup wins over drift found earlier, so a failure is never reported as redeploy', async t => {
    for (const failing of ['.ploinky/repos/webmeet', '.runtime/ploinky', 'AdvancedLanguageAgent']) {
        const f = fixture(t);
        f.state.remoteImage = { reference: 'docker.io/assistos/ploinky-box:latest', configDigest: '9'.repeat(64) };
        for (const drifted of ['.ploinky/repos/webmeet', '.runtime/ploinky', 'AdvancedLanguageAgent']) {
            f.state.remote[drifted] = drifted === failing
                ? Object.assign(Error('ls-remote'), { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' }) : { commit: '8'.repeat(40) };
        }
        await assert.rejects(select(f), { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' }, failing);
        assert.deepEqual(f.events, []);
    }
});

test('a failing Explorer lookup rejects, and the workspace lock is released after a rethrown classification error', async t => {
    const f = fixture(t); f.state.remote[EXPLORER_SOURCE] = Object.assign(Error('ls-remote'), { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' });
    await assert.rejects(select(f), { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' });
    assert.deepEqual(f.events, [], 'nothing is locked or fetched when the pin proof itself fails');
    const g = fixture(t); g.state.fastForward = false;
    await assert.rejects(select(g), { code: 'QA_UPDATE_NOT_FAST_FORWARD' });
    assert.deepEqual(g.events, ['lock', 'unlock']);
});

test('a branch that moves to another head during the objects-only fetch is rejected, not selected', async t => {
    const f = fixture(t), fetch = f.adapters.fetch;
    f.adapters.fetch = (...args) => { fetch(...args); f.state.commit = '9'.repeat(40); };
    await assert.rejects(select(f), { code: 'QA_UPDATE_REMOTE_MOVED' });
    assert.deepEqual(f.events, ['lock', 'fetch', 'unlock']); noMutation(f);
});

test('a head that moves after the pin proof is rejected before it is classified, even when its commit is cached', async t => {
    const f = fixture(t), remoteDefault = f.adapters.remoteDefault;
    f.state.changes = [change('explorer/manifest.json')];
    let explorerLookups = 0;
    f.adapters.remoteDefault = repo => {
        const remote = remoteDefault(repo);
        if (path.relative(f.scope.workspace, repo) !== EXPLORER_SOURCE || explorerLookups++ === 0) return remote;
        return { ...remote, commit: '9'.repeat(40) };
    };
    await assert.rejects(select(f), { code: 'QA_UPDATE_REMOTE_MOVED' });
    assert.deepEqual(f.events, ['lock', 'unlock']); noMutation(f);
});

test('select takes no runtime readiness or health proof, so a running but unhealthy QA can still be redeployed', async t => {
    const f = fixture(t); f.agents[0].ready = false; f.state.healthFailure = 1;
    f.state.remote['.runtime/ploinky'] = { commit: '8'.repeat(40) };
    assert.equal((await select(f)).mode, 'redeploy');
    assert.equal(f.state.healthFailure, 1, 'health was never consulted'); assert.deepEqual(f.events, []);
    f.state.active = false;
    assert.equal((await select(f)).mode, 'redeploy');
});

test('execute refuses a moved Explorer head before the receipt, any fetch or any change', async t => {
    for (const mutate of [() => {}, f => { f.state.commit = OLD; f.state.changes = []; }]) {
        const f = fixture(t); mutate(f);
        await assert.rejects(f.service.execute(f.receipt, { expectedCommit: 'c'.repeat(40) }), { code: 'QA_UPDATE_REMOTE_MOVED' });
        assert.deepEqual(f.events, ['lock', 'unlock']); noMutation(f);
    }
});

test('execute accepts only the pinned head and requires the pin to be supplied', async t => {
    const f = fixture(t);
    const result = await f.service.execute(f.receipt, { expectedCommit: NEXT });
    assert.equal(result.status, 'updated'); assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, NEXT);
    for (const options of [undefined, {}, { expectedCommit: '' }, { expectedCommit: 'B'.repeat(40) }]) {
        const g = fixture(t);
        await assert.rejects(g.service.execute(g.receipt, options), { code: 'QA_UPDATE_USAGE_INVALID' });
        assert.deepEqual(g.events, []); noMutation(g);
    }
});

// --- pure registry resolution ----------------------------------------------

const sha = body => `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
const hex = value => value.slice('sha256:'.length);
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const DOCKER_LIST = 'application/vnd.docker.distribution.manifest.list.v2+json';
const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';

function registryImages() {
    const config = name => sha(`config-${name}`);
    const manifest = (name, mediaType = OCI_MANIFEST) => Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType,
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: config(name), size: 1 }, layers: [] }));
    const bodies = { amd64: manifest('amd64'), arm64: manifest('arm64'), attestation: manifest('attestation'), amd64b: manifest('amd64b') };
    const entry = (name, os, architecture) => ({ mediaType: OCI_MANIFEST, digest: sha(bodies[name]), size: bodies[name].length,
        platform: { os, architecture } });
    const index = (entries, mediaType = OCI_INDEX) => ({ schemaVersion: 2, mediaType, manifests: entries });
    const byDigest = new Map(Object.values(bodies).map(body => [sha(body), body]));
    return { config, bodies, entry, index, byDigest,
        fetchByDigest: async value => { if (!byDigest.has(value)) throw Error('unknown digest'); return byDigest.get(value); } };
}

test('platformConfigDigest picks the one linux/amd64 config from an index that also lists arm64 and attestations', async () => {
    const r = registryImages();
    const root = r.index([r.entry('arm64', 'linux', 'arm64'), r.entry('attestation', 'unknown', 'unknown'), r.entry('amd64', 'linux', 'amd64')]);
    assert.equal(await platformConfigDigest(root, r.fetchByDigest), hex(r.config('amd64')));
    const docker = r.index([r.entry('amd64', 'linux', 'amd64')], DOCKER_LIST);
    assert.equal(await platformConfigDigest(docker, r.fetchByDigest, { os: 'linux', architecture: 'amd64' }), hex(r.config('amd64')));
    assert.equal(await platformConfigDigest(root, r.fetchByDigest, { os: 'linux', architecture: 'arm64' }), hex(r.config('arm64')));
});

test('platformConfigDigest returns the config of a single manifest without any lookup', async () => {
    const r = registryImages();
    for (const mediaType of [OCI_MANIFEST, DOCKER_MANIFEST, undefined]) {
        const doc = { ...JSON.parse(r.bodies.amd64), mediaType };
        assert.equal(await platformConfigDigest(doc, async () => { throw Error('no lookup expected'); }), hex(r.config('amd64')));
    }
});

test('platformConfigDigest rejects ambiguous, missing, mismatched and malformed registry data', async () => {
    const r = registryImages(); const rejected = (root, fetchByDigest = r.fetchByDigest) =>
        assert.rejects(platformConfigDigest(root, fetchByDigest), { code: 'QA_SELECT_IMAGE_UNRESOLVED' });
    await rejected(r.index([r.entry('amd64', 'linux', 'amd64'), r.entry('amd64b', 'linux', 'amd64')]));
    await rejected(r.index([r.entry('arm64', 'linux', 'arm64'), r.entry('attestation', 'unknown', 'unknown')]));
    await rejected(r.index([]));
    // A body that does not hash to the digest it was requested by.
    await rejected(r.index([r.entry('amd64', 'linux', 'amd64')]), async () => r.bodies.arm64);
    await rejected(r.index([r.entry('amd64', 'linux', 'amd64')]), async () => Buffer.alloc(0));
    await rejected(r.index([r.entry('amd64', 'linux', 'amd64')]), async () => '<html>login</html>');
    const html = Buffer.from('<html>not json</html>');
    await rejected(r.index([{ ...r.entry('amd64', 'linux', 'amd64'), digest: sha(html) }]), async () => html);
    // Nested index, wrong media type, missing or malformed config digest, non-sha256 digests.
    const nested = Buffer.from(JSON.stringify(r.index([r.entry('amd64', 'linux', 'amd64')])));
    await rejected(r.index([{ ...r.entry('amd64', 'linux', 'amd64'), digest: sha(nested) }]), async () => nested);
    await rejected({ ...JSON.parse(r.bodies.amd64), mediaType: 'text/html' });
    await rejected({ ...JSON.parse(r.bodies.amd64), config: { digest: 'sha256:short' } });
    await rejected({ ...JSON.parse(r.bodies.amd64), config: undefined });
    await rejected({ ...JSON.parse(r.bodies.amd64), schemaVersion: 1 });
    await rejected(r.index([{ ...r.entry('amd64', 'linux', 'amd64'), digest: 'sha512:abc' }]));
    await rejected(null); await rejected([]); await rejected('{}');
    await rejected({ ...r.index([r.entry('amd64', 'linux', 'amd64')]), config: JSON.parse(r.bodies.amd64).config });
});

// --- production adapter: reference resolution and registry protocol ---------

function registryWorkspace(t, reference = 'docker.io/assistos/ploinky-box:latest') {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-update-image-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    write(path.join(root, '.runtime/ploinky/ploinky-box/constants.mjs'), `
        export const BOX_IMAGE_OVERRIDE_ENV = 'PLOINKY_BOX_IMAGE';
        export function resolveBoxImageReference(env = process.env) {
            const configured = env?.[BOX_IMAGE_OVERRIDE_ENV];
            if (configured === undefined || configured === '') return ${JSON.stringify(reference)};
            return configured;
        }
    `);
    return { workspace: root };
}

function registryServer(overrides = {}) {
    const r = registryImages();
    const root = Buffer.from(JSON.stringify(r.index([r.entry('arm64', 'linux', 'arm64'),
        r.entry('attestation', 'unknown', 'unknown'), r.entry('amd64', 'linux', 'amd64')])));
    const requests = [];
    const respond = (body, init = {}) => new Response(body, { status: 200, ...init });
    const fetchImpl = async (url, options) => {
        requests.push({ url: String(url), options });
        const custom = await overrides.handler?.(String(url), options, { root, r, respond });
        if (custom) return custom;
        if (String(url).startsWith('https://auth.docker.io/token')) return respond(JSON.stringify({ token: 'anonymous-pull-token' }));
        const target = String(url).split('/manifests/')[1];
        if (target === 'latest' || target === sha(root)) return respond(root, { headers: { 'Docker-Content-Digest': sha(root) } });
        if (r.byDigest.has(target)) return respond(r.byDigest.get(target));
        return respond('not found', { status: 404 });
    };
    return { fetchImpl, requests, root, r };
}

const unresolved = { code: 'QA_SELECT_IMAGE_UNRESOLVED' };

test('remoteBoxImage resolves the deployed reference to the linux/amd64 config digest over anonymous, no-redirect, bounded registry calls', async t => {
    const server = registryServer();
    const previous = process.env.PLOINKY_BOX_IMAGE; process.env.PLOINKY_BOX_IMAGE = 'docker.io/evil/other:latest';
    t.after(() => { if (previous === undefined) delete process.env.PLOINKY_BOX_IMAGE; else process.env.PLOINKY_BOX_IMAGE = previous; });
    const adapters = updateProductionAdapters(registryWorkspace(t), { fetch: server.fetchImpl, arch: 'x64' });
    assert.deepEqual(await adapters.remoteBoxImage(), {
        reference: 'docker.io/assistos/ploinky-box:latest', configDigest: hex(server.r.config('amd64')) });
    assert.deepEqual(server.requests.map(request => request.url), [
        'https://auth.docker.io/token?service=registry.docker.io&scope=repository:assistos/ploinky-box:pull',
        'https://registry-1.docker.io/v2/assistos/ploinky-box/manifests/latest',
        `https://registry-1.docker.io/v2/assistos/ploinky-box/manifests/${sha(server.r.bodies.amd64)}`]);
    for (const { options } of server.requests) {
        assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    }
    assert.equal(server.requests[0].options.headers.Authorization, undefined);
    for (const { options } of server.requests.slice(1)) {
        assert.equal(options.headers.Authorization, 'Bearer anonymous-pull-token');
        for (const type of [OCI_INDEX, DOCKER_LIST, OCI_MANIFEST, DOCKER_MANIFEST]) assert.ok(options.headers.Accept.split(', ').includes(type), type);
    }
});

test('remoteBoxImage resolves a digest-pinned reference and a single-manifest image', async t => {
    const single = registryImages().bodies.amd64;
    const reference = `docker.io/assistos/ploinky-box@${sha(single)}`;
    const requests = [];
    const adapters = updateProductionAdapters(registryWorkspace(t, reference), { arch: 'x64', fetch: async url => {
        requests.push(String(url));
        return String(url).includes('/token') ? new Response(JSON.stringify({ access_token: 'pull' })) : new Response(single);
    } });
    assert.deepEqual(await adapters.remoteBoxImage(), { reference, configDigest: hex(JSON.parse(single).config.digest) });
    assert.equal(requests[1], `https://registry-1.docker.io/v2/assistos/ploinky-box/manifests/${sha(single)}`);
    const tampered = updateProductionAdapters(registryWorkspace(t, reference), { arch: 'x64', fetch: async url =>
        String(url).includes('/token') ? new Response(JSON.stringify({ token: 'pull' })) : new Response('{"schemaVersion":2}') });
    await assert.rejects(tampered.remoteBoxImage(), unresolved);
});

for (const [name, handler] of [
    ['a 401 from the token endpoint', (url, _o, { respond }) => url.includes('/token') ? respond('{"token":"anonymous-pull-token"}', { status: 401 }) : null],
    ['a 500 from the token endpoint', (url, _o, { respond }) => url.includes('/token') ? respond('{"token":"anonymous-pull-token"}', { status: 500 }) : null],
    ['a token answer without a token', (url, _o, { respond }) => url.includes('/token') ? respond('{"expires_in":300}') : null],
    ['a token that is not a header-safe string', (url, _o, { respond }) => url.includes('/token') ? respond('{"token":"a\\r\\nX: y"}') : null],
    ['a 401 from the registry', (url, _o, { respond, root }) => url.endsWith('/manifests/latest') ? respond(root, { status: 401 }) : null],
    ['a 500 from the registry', (url, _o, { respond, root }) => url.endsWith('/manifests/latest') ? respond(root, { status: 500 }) : null],
    ['a 500 for the per-platform manifest', (url, _o, { respond, r }) =>
        url.endsWith(sha(r.bodies.amd64)) ? respond(r.bodies.amd64, { status: 500 }) : null],
    ['an HTML answer with status 200', (url, _o, { respond }) => url.includes('/manifests/') ? respond('<html><body>Sign in</body></html>', { headers: { 'Content-Type': 'text/html' } }) : null],
    ['an empty answer', (url, _o, { respond }) => url.includes('/manifests/') ? respond('') : null],
    ['an index without linux/amd64', (url, _o, { respond, r }) => url.endsWith('/manifests/latest')
        ? respond(JSON.stringify(r.index([r.entry('arm64', 'linux', 'arm64'), r.entry('attestation', 'unknown', 'unknown')]))) : null],
    ['two linux/amd64 entries', (url, _o, { respond, r }) => url.endsWith('/manifests/latest')
        ? respond(JSON.stringify(r.index([r.entry('amd64', 'linux', 'amd64'), r.entry('amd64b', 'linux', 'amd64')]))) : null],
    ['a per-platform body that does not hash to its digest', (url, _o, { respond, r }) =>
        url.endsWith(sha(r.bodies.amd64)) ? respond(r.bodies.arm64) : null],
    ['a registry content digest that disagrees with the bytes', (url, _o, { respond, root }) =>
        url.endsWith('/manifests/latest') ? respond(root, { headers: { 'Docker-Content-Digest': sha('other') } }) : null],
    ['a redirect, which fetch rejects under redirect:error', (url) => { if (url.includes('/manifests/')) throw new TypeError('fetch failed'); return null; }],
    ['a timeout', (url) => { if (url.includes('/manifests/')) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); return null; }],
    ['an announced oversized answer', (url, _o, { respond, root }) => url.endsWith('/manifests/latest')
        ? respond(root, { headers: { 'Content-Length': String(4 * 1024 * 1024 + 1) } }) : null],
    ['an oversized answer', (url, _o, { respond }) => url.endsWith('/manifests/latest') ? respond(Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)) : null],
]) {
    test(`remoteBoxImage fails closed on ${name}`, async t => {
        const server = registryServer({ handler });
        const adapters = updateProductionAdapters(registryWorkspace(t), { fetch: server.fetchImpl, arch: 'x64' });
        await assert.rejects(adapters.remoteBoxImage(), error => {
            assert.equal(error.code, 'QA_SELECT_IMAGE_UNRESOLVED'); assert.equal(/anonymous-pull-token|html|Sign in/i.test(error.message), false);
            return true;
        });
    });
}

for (const reference of ['ghcr.io/assistos/ploinky-box:latest', 'docker.io/assistos/ploinky-box', 'docker.io/ploinky-box:latest',
    'docker.io/a/b/c:latest', `docker.io/assistos/ploinky-box:latest@sha256:${'a'.repeat(64)}`, 'docker.io/assistos/ploinky-box@sha256:abc',
    'docker.io/Assistos/ploinky-box:latest', 'localhost:5000/assistos/ploinky-box:latest', 'docker.io/assistos/ploinky-box:']) {
    test(`remoteBoxImage rejects the unsupported image reference ${reference} before any registry call`, async t => {
        const server = registryServer();
        const adapters = updateProductionAdapters(registryWorkspace(t, reference), { fetch: server.fetchImpl, arch: 'x64' });
        await assert.rejects(adapters.remoteBoxImage(), { code: 'QA_SELECT_IMAGE_REFERENCE_UNSUPPORTED' });
        assert.deepEqual(server.requests, []);
    });
}

test('remoteBoxImage needs the amd64 QA host and a readable Ploinky constants module', async t => {
    const server = registryServer();
    await assert.rejects(updateProductionAdapters(registryWorkspace(t), { fetch: server.fetchImpl, arch: 'arm64' }).remoteBoxImage(), unresolved);
    assert.deepEqual(server.requests, []);
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-update-noconstants-')));
    t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
    await assert.rejects(updateProductionAdapters({ workspace: empty }, { fetch: server.fetchImpl, arch: 'x64' }).remoteBoxImage(), unresolved);
    const broken = registryWorkspace(t);
    write(path.join(broken.workspace, '.runtime/ploinky/ploinky-box/constants.mjs'), 'export const x = 1;');
    await assert.rejects(updateProductionAdapters(broken, { fetch: server.fetchImpl, arch: 'x64' }).remoteBoxImage(), unresolved);
    const throwing = registryWorkspace(t);
    write(path.join(throwing.workspace, '.runtime/ploinky/ploinky-box/constants.mjs'),
        'export function resolveBoxImageReference() { throw new TypeError("bad"); }');
    await assert.rejects(updateProductionAdapters(throwing, { fetch: server.fetchImpl, arch: 'x64' }).remoteBoxImage(), unresolved);
    assert.deepEqual(server.requests, []);
});

test('the production remote default reads a real origin and fails when ls-remote fails', t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-update-remote-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (cwd, ...args) => {
        const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    const origin = path.join(root, 'origin.git'), clone = path.join(root, 'clone');
    fs.mkdirSync(origin); git(origin, 'init', '--bare', '-b', 'trunk');
    fs.mkdirSync(clone); git(clone, 'init', '-b', 'trunk'); git(clone, 'config', 'user.name', 'Test'); git(clone, 'config', 'user.email', 't@example.invalid');
    write(path.join(clone, 'a.txt'), 'a'); git(clone, 'add', '.'); git(clone, 'commit', '-m', 'Initial');
    git(clone, 'remote', 'add', 'origin', origin); git(clone, 'push', 'origin', 'trunk');
    const adapters = updateProductionAdapters();
    assert.deepEqual(adapters.remoteDefault(clone), { branch: 'trunk', commit: git(clone, 'rev-parse', 'HEAD') });
    git(clone, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
    assert.throws(() => adapters.remoteDefault(clone), { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' });
});

// --- command line ------------------------------------------------------------

test('command line usage: select and execute need the pinned commit and the held-lock flag, in order', () => {
    assert.deepEqual(parseArguments(['plan']), { mode: 'plan' });
    assert.deepEqual(parseArguments(['select', '--expected-commit', NEXT, '--lock-held']), { mode: 'select', expectedCommit: NEXT });
    assert.deepEqual(parseArguments(['execute', '--receipt', '/tmp/r/update.json', '--expected-commit', NEXT, '--lock-held']),
        { mode: 'execute', receipt: '/tmp/r/update.json', expectedCommit: NEXT });
    for (const argv of [[], ['select'], ['select', '--expected-commit', NEXT], ['select', '--lock-held', '--expected-commit', NEXT],
        ['select', '--expected-commit', NEXT.toUpperCase(), '--lock-held'], ['select', '--expected-commit', NEXT.slice(1), '--lock-held'],
        ['select', '--expected-commit', NEXT, '--lock-held', 'extra'], ['plan', '--lock-held'],
        ['execute', '--receipt', '/tmp/r/update.json', '--lock-held'],
        ['execute', '--receipt', '/tmp/r/update.json', '--expected-commit', NEXT],
        ['execute', '--receipt', '', '--expected-commit', NEXT, '--lock-held'],
        ['execute', '--expected-commit', NEXT, '--receipt', '/tmp/r/update.json', '--lock-held'],
        ['restart', '--expected-commit', NEXT, '--lock-held']]) {
        assert.throws(() => parseArguments(argv), { code: 'QA_UPDATE_USAGE_INVALID' }, JSON.stringify(argv));
    }
});

test('command line failures print a safe rejection and exit 1, never the redeploy or fresh-install statuses', () => {
    const script = fileURLToPath(new URL('../../../.github/scripts/update-explorer-qa.mjs', import.meta.url));
    for (const args of [[], ['select'], ['select', '--expected-commit', NEXT], ['execute', '--receipt', '/tmp/x', '--lock-held']]) {
        const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1); assert.deepEqual(JSON.parse(result.stdout), { result: 'failed', status: 'rejected', code: 'QA_UPDATE_USAGE_INVALID' });
    }
    if (process.platform !== 'linux' || os.userInfo().username !== 'admin') {
        // Valid usage still stops on a non-QA host before any lock or runtime access.
        const hosted = spawnSync(process.execPath, [script, 'select', '--expected-commit', NEXT, '--lock-held'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(hosted.status, 1); assert.equal(JSON.parse(hosted.stdout).code, 'QA_HOST_INVALID');
    }
});

test('main validates usage before touching a host', async () => {
    await assert.rejects(main(['select']), { code: 'QA_UPDATE_USAGE_INVALID' });
});

test('the held-lock probe passes only when the host lock is busy', () => {
    const calls = [];
    const probe = result => assertHostLockHeld('/fixture.lock', (...args) => { calls.push(args); return result; });
    probe({ status: 75 });
    assert.deepEqual(calls[0].slice(0, 2), ['flock', ['-n', '-E', '75', '/fixture.lock', 'true']]);
    for (const result of [{ status: 0 }, { status: 1 }, { status: null }, { status: 75, error: Error('spawn') }]) {
        assert.throws(() => probe(result), { code: 'QA_UPDATE_HOST_LOCK_REQUIRED' });
    }
});
