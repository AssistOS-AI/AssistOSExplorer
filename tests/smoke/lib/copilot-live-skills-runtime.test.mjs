import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import {
    createLiveSkillsRuntimeReader, normalizeLiveSkillsImageId, program, readLiveSkillsCodeHashes, readLiveSkillsSnapshot,
    readRegistryAndRuntime, validateLiveSkillsRuntimeBinding,
} from './copilot-live-skills-runtime.mjs';
import { createLiveSkillsFixture, liveSkillsHash } from './copilot-live-skills.mjs';

const digest = 'a'.repeat(64);
const files = ['server/copilot-context.mjs', 'server/constants.mjs', 'server/robot-store.mjs',
    'server/live-skill-catalog.mjs', 'server/skill-catalog-api.mjs', 'copilot/src/lib/storage/conversationSessionStore.mjs',
    'copilot/src/lib/skills/robotSkillCatalog.mjs', 'copilot/src/lib/execution/alaEngine.mjs', 'copilot/src/lib/webchat/webchatRuntime.mjs'];

function fixture(t, prefix = 'live-skill-runtime-', repositoryRelative = 'AchillesCLI') {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const repository = path.join(directory, repositoryRelative);
    const source = path.join(repository, 'roboTeamAgent');
    const code = path.join(directory, 'code');
    const expected = {};
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
        const data = `export const selected = ${JSON.stringify(file)};\n`;
        fs.writeFileSync(path.join(source, file), data);
        expected[file] = createHash('sha256').update(data).digest('hex');
    }
    fs.mkdirSync(code);
    // Match stageSourceTreeWithOverrides: directory entries link into the selected agent mount.
    for (const name of ['server', 'copilot']) fs.symlinkSync(path.join(source, name), path.join(code, name), 'dir');
    const descriptors = new Map();
    // macOS has no /proc. Map only its descriptor observation; actual files, symlinks,
    // O_NOFOLLOW reads, inode metadata, and mutations all use the real filesystem.
    const fsApi = { ...fs,
        openSync(file, flags) { const fd = fs.openSync(file, flags); descriptors.set(fd, file); return fd; },
        closeSync(fd) { descriptors.delete(fd); return fs.closeSync(fd); },
        realpathSync(file) {
            if (process.platform !== 'linux' && /^\/proc\/self\/fd\/\d+$/.test(file)) return fs.realpathSync(descriptors.get(Number(path.basename(file))));
            return fs.realpathSync(file);
        },
    };
    return { directory, repository, source, code, expected, fsApi,
        read: (overrides = {}) => readLiveSkillsCodeHashes({ expectedRepository: repository, contractFiles: files }, { codeRoot: code, fsApi, ...overrides }) };
}

test('image identity accepts only the full raw Podman and normalized forms', () => {
    assert.equal(normalizeLiveSkillsImageId(digest), digest);
    assert.equal(normalizeLiveSkillsImageId('sha256:' + digest), digest);
    for (const value of ['', null, undefined, {}, 'sha256:', digest.slice(1), digest + '0', digest.toUpperCase(),
        'sha256:sha256:' + digest, 'SHA256:' + digest, 'sha512:' + digest, ' ' + digest, digest + '\n', 'g'.repeat(64)]) {
        assert.throws(() => normalizeLiveSkillsImageId(value), /complete SHA-256/);
    }
});

// The admitted Box root is the host path itself: the Box mounts the workspace at its own path.
function readerSetup(f, { root = f.directory, image = 'sha256:' + digest } = {}) {
    const startedAt = new Date().toISOString();
    const release = { liveBox: { box: { containerId: 'b'.repeat(64), imageId: digest, startedAt }, workspaceSourceMount: { source: root } },
        repositories: { achillesCLI: { repositoryPath: f.repository } } };
    const codeSource = `${root}/.ploinky/container-runtime/owned-runtime/code-123`;
    fs.mkdirSync(codeSource, { recursive: true });
    fs.mkdirSync(`${root}/.data/roboTeamAgent`, { recursive: true });
    fs.mkdirSync(`${root}/.ploinky/container-runtime/owned-runtime/Agent-1-2`, { recursive: true });
    const runtime = { key: 'owned-runtime', containerId: 'c'.repeat(64), instanceId: randomUUID(), enableGeneration: randomUUID(),
        startedAt, imageId: 'sha256:' + 'd'.repeat(64), mounts: [
            { Type: 'bind', Source: root, Destination: root, RW: true },
            { Type: 'bind', Source: `${root}/.data/roboTeamAgent`, Destination: '/data', RW: true },
            { Type: 'bind', Source: `${f.repository}/roboTeamAgent`, Destination: `${f.repository}/roboTeamAgent`, RW: true },
            { Type: 'bind', Source: codeSource, Destination: '/code', RW: true },
            // Production always emits exactly one read-only staged /Agent and one read-only AgentLib grant.
            { Type: 'bind', Source: `${root}/.ploinky/container-runtime/owned-runtime/Agent-1-2`, Destination: '/Agent', RW: false },
            { Type: 'bind', Source: '/opt/ploinky-agentlib', Destination: '/opt/ploinky-agentlib', RW: false },
        ] };
    const state = { image, nestedReads: 0, programs: [], outerMounts: [{ Type: 'bind', Source: root, Destination: root, RW: true }],
        outerEnv: [`PLOINKY_WORKSPACE_ROOT=${root}`], outerWorkingDir: root };
    const runCommand = async (args, input) => {
        if (args[0] === 'inspect') return [{ Id: release.liveBox.box.containerId, Image: state.image, State: { Running: true, StartedAt: startedAt },
            Config: { Env: state.outerEnv, WorkingDir: state.outerWorkingDir }, Mounts: state.outerMounts }];
        state.nestedReads += 1; state.programs.push(input); return runtime;
    };
    const env = { SMOKE_PLOINKY_BOX_CONTAINER: 'owned-box', SMOKE_BOX_BASE_URL: 'http://127.0.0.1:8080', SMOKE_WORKSPACE_ROOT: root };
    const input = { env, baseURL: 'http://127.0.0.1:8080', verifierPath: '/unused-verifier' };
    return { release, runtime, state, runCommand, input,
        create: () => createLiveSkillsRuntimeReader(input, { collectRelease: async () => release, runCommand }) };
}

