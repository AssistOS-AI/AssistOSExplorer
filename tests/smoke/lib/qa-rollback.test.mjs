import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    ACCOUNT_CAPABILITY, accountCapability, createRollbackService, enableArguments,
    productionAdapters, restorePriorSelections, sanitizeBox,
} from '../../../.github/scripts/rollback-explorer-qa.mjs';

const OLD = 'a'.repeat(64), FAILED = 'b'.repeat(64), FRESH = 'c'.repeat(64), IMAGE = 'd'.repeat(64);
const librarySource = '.ploinky/agentlib/generations/' + 'e'.repeat(40) + '-' + 'f'.repeat(12);
const fixtureSource = 'reviewed fixture account preservation implementation';
const fixtureCapabilities = Object.fromEntries(Object.keys(ACCOUNT_CAPABILITY)
    .map(relative => [relative, crypto.createHash('sha256').update(fixtureSource).digest('hex')]));
const fixtureCapability = root => accountCapability(root, fixtureCapabilities);
const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
};

function fixture(t, { predecessor = true, supported = true } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rollback-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scope = { workspace: path.join(root, 'workspace'), backups: path.join(root, 'backups'),
        lock: path.join(root, 'lock'), box: 'ploinky-box-qa-7a31ab7775eb', hash: '7a31ab7775eb' };
    const backup = path.join(scope.backups, 'redeploy-12345678');
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const relative of ['.runtime/ploinky', '.ploinky/repos/AchillesIDE', 'AdvancedLanguageAgent', librarySource]) {
        write(path.join(scope.workspace, relative, '.source-pin'), 'e'.repeat(40));
    }
    for (const relative of Object.keys(ACCOUNT_CAPABILITY)) {
        write(path.join(scope.workspace, '.runtime/ploinky', relative), fixtureSource);
    }
    if (!supported) write(path.join(scope.workspace, '.runtime/ploinky/cli/utils/agents.js'), 'old unsafe seeding');
    write(path.join(scope.workspace, '.env'), 'PRESERVED="literal bytes"\n');
    write(path.join(scope.workspace, '.ploinky/master-key'), 'saved seed\n');
    write(path.join(scope.workspace, '.ploinky/passwords.enc'), 'opaque saved accounts including empty route selection\n');
    write(path.join(scope.workspace, '.ploinky/.secrets'), 'paired encrypted selected tunnel credentials\n');
    write(path.join(scope.workspace, '.ploinky/data/dpuAgent/data'), 'durable application data');
    write(path.join(scope.workspace, '.ploinky/data/router-security/revocations'), 'preserved revocations');
    for (const relative of ['running/watchdog', 'run/runtime-transaction', 'box/descriptor', 'data/edge-routing/selector', 'data/edge-publication/lease']) {
        write(path.join(scope.workspace, '.ploinky', relative), 'old generated identifier');
    }
    write(path.join(scope.workspace, 'authored/source.txt'), 'local authored data');
    write(path.join(scope.workspace, '.ploinky/operator-private-settings.json'), 'operator-owned unknown state');
    write(path.join(scope.workspace, '.ploinky/edge-desired.json'), {
        hosts: { 'explorer-qa.axiologic.dev': { agent: 'AchillesIDE/explorer',
            routerSurfaces: ['browser-auth', 'agent-mcp', 'user-admin', 'workspace-assets', 'blob-transfer', 'marketplace-ui', 'webchat', 'webtty'] } },
        cloudflare: { tunnelId: '89dd05b5-05a7-4bd4-9626-ec4343b07c67',
            tunnelTokenSecret: 'publication/explorer-qa-tunnel', apiTokenSecret: 'publication/explorer-qa-api' },
        media: { publicIPv4: '45.136.70.141', addressMode: 'direct' },
    });
    const registry = { explorer: { type: 'agent', runtime: 'podman', containerId: OLD,
        repoName: 'AchillesIDE', agentName: 'explorer', auth: { mode: 'local' }, runMode: 'isolated', profile: 'default' } };
    write(path.join(scope.workspace, '.ploinky/agents.json'), registry);
    const raw = id => ({ Id: id, Image: `sha256:${IMAGE}`, Name: scope.box,
        Config: { User: 'podman', Labels: { 'io.assistos.ploinky-box.path-hash': scope.hash,
            'io.assistos.ploinky-box.role': 'box', 'io.assistos.ploinky-box.image-ref': `example.test/box@sha256:${IMAGE}` } },
        HostConfig: { Privileged: false, Init: true, PortBindings: {
            '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8097' }],
        } }, State: { Running: true }, Mounts: [
            { Source: scope.workspace, Destination: '/workspace', RW: true, Type: 'bind' },
            { Source: path.join(scope.workspace, '.runtime/ploinky'), Destination: '/opt/ploinky', RW: false, Type: 'bind' },
            { Source: path.join(scope.workspace, librarySource), Destination: '/opt/ploinky-agentlib', RW: false, Type: 'bind' },
        ] });
    const box = id => ({ engine: 'podman', box: sanitizeBox(raw(id), scope) });
    const boxes = predecessor ? [box(OLD)] : [];
    const events = [];
    let held = false;
    const adapters = {
        assertHost() {}, machineId: () => 'machine-fixture', accountCapability: fixtureCapability,
        sourcePin: directory => ({ commit: fs.readFileSync(path.join(directory, '.source-pin'), 'utf8'), branch: 'main', origin: 'fixture' }),
        boxes: () => structuredClone(boxes), imageId: () => IMAGE, checkPrerequisites() {},
        async acquireWorkspaceLock() {
            assert.equal(held, false); held = true; events.push('lock');
            return { release() { if (held) { held = false; events.push('unlock'); } } };
        },
        async quiesce(item) { assert.equal(held, true); events.push(`quiesce:${item.box.id}`); },
        stop(item) { assert.equal(held, true); events.push(`stop:${item.box.id}`); boxes.find(row => row.box.id === item.box.id).box.running = false; },
        rename(item, name) { assert.equal(held, true); events.push(`rename:${item.box.id}`); boxes.find(row => row.box.id === item.box.id).box.name = name; },
        copy(from, to) { assert.equal(held, true); events.push('copy:' + path.relative(scope.workspace, to)); fs.cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true }); },
        async prepare() {
            assert.equal(held, false); events.push('prepare');
            for (const relative of ['agents.json', 'running', 'run', 'box', 'data/edge-routing', 'data/edge-publication', 'data/router-security']) {
                assert.equal(fs.existsSync(path.join(scope.workspace, '.ploinky', relative)), false, relative);
            }
            const fresh = box(FRESH); boxes.push(fresh); return structuredClone(fresh);
        },
        async initialize() {
            events.push('initialize');
            assert.equal(fs.existsSync(path.join(scope.workspace, '.ploinky/data/router-security')), false);
            write(path.join(scope.workspace, '.ploinky/data/edge-routing/selector'), 'fresh generation');
            // Durable security is copied after the Box lock has been released for supervisor startup.
            adapters.copy = (from, to) => { events.push('restore-policy'); fs.cpSync(from, to, { recursive: true }); };
        },
        async start(_item, authority) {
            events.push('start');
            assert.equal(fs.readFileSync(path.join(scope.workspace, '.ploinky/data/router-security/revocations'), 'utf8'), 'preserved revocations');
            assert.equal(authority.agents[0].auth, 'local');
            write(path.join(scope.workspace, '.ploinky/agents.json'), { ...registry, explorer: { ...registry.explorer, containerId: FRESH } });
        },
        async ready() { events.push('ready'); return { ready: true, generation: 'fresh', count: 1 }; },
    };
    const service = createRollbackService(adapters, scope);
    const candidate = () => {
        fs.renameSync(scope.workspace, path.join(backup, 'workspace'));
        boxes[0].box.name += '-rollback-' + path.basename(backup); boxes[0].box.running = false;
        write(path.join(scope.workspace, 'failed-state'), 'failed generation retained');
        boxes.push(box(FAILED));
    };
    return { root, scope, backup, service, adapters, boxes, events, raw, candidate };
}

