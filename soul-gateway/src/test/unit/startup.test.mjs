import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const STARTUP_SCRIPT = new URL('../../../startup.sh', import.meta.url);

async function writeFakeGateway(root, marker, options = {}) {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    if (options.withNodeModules !== false) {
        await mkdir(join(root, 'node_modules'), { recursive: true });
    }
    const dependencyImport = options.dependencyName
        ? `import ${JSON.stringify(options.dependencyName)};\n`
        : '';
    await writeFile(
        join(root, 'src/index.mjs'),
        `${dependencyImport}import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.STARTUP_MARKER_OUTPUT, ${JSON.stringify(marker)});`,
    );
}

async function writeFakeDependency(nodeModulesDir, name) {
    const packageDir = join(nodeModulesDir, name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, 'package.json'), '{"type":"module","main":"index.mjs"}\n');
    await writeFile(join(packageDir, 'index.mjs'), 'export default true;\n');
}

function runStartup(env) {
    return new Promise((resolve) => {
        const child = spawn('bash', [STARTUP_SCRIPT.pathname], {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

describe('startup.sh', () => {
    it('runs mounted CODE_DIR source even when image source exists', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'soul-startup-mounted-'));
        try {
            const imageDir = join(dir, 'image');
            const codeDir = join(dir, 'code');
            const dataDir = join(dir, 'data');
            const markerPath = join(dir, 'marker.txt');
            await writeFakeGateway(imageDir, 'image');
            await writeFakeGateway(codeDir, 'code');

            const result = await runStartup({
                SOUL_GATEWAY_IMAGE_APP_DIR: imageDir,
                CODE_DIR: codeDir,
                DATA_DIR: dataDir,
                SQLITE_PATH: join(dataDir, 'gateway.sqlite3'),
                STARTUP_MARKER_OUTPUT: markerPath,
                BROWSER_POOL_SIZE: '0',
            });

            assert.equal(
                result.code,
                0,
                `startup failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
            );
            assert.equal(await readFile(markerPath, 'utf8'), 'code');
            assert.match(result.stdout, /Using mounted source from .*\/code\/src\/?/);
            assert.doesNotMatch(result.stdout, /Using baked source/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('fails clearly when mounted CODE_DIR source is missing', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'soul-startup-missing-code-'));
        try {
            const codeDir = join(dir, 'code');
            const dataDir = join(dir, 'data');
            const markerPath = join(dir, 'marker.txt');
            await mkdir(codeDir, { recursive: true });

            const result = await runStartup({
                CODE_DIR: codeDir,
                DATA_DIR: dataDir,
                SQLITE_PATH: join(dataDir, 'gateway.sqlite3'),
                STARTUP_MARKER_OUTPUT: markerPath,
                BROWSER_POOL_SIZE: '0',
            });

            assert.notEqual(result.code, 0);
            assert.match(
                `${result.stdout}\n${result.stderr}`,
                /Soul Gateway source not found at .*\/code\/src/,
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('links prepared Agent dependencies into CODE_DIR', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'soul-startup-agent-deps-'));
        try {
            const codeDir = join(dir, 'code');
            const agentNodeModulesDir = join(dir, 'Agent', 'node_modules');
            const dataDir = join(dir, 'data');
            const markerPath = join(dir, 'marker.txt');
            await writeFakeGateway(codeDir, 'code', {
                dependencyName: 'agent-only-dependency',
                withNodeModules: false,
            });
            await writeFakeDependency(agentNodeModulesDir, 'agent-only-dependency');

            const result = await runStartup({
                CODE_DIR: codeDir,
                DATA_DIR: dataDir,
                SQLITE_PATH: join(dataDir, 'gateway.sqlite3'),
                STARTUP_MARKER_OUTPUT: markerPath,
                AGENT_NODE_MODULES_DIR: agentNodeModulesDir,
                BROWSER_POOL_SIZE: '0',
            });

            assert.equal(
                result.code,
                0,
                `startup failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
            );
            assert.equal(await readFile(markerPath, 'utf8'), 'code');
            assert.match(
                result.stdout,
                /Linked prepared runtime dependencies from .*\/Agent\/node_modules to .*\/code\/node_modules/,
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