test('actual reader setup accepts prefixed Podman identity and rejects a different or invalid image', async t => {
    const f = fixture(t);
    const setup = readerSetup(f);
    const reader = await setup.create();
    assert.equal(setup.state.nestedReads, 1);
    assert.equal(reader.workspaceRoot, f.directory, 'The reader must expose the admitted root before any fixture exists.');
    for (const image of ['sha256:' + 'e'.repeat(64), 'bad', 'sha256:' + digest + '\n']) {
        setup.state.image = image;
        await assert.rejects(setup.create());
        assert.equal(setup.state.nestedReads, 1, 'Invalid outer identity must fail before entering a nested runtime.');
    }
});

test('primary: the reader admits a canonical same-path workspace containing a space and Unicode', async t => {
    const f = fixture(t, 'fresh workspace ü ');
    assert.match(f.directory, / ü /);
    const setup = readerSetup(f);
    const reader = await setup.create();
    assert.equal(reader.workspaceRoot, f.directory);
    assert.equal(setup.state.nestedReads, 1);
});

test('code symlink tree hashes every exact selected source file', async t => {
    const f = fixture(t);
    assert.notEqual(fs.realpathSync(path.join(f.code, files[0])), path.join(f.code, files[0]), 'Fixture reproduces the rejected legitimate /code layout.');
    assert.deepEqual(await f.read(), f.expected);
});

for (const [name, mutate] of Object.entries({
    'copied runtime bytes': f => {
        fs.unlinkSync(path.join(f.code, 'server')); fs.cpSync(path.join(f.source, 'server'), path.join(f.code, 'server'), { recursive: true });
    },
    'different repository with identical bytes': f => {
        fs.cpSync(path.join(f.source, 'server'), path.join(f.directory, 'other-server'), { recursive: true });
        fs.unlinkSync(path.join(f.code, 'server')); fs.symlinkSync(path.join(f.directory, 'other-server'), path.join(f.code, 'server'));
    },
    'another contract file in the same repository': f => {
        fs.unlinkSync(path.join(f.code, 'server')); fs.mkdirSync(path.join(f.code, 'server'));
        fs.symlinkSync(path.join(f.source, files[1]), path.join(f.code, files[0]));
    },
    'symlinked source file': f => {
        fs.renameSync(path.join(f.source, files[0]), path.join(f.directory, 'external.mjs'));
        fs.symlinkSync(path.join(f.directory, 'external.mjs'), path.join(f.source, files[0]));
    },
    'hardlinked source file': f => { fs.linkSync(path.join(f.source, files[0]), path.join(f.directory, 'alias.mjs')); },
    'missing contract file': f => { fs.unlinkSync(path.join(f.source, files[0])); },
})) {
    test(`code observer rejects ${name}`, async t => {
        const f = fixture(t); mutate(f); await assert.rejects(f.read());
    });
}

test('code observer rejects a link retargeted during the open file read', async t => {
    const f = fixture(t);
    const original = f.fsApi.readFileSync;
    f.fsApi.readFileSync = fd => {
        const data = original(fd);
        fs.cpSync(path.join(f.source, 'server'), path.join(f.directory, 'other-server'), { recursive: true });
        fs.unlinkSync(path.join(f.code, 'server')); fs.symlinkSync(path.join(f.directory, 'other-server'), path.join(f.code, 'server'));
        return data;
    };
    await assert.rejects(f.read(), /Runtime contract link changed/);
});

test('code observer rejects source mutation during the read', async t => {
    const f = fixture(t);
    const original = f.fsApi.readFileSync;
    f.fsApi.readFileSync = fd => { const data = original(fd); fs.appendFileSync(path.join(f.source, files[0]), '// changed\n'); return data; };
    await assert.rejects(f.read(), /changed during its read/);
});

