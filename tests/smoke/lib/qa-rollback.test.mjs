import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolveExplorerGraphOrSkip } from './explorer-graph.mjs';
import {
    assertImageOwnedAgentLib, currentQaBox, EXPECTED_DEFAULT_GRAPH, imageAgentLibSourceId, productionAdapters, sanitizeBox,
    SOURCE_CHECK_SCRIPT, sourcePinFromReport, sourceSandboxArguments,
} from '../../../.github/scripts/rollback-explorer-qa.mjs';
import { writeLockModule } from './qa-fake-lock-modules.mjs';

const OLD = 'a'.repeat(64), FRESH = 'c'.repeat(64), IMAGE = 'd'.repeat(64);
const librarySource = '.ploinky/agentlib/generations/' + 'e'.repeat(40) + '-' + 'f'.repeat(12);
const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
};

function fixture(t, { predecessor = true } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-rollback-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scope = { workspace: path.join(root, 'workspace'), backups: path.join(root, 'backups'),
        lock: path.join(root, 'lock'), box: 'ploinky-box-qa-7a31ab7775eb', hash: '7a31ab7775eb' };
    for (const relative of ['.runtime/ploinky', '.ploinky/repos/AchillesIDE', 'AdvancedLanguageAgent', librarySource]) {
        write(path.join(scope.workspace, relative, '.source-pin'), 'e'.repeat(40));
    }
    const raw = id => ({ Id: id, Image: `sha256:${IMAGE}`, Name: scope.box,
        Config: { User: 'podman', WorkingDir: scope.workspace, Env: [`PLOINKY_WORKSPACE_ROOT=${scope.workspace}`],
            Labels: { 'io.assistos.ploinky-box.path-hash': scope.hash,
            'io.assistos.ploinky-box.role': 'box', 'io.assistos.ploinky-box.image-ref': `example.test/box@sha256:${IMAGE}` } },
        HostConfig: { Privileged: false, Init: true, PortBindings: {
            '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8097' }],
        } }, State: { Running: true }, Mounts: [
            { Source: scope.workspace, Destination: scope.workspace, RW: true, Type: 'bind' },
            { Source: path.join(scope.workspace, '.runtime/ploinky'), Destination: '/opt/ploinky', RW: false, Type: 'bind' },
            { Source: path.join(scope.workspace, librarySource), Destination: '/opt/ploinky-agentlib', RW: false, Type: 'bind' },
            // D6: the mounted checkout is shadowed read-only at its own workspace path, and the
            // Box state directory is masked by its read-only `empty/` directory.
            { Source: path.join(scope.workspace, '.runtime/ploinky'), Destination: path.join(scope.workspace, '.runtime/ploinky'), RW: false, Type: 'bind' },
            { Source: path.join(scope.workspace, '.ploinky-box/empty'), Destination: path.join(scope.workspace, '.ploinky-box'), RW: false, Type: 'bind' },
        ] });
    const box = id => ({ engine: 'podman', box: sanitizeBox(raw(id), scope) });
    const boxes = predecessor ? [box(OLD)] : [];
    return { root, scope, boxes, raw };
}