test('account capability compares every reviewed file and fails closed for missing code', t => {
    const f = fixture(t);
    assert.equal(fixtureCapability(f.scope.workspace), true);
    assert.equal(accountCapability(f.scope.workspace), false, 'fixture implementation cannot authorize production recovery');
    fs.unlinkSync(path.join(f.scope.workspace, '.runtime/ploinky/cli/utils/security/passwordStoreLock.mjs'));
    assert.equal(fixtureCapability(f.scope.workspace), false);
});

test('capture records unsupported prior code, but plan/execute refuse before mutation', async t => {
    const f = fixture(t, { supported: false });
    const receipt = f.service.capture(f.backup);
    assert.equal(receipt.rollbackSupported, false);
    assert.equal(receipt.rollbackCode, 'QA_PRIOR_CREDENTIAL_RUNTIME_UNSUPPORTED');
    await assert.rejects(f.service.execute(f.backup, 'absent'), { code: receipt.rollbackCode });
    assert.deepEqual(f.events, []);
    assert.deepEqual(fs.readdirSync(f.backup).sort(), ['prior-containers.txt', 'rollback-authority.json']);
});

test('cold capture is supported, but no predecessor rollback is fabricated', async t => {
    const f = fixture(t, { predecessor: false });
    assert.equal(f.service.capture(f.backup).rollbackSupported, true);
    await assert.rejects(f.service.execute(f.backup, 'absent'), { code: 'QA_NO_PREDECESSOR' });
    assert.deepEqual(f.events, []);
});