test('code observer rejects empty, duplicate and escaping contract paths', async t => {
    const f = fixture(t);
    for (const contractFiles of [[], [files[0], files[0]], ['../outside.mjs'], ['/outside.mjs'], ['server/./constants.mjs'], ['server//constants.mjs']]) {
        await assert.rejects(readLiveSkillsCodeHashes({ expectedRepository: f.repository, contractFiles }, { codeRoot: f.code, fsApi: f.fsApi }));
    }
});

// ---------------------------------------------------------------------------------------------------------
// Same-path mount policy. Every case is built from the exact tuples Ploinky's production mount builder emits.
// ---------------------------------------------------------------------------------------------------------
const bindMount = (Source, Destination, RW = true) => ({ Type: 'bind', Source, Destination, RW });

function mountCase(t, { prefix = 'live skill ü mounts ', repositoryRelative = 'AchillesCLI' } = {}) {
    const f = fixture(t, prefix, repositoryRelative);
    const setup = readerSetup(f);
    const root = f.directory;
    const stage = `${root}/.ploinky/container-runtime/owned-runtime`;
    fs.mkdirSync(`${stage}/Agent-1-2`, { recursive: true });
    fs.mkdirSync(`${root}/.ploinky/data`, { recursive: true });
    const runtime = structuredClone(setup.runtime);
    const validate = (value = runtime, options = {}) => validateLiveSkillsRuntimeBinding(value, f.repository, { workspaceRoot: root, fsApi: fs, ...options });
    return { f, setup, root, stage, runtime, validate, source: `${f.repository}/roboTeamAgent`,
        clone: mutate => { const value = structuredClone(runtime); mutate(value); return value; } };
}

test('runtime mounts accept the exact production tuples, including a space and Unicode root', t => {
    const c = mountCase(t);
    assert.equal(c.validate(), c.runtime);
    const full = c.clone(value => value.mounts.push(
        // Binds that exist in production but lie outside every path the evidence reads.
        bindMount(`${c.root}/.ploinky/shared`, '/shared'),
        bindMount(`${c.root}/.ploinky/probe/owned-runtime`, '/run/ploinky-health-probes'),
        bindMount(`${c.root}/.ploinky/home/roboTeamAgent`, '/root'),
        bindMount('/tmp/ploinky-runtime-guards/0123456789abcdef01234567/data', `${c.root}/.ploinky/data`, false),
        bindMount(`${c.root}/.ploinky/data/edge-topology`, '/run/ploinky-edge-topology', false),
        bindMount('/opt/ploinky-agentlib', `${c.root}/achillesAgentLib`, false),
        bindMount(`${c.root}/.ploinky/deps/store/abc/node_modules`, `${c.root}/.ploinky/deps/store/abc/node_modules`, false),
        bindMount(`${c.root}/AdvancedLanguageAgent`, `${c.root}/AdvancedLanguageAgent`),
    ));
    assert.equal(c.validate(full), full);
});

test('the read-only controller pin is accepted only for a source that lives below it, and only as an exact read-only self bind', t => {
    const c = mountCase(t, { repositoryRelative: '.ploinky/repos/AchillesCLI' });
    const pin = path.join(c.root, '.ploinky');
    const pinned = c.clone(value => value.mounts.push(bindMount(pin, pin, false)));
    assert.equal(c.validate(pinned), pinned);
    assert.throws(() => c.validate(c.clone(value => value.mounts.push(bindMount(pin, pin, true)))), /read-only/);
    assert.throws(() => c.validate(c.clone(value => value.mounts.push(bindMount(`${c.root}/elsewhere`, pin, false)))), /exact verified/);
    assert.throws(() => c.validate(c.clone(value => value.mounts.push(bindMount(pin, pin, false), bindMount(pin, pin, false)))), /exact verified/);
    // Without the pin the same source is still fully valid: the pin is production hardening, not a requirement.
    assert.equal(c.validate(), c.runtime);
});

