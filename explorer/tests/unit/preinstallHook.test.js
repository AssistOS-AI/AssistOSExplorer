import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const explorerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hookPath = path.join(explorerRoot, 'scripts', 'hooks', 'preinstall.sh');

async function createHookFixture(tempDir) {
    const fixtureRoot = path.join(tempDir, 'explorer');
    const fixtureHook = path.join(fixtureRoot, 'scripts', 'hooks', 'preinstall.sh');
    await fs.mkdir(path.dirname(fixtureHook), { recursive: true });
    await fs.copyFile(hookPath, fixtureHook);
    await fs.copyFile(path.join(explorerRoot, '.gitignore'), path.join(fixtureRoot, '.gitignore'));
    return { fixtureRoot, fixtureHook };
}

function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
}

async function withTempDir(run) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-preinstall-'));
    try {
        return await run(tempDir);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

test('preinstall does not require a master key or mutate workspace secrets', async () => {
    await withTempDir(async (tempDir) => {
        const { fixtureRoot, fixtureHook } = await createHookFixture(tempDir);
        const workspaceRoot = path.join(tempDir, 'workspace');
        const ploinkyRoot = path.join(workspaceRoot, '.ploinky');
        const axifaceRoot = path.join(tempDir, 'axi-face');
        const envPath = path.join(workspaceRoot, '.env');
        const masterKeyPath = path.join(ploinkyRoot, 'master-key');
        const secretsPath = path.join(ploinkyRoot, '.secrets');
        const envContents = 'UNRELATED_SETTING=preserved\n';
        const masterKeyContents = `${'a'.repeat(64)}\n`;
        const secretsContents = 'existing-encrypted-payload\n';

        await fs.mkdir(path.join(axifaceRoot, 'src'), { recursive: true });
        await fs.mkdir(path.join(axifaceRoot, 'packs', 'default'), { recursive: true });
        await fs.mkdir(ploinkyRoot, { recursive: true });
        await fs.writeFile(path.join(axifaceRoot, 'src', 'axi-face.mjs'), 'export {};\n', 'utf8');
        await fs.writeFile(
            path.join(axifaceRoot, 'packs', 'default', 'manifest.json'),
            '{"id":"default"}\n',
            'utf8'
        );
        await fs.writeFile(envPath, envContents, 'utf8');
        await fs.writeFile(masterKeyPath, masterKeyContents, 'utf8');
        await fs.writeFile(secretsPath, secretsContents, 'utf8');

        const hookEnv = {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            AXIFACE_REPO_PATH: axifaceRoot
        };
        delete hookEnv.PLOINKY_MASTER_KEY;

        for (let run = 0; run < 2; run += 1) {
            const result = spawnSync('bash', [fixtureHook], {
                cwd: fixtureRoot,
                env: hookEnv,
                encoding: 'utf8'
            });
            assert.equal(result.status, 0, result.stderr || result.stdout);
        }

        assert.equal(await fs.readFile(envPath, 'utf8'), envContents);
        assert.equal(await fs.readFile(masterKeyPath, 'utf8'), masterKeyContents);
        assert.equal(await fs.readFile(secretsPath, 'utf8'), secretsContents);
    });
});

test('preinstall does not create Ploinky state in a clean workspace', async () => {
    await withTempDir(async (tempDir) => {
        const { fixtureRoot, fixtureHook } = await createHookFixture(tempDir);
        const workspaceRoot = path.join(tempDir, 'workspace');
        const axifaceRoot = path.join(tempDir, 'axi-face');

        await fs.mkdir(workspaceRoot, { recursive: true });
        await fs.mkdir(path.join(axifaceRoot, 'src'), { recursive: true });
        await fs.mkdir(path.join(axifaceRoot, 'packs', 'default'), { recursive: true });
        await fs.writeFile(path.join(axifaceRoot, 'src', 'axi-face.mjs'), 'export {};\n', 'utf8');
        await fs.writeFile(
            path.join(axifaceRoot, 'packs', 'default', 'manifest.json'),
            '{"id":"default"}\n',
            'utf8'
        );

        const hookEnv = {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspaceRoot,
            AXIFACE_REPO_PATH: axifaceRoot
        };
        delete hookEnv.PLOINKY_MASTER_KEY;

        const result = spawnSync('bash', [fixtureHook], {
            cwd: fixtureRoot,
            env: hookEnv,
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        await assert.rejects(fs.stat(path.join(workspaceRoot, '.ploinky')), { code: 'ENOENT' });
        await assert.rejects(fs.stat(path.join(workspaceRoot, '.env')), { code: 'ENOENT' });
    });
});

test('preinstall grants only the primary Explorer the literal global workspace path', async () => {
    await withTempDir(async (tempDir) => {
        const { fixtureRoot, fixtureHook } = await createHookFixture(tempDir);
        const workspaceRoot = path.join(tempDir, "work space ăîș 'quoted'");
        const agentsFile = path.join(workspaceRoot, '.ploinky', 'agents.json');
        const axifaceRoot = path.join(tempDir, 'axi-face');
        await fs.mkdir(path.dirname(agentsFile), { recursive: true });
        await fs.mkdir(path.join(axifaceRoot, 'src'), { recursive: true });
        await fs.mkdir(path.join(axifaceRoot, 'packs'), { recursive: true });
        await fs.writeFile(path.join(axifaceRoot, 'src', 'axi-face.mjs'), 'export {};\n');
        const base = { type: 'agent', agentName: 'explorer', repoName: 'AchillesIDE', runMode: 'isolated' };
        const records = { primary: { ...base }, alias: { ...base, alias: 'other' }, foreign: { ...base, repoName: 'other' } };
        await fs.writeFile(agentsFile, JSON.stringify(records));
        const result = spawnSync('bash', [fixtureHook], {
            cwd: fixtureRoot,
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: workspaceRoot, PLOINKY_REPO_NAME: 'AchillesIDE', PLOINKY_AGENT_NAME: 'explorer', AXIFACE_REPO_PATH: axifaceRoot },
            encoding: 'utf8',
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const updated = JSON.parse(await fs.readFile(agentsFile, 'utf8'));
        assert.deepEqual(updated.primary, { ...base, runMode: 'global', projectPath: workspaceRoot });
        assert.deepEqual(updated.alias, records.alias);
        assert.deepEqual(updated.foreign, records.foreign);
    });
});

for (const source of ['vendored', 'external']) {
    test(`preinstall keeps ${source} AxiFace source unchanged and generates only an ignored Explorer index`, async () => {
        await withTempDir(async (tempDir) => {
            const { fixtureRoot, fixtureHook } = await createHookFixture(tempDir);
            const workspaceRoot = path.join(tempDir, 'workspace');
            const axifaceRoot = source === 'vendored'
                ? path.join(fixtureRoot, 'shared', 'vendor', 'axi-face')
                : path.join(tempDir, 'external-axi-face');
            await fs.mkdir(workspaceRoot);
            await fs.mkdir(path.join(axifaceRoot, 'src'), { recursive: true });
            await fs.writeFile(path.join(axifaceRoot, 'src', 'axi-face.mjs'), 'export {};\n');
            for (const name of ['zebra', 'alpha']) {
                const packRoot = path.join(axifaceRoot, 'packs', name);
                await fs.mkdir(packRoot, { recursive: true });
                await fs.writeFile(path.join(packRoot, 'manifest.json'), JSON.stringify({
                    id: name,
                    name: `${name} avatar`,
                    emotions: ['neutral', 'happy'],
                    frames: { neutral: './neutral.svg' }
                }));
                await fs.writeFile(path.join(packRoot, 'neutral.svg'), '<svg/>\n');
            }
            for (const root of [fixtureRoot, axifaceRoot]) {
                git(root, 'init', '--quiet');
                git(root, 'add', '.');
            }
            const explorerStatusBefore = git(fixtureRoot, 'status', '--porcelain=v1', '--untracked-files=all');
            const axifaceStatusBefore = git(axifaceRoot, 'status', '--porcelain=v1', '--untracked-files=all');
            const hookEnv = { ...process.env, PLOINKY_WORKSPACE_ROOT: workspaceRoot };
            delete hookEnv.PLOINKY_MASTER_KEY;
            delete hookEnv.AXIFACE_REPO_PATH;
            if (source === 'external') hookEnv.AXIFACE_REPO_PATH = axifaceRoot;

            for (let run = 0; run < 2; run += 1) {
                const result = spawnSync('bash', [fixtureHook], {
                    cwd: fixtureRoot,
                    env: hookEnv,
                    encoding: 'utf8'
                });
                assert.equal(result.status, 0, result.stderr || result.stdout);
                assert.equal(git(axifaceRoot, 'status', '--porcelain=v1', '--untracked-files=all'), axifaceStatusBefore);
                assert.equal(git(fixtureRoot, 'status', '--porcelain=v1', '--untracked-files=all'), explorerStatusBefore);
                assert.equal(git(axifaceRoot, 'diff', '--name-only'), '');
                assert.equal(git(axifaceRoot, 'ls-files', '--others', '--exclude-standard'), '');
            }

            await assert.rejects(fs.stat(path.join(axifaceRoot, 'packs', 'index.json')), { code: 'ENOENT' });
            const outputPath = path.join(fixtureRoot, 'shared', 'generated', 'axi-face-packs.json');
            const output = JSON.parse(await fs.readFile(outputPath, 'utf8'));
            assert.deepEqual(output.packs.map(({ id, manifestSrc, frames }) => ({ id, manifestSrc, frames })), [
                { id: 'alpha', manifestSrc: '/explorer/shared/vendor/axi-face/packs/alpha/manifest.json', frames: { neutral: './neutral.svg' } },
                { id: 'zebra', manifestSrc: '/explorer/shared/vendor/axi-face/packs/zebra/manifest.json', frames: { neutral: './neutral.svg' } }
            ]);
            assert.equal(git(fixtureRoot, 'check-ignore', 'shared/generated/axi-face-packs.json').trim(), 'shared/generated/axi-face-packs.json');
            await fs.writeFile(path.join(fixtureRoot, 'shared', 'generated', 'unrelated.json'), '{}\n');
            assert.match(git(fixtureRoot, 'ls-files', '--others', '--exclude-standard'), /shared\/generated\/unrelated\.json/);
        });
    });
}