for (const current of ['absent', FAILED]) {
    test(`recovery reconstructs fresh runtime state while retaining coherent source, key and data (${current === 'absent' ? 'early copy failure' : 'failed candidate'})`, async t => {
        const f = fixture(t);
        f.service.capture(f.backup);
        if (current !== 'absent') f.candidate();
        const receipt = await f.service.execute(f.backup, current);
        assert.equal(receipt.result, 'recovered'); assert.equal(receipt.recoveryBoxId, FRESH);
        assert.equal(receipt.browserAcceptance, 'not-run');
        for (const relative of ['.env', '.ploinky/master-key', '.ploinky/passwords.enc', '.ploinky/.secrets',
            'authored/source.txt', '.ploinky/data/dpuAgent/data', '.ploinky/operator-private-settings.json']) {
            assert.deepEqual(fs.readFileSync(path.join(f.scope.workspace, relative)), fs.readFileSync(path.join(f.backup, 'workspace', relative)));
        }
        assert.equal(f.boxes.find(item => item.box.id === OLD).box.running, false);
        if (current !== 'absent') {
            assert.equal(f.boxes.find(item => item.box.id === FAILED).box.running, false);
            assert.equal(fs.readFileSync(path.join(f.backup, 'failed-workspace/failed-state'), 'utf8'), 'failed generation retained');
        }
        assert.ok(f.events.indexOf('initialize') < f.events.indexOf('restore-policy'));
        assert.ok(f.events.indexOf('restore-policy') < f.events.indexOf('start'));
        assert.ok(f.events.indexOf('unlock') < f.events.indexOf('prepare'));
        await assert.rejects(f.service.execute(f.backup, current), { code: 'QA_ROLLBACK_ALREADY_ATTEMPTED' });
    });
}