for (const [name, mutate, message] of [
    ['a missing root bind', (v, c) => { v.mounts.splice(0, 1); }, /exact verified source mount at/],
    ['a duplicate root bind', (v, c) => { v.mounts.push(structuredClone(v.mounts[0])); }, /exact verified source mount at/],
    ['a retired /workspace alias instead of the root', (v, c) => { v.mounts[0] = bindMount('/workspace', '/workspace'); }, /exact verified source mount at/],
    ['a root bind sourced from a prefix-lookalike directory', (v, c) => { v.mounts[0].Source = `${c.root}-evil`; }, /exact verified source mount at/],
    ['a read-only root bind', (v, c) => { v.mounts[0].RW = false; }, /writable/],
    ['a non-bind root mount', (v, c) => { v.mounts[0].Type = 'volume'; }, /exact verified source mount at/],
    ['a foreign /data source', (v, c) => { v.mounts[1].Source = `${c.root}/.data/other`; }, /\/data/],
    ['a /data source outside the root', (v, c) => { v.mounts[1].Source = '/srv/other/.data/roboTeamAgent'; }, /\/data/],
    ['a foreign staged source', (v, c) => { v.mounts[2].Source = `${c.root}/other/roboTeamAgent`; }, /roboTeamAgent/],
    ['a /code staged for another runtime', (v, c) => { v.mounts[3].Source = `${c.root}/.ploinky/container-runtime/another/code-123`; }, /staged directory/],
    ['a /code staged outside the root', (v, c) => { v.mounts[3].Source = `${c.root}-evil/.ploinky/container-runtime/owned-runtime/code-123`; }, /staged directory/],
    ['a /code with a nested staging path', (v, c) => { v.mounts[3].Source += '/nested'; }, /staged directory/],
    ['a /code with a traversal staging path', (v, c) => { v.mounts[3].Source += '/../../x'; }, /staged directory/],
    ['a duplicate /code', (v, c) => { v.mounts.push(structuredClone(v.mounts[3])); }, /one exact \/code/],
    ['a duplicate /data', (v, c) => { v.mounts.push(structuredClone(v.mounts[1])); }, /exact verified source mount at \/data/],
    ['a traversal runtime key', (v, c) => { v.key = '../owned-runtime'; }, /single path segment/],
    ['an empty runtime key', (v, c) => { v.key = ''; }, /single path segment/],
    ['a missing /Agent', (v, c) => { v.mounts.splice(4, 1); }, /one exact \/Agent/],
    ['a duplicate /Agent', (v, c) => { v.mounts.push(structuredClone(v.mounts[4])); }, /one exact \/Agent/],
    ['a writable /Agent', (v, c) => { v.mounts[4].RW = true; }, /read-only/],
    ['a foreign /Agent', (v, c) => { v.mounts[4].Source = `${c.root}/foreign/Agent-1-2`; }, /staged directory/],
    ['a missing AgentLib grant', (v, c) => { v.mounts.splice(5, 1); }, /exact verified read-only source mount at \/opt\/ploinky-agentlib/],
    ['a duplicate AgentLib grant', (v, c) => { v.mounts.push(structuredClone(v.mounts[5])); }, /exact verified read-only source mount at \/opt\/ploinky-agentlib/],
    ['a writable AgentLib grant', (v, c) => { v.mounts[5].RW = true; }, /exact verified read-only source mount at \/opt\/ploinky-agentlib/],
    ['an AgentLib grant from a foreign source', (v, c) => { v.mounts[5].Source = `${c.root}/foreign-agentlib`; }, /exact verified read-only source mount at \/opt\/ploinky-agentlib/],
    ['a relative AgentLib source', (v, c) => { v.mounts[5].Source = 'opt/ploinky-agentlib'; }, /exact verified read-only source mount at \/opt\/ploinky-agentlib/],
    ['a nested shadow below the staged source', (v, c) => { v.mounts.push(bindMount(`${c.root}/foreign`, `${c.source}/server`)); }, /shadowing/],
    ['a nested shadow of one contract file', (v, c) => { v.mounts.push(bindMount(`${c.root}/foreign`, `${c.source}/server/robot-store.mjs`)); }, /shadowing/],
    ['a nested shadow below /data', (v, c) => { v.mounts.push(bindMount(`${c.root}/foreign`, '/data/robots')); }, /shadowing/],
    ['a nested shadow below /code', (v, c) => { v.mounts.push(bindMount(`${c.root}/foreign`, '/code/server')); }, /shadowing/],
    ['a nested shadow below /Agent', (v, c) => { v.mounts.push(bindMount(`${c.root}/foreign`, '/Agent/index.mjs')); }, /shadowing/],
    ['a nested shadow below the AgentLib grant', (v, c) => { v.mounts.push(bindMount(`${c.root}/foreign`, '/opt/ploinky-agentlib/lib.mjs')); }, /shadowing/],
    ['a mount over an ancestor of the root', (v, c) => { v.mounts.push(bindMount('/srv/foreign', path.posix.dirname(c.root))); }, /shadowing/],
    ['a mount over the filesystem root', (v, c) => { v.mounts.push(bindMount('/srv/foreign', '/')); }, /shadowing/],
    ['a non-normalized destination', (v, c) => { v.mounts.push(bindMount(`${c.root}/foreign`, `${c.root}/./x`)); }, /shadowing/],
    ['a prefix-lookalike source with the same staged name', (v, c) => { v.mounts[2].Source = `${c.source}-evil`; }, /roboTeamAgent/],
]) {
    test(`runtime mounts reject ${name}`, t => {
        const c = mountCase(t);
        const changed = c.clone(value => mutate(value, c));
        assert.throws(() => c.validate(changed), message || /./);
    });
}

test('runtime mounts reject any overlap with the run folder, but allow unrelated nested binds', t => {
    const c = mountCase(t);
    const fixture = createLiveSkillsFixture(c.root);
    for (const destination of [fixture.workspace, `${fixture.workspace}/.receipts`, `${fixture.workspace}/.agents/skills`]) {
        const changed = c.clone(value => value.mounts.push(bindMount(`${c.root}/foreign`, destination)));
        assert.equal(c.validate(changed), changed, 'Without a run folder nothing protects it.');
        assert.throws(() => c.validate(changed, { fixtureWorkspace: fixture.workspace }), /shadowing/, destination);
    }
    const unrelated = c.clone(value => value.mounts.push(bindMount(`${c.root}/foreign`, `${c.root}/another-folder`)));
    assert.equal(c.validate(unrelated, { fixtureWorkspace: fixture.workspace }), unrelated);
    for (const bad of [`${c.root}-evil/${fixture.folder}`, `${c.root}/../${fixture.folder}`, '/workspace', `${fixture.workspace}/..`]) {
        assert.throws(() => c.validate(c.runtime, { fixtureWorkspace: bad }), /under the admitted root|clean absolute|copilot-live-skills/, bad);
    }
});

