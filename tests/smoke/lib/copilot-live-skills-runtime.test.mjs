import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { createLiveSkillsRuntimeReader, normalizeLiveSkillsImageId, readLiveSkillsCodeHashes } from './copilot-live-skills-runtime.mjs';

const digest = 'a'.repeat(64);
const files = ['server/copilot-context.mjs', 'server/constants.mjs', 'server/robot-store.mjs',
    'server/live-skill-catalog.mjs', 'server/skill-catalog-api.mjs', 'copilot/src/lib/conversationSessionStore.mjs',
    'copilot/src/lib/robotSkillCatalog.mjs', 'copilot/src/lib/alaEngine.mjs', 'copilot/src/lib/webchatRuntime.mjs'];

function fixture(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-skill-runtime-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const repository = path.join(directory, 'AchillesCLI');
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

test('actual reader setup accepts prefixed Podman identity and rejects a different or invalid image', async t => {
    const f = fixture(t);
    const expectedRepository = '/workspace/AchillesCLI';
    const startedAt = new Date().toISOString();
    const release = { liveBox: { box: { containerId: 'b'.repeat(64), imageId: digest, startedAt } },
        repositories: { achillesCLI: { repositoryPath: f.repository } } };
    const runtime = { key: 'owned-runtime', containerId: 'c'.repeat(64), instanceId: randomUUID(), enableGeneration: randomUUID(),
        startedAt, imageId: 'sha256:' + 'd'.repeat(64), mounts: [
            { Type: 'bind', Source: '/workspace', Destination: '/workspace', RW: true },
            { Type: 'bind', Source: '/workspace/.data/roboTeamAgent', Destination: '/data', RW: true },
            { Type: 'bind', Source: `${expectedRepository}/roboTeamAgent`, Destination: `${expectedRepository}/roboTeamAgent`, RW: true },
            { Type: 'bind', Source: '/workspace/.ploinky/container-runtime/owned-runtime/code-123', Destination: '/code', RW: true },
        ] };
    let image = 'sha256:' + digest, nestedReads = 0;
    const runCommand = async args => {
        if (args[0] === 'inspect') return [{ Id: release.liveBox.box.containerId, Image: image, State: { Running: true, StartedAt: startedAt },
            Mounts: [{ Type: 'bind', Source: f.directory, Destination: '/workspace', RW: true }] }];
        nestedReads += 1; return runtime;
    };
    const input = { env: { SMOKE_PLOINKY_BOX_CONTAINER: 'owned-box', SMOKE_BOX_BASE_URL: 'http://127.0.0.1:8080', SMOKE_WORKSPACE_ROOT: f.directory },
        baseURL: 'http://127.0.0.1:8080', verifierPath: '/unused-verifier' };
    await createLiveSkillsRuntimeReader(input, { collectRelease: async () => release, runCommand });
    assert.equal(nestedReads, 1);
    for (image of ['sha256:' + 'e'.repeat(64), 'bad', 'sha256:' + digest + '\n']) {
        await assert.rejects(createLiveSkillsRuntimeReader(input, { collectRelease: async () => release, runCommand }));
        assert.equal(nestedReads, 1, 'Invalid outer identity must fail before entering a nested runtime.');
    }
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
