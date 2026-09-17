import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Explorer discovers repositories through its global workspace without a fixed alias', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));

    assert.equal(Object.hasOwn(manifest.volumes || {}, '.ploinky/repos'), false);
    assert.equal(Object.values(manifest.volumes || {}).some((destination) => (
        destination === '/workspace' || String(destination).startsWith('/workspace/')
    )), false);
});