test('runtime mounts require canonical sources: symlinked staging, data, source and root aliases are rejected', t => {
    const c = mountCase(t);
    const stagedCode = c.runtime.mounts[3].Source;
    fs.renameSync(stagedCode, `${stagedCode}-real`);
    fs.symlinkSync(`${stagedCode}-real`, stagedCode);
    assert.throws(() => c.validate(), /\/code/);
    fs.unlinkSync(stagedCode);
    fs.renameSync(`${stagedCode}-real`, stagedCode);
    assert.equal(c.validate(), c.runtime);
    const data = c.runtime.mounts[1].Source;
    fs.renameSync(data, `${data}-real`);
    fs.symlinkSync(`${data}-real`, data);
    assert.throws(() => c.validate(), /\/data/);
    fs.unlinkSync(data);
    fs.renameSync(`${data}-real`, data);
    const alias = `${c.root}-alias`;
    fs.symlinkSync(c.root, alias);
    t.after(() => fs.rmSync(alias, { force: true }));
    const viaAlias = structuredClone(c.runtime);
    for (const mount of viaAlias.mounts) mount.Source = mount.Source.replace(c.root, alias);
    for (const mount of viaAlias.mounts) mount.Destination = mount.Destination.replace(c.root, alias);
    assert.throws(() => validateLiveSkillsRuntimeBinding(viaAlias, `${alias}/${path.basename(c.f.repository)}`, { workspaceRoot: alias, fsApi: fs }));
    const source = c.source;
    fs.renameSync(source, `${source}-real`);
    fs.symlinkSync(`${source}-real`, source);
    assert.throws(() => c.validate(), /roboTeamAgent/);
});

test('runtime mounts reject an unclean root before looking at any mount', t => {
    const c = mountCase(t);
    for (const workspaceRoot of [undefined, '', '/', `${c.root}/`, `${c.root}/../x`, `${c.root}:x`, `${c.root}\n`, 'relative']) {
        assert.throws(() => validateLiveSkillsRuntimeBinding(c.runtime, c.f.repository, { workspaceRoot }), /clean absolute host path/);
    }
    assert.throws(() => validateLiveSkillsRuntimeBinding(c.runtime, `${c.root}-evil/AchillesCLI`, { workspaceRoot: c.root }), /outside the admitted root/);
    assert.throws(() => validateLiveSkillsRuntimeBinding(c.runtime, path.posix.dirname(c.root), { workspaceRoot: c.root }), /outside the admitted root/);
});

// ---------------------------------------------------------------------------------------------------------
// The reader: one verified root before any fixture, exact outer proof, strict nested policy.
// ---------------------------------------------------------------------------------------------------------
test('the reader rejects a release whose Box workspace is not the selected host workspace', async t => {
    const f = fixture(t, 'fresh workspace ü ');
    const setup = readerSetup(f);
    setup.release.liveBox.workspaceSourceMount = { source: `${f.directory}-evil` };
    await assert.rejects(setup.create(), /verified Box workspace is not the selected host workspace/);
    assert.equal(setup.state.nestedReads, 0);
});

test('the reader proves the exact outer root from the inspected Box, not from the release alone', async t => {
    for (const [name, mutate, message] of [
        ['a different PLOINKY_WORKSPACE_ROOT', (s, f) => { s.outerEnv = [`PLOINKY_WORKSPACE_ROOT=${f.directory}-evil`]; }, /cwd does not equal|runs another workspace|exactly one|source/],
        ['a missing PLOINKY_WORKSPACE_ROOT', (s) => { s.outerEnv = []; }, /exactly one PLOINKY_WORKSPACE_ROOT/],
        ['a duplicate PLOINKY_WORKSPACE_ROOT', (s, f) => { s.outerEnv = [`PLOINKY_WORKSPACE_ROOT=${f.directory}`, `PLOINKY_WORKSPACE_ROOT=${f.directory}`]; }, /exactly one PLOINKY_WORKSPACE_ROOT/],
        ['a different working directory', (s, f) => { s.outerWorkingDir = '/workspace'; }, /cwd does not equal/],
        ['a retired /workspace alias mount', (s, f) => { s.outerMounts = [bindMount(f.directory, '/workspace')]; }, /exactly one/],
        ['a read-only root bind', (s, f) => { s.outerMounts[0].RW = false; }, /writable bind/],
        ['a root bind sourced elsewhere', (s, f) => { s.outerMounts[0].Source = `${f.directory}-evil`; }, /source does not equal its destination/],
        ['a second alias of the workspace source', (s, f) => { s.outerMounts.push(bindMount(f.directory, '/srv/alias')); }, /another alias/],
        ['a duplicate root bind', (s, f) => { s.outerMounts.push(structuredClone(s.outerMounts[0])); }, /exactly one/],
        ['an outer shadow inside the verified source', (s, f) => { s.outerMounts.push(bindMount(`${f.directory}-evil`, `${f.repository}/roboTeamAgent/server`)); }, /shadowing/],
        ['an outer mount over an ancestor of the root', (s, f) => { s.outerMounts.push(bindMount('/srv/foreign', path.posix.dirname(f.directory))); }, /shadowing/],
    ]) {
        const f = fixture(t, 'fresh workspace ü ');
        const setup = readerSetup(f);
        mutate(setup.state, f);
        await assert.rejects(setup.create(), message, name);
        assert.equal(setup.state.nestedReads, 0, `${name} must fail before entering a nested runtime.`);
    }
});

