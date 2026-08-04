import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ignoredDirectories = new Set([
    '.achilles-cli',
    '.git',
    '.ploinky',
    '__pycache__',
    'node_modules',
]);

async function findManifests(directory = repoRoot) {
    const manifests = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!ignoredDirectories.has(entry.name)) {
                manifests.push(...await findManifests(path.join(directory, entry.name)));
            }
        } else if (entry.isFile() && entry.name === 'manifest.json') {
            manifests.push(path.join(directory, entry.name));
        }
    }
    return manifests;
}

async function readManifest(relativePath) {
    return JSON.parse(await fs.readFile(path.join(repoRoot, relativePath), 'utf8'));
}

test('only the three coding agents select lite-sandbox', async () => {
    const selected = [];
    for (const manifestPath of await findManifests()) {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (manifest['lite-sandbox'] === true) {
            selected.push(path.relative(repoRoot, manifestPath));
        }
    }

    assert.deepEqual(selected.sort(), [
        'codexAgent/manifest.json',
        'opencodeAgent/manifest.json',
        'piAgent/manifest.json',
    ]);

    for (const manifestPath of selected) {
        const manifest = await readManifest(manifestPath);
        assert.equal(manifest.startup, 'manual', manifestPath);
    }
});

test('GPTResearcher remains a manual specialized container', async () => {
    const manifest = await readManifest('GPTResearcher/manifest.json');
    assert.equal(Object.hasOwn(manifest, 'lite-sandbox'), false);
    assert.equal(manifest.container, 'docker.io/assistos/bwrap-runner:node24-python-bookworm');
    assert.equal(manifest.startup, 'manual');
    assert.equal(manifest.agent, 'sh /code/scripts/start-gpt-researcher.sh');
    assert.equal(manifest.profiles?.default?.install, 'sh /code/scripts/install-gpt-researcher.sh');
    assert.equal(manifest.readiness?.protocol, 'mcp');
    assert.equal(manifest.health?.readiness?.script, 'readiness.sh');
});