for (const [name, mutate, code] of [
    ['host identity', f => { f.adapters.machineId = () => 'another-host'; }, 'QA_AUTHORITY_IDENTITY_INVALID'],
    ['source pin', f => write(path.join(f.scope.workspace, '.runtime/ploinky/.source-pin'), 'changed'), 'QA_PREVIOUS_SOURCES_CHANGED'],
    ['saved accounts', f => write(path.join(f.scope.workspace, '.ploinky/passwords.enc'), 'changed'), 'QA_PREVIOUS_AUTH_CHANGED'],
    ['source capability', f => write(path.join(f.scope.workspace, '.runtime/ploinky/cli/utils/agents.js'), 'changed'), 'QA_PRIOR_CREDENTIAL_RUNTIME_UNSUPPORTED'],
    ['image identity', f => { f.adapters.imageId = () => 'f'.repeat(64); }, 'QA_PREVIOUS_IMAGE_CHANGED'],
    ['container identity', f => { f.boxes[0].box.contract = 'changed'; }, 'QA_PREDECESSOR_CHANGED'],
    ['unselected active Box', f => { const other = structuredClone(f.boxes[0]); other.box.id = FAILED; other.box.name += '-foreign'; f.boxes.push(other); }, 'QA_UNSELECTED_ACTIVE_BOX'],
    ['same-workspace Box with unrelated name', f => { const other = structuredClone(f.boxes[0]); other.box.id = FAILED; other.box.name = 'renamed-by-operator'; f.boxes.push(other); }, 'QA_UNSELECTED_ACTIVE_BOX'],
    ['insufficient recovery capacity', f => { f.adapters.checkPrerequisites = () => { throw Object.assign(new Error('no space'), { code: 'QA_RECOVERY_SPACE_INSUFFICIENT' }); }; }, 'QA_RECOVERY_SPACE_INSUFFICIENT'],
    ['workspace inode', f => { fs.renameSync(f.scope.workspace, f.scope.workspace + '-moved'); fs.mkdirSync(f.scope.workspace); }, 'QA_PREVIOUS_WORKSPACE_CHANGED'],
    ['prior exact records', f => write(path.join(f.backup, 'prior-containers.txt'), 'podman|short|guessed'), 'QA_PRIOR_RECORD_CHANGED'],
]) {
    test(`admission rejects changed ${name} without runtime or filesystem mutation`, async t => {
        const f = fixture(t); f.service.capture(f.backup); mutate(f);
        await assert.rejects(f.service.execute(f.backup, 'absent'), { code });
        assert.deepEqual(f.events, []);
        assert.equal(fs.existsSync(path.join(f.backup, 'rollback-result.json')), false);
    });
}

for (const step of ['quiesce', 'stop', 'copy', 'prepare', 'initialize', 'start', 'ready']) {
    test(`failure in ${step} preserves evidence and never reports readiness`, async t => {
        const f = fixture(t); f.service.capture(f.backup); f.candidate();
        f.adapters[step] = () => { throw Object.assign(new Error('safe fixture error'), { code: 'QA_FIXTURE_FAILURE' }); };
        await assert.rejects(f.service.execute(f.backup, FAILED), { code: 'QA_FIXTURE_FAILURE' });
        const receipt = JSON.parse(fs.readFileSync(path.join(f.backup, 'rollback-result.json')));
        assert.equal(receipt.result, 'failed');
        assert.equal(f.boxes.some(item => item.box.id === OLD), true);
        assert.equal(f.boxes.some(item => item.box.id === FAILED), true);
        assert.equal(fs.existsSync(path.join(f.backup, 'workspace/.ploinky/passwords.enc')), true);
        assert.equal(f.events.includes('unlock'), true);
        if (step === 'quiesce' || step === 'stop') assert.equal(fs.existsSync(path.join(f.scope.workspace, 'failed-state')), true);
    });
}

test('missing, short and stale current IDs cannot select a candidate by guessed name', async t => {
    const f = fixture(t); f.service.capture(f.backup); f.candidate();
    for (const id of [undefined, '', 'b'.repeat(12), 'absent', 'f'.repeat(64), OLD]) {
        await assert.rejects(f.service.execute(f.backup, id));
    }
    assert.deepEqual(f.events, []);
});

test('aliases use the supported CLI grammar and keep the prior auth policy', () => {
    assert.deepEqual(enableArguments({ repo: 'AchillesIDE', agent: 'onlyOffice', alias: 'documents', auth: 'local' }),
        ['enable', 'agent', 'AchillesIDE/onlyOffice', 'isolated', '--auth', 'pwd', 'as', 'documents']);
    assert.deepEqual(enableArguments({ repo: 'AchillesIDE', agent: 'onlyOffice', alias: '', auth: 'none' }),
        ['enable', 'agent', 'AchillesIDE/onlyOffice', 'isolated', '--auth', 'none']);
    assert.deepEqual(enableArguments({ repo: 'AchillesIDE', agent: 'webmeetAgent', alias: '', auth: 'guest', runMode: 'global' }),
        ['enable', 'agent', 'AchillesIDE/webmeetAgent', 'global', '--auth', 'guest']);
    assert.deepEqual(enableArguments({ repo: 'AchillesIDE', agent: 'gitAgent', alias: '', auth: 'none', runMode: 'devel', develRepo: 'work' }),
        ['enable', 'agent', 'AchillesIDE/gitAgent', 'devel', 'work', '--auth', 'none']);
});