// The inner validator realpaths Box-side sources on the host, which only proves anything when the Box sees the
// same directory there. An outer mount over any accepted source therefore fails reader setup.
for (const [name, destination] of [
    ['the persistent data source', f => `${f.directory}/.data/roboTeamAgent`],
    ['an ancestor of the persistent data source', f => `${f.directory}/.data`],
    ['the staged /code source', f => `${f.directory}/.ploinky/container-runtime/owned-runtime/code-123`],
    ['the staged /Agent source', f => `${f.directory}/.ploinky/container-runtime/owned-runtime/Agent-1-2`],
    ['the runtime staging directory', f => `${f.directory}/.ploinky/container-runtime/owned-runtime`],
    ['a file below the verified source', f => `${f.repository}/roboTeamAgent/server/robot-store.mjs`],
]) {
    test(`the reader rejects an outer Box mount over ${name}`, async t => {
        const f = fixture(t, 'fresh workspace ü ');
        const setup = readerSetup(f);
        setup.state.outerMounts.push(bindMount(`${f.directory}-evil`, destination(f)));
        await assert.rejects(setup.create(), /shadowing/);
    });
}

test('the reader accepts the exact AgentLib alias outer mount in local-AgentLib mode and nothing else below the root', async t => {
    const f = fixture(t, 'fresh workspace ü ');
    const setup = readerSetup(f);
    const alias = `${f.directory}/achillesAgentLib`;
    setup.release.agentLib = { mode: 'local', sourceRelativePath: 'achillesAgentLib' };
    setup.state.outerMounts.push(bindMount(alias, alias, false));
    assert.equal((await setup.create()).workspaceRoot, f.directory);
    // The alias must be one exact read-only same-path bind.
    setup.state.outerMounts.push(bindMount(alias, alias, false));
    await assert.rejects(setup.create(), /exact verified/);
});

test('the reader rejects an outer Box mount over the run folder at capture', async t => {
    const f = fixture(t, 'fresh workspace ü ');
    const setup = readerSetup(f);
    const reader = await setup.create();
    const fixtureValue = createLiveSkillsFixture(reader.workspaceRoot);
    setup.state.outerMounts.push(bindMount(`${f.directory}-evil`, `${fixtureValue.workspace}/.receipts`));
    await assert.rejects(reader.capture({ sessionId: randomUUID(), fixture: fixtureValue }), /shadowing/);
});

test('the reader never starts a command for a root Box evidence cannot admit', async t => {
    for (const name of ['fresh:workspace', 'fresh\nworkspace', 'fresh\\workspace']) {
        const f = fixture(t, 'parent ');
        const root = path.join(f.directory, name);
        fs.mkdirSync(path.join(root, 'AchillesCLI/roboTeamAgent'), { recursive: true });
        const setup = readerSetup({ ...f, directory: root, repository: path.join(root, 'AchillesCLI') }, { root });
        let commands = 0;
        const run = async () => { commands += 1; return []; };
        await assert.rejects(createLiveSkillsRuntimeReader(setup.input, { collectRelease: async () => setup.release, runCommand: run }), /clean absolute host path/, name);
        assert.equal(commands, 0);
    }
});

test('the reader requires the verified AchillesCLI to be inside the admitted root and admits only canonical roots', async t => {
    const f = fixture(t, 'fresh workspace ü ');
    const setup = readerSetup(f);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'outside-cli-')));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.mkdirSync(path.join(outside, 'roboTeamAgent'));
    setup.release.repositories.achillesCLI.repositoryPath = outside;
    await assert.rejects(setup.create(), /Verified AchillesCLI must belong to the selected workspace/);
    setup.release.repositories.achillesCLI.repositoryPath = `${f.directory}-evil`;
    await assert.rejects(setup.create());
    // An alias of the root resolves to the canonical admitted root.
    const g = fixture(t, 'fresh workspace ü ');
    const aliased = readerSetup(g);
    const alias = `${g.directory}-alias`;
    fs.symlinkSync(g.directory, alias);
    t.after(() => fs.rmSync(alias, { force: true }));
    aliased.input.env.SMOKE_WORKSPACE_ROOT = alias;
    assert.equal((await aliased.create()).workspaceRoot, g.directory);
});

