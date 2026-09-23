import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { classifyChanges, createUpdateService, EXPLORER_SOURCE, updateProductionAdapters } from '../../../.github/scripts/update-explorer-qa.mjs';

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
        enableGeneration: `generation-${index}`, id: String(index + 1).repeat(64), image: `sha256:${IMAGE}`, ready: true,
    }));
    const state = { dirty: false, branch: 'main', commit: NEXT, local: true, fastForward: true,
        active: true, changes: [change('explorer/services/infrastructure/explorerApi.js')],
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
        runtime: async () => ({ agents: structuredClone(agents), active: state.active }),
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
                throw Object.assign(Error('private process output is never reported'), { code: 'QA_UPDATE_EXTERNAL_COMMAND_FAILED' });
            }
            agent.id = (10 + restarts).toString(16).repeat(64);
            agent.image = `sha256:${IMAGE}`; agent.ready = true;
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
    f.state.changes.push(change('gitAgent/IDE-plugins/git-panel/panel.js'), change('webmeetAgent/docs/readme.md'));
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
    await assert.rejects(f.service.execute(f.receipt), error => error.receipt.status === 'failed' && error.receipt.rollback === 'failed');
    assert.equal(f.sourcePins[EXPLORER_SOURCE].commit, OLD);
});

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
    assert.deepEqual(classified, { affected: ['explorer'], shared: false });
    assert.equal(adapters.hasCommit(root, candidate), true); assert.equal(adapters.isAncestor(root, previous, candidate), true);
    adapters.fastForward(root, candidate); assert.equal(git(['rev-parse', 'HEAD']), candidate);
    adapters.restore(root, previous); assert.equal(git(['rev-parse', 'HEAD']), previous);
    assert.equal(fs.existsSync(path.join(root, 'explorer/assets/old.svg')), true);
});
