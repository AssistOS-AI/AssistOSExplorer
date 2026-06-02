import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const STARTUP_SCRIPT = new URL('../../../startup.sh', import.meta.url);

async function writeFakeGateway(root, marker) {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(
        join(root, 'src/index.mjs'),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.STARTUP_MARKER_OUTPUT, ${JSON.stringify(marker)});`,
    );
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
    it('prefers baked image source over live repo mounts by default', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'soul-startup-'));
        try {
            const imageDir = join(dir, 'image');
            const codeDir = join(dir, 'code');
            const appDir = join(dir, 'app');
            const dataDir = join(dir, 'data');
            const markerPath = join(dir, 'marker.txt');
            await writeFakeGateway(imageDir, 'image');
            await writeFakeGateway(codeDir, 'code');

            const result = await runStartup({
                SOUL_GATEWAY_IMAGE_APP_DIR: imageDir,
                CODE_DIR: codeDir,
                APP_DIR: appDir,
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
            assert.equal(await readFile(markerPath, 'utf8'), 'image');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('can opt into live mounted source for development', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'soul-startup-live-'));
        try {
            const imageDir = join(dir, 'image');
            const codeDir = join(dir, 'code');
            const appDir = join(dir, 'app');
            const dataDir = join(dir, 'data');
            const markerPath = join(dir, 'marker.txt');
            await writeFakeGateway(imageDir, 'image');
            await writeFakeGateway(codeDir, 'code');

            const result = await runStartup({
                SOUL_GATEWAY_IMAGE_APP_DIR: imageDir,
                SOUL_GATEWAY_USE_LIVE_SOURCE: '1',
                CODE_DIR: codeDir,
                APP_DIR: appDir,
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
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