test('capture hands the admitted root to the in-Box reader as structured JSON and rejects another root or a shadowed run folder', async t => {
    const f = fixture(t, 'fresh $HOME \'q\' ü ');
    const setup = readerSetup(f);
    const reader = await setup.create();
    const fixtureValue = createLiveSkillsFixture(reader.workspaceRoot);
    const sessionId = randomUUID();
    const original = setup.runCommand;
    let snapshot = { workspaceRoot: f.directory, codeHashes: f.expected };
    // Only the in-Box snapshot read is `exec ... <box> podman exec ...`; every other command is answered by the shared stub.
    const run = async (args, input) => (args[0] === 'exec' && args[5] === 'podman' ? snapshot : original(args, input));
    const reading = await createLiveSkillsRuntimeReader(setup.input, { collectRelease: async () => setup.release, runCommand: run });
    const captured = await reading.capture({ sessionId, fixture: fixtureValue });
    assert.equal(captured, snapshot);
    const sent = setup.state.programs.length;
    assert.ok(sent >= 2);
    // The snapshot program text carries the root only as JSON, never through a shell or a retired alias.
    const text = program(readLiveSkillsSnapshot, { sessionId, folder: fixtureValue.folder, skillNames: [], contractFiles: [], expectedRepository: f.repository, workspaceRoot: f.directory });
    assert.ok(text.includes(`"workspaceRoot":${JSON.stringify(f.directory)}`));
    snapshot = { workspaceRoot: '/workspace', codeHashes: f.expected };
    await assert.rejects(reading.capture({ sessionId, fixture: fixtureValue }), /different workspace root/);
    snapshot = { workspaceRoot: f.directory, codeHashes: { ...f.expected, 'server/constants.mjs': 'b'.repeat(64) } };
    await assert.rejects(reading.capture({ sessionId, fixture: fixtureValue }), /differs from the verified checkout/);
    snapshot = { workspaceRoot: f.directory, codeHashes: f.expected };
    const foreign = createLiveSkillsFixture('/srv/other workspace');
    await assert.rejects(reading.capture({ sessionId, fixture: foreign }), /not under the admitted workspace root/);
    const lookalike = { ...fixtureValue, workspace: `${f.directory}-evil/${fixtureValue.folder}` };
    await assert.rejects(reading.capture({ sessionId, fixture: lookalike }), /not under the admitted workspace root/);
});

test('a runtime shadow of the run folder appearing after setup fails the next capture', async t => {
    const f = fixture(t, 'fresh workspace ü ');
    const setup = readerSetup(f);
    const reader = await setup.create();
    const fixtureValue = createLiveSkillsFixture(reader.workspaceRoot);
    // The runtime is pinned at setup: a replaced mount inventory is a replaced runtime.
    setup.runtime.mounts.push(bindMount(`${f.directory}/foreign`, `${fixtureValue.workspace}/.receipts`));
    await assert.rejects(reader.capture({ sessionId: randomUUID(), fixture: fixtureValue }), /remounted|shadowing/);
});

// ---------------------------------------------------------------------------------------------------------
// The in-Box programs. They are serialized, so they may reference no module binding.
// ---------------------------------------------------------------------------------------------------------
const TRICKY_ROOTS = ["/srv/it's $HOME `x` ${y} \"q\"", '/Volumes/Ünïcode ws/ñ 数据 café', '/srv/fresh workspace', '/srv/a b'];

for (const root of TRICKY_ROOTS) {
    for (const [name, fn, args] of [
        ['readLiveSkillsSnapshot', readLiveSkillsSnapshot, { sessionId: randomUUID(), folder: `copilot-live-skills-${randomUUID()}`, skillNames: [], contractFiles: [], expectedRepository: `${root}/AchillesCLI`, workspaceRoot: root }],
        ['readRegistryAndRuntime', readRegistryAndRuntime, { workspaceRoot: root }],
    ]) {
        test(`${name} serializes the root ${JSON.stringify(root)} as one JSON value that Node parses and runs without a ReferenceError`, t => {
            const text = program(fn, args);
            assert.ok(text.includes(JSON.stringify(args)), 'Arguments must travel as one JSON value.');
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'program-'));
            t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
            const file = path.join(directory, 'program.mjs');
            fs.writeFileSync(file, text);
            const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
            assert.equal(check.status, 0, check.stderr);
            // Reveal the real error instead of the generic evidence message, then require that it is not a serialization failure.
            const revealing = text.replace(/\.catch\(\(\) => \{[^}]*\}\);\n$/, '.catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });\n');
            assert.notEqual(revealing, text, 'The program ends with the generic catch handler.');
            const run = spawnSync(process.execPath, ['--input-type=module', '-'], { input: revealing, encoding: 'utf8', timeout: 20_000 });
            assert.notEqual(run.status, 0);
            assert.doesNotMatch(run.stderr, /ReferenceError|SyntaxError/, run.stderr);
        });
    }
}