const AGENTLIB_REPORT = Object.freeze({ schema: 'ploinky.box.library-inspect/v1', library: 'achillesAgentLib',
    packageName: 'ploinky-agent-lib', packageVersion: '1.4.0', provenance: { schema: 'ploinky.box.library/v1',
        library: 'achillesAgentLib', packageName: 'ploinky-agent-lib', packageVersion: '1.4.0',
        repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git', branch: 'master', commit: '9'.repeat(40) } });
const imageSourceId = image => crypto.createHash('sha256')
    .update(JSON.stringify({ kind: 'image', library: 'achillesAgentLib', supplyingImageId: `sha256:${image}` })).digest('hex');

// A Box created by Ploinky with image-owned libraries: the outer image is the
// only AchillesAgentLib identity, so it carries no commit or fingerprint label.
function imageFixture(t) {
    const f = fixture(t);
    const sourceId = imageSourceId(IMAGE);
    const proof = { Id: `sha256:${IMAGE}`, Os: 'linux', Architecture: 'amd64', Config: { User: 'podman' },
        verifiedImageReference: `example.test/box@sha256:${IMAGE}`, referenceImageId: `sha256:${IMAGE}`,
        agentLibInspection: structuredClone(AGENTLIB_REPORT), runtimeAgentLibInspection: structuredClone(AGENTLIB_REPORT) };
    const raw = id => {
        const value = f.raw(id);
        value.Mounts = value.Mounts.filter(mount => mount.Destination !== '/opt/ploinky-agentlib');
        value.Config.Env.push(`PLOINKY_BOX_IMAGE_ID=sha256:${IMAGE}`);
        Object.assign(value.Config.Labels, Object.fromEntries(Object.entries({ mode: 'image',
            'source-id': sourceId, 'source-path': 'image' }).map(([key, data]) => [`io.assistos.ploinky-box.agentlib-${key}`, data])));
        return value;
    };
    fs.rmSync(path.join(f.scope.workspace, librarySource), { recursive: true });
    f.boxes[0] = { engine: 'podman', box: sanitizeBox(raw(OLD), f.scope, proof) };
    return { ...f, rawImage: raw, proof, sourceId };
}

// A Box created by a Ploinky release before image-owned libraries. It remains a
// valid predecessor to capture and roll back, never a current QA Box.
function legacyImageFixture(t) {
    const f = fixture(t);
    const commit = 'e'.repeat(40), fingerprint = 'f'.repeat(64);
    const sourceId = crypto.createHash('sha256').update(`image:sha256:${IMAGE}:${fingerprint}`).digest('hex');
    const proof = { Id: `sha256:${IMAGE}`, Os: 'linux', Architecture: 'amd64', Config: { User: 'podman' },
        verifiedImageReference: `example.test/box@sha256:${IMAGE}`, referenceImageId: `sha256:${IMAGE}`,
        agentLibBundle: { schemaVersion: 1, commit, fingerprint }, runtimeAgentLibBundle: { schemaVersion: 1, commit, fingerprint } };
    const raw = id => {
        const value = f.raw(id);
        value.Mounts = value.Mounts.filter(mount => mount.Destination !== '/opt/ploinky-agentlib');
        Object.assign(value.Config.Labels, Object.fromEntries(Object.entries({ mode: 'image', commit, fingerprint,
            'source-id': sourceId, 'source-path': 'image' }).map(([key, data]) => [`io.assistos.ploinky-box.agentlib-${key}`, data])));
        return value;
    };
    fs.rmSync(path.join(f.scope.workspace, librarySource), { recursive: true });
    f.boxes[0] = { engine: 'podman', box: sanitizeBox(raw(OLD), f.scope, proof) };
    return { ...f, rawImage: raw, proof, commit, fingerprint, sourceId };
}

test('image-owned AgentLib admission binds the exact outer image, its labels and environment, and both actual copies', t => {
    const f = imageFixture(t), raw = f.rawImage(OLD);
    const admitted = sanitizeBox(raw, f.scope, f.proof);
    assert.deepEqual(admitted.agentLib, { mode: 'image', contract: 'image-owned', imageId: `sha256:${IMAGE}`,
        sourceId: f.sourceId, sourceRelativePath: 'image', packageName: 'ploinky-agent-lib', packageVersion: '1.4.0',
        provenance: { repository: 'https://github.com/AssistOS-AI/AchillesAgentLib.git', branch: 'master', commit: '9'.repeat(40) } });
    assert.equal(imageAgentLibSourceId(`sha256:${IMAGE}`), f.sourceId, 'the source identity is Ploinky\'s image-and-library hash');
    assert.equal(admitted.mounts.some(mount => mount.Destination === '/opt/ploinky-agentlib'), false);
    assert.throws(() => sanitizeBox(raw, f.scope), { code: 'QA_AGENTLIB_IMAGE_IDENTITY_INVALID' });
    for (const [label, mutate, code] of [
        ['image ID', proof => { proof.Id = 'a'.repeat(64); }, 'QA_AGENTLIB_IMAGE_IDENTITY_INVALID'],
        ['architecture', proof => { proof.Architecture = 'arm64'; }, 'QA_AGENTLIB_IMAGE_IDENTITY_INVALID'],
        ['OS', proof => { proof.Os = 'windows'; }, 'QA_AGENTLIB_IMAGE_IDENTITY_INVALID'],
        ['user', proof => { proof.Config.User = 'root'; }, 'QA_AGENTLIB_IMAGE_IDENTITY_INVALID'],
        ['reference image', proof => { proof.referenceImageId = 'a'.repeat(64); }, 'QA_AGENTLIB_IMAGE_REFERENCE_CHANGED'],
        ['reference', proof => { proof.verifiedImageReference = `example.test/box@sha256:${'a'.repeat(64)}`; }, 'QA_AGENTLIB_IMAGE_REFERENCE_CHANGED'],
        ['no image probe', proof => { delete proof.agentLibInspection; }, 'QA_AGENTLIB_IMAGE_BUNDLE_INVALID'],
        ['foreign package', proof => { proof.agentLibInspection.packageName = 'other-lib'; }, 'QA_AGENTLIB_IMAGE_BUNDLE_INVALID'],
        ['foreign library', proof => { proof.agentLibInspection.library = 'mcp-sdk'; }, 'QA_AGENTLIB_IMAGE_BUNDLE_INVALID'],
        ['foreign report', proof => { proof.agentLibInspection.schema = 'ploinky.box.library-smoke/v1'; }, 'QA_AGENTLIB_IMAGE_BUNDLE_INVALID'],
        ['empty version', proof => { proof.agentLibInspection.packageVersion = ''; }, 'QA_AGENTLIB_IMAGE_BUNDLE_INVALID'],
        ['no running probe', proof => { delete proof.runtimeAgentLibInspection; }, 'QA_AGENTLIB_RUNTIME_BUNDLE_INVALID'],
        ['running version differs', proof => { proof.runtimeAgentLibInspection.packageVersion = '1.4.1'; }, 'QA_AGENTLIB_RUNTIME_BUNDLE_INVALID'],
        ['running provenance differs', proof => { proof.runtimeAgentLibInspection.provenance.commit = '8'.repeat(40); }, 'QA_AGENTLIB_RUNTIME_BUNDLE_INVALID'],
    ]) {
        const changed = structuredClone(f.proof); mutate(changed);
        assert.throws(() => sanitizeBox(raw, f.scope, changed), { code }, label);
    }
    for (const [key, value] of [['source-id', 'a'.repeat(64)], ['source-path', '.ploinky/agentlib/generations/fake'],
        ['commit', 'a'.repeat(40)], ['fingerprint', 'a'.repeat(64)]]) {
        const changed = structuredClone(raw);
        changed.Config.Labels[`io.assistos.ploinky-box.agentlib-${key}`] = value;
        assert.throws(() => sanitizeBox(changed, f.scope, f.proof), { code: 'QA_AGENTLIB_IMAGE_LABELS_INVALID' }, key);
    }
    for (const [label, mutate] of [
        ['missing', env => env.filter(entry => !entry.startsWith('PLOINKY_BOX_IMAGE_ID='))],
        ['another image', env => env.map(entry => entry.startsWith('PLOINKY_BOX_IMAGE_ID=') ? `PLOINKY_BOX_IMAGE_ID=sha256:${'a'.repeat(64)}` : entry)],
        ['duplicated', env => [...env, `PLOINKY_BOX_IMAGE_ID=sha256:${IMAGE}`]],
    ]) {
        const changed = structuredClone(raw); changed.Config.Env = mutate(changed.Config.Env);
        assert.throws(() => sanitizeBox(changed, f.scope, f.proof), { code: 'QA_AGENTLIB_IMAGE_ID_ENV_INVALID' }, label);
    }
    // Build provenance is diagnostic: an unavailable or malformed record never
    // blocks a usable package, and no commit is compared with anything.
    for (const provenance of [null, { commit: 'master' }]) {
        const changed = structuredClone(f.proof);
        changed.agentLibInspection.provenance = structuredClone(provenance);
        changed.runtimeAgentLibInspection.provenance = structuredClone(provenance);
        assert.equal(sanitizeBox(raw, f.scope, changed).agentLib.provenance, null);
    }
    const unversioned = structuredClone(f.proof);
    unversioned.agentLibInspection.packageVersion = null; unversioned.runtimeAgentLibInspection.packageVersion = null;
    assert.equal(sanitizeBox(raw, f.scope, unversioned).agentLib.packageVersion, null);
    const stopped = structuredClone(raw); stopped.State.Running = false;
    const stoppedProof = structuredClone(f.proof); delete stoppedProof.runtimeAgentLibInspection;
    assert.deepEqual(sanitizeBox(stopped, f.scope, stoppedProof).agentLib, admitted.agentLib,
        'a stopped predecessor retains authority from its separately verified immutable image');
});

test('a retired commit-labelled image predecessor is still admitted by its own sealed verifier', t => {
    const f = legacyImageFixture(t), raw = f.rawImage(OLD);
    const admitted = sanitizeBox(raw, f.scope, f.proof);
    assert.deepEqual(admitted.agentLib, { mode: 'image', imageId: `sha256:${IMAGE}`, commit: f.commit,
        fingerprint: f.fingerprint, sourceId: f.sourceId, sourceRelativePath: 'image' });
    assert.throws(() => assertImageOwnedAgentLib(admitted.agentLib), (error) => error.code === 'QA_AGENTLIB_IMAGE_MODE_REQUIRED'
        && /image mode under the retired commit-labelled contract/.test(error.message));
    for (const mutate of [
        proof => { delete proof.agentLibBundle; },
        proof => { proof.agentLibBundle.commit = 'a'.repeat(40); },
        proof => { proof.agentLibBundle.fingerprint = 'a'.repeat(64); },
        proof => { proof.agentLibBundle.schemaVersion = 2; },
        proof => { delete proof.runtimeAgentLibBundle; },
        proof => { proof.runtimeAgentLibBundle.fingerprint = 'a'.repeat(64); },
    ]) {
        const changed = structuredClone(f.proof); mutate(changed);
        assert.throws(() => sanitizeBox(raw, f.scope, changed));
    }
    for (const [key, value] of [['source-id', 'a'.repeat(64)], ['source-path', '.ploinky/agentlib/generations/fake'],
        ['commit', 'a'.repeat(40)], ['fingerprint', 'a'.repeat(64)]]) {
        const changed = structuredClone(raw);
        changed.Config.Labels[`io.assistos.ploinky-box.agentlib-${key}`] = value;
        assert.throws(() => sanitizeBox(changed, f.scope, f.proof));
    }
    const partial = structuredClone(raw);
    delete partial.Config.Labels['io.assistos.ploinky-box.agentlib-fingerprint'];
    assert.throws(() => sanitizeBox(partial, f.scope, f.proof), { code: 'QA_AGENTLIB_IMAGE_LABELS_INVALID' },
        'a commit label without its fingerprint is neither contract');
});

test('the current QA Box must take AgentLib from its image and names what it found instead', () => {
    for (const [selection, observed] of [
        [null, 'no AgentLib selection'],
        [{ mode: 'local', commit: 'a'.repeat(40) }, 'local mode'],
        [{ mode: 'managed', commit: 'a'.repeat(40) }, 'managed mode'],
        [{ mode: 'image', commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64) }, 'image mode under the retired commit-labelled contract'],
    ]) {
        assert.throws(() => assertImageOwnedAgentLib(selection), (error) => error.code === 'QA_AGENTLIB_IMAGE_MODE_REQUIRED'
            && error.message.includes(`the QA Box uses ${observed}.`)
            && error.message.includes('Remove any achillesAgentLib checkout from the QA workspace')
            && error.message.includes('then redeploy'), observed);
    }
    const selection = { mode: 'image', contract: 'image-owned', imageId: `sha256:${IMAGE}` };
    assert.equal(assertImageOwnedAgentLib(selection), selection);
});

test('image AgentLib rejects mounts shadowing the package, either verifier, provenance or their interpreter', t => {
    for (const make of [imageFixture, legacyImageFixture]) {
        const f = make(t);
        for (const destination of ['/opt/ploinky-agentlib', '/opt/ploinky-agentlib/lib', '/opt', '/',
            '/usr/local/share/ploinky', '/usr/local/share/ploinky/smoke-libraries.mjs',
            '/usr/local/share/ploinky/agentlib', '/usr/local/share/ploinky/agentlib/runtime-contract.json',
            '/usr/local/share/ploinky/agentlib/image-bundle.mjs',
            '/usr/local/share', '/usr/local/bin/node', '/usr/local/bin', '/opt/ploinky/../ploinky-agentlib',
            'relative', '/opt\\ploinky-agentlib']) {
            const raw = f.rawImage(OLD);
            raw.Mounts.push({ Source: '/foreign', Destination: destination, Type: 'bind', RW: false });
            assert.throws(() => sanitizeBox(raw, f.scope, f.proof), { code: 'QA_AGENTLIB_IMAGE_SHADOWED' }, destination);
        }
    }
});

function fakeEngine(t, f) {
    const records = path.join(f.root, 'commands.jsonl'), input = path.join(f.root, 'inspection.json');
    const setInput = (raw, report) => write(input, { raw,
        image: { Id: f.proof.Id, Os: 'linux', Architecture: 'amd64', Config: { User: 'podman' } }, report });
    fs.writeFileSync(path.join(f.root, 'podman'), `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2), data=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'));
fs.appendFileSync(${JSON.stringify(records)},JSON.stringify(args)+'\\n');
if(args[0]==='container'&&args[1]==='ls') console.log(data.raw.Id);
else if(args[0]==='container'&&args[1]==='inspect') console.log(JSON.stringify([data.raw]));
else if(args[0]==='image'&&args[1]==='inspect') console.log(JSON.stringify([data.image]));
else if(args[0]==='run'||(args[0]==='container'&&args[1]==='exec')) console.log(JSON.stringify(data.report));
else process.exit(19);
`, { mode: 0o700 });
    fs.writeFileSync(path.join(f.root, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${f.root}:/usr/bin:/bin`;
    t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
    const calls = () => fs.readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { setInput, calls, reset: () => fs.writeFileSync(records, '') };
}

const SEALED_PROBE_FLAGS = ['--rm', '--network=none', '--pull=never', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--user=podman', '--entrypoint=/usr/local/bin/node'];

test('production verification runs the image\'s own AgentLib probe offline and in the running Box, pinning no commit', async t => {
    const f = imageFixture(t), engine = fakeEngine(t, f);
    engine.setInput(f.rawImage(OLD), AGENTLIB_REPORT);
    const adapters = productionAdapters(f.scope);
    const boxes = adapters.boxes();
    assert.equal(boxes.length, 1);
    assert.deepEqual(await adapters.verifyAgentLib(boxes[0]), boxes[0].box.agentLib);
    assert.equal(boxes[0].box.agentLib.contract, 'image-owned');
    const calls = engine.calls();
    const probes = calls.filter(args => args[0] === 'run');
    assert.ok(probes.length > 0);
    for (const args of probes) {
        for (const flag of [...SEALED_PROBE_FLAGS, '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777']) assert.ok(args.includes(flag), flag);
        assert.deepEqual(args.slice(-4), [IMAGE, '/usr/local/share/ploinky/smoke-libraries.mjs', 'inspect', 'achillesAgentLib']);
        assert.equal(args.some(value => value.startsWith('--volume') || value.startsWith('--mount')), false);
    }
    assert.ok(calls.some(args => args[0] === 'container' && args[1] === 'exec' && args.includes(OLD)
        && args.slice(-3).join(' ') === '/usr/local/share/ploinky/smoke-libraries.mjs inspect achillesAgentLib'));
    assert.equal(calls.flat().some(value => /expected-commit|image-bundle\.mjs/.test(value)), false);
    const shadowed = f.rawImage(OLD);
    shadowed.Mounts.push({ Source: '/foreign', Destination: '/usr/local/bin/node', Type: 'bind', RW: false });
    engine.setInput(shadowed, AGENTLIB_REPORT); engine.reset();
    assert.throws(() => adapters.boxes(), { code: 'QA_AGENTLIB_IMAGE_SHADOWED' });
    assert.equal(engine.calls().some(args => args[0] === 'run' || (args[0] === 'container' && args[1] === 'exec')), false,
        'mount shadowing must reject before executing the alleged verifier');
});

test('production verification refuses a current Box whose AgentLib is not image-owned', async t => {
    const legacy = legacyImageFixture(t), engine = fakeEngine(t, legacy);
    engine.setInput(legacy.rawImage(OLD), legacy.proof.agentLibBundle);
    const adapters = productionAdapters(legacy.scope);
    const [box] = adapters.boxes();
    assert.equal(box.box.agentLib.commit, legacy.commit, 'a retired image Box is still admitted as a predecessor');
    for (const args of engine.calls().filter(call => call[0] === 'run')) {
        assert.deepEqual(args.slice(-5), [IMAGE, '/usr/local/share/ploinky/agentlib/image-bundle.mjs', 'verify', '--expected-commit', legacy.commit],
            'the retired image checks the commit its own label names');
    }
    await assert.rejects(adapters.verifyAgentLib(box), (error) => error.code === 'QA_AGENTLIB_IMAGE_MODE_REQUIRED'
        && /retired commit-labelled contract/.test(error.message));
    const managed = legacy.raw(OLD);
    Object.assign(managed.Config.Labels, Object.fromEntries(Object.entries({ mode: 'managed', commit: 'e'.repeat(40),
        fingerprint: 'f'.repeat(64), 'source-id': 'a'.repeat(64), 'source-path': librarySource })
        .map(([key, data]) => [`io.assistos.ploinky-box.agentlib-${key}`, data])));
    engine.setInput(managed, null);
    const [managedBox] = adapters.boxes();
    await assert.rejects(adapters.verifyAgentLib(managedBox), (error) => error.code === 'QA_AGENTLIB_IMAGE_MODE_REQUIRED'
        && error.message.includes('the QA Box uses managed mode.'));
});

test('the current QA Box is the single running exact-name Box beside only stopped redeploy Boxes', () => {
    const scope = { box: 'ploinky-box-qa-7a31ab7775eb' };
    const row = (name, running, id = 'a') => ({ engine: 'podman', box: { id: id.repeat(64), name, running } });
    const exact = row(scope.box, true);
    assert.equal(currentQaBox([exact], scope), exact);
    assert.equal(currentQaBox([row(`${scope.box}-rollback-redeploy-AbCd1234`, false, 'b'), exact,
        row(`${scope.box}-failed-redeploy-Zy9xW8v7`, false, 'c')], scope), exact);
    for (const [name, rows] of Object.entries({
        'a running retained Box': [exact, row(`${scope.box}-rollback-redeploy-AbCd1234`, true, 'b')],
        'two exact Boxes': [exact, row(scope.box, false, 'b')],
        'no exact Box': [row(`${scope.box}-rollback-redeploy-AbCd1234`, false, 'b')],
        'a stopped exact Box': [row(scope.box, false)],
        'an arbitrarily named stopped Box': [exact, row(`${scope.box}-old`, false, 'b')],
        'a retained Box with a short backup id': [exact, row(`${scope.box}-rollback-redeploy-AbCd123`, false, 'b')],
        'a foreign Box': [exact, row('production', false, 'b')],
    })) {
        assert.throws(() => currentQaBox(rows, scope), { code: 'QA_EXACT_RUNNING_BOX_REQUIRED' }, name);
    }
});

test('container security and environment fields contribute to the exact immutable contract', t => {
    const f = fixture(t), baseline = f.raw(OLD);
    const expected = sanitizeBox(baseline, f.scope).contract;
    for (const change of [item => { item.HostConfig.SecurityOpt = ['seccomp=unconfined']; },
        item => { item.Config.Env = [...item.Config.Env, 'DIFFERENT=secret-not-logged']; }, item => { item.HostConfig.Binds = ['/foreign:/extra']; }]) {
        const changed = structuredClone(baseline); change(changed);
        assert.notEqual(sanitizeBox(changed, f.scope).contract, expected);
    }
});

test('Box admission requires the same-path host workspace mount, working directory and workspace root', t => {
    const f = fixture(t), baseline = f.raw(OLD);
    assert.equal(sanitizeBox(baseline, f.scope).mounts.filter(mount => mount.Destination === f.scope.workspace).length, 1);
    for (const change of [
        item => { item.Mounts.find(mount => mount.Source === f.scope.workspace).Destination = '/workspace'; },
        item => { item.Mounts.push({ Source: f.scope.workspace, Destination: '/workspace', RW: true, Type: 'bind' }); },
        item => { item.Mounts.find(mount => mount.Source === f.scope.workspace).RW = false; },
        item => { item.Config.WorkingDir = '/workspace'; },
        item => { delete item.Config.WorkingDir; },
        item => { item.Config.Env = ['PLOINKY_WORKSPACE_ROOT=/workspace']; },
        item => { item.Config.Env = []; },
        item => { item.Config.Env.push(`PLOINKY_WORKSPACE_ROOT=${f.scope.workspace}`); },
    ]) {
        const changed = structuredClone(baseline); change(changed);
        assert.throws(() => sanitizeBox(changed, f.scope), { code: 'QA_BOX_WORKSPACE_INVALID' });
    }
});

test('the expected default graph matches the direct enable entries of this repository, without any sibling checkout', () => {
    const read = relative => JSON.parse(fs.readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8'));
    const specification = entry => String(typeof entry === 'string' ? entry : entry.agent).split(/\s+/)[0];
    const reference = spec => (spec.includes('/') ? spec : `AchillesIDE/${spec}`);
    const derived = ['AchillesIDE/explorer', ...read('explorer/manifest.json').enable.map(specification).map(reference),
        ...read('userPersistoAgent/manifest.json').enable.map(specification).map(reference)];
    assert.deepEqual([...EXPECTED_DEFAULT_GRAPH].sort(), [...new Set(derived)].sort());
});

test('the expected default graph lists exactly what the Explorer manifests enable', t => {
    const graph = resolveExplorerGraphOrSkip(t);
    if (!graph) return;
    assert.deepEqual([...EXPECTED_DEFAULT_GRAPH].sort(), [...graph.runtimes.keys()].sort());
});

// A fake engine on PATH. `transparent` runs the sandbox script on the host,
// which is safe only for benign fixtures; `canned` returns a fixed report and
// runs nothing. Every invocation is recorded. A fake `git` records any host Git.
function fakeSandboxEngine(root, { mode, report = null, rootless = 'true' }) {
    const bin = path.join(root, 'fake-bin'), record = path.join(root, 'engine.jsonl'), hostGit = path.join(root, 'host-git.jsonl');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'podman'), `#!${process.execPath}
        const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
        const args = process.argv.slice(2), input = args[0] === 'run' ? fs.readFileSync(0, 'utf8') : '';
        fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, input }) + '\\n');
        if (args[0] === 'info') { process.stdout.write(${JSON.stringify(rootless)}); process.exit(0); }
        if (args[0] !== 'run') process.exit(40);
        if (${JSON.stringify(mode)} === 'transparent') {
            const result = spawnSync(process.execPath, ['--input-type=module', '-', args.at(-1)], { input, encoding: 'utf8' });
            process.stdout.write(result.stdout); process.exit(result.status);
        }
        process.stdout.write(${JSON.stringify(JSON.stringify(report))});
    `, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
        require('node:fs').appendFileSync(${JSON.stringify(hostGit)}, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(97);
    `, { mode: 0o700 });
    const calls = () => fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    const hostGitCalls = () => fs.existsSync(hostGit) ? fs.readFileSync(hostGit, 'utf8').trim().split('\n') : [];
    return { bin, calls, hostGitCalls };
}

