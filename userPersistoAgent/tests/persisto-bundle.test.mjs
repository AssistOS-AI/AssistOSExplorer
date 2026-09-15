import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const root = new URL('../external/Persisto/', import.meta.url);

test('the complete Persisto runtime is pinned and available without a startup installer', async () => {
    const metadata = JSON.parse(await readFile(new URL('upstream.json', root), 'utf8'));
    assert.equal(metadata.commit, 'a711a67f6bdfdec15af91f9f79aa8a0d69397149');
    assert.equal(metadata.repository, 'https://github.com/OpenDSU/Persisto.git');
    assert.equal(metadata.license, 'MIT');
    assert.equal(Object.keys(metadata.files).length, 9);
    for (const [path, expected] of Object.entries(metadata.files)) {
        assert.match(path, /^(LICENSE|src\/[A-Za-z0-9/_.-]+\.cjs)$/);
        assert.equal(path.includes('..'), false);
        const content = await readFile(new URL(path, root));
        assert.equal(createHash('sha256').update(content).digest('hex'), expected, path);
    }
    const require = createRequire(import.meta.url);
    assert.equal(typeof require('../external/Persisto/src/persistence/Persisto.cjs').initialisePersisto, 'function');
    assert.equal(typeof require('../external/Persisto/src/persistence/strategies/SimpleFSStorageStrategy.cjs').getSimpleFSStorageStrategy, 'function');
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
    assert.equal(manifest.profiles.default.install, undefined);
    assert.match(manifest.agent, /scripts\/start\.sh/);
});