// Reads the snapshot with the real in-Box function against a real directory tree. Only the runtime locations
// (/data robots and /code) are redirected to temporary directories; the workspace root is the admitted host path.
function snapshotCase(t, prefix = 'fresh workspace ü ') {
    const f = fixture(t, prefix);
    const folder = `copilot-live-skills-${randomUUID()}`;
    const workspace = path.join(f.directory, folder);
    fs.mkdirSync(path.join(workspace, '.receipts'), { recursive: true });
    const dataRoot = path.join(f.directory, '_data');
    const sessionId = randomUUID();
    const robot = path.join(dataRoot, 'robots/default-robot');
    fs.mkdirSync(path.join(robot, 'copilot/sessions'), { recursive: true });
    fs.writeFileSync(path.join(robot, 'metadata.json'), JSON.stringify({ name: 'default', id: 'default-robot' }));
    const writeSession = (cwd = workspace) => fs.writeFileSync(path.join(robot, `copilot/sessions/${sessionId}.json`),
        JSON.stringify({ sessionId, cwd, messages: [{ id: 'm', role: 'user', text: 'x', status: 'completed', turnId: 't' }] }));
    writeSession();
    const args = { sessionId, folder, skillNames: [], contractFiles: files, expectedRepository: f.repository, workspaceRoot: f.directory };
    const read = async (overrides = {}, options = {}) => {
        let emitted;
        await readLiveSkillsSnapshot({ ...args, ...overrides }, { dataRoot, codeRoot: f.code, fsApi: f.fsApi, emit: value => { emitted = value; }, ...options });
        return emitted;
    };
    return { f, folder, workspace, dataRoot, sessionId, robot, writeSession, args, read };
}

test('the in-Box reader accepts a same-path root with a space and Unicode and reports the root it used', async t => {
    const c = snapshotCase(t);
    fs.writeFileSync(path.join(c.workspace, '.receipts', `${randomUUID()}-live-abcdef01-control.json`), '{"version":1}\n');
    const result = await c.read();
    assert.equal(result.workspaceRoot, c.f.directory);
    assert.equal(result.session.cwd, c.workspace);
    assert.equal(Object.keys(result.receipts).length, 1);
    assert.deepEqual(result.codeHashes, c.f.expected);
});

test('the in-Box reader rejects a session whose cwd is not the run folder under the admitted root', async t => {
    const c = snapshotCase(t);
    for (const cwd of [`/workspace/${c.folder}`, `${c.f.directory}-evil/${c.folder}`, `${c.workspace}/..`, c.f.directory]) {
        c.writeSession(cwd);
        await assert.rejects(c.read(), undefined, cwd);
    }
});

test('the in-Box reader rejects unclean roots, repositories outside the root and non-canonical paths', async t => {
    const c = snapshotCase(t);
    for (const workspaceRoot of ['/workspace', `${c.f.directory}-evil`, `${c.f.directory}/`, `${c.f.directory}/../${path.basename(c.f.directory)}`, 'relative', '/', '']) {
        await assert.rejects(c.read({ workspaceRoot }), undefined, workspaceRoot);
    }
    await assert.rejects(c.read({ expectedRepository: `${c.f.directory}-evil/AchillesCLI` }));
    await assert.rejects(c.read({ expectedRepository: path.dirname(c.f.directory) }));
    const alias = `${c.f.directory}-alias`;
    fs.symlinkSync(c.f.directory, alias);
    t.after(() => fs.rmSync(alias, { force: true }));
    await assert.rejects(c.read({ workspaceRoot: alias, expectedRepository: `${alias}/${path.basename(c.f.repository)}` }), /canonical/);
});

test('the in-Box reader rejects a symlinked run folder, receipts directory or receipt file', async t => {
    const c = snapshotCase(t);
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'escape-')));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, `${randomUUID()}-live-abcdef01-probe.json`), '{"escaped":true}\n');
    fs.renameSync(path.join(c.workspace, '.receipts'), path.join(c.workspace, '.receipts-real'));
    fs.symlinkSync(outside, path.join(c.workspace, '.receipts'));
    await assert.rejects(c.read(), /receipts directory escapes/);
    fs.unlinkSync(path.join(c.workspace, '.receipts'));
    fs.renameSync(path.join(c.workspace, '.receipts-real'), path.join(c.workspace, '.receipts'));
    const name = `${randomUUID()}-live-abcdef01-probe.json`;
    fs.symlinkSync(path.join(outside, fs.readdirSync(outside)[0]), path.join(c.workspace, '.receipts', name));
    await assert.rejects(c.read(), /symlink/);
    fs.unlinkSync(path.join(c.workspace, '.receipts', name));
    fs.renameSync(c.workspace, `${c.workspace}-real`);
    fs.symlinkSync(outside, c.workspace);
    await assert.rejects(c.read(), /real directory inside the admitted root/);
});

test('the in-Box reader rejects receipt names that are not run receipts', async t => {
    const c = snapshotCase(t);
    for (const name of ['notes.txt', `${randomUUID()}-live-abcdef01-other.json`, '.hidden']) {
        const file = path.join(c.workspace, '.receipts', name);
        try { fs.writeFileSync(file, '{}'); } catch { continue; }
        await assert.rejects(c.read(), undefined, name);
        fs.rmSync(file, { force: true });
    }
});