test('capture retains actual global, guest, embedded-profile and devel selection shapes', t => {
    const f = fixture(t);
    const records = {
        webmeet: { type: 'agent', runtime: 'podman', containerId: OLD, repoName: 'AchillesIDE', agentName: 'webmeetAgent',
            auth: { mode: 'guest' }, profile: 'default', runMode: 'global' },
        git: { type: 'agent', runtime: 'podman', containerId: FAILED, repoName: 'AchillesIDE', agentName: 'gitAgent',
            auth: { mode: 'none' }, profile: 'embedded', runMode: 'global' },
        development: { type: 'agent', runtime: 'podman', containerId: FRESH, repoName: 'AchillesIDE', agentName: 'explorer',
            auth: { mode: 'local' }, profile: 'default', runMode: 'devel', develRepo: 'work' },
    };
    write(path.join(f.scope.workspace, '.ploinky/agents.json'), records);
    f.service.capture(f.backup);
    const captured = JSON.parse(fs.readFileSync(path.join(f.backup, 'rollback-authority.json'))).agents;
    for (const selection of captured) {
        const original = records[selection.name];
        assert.equal(selection.auth, original.auth.mode); assert.equal(selection.runMode, original.runMode);
        assert.equal(selection.profile, original.profile); assert.equal(selection.develRepo, original.develRepo);
    }
});

test('identity is checked again after acquiring the workspace mutation lock', async t => {
    const f = fixture(t); f.service.capture(f.backup);
    const acquire = f.adapters.acquireWorkspaceLock;
    f.adapters.acquireWorkspaceLock = async () => {
        const lock = await acquire();
        f.boxes[0].box.contract = 'drifted while waiting for lock';
        return lock;
    };
    await assert.rejects(f.service.execute(f.backup, 'absent'), { code: 'QA_PREDECESSOR_CHANGED' });
    assert.deepEqual(f.events, ['lock', 'unlock']);
    assert.equal(fs.existsSync(path.join(f.backup, 'rollback-result.json')), false);
});

test('container security and environment fields contribute to the exact immutable contract', t => {
    const f = fixture(t), baseline = f.raw(OLD);
    const expected = sanitizeBox(baseline, f.scope).contract;
    for (const change of [item => { item.HostConfig.SecurityOpt = ['seccomp=unconfined']; },
        item => { item.Config.Env = ['DIFFERENT=secret-not-logged']; }, item => { item.HostConfig.Binds = ['/foreign:/extra']; }]) {
        const changed = structuredClone(baseline); change(changed);
        assert.notEqual(sanitizeBox(changed, f.scope).contract, expected);
    }
});

test('selection replay preserves existing choices and refreshes the registry after each real enable', async () => {
    const selections = [{ name: 'office', repo: 'AchillesIDE', agent: 'onlyOffice', alias: '', auth: 'local', profile: 'default' },
        { name: 'stats', repo: 'UmamiAgent', agent: 'umamiAgent', alias: 'analytics', auth: 'none', profile: 'default' }];
    const registry = {};
    const enabled = [];
    const replay = () => restorePriorSelections({ selections, profile: 'default', readRegistry: async () => registry,
        enable: async args => {
            enabled.push(args);
            // The first enable may register its dependency, so a fresh read must avoid a duplicate second enable.
            for (const selection of selections) registry[selection.name] = { type: 'agent', repoName: selection.repo,
                agentName: selection.agent, alias: selection.alias, profile: selection.profile, auth: { mode: selection.auth } };
        } });
    assert.deepEqual(await replay(), { restored: ['office'] });
    assert.deepEqual(await replay(), { restored: [] });
    assert.equal(enabled.length, 1);
    registry.office.auth.mode = 'none';
    await assert.rejects(replay(), { code: 'QA_SELECTION_POLICY_CHANGED' });
    delete registry.office;
    selections[0].profile = 'custom';
    await assert.rejects(replay(), { code: 'QA_OPTIONAL_PROFILE_UNSUPPORTED' });
});