// Runs production `sourcePin` in a child whose PATH starts with the fake engine.
function productionSourcePin(scope, bin, repo, sandbox) {
    const helper = new URL('../../../.github/scripts/rollback-explorer-qa.mjs', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const { productionAdapters } = await import(process.argv[1]);
        try { process.stdout.write(JSON.stringify({ pin: productionAdapters(JSON.parse(process.argv[2])).sourcePin(process.argv[3], JSON.parse(process.argv[4])) })); }
        catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
    `, helper, JSON.stringify(scope), repo, JSON.stringify(sandbox)], { encoding: 'utf8', timeout: 20000,
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

function gitFixture(repo) {
    const git = args => {
        const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 5000,
            env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } });
        assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
    };
    git(['init', '--initial-branch=main']); git(['remote', 'add', 'origin', 'https://github.com/AssistOS-AI/ploinky.git']);
    git(['add', '.']); git(['commit', '-m', 'Fixture source']);
    return git;
}

test('production source admission requires a clean owned Git checkout at its captured origin, checked only in the sandbox', t => {
    const f = fixture(t);
    const repo = path.join(f.scope.workspace, '.runtime/ploinky');
    const git = gitFixture(repo);
    const engine = fakeSandboxEngine(f.root, { mode: 'transparent' });
    const sandbox = { engine: 'podman', image: IMAGE };
    assert.deepEqual(productionSourcePin(f.scope, engine.bin, repo, sandbox).pin,
        { commit: git(['rev-parse', 'HEAD']), branch: 'main', origin: 'https://github.com/AssistOS-AI/ploinky.git' });
    write(path.join(repo, 'local-change'), 'uncommitted');
    assert.equal(productionSourcePin(f.scope, engine.bin, repo, sandbox).code, 'QA_SOURCE_NOT_CLEAN');
    fs.unlinkSync(path.join(repo, 'local-change'));
    git(['remote', 'set-url', 'origin', 'https://example.test/unreviewed.git']);
    assert.equal(productionSourcePin(f.scope, engine.bin, repo, sandbox).code, 'QA_SOURCE_ORIGIN_INVALID');
    // Without the exact pinned image of a Podman Box nothing runs at all.
    for (const missing of [null, { engine: 'docker', image: IMAGE }, { engine: 'podman', image: 'latest' }]) {
        const before = engine.calls().length;
        assert.equal(productionSourcePin(f.scope, engine.bin, repo, missing).code, 'QA_SOURCE_SANDBOX_UNAVAILABLE');
        assert.equal(engine.calls().length, before);
    }
    assert.deepEqual(engine.hostGitCalls(), [], 'no Git ran in the host process');
});

test('the source sandbox refuses a rootful engine before running any check', t => {
    const f = fixture(t);
    const repo = path.join(f.scope.workspace, '.runtime/ploinky');
    gitFixture(repo);
    const engine = fakeSandboxEngine(f.root, { mode: 'transparent', rootless: 'false' });
    assert.equal(productionSourcePin(f.scope, engine.bin, repo, { engine: 'podman', image: IMAGE }).code, 'QA_SOURCE_SANDBOX_UNAVAILABLE');
    assert.deepEqual(engine.calls().map(call => call.args[0]), ['info']);
});

// E9: Box-written Git configuration never executes on the host.
function fsmonitorFixture(f) {
    const repo = path.join(f.scope.workspace, '.ploinky/repos/AchillesIDE');
    const marker = path.join(f.root, 'fsmonitor-ran-on-host');
    write(path.join(repo, 'README.md'), 'fixture');
    gitFixture(repo);
    const hook = path.join(repo, '.git/fsmonitor-hook');
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    fs.appendFileSync(path.join(repo, '.git/config'), `[core]\n\tfsmonitor = ${hook}\n`);
    return { repo, marker };
}

// The status check exactly as the former host-side sourcePin ran it.
const formerHostStatus = repo => spawnSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, 'status', '--porcelain=v1',
    '--untracked-files=all', '--ignore-submodules=none'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });

test('E9 control: the former host-side status check executes Box-written core.fsmonitor', t => {
    const f = fixture(t), { repo, marker } = fsmonitorFixture(f);
    assert.equal(formerHostStatus(repo).status, 0);
    assert.equal(fs.existsSync(marker), true, 'the fixture triggers: a host-side check runs the hook');
});

test('E9: the sandbox script disables Box-written fsmonitor even where it runs', t => {
    const f = fixture(t), { repo, marker } = fsmonitorFixture(f);
    const result = spawnSync(process.execPath, ['--input-type=module', '-', repo], { input: SOURCE_CHECK_SCRIPT, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status.status, 0, 'the check itself still reports');
    assert.equal(fs.existsSync(marker), false);
});

test('E9: production source admission reports the pin through the sandbox and the host never runs the hook', t => {
    const f = fixture(t), { repo, marker } = fsmonitorFixture(f);
    const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    // The canned report is what the sandbox returns: the engine fake runs nothing.
    const ok = stdout => ({ status: 0, stdout });
    const report = { toplevel: ok(repo + '\n'), status: ok(''), head: ok(head.stdout), origin: ok('https://github.com/AssistOS-AI/ploinky.git\n'), branch: ok('main\n') };
    const engine = fakeSandboxEngine(f.root, { mode: 'canned', report });
    const pin = productionSourcePin(f.scope, engine.bin, repo, { engine: 'podman', image: `sha256:${IMAGE}` }).pin;
    assert.deepEqual(pin, { commit: head.stdout.trim(), branch: 'main', origin: 'https://github.com/AssistOS-AI/ploinky.git' });
    assert.equal(fs.existsSync(marker), false, 'the hook never ran on the host');
    assert.deepEqual(engine.hostGitCalls(), [], 'no Git ran in the host process');
    const run = engine.calls().find(call => call.args[0] === 'run');
    assert.deepEqual(run.args, sourceSandboxArguments(repo, IMAGE));
    for (const flag of ['--rm', '--network=none', '--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--user=1000:1000', `--volume=${repo}:${repo}:ro`]) assert.ok(run.args.includes(flag), flag);
    assert.equal(run.input, SOURCE_CHECK_SCRIPT);
    assert.equal(run.args.filter(arg => arg.startsWith('--volume') || arg.startsWith('--mount') || arg === '-v').length, 1, 'only the repository is mounted');
    assert.equal(run.args.some(arg => /^--(?:privileged|cap-add|device|network=(?!none))/.test(arg)), false);
});

test('E9: a sandbox report that is incomplete or failed is refused with the former host-check codes', () => {
    const repo = '/home/admin/explorerQaWorkspace/.runtime/ploinky';
    const ok = stdout => ({ status: 0, stdout });
    const base = { toplevel: ok(repo), status: ok(''), head: ok('e'.repeat(40)), origin: ok('https://github.com/AssistOS-AI/ploinky.git'), branch: ok('main') };
    assert.deepEqual(sourcePinFromReport(repo, base), { commit: 'e'.repeat(40), branch: 'main', origin: 'https://github.com/AssistOS-AI/ploinky.git' });
    for (const [change, code] of [
        [report => { report.status = { status: 128, stdout: '' }; }, 'QA_EXTERNAL_COMMAND_FAILED'],
        [report => { delete report.head; }, 'QA_EXTERNAL_COMMAND_FAILED'],
        [report => { report.toplevel = ok('/elsewhere'); }, 'QA_SOURCE_NOT_CLEAN'],
        [report => { report.status = ok('?? planted\n'); }, 'QA_SOURCE_NOT_CLEAN'],
        [report => { report.head = ok('HEAD'); }, 'QA_SOURCE_COMMIT_INVALID'],
        [report => { report.origin = ok('https://example.test/x.git'); }, 'QA_SOURCE_ORIGIN_INVALID'],
    ]) {
        const report = structuredClone(base); change(report);
        assert.throws(() => sourcePinFromReport(repo, report), { code });
    }
    assert.throws(() => sourcePinFromReport(repo, null), { code: 'QA_EXTERNAL_COMMAND_FAILED' });
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

test('production readiness passes both selected QA ports to an independent Box exec', t => {
    const f = fixture(t), executable = path.join(f.root, 'podman'), record = path.join(f.root, 'exec.jsonl');
    write(executable, `#!${process.execPath}
        const fs = require('node:fs');
        const args = process.argv.slice(2), source = fs.readFileSync(0, 'utf8');
        fs.appendFileSync(process.env.QA_EXEC_RECORD, JSON.stringify({ args, source }) + '\\n');
        for (const entry of ['PLOINKY_WORKSPACE_ROOT=/home/admin/explorerQaWorkspace', 'PLOINKY_ROUTER_HOST_PORT=8097', 'PLOINKY_MEDIA_HOST_PORT=7882']) {
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
        await adapters.ready(item, { agents: [] });
    `, helper, FRESH], { encoding: 'utf8', timeout: 5000, env: { ...process.env,
        PATH: f.root + path.delimiter + process.env.PATH, QA_EXEC_RECORD: record,
        PLOINKY_ROUTER_HOST_PORT: '9000', PLOINKY_MEDIA_HOST_PORT: '9001' } });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.match(calls[0].source, /loadActiveEdgeRoutingGeneration/);
    for (const call of calls) {
        assert.deepEqual(call.args.slice(0, 14), ['container', 'exec', '-i', '--user', 'podman', '--workdir', '/home/admin/explorerQaWorkspace',
            '--env', 'PLOINKY_WORKSPACE_ROOT=/home/admin/explorerQaWorkspace', '--env', 'PLOINKY_ROUTER_HOST_PORT=8097',
            '--env', 'PLOINKY_MEDIA_HOST_PORT=7882', FRESH]);
        assert.equal(call.args.includes('PLOINKY_ROUTER_HOST_PORT=9000'), false);
        assert.equal(call.args.includes('PLOINKY_MEDIA_HOST_PORT=9001'), false);
    }
});

// D6: every Box must shadow the mounted checkout read-only at its own workspace
// path and mask the Box state directory with its read-only `empty/` directory.
// There is no label or version exception: a Box built by an earlier runtime has
// neither mount and is refused.
const shadowOf = (f, raw) => raw.Mounts.find(mount => mount.Destination === path.join(f.scope.workspace, '.runtime/ploinky'));
const maskOf = (f, raw) => raw.Mounts.find(mount => mount.Destination === path.join(f.scope.workspace, '.ploinky-box'));
const oldRuntimeBox = f => {
    const raw = f.raw(OLD);
    raw.Mounts = raw.Mounts.filter(mount => mount !== shadowOf(f, raw) && mount !== maskOf(f, raw));
    return raw;
};

test('D6: Box identity requires exactly one read-only checkout shadow and one read-only mask of the Box state directory', t => {
    const f = fixture(t);
    assert.equal(sanitizeBox(f.raw(OLD), f.scope).id, OLD);
    for (const [label, change] of [
        ['shadow missing', raw => { raw.Mounts.splice(raw.Mounts.indexOf(shadowOf(f, raw)), 1); }],
        ['shadow writable', raw => { shadowOf(f, raw).RW = true; }],
        ['shadow from another source', raw => { shadowOf(f, raw).Source = path.join(f.scope.workspace, 'elsewhere'); }],
        ['shadow duplicated', raw => { raw.Mounts.push({ ...shadowOf(f, raw) }); }],
        ['shadow not a bind', raw => { shadowOf(f, raw).Type = 'volume'; }],
        ['mask missing', raw => { raw.Mounts.splice(raw.Mounts.indexOf(maskOf(f, raw)), 1); }],
        ['mask writable', raw => { maskOf(f, raw).RW = true; }],
        ['mask from another source', raw => { maskOf(f, raw).Source = path.join(f.scope.workspace, '.ploinky-box'); }],
        ['mask from the old home store', raw => { maskOf(f, raw).Source = '/home/admin/.ploinky-box/empty'; }],
        ['mask duplicated', raw => { raw.Mounts.push({ ...maskOf(f, raw) }); }],
        ['mask not a bind', raw => { maskOf(f, raw).Type = 'volume'; }],
    ]) {
        const raw = f.raw(OLD); change(raw);
        assert.throws(() => sanitizeBox(raw, f.scope), { code: 'QA_BOX_SOURCE_INVALID' }, label);
    }
});

test('Q1: an old-runtime Box (no checkout shadow, no mask) is refused with QA_BOX_SOURCE_INVALID before anything runs in it', t => {
    const f = fixture(t);
    assert.throws(() => sanitizeBox(oldRuntimeBox(f), f.scope), { code: 'QA_BOX_SOURCE_INVALID' });
});

test('Q1: the production Box inspection refuses an old-runtime Box before it executes anything inside it', t => {
    const f = imageFixture(t), engine = fakeEngine(t, f);
    const raw = f.rawImage(OLD);
    engine.setInput(raw, AGENTLIB_REPORT);
    assert.equal(productionAdapters(f.scope).boxes().length, 1, 'the current-runtime Box is admitted');
    raw.Mounts = raw.Mounts.filter(mount => mount !== shadowOf(f, raw) && mount !== maskOf(f, raw));
    engine.setInput(raw, AGENTLIB_REPORT); engine.reset();
    assert.throws(() => productionAdapters(f.scope).boxes(), { code: 'QA_BOX_SOURCE_INVALID' });
    assert.equal(engine.calls().some(args => args[0] === 'run' || (args[0] === 'container' && args[1] === 'exec')), false,
        'the alleged verifier is never executed inside a Box that fails the mount proof');
});

test('production lock adapter imports the deployed runtime\'s lock module and takes its workspace lock with the workspace root', async t => {
    const f = fixture(t);
    const adapters = productionAdapters(f.scope);
    const runtimeRoot = path.join(f.root, 'workspace-runtime');
    const moduleUrl = writeLockModule(runtimeRoot);
    const held = await adapters.acquireWorkspaceLock(runtimeRoot, { workspaceRoot: f.scope.workspace });
    assert.equal(fs.existsSync(path.join(f.scope.workspace, '.ploinky-box/locks/workspace.lock')), true);
    held.assertHeld();
    held.release();
    held.release();
    assert.throws(() => held.assertHeld(), { code: 'QA_WORKSPACE_LOCK_RELEASED' });
    assert.equal(fs.existsSync(path.join(f.scope.workspace, '.ploinky-box/locks/workspace.lock')), false);
    const { calls } = await import(moduleUrl);
    assert.deepEqual(calls.map(call => call.op), ['acquire', 'assertHeld', 'release']);
    assert.deepEqual(calls[0].args, [f.scope.box, { workspaceRoot: f.scope.workspace }]);
    assert.equal(calls[0].args.length, 2, 'the instance and the options, nothing else');
    await assert.rejects(adapters.acquireWorkspaceLock(runtimeRoot, { workspaceRoot: path.join(f.root, 'absent') }),
        { code: 'PLOINKY_BOX_WORKSPACE_ABSENT' });
});

test('the source check reports the upstream from the same sandbox run, never through host Git', t => {
    const f = fixture(t);
    const repo = path.join(f.scope.workspace, '.runtime/ploinky');
    const git = gitFixture(repo);
    const engine = fakeSandboxEngine(f.root, { mode: 'transparent' });
    const helper = new URL('../../../.github/scripts/rollback-explorer-qa.mjs', import.meta.url).href;
    const check = () => {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
            const { productionAdapters } = await import(process.argv[1]);
            process.stdout.write(JSON.stringify(productionAdapters(JSON.parse(process.argv[2])).sourceCheck(process.argv[3], { engine: 'podman', image: process.argv[4] })));
        `, helper, JSON.stringify(f.scope), repo, IMAGE], { encoding: 'utf8', timeout: 20000,
            env: { ...process.env, PATH: engine.bin + path.delimiter + process.env.PATH } });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    };
    assert.equal(check().upstream, null, 'no upstream configured');
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(['branch', '--set-upstream-to=origin/main', 'main']);
    const checked = check();
    assert.equal(checked.upstream, 'origin/main');
    assert.deepEqual(checked.pin, { commit: git(['rev-parse', 'HEAD']), branch: 'main', origin: 'https://github.com/AssistOS-AI/ploinky.git' });
    assert.equal(engine.calls().filter(call => call.args[0] === 'run').length, 2, 'one sandbox run per check');
    assert.deepEqual(engine.hostGitCalls(), []);
});