test('production source admission requires a clean owned Git checkout at its captured origin', t => {
    const f = fixture(t);
    const repo = path.join(f.scope.workspace, '.runtime/ploinky');
    const git = args => {
        const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000,
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
        assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    git(['init', '--initial-branch=main']); git(['remote', 'add', 'origin', 'https://github.com/AssistOS-AI/ploinky.git']);
    git(['add', '.']); git(['commit', '-m', 'Fixture source']);
    const adapters = productionAdapters(f.scope);
    const pin = adapters.sourcePin(repo);
    assert.equal(pin.commit, git(['rev-parse', 'HEAD'])); assert.equal(pin.branch, 'main');
    write(path.join(repo, 'local-change'), 'uncommitted');
    assert.throws(() => adapters.sourcePin(repo), { code: 'QA_SOURCE_NOT_CLEAN' });
    fs.unlinkSync(path.join(repo, 'local-change'));
    git(['remote', 'set-url', 'origin', 'https://example.test/unreviewed.git']);
    assert.throws(() => adapters.sourcePin(repo), { code: 'QA_SOURCE_ORIGIN_INVALID' });
});

test('exact Box inspection rejects privilege, source-write and publication drift', t => {
    const f = fixture(t);
    for (const change of [item => { item.HostConfig.Privileged = true; }, item => { item.Mounts[1].RW = true; },
        item => { item.HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0'; }, item => { item.Id = 'short'; }]) {
        const raw = f.raw(OLD); change(raw); assert.throws(() => sanitizeBox(raw, f.scope));
    }
});

test('QA Podman empty UDP wildcard is admitted without normalizing the raw identity contract', t => {
    const f = fixture(t), explicit = f.raw(OLD), empty = f.raw(OLD);
    empty.HostConfig.PortBindings['7882/udp'][0].HostIp = '';
    const captured = sanitizeBox(empty, f.scope);
    assert.equal(captured.ports['7882/udp'][0].HostIp, '');
    assert.equal(empty.HostConfig.PortBindings['7882/udp'][0].HostIp, '', 'inspection input must remain unchanged');
    assert.notEqual(captured.contract, sanitizeBox(explicit, f.scope).contract, 'raw publication drift remains detectable');
    for (const address of [undefined, null, '::', '127.0.0.1', '192.0.2.10']) {
        const invalid = f.raw(OLD); invalid.HostConfig.PortBindings['7882/udp'][0].HostIp = address;
        assert.throws(() => sanitizeBox(invalid, f.scope), String(address));
    }
    for (const mutate of [
        raw => { raw.HostConfig.PortBindings['8080/tcp'][0].HostIp = ''; },
        raw => { raw.HostConfig.PortBindings['7882/udp'].push({ HostIp: '', HostPort: '7882' }); },
        raw => { raw.HostConfig.PortBindings['7000/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '7000' }]; },
    ]) {
        const invalid = f.raw(OLD); mutate(invalid); assert.throws(() => sanitizeBox(invalid, f.scope));
    }
});

test('a legacy image tag requires an exact inspected image ID and canonical immutable repository digest', t => {
    const f = fixture(t), raw = f.raw(OLD);
    raw.Config.Labels['io.assistos.ploinky-box.image-ref'] = 'docker.io/assistos/ploinky-box:latest';
    raw.ImageName = raw.Config.Labels['io.assistos.ploinky-box.image-ref'];
    const reference = `docker.io/assistos/ploinky-box@sha256:${'e'.repeat(64)}`;
    const proof = { Id: `sha256:${IMAGE}`, Os: 'linux', Architecture: 'amd64', RepoDigests: [reference] };
    assert.throws(() => sanitizeBox(raw, f.scope), { code: 'QA_IMAGE_NOT_PINNED' });
    const admitted = sanitizeBox(raw, f.scope, proof);
    assert.equal(admitted.imageReference, reference);
    assert.equal(raw.Config.Labels['io.assistos.ploinky-box.image-ref'], 'docker.io/assistos/ploinky-box:latest');
    const explicit = structuredClone(raw); explicit.Config.Labels['io.assistos.ploinky-box.image-ref'] = reference;
    assert.notEqual(admitted.contract, sanitizeBox(explicit, f.scope).contract, 'original tag/config remains in the raw identity digest');
    for (const change of [item => { item.Id = 'f'.repeat(64); }, item => { item.Architecture = 'arm64'; },
        item => { item.Os = 'windows'; }, item => { item.RepoDigests = []; },
        item => { item.RepoDigests = ['docker.io/assistos/ploinky-box:latest']; },
        item => { item.RepoDigests = [`example.test/foreign@sha256:${'e'.repeat(64)}`]; }]) {
        const invalid = structuredClone(proof); change(invalid);
        assert.throws(() => sanitizeBox(raw, f.scope, invalid), { code: 'QA_IMAGE_NOT_PINNED' });
    }
});

test('production routing initialization and readiness pass both selected QA ports to independent Box execs', t => {
    const f = fixture(t), executable = path.join(f.root, 'podman'), record = path.join(f.root, 'exec.jsonl');
    write(executable, `#!${process.execPath}
        const fs = require('node:fs');
        const args = process.argv.slice(2), source = fs.readFileSync(0, 'utf8');
        fs.appendFileSync(process.env.QA_EXEC_RECORD, JSON.stringify({ args, source }) + '\\n');
        for (const entry of ['PLOINKY_WORKSPACE_ROOT=/workspace', 'PLOINKY_ROUTER_HOST_PORT=8097', 'PLOINKY_MEDIA_HOST_PORT=7882']) {
            if (!args.some((value, index) => value === '--env' && args[index + 1] === entry)) process.exit(31);
        }
        process.stdout.write(JSON.stringify({ ready: true, failed: false, generation: 'fixture', count: 1 }));
    `);
    fs.chmodSync(executable, 0o700);
    const helper = new URL('../../../.github/scripts/rollback-explorer-qa.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { productionAdapters } = await import(process.argv[1]);
        const adapters = productionAdapters();
        const item = { engine: 'podman', box: { id: process.argv[2] } };
        await adapters.initialize(item);
        await adapters.ready(item, { agents: [] });
    `, helper, FRESH], { encoding: 'utf8', timeout: 5000, env: { ...process.env,
        PATH: f.root + path.delimiter + process.env.PATH, QA_EXEC_RECORD: record,
        PLOINKY_ROUTER_HOST_PORT: '9000', PLOINKY_MEDIA_HOST_PORT: '9001' } });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.match(calls[0].source, /initializeFreshEdgeRoutingSources/);
    assert.match(calls[1].source, /loadActiveEdgeRoutingGeneration/);
    for (const call of calls) {
        assert.deepEqual(call.args.slice(0, 14), ['container', 'exec', '-i', '--user', 'podman', '--workdir', '/workspace',
            '--env', 'PLOINKY_WORKSPACE_ROOT=/workspace', '--env', 'PLOINKY_ROUTER_HOST_PORT=8097',
            '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', FRESH]);
        assert.equal(call.args.includes('PLOINKY_ROUTER_HOST_PORT=9000'), false);
        assert.equal(call.args.includes('PLOINKY_MEDIA_HOST_PORT=9001'), false);
    }
});

test('the actual CLI refuses a foreign host without showing environment credentials', () => {
    if (process.platform === 'linux' && os.userInfo().username === 'admin' && os.homedir() === '/home/admin') return;
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../.github/scripts/rollback-explorer-qa.mjs', import.meta.url)),
        'execute', '/home/admin/.qa-deployment-backups/redeploy-12345678', '--current-id', FAILED],
    { encoding: 'utf8', env: { ...process.env, SECRET: 'never-log-this' }, timeout: 5000 });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { result: 'failed', code: 'QA_HOST_INVALID' });
    assert.doesNotMatch(result.stdout + result.stderr, /never-log-this/);
});

test('production recovery permits the bounded full graph shutdown without the former three minute cutoff', () => {
    const helper = new URL('../../../.github/scripts/rollback-explorer-qa.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        let calls = 0;
        childProcess.spawnSync = (program, args, options) => {
            calls++;
            assert.equal(program, 'podman');
            assert.equal(options.timeout, 900_000);
            assert(options.timeout > 199_229, 'Measured complete QA shutdown must fit');
            assert.match(options.input, /createProductionAdapters/);
            assert(args.includes('PLOINKY_ROUTER_HOST_PORT=8097'));
            return { status: 0, stdout: JSON.stringify({ result: 'passed' }) };
        };
        syncBuiltinESMExports();
        const { productionAdapters } = await import(process.argv[1]);
        await productionAdapters().quiesce({ engine: 'podman', box: { id: process.argv[2] } });
        assert.equal(calls, 1);
    `, helper, FRESH], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
});
