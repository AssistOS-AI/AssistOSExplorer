import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STORAGE_KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function assertSafePersistentStorage(storage, label) {
    assert.equal(typeof storage, 'object', `${label} must be an object`);
    assert.match(storage.key, STORAGE_KEY_RE, `${label}.key must be one safe path segment`);
    assert.notEqual(storage.key, '.');
    assert.notEqual(storage.key, '..');
    assert.equal(path.posix.isAbsolute(storage.containerPath), true, `${label}.containerPath must be absolute`);
}

function inspectPersistentStorage(value, label = 'manifest') {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'persistentStorage')) {
        assertSafePersistentStorage(value.persistentStorage, `${label}.persistentStorage`);
    }
    for (const [key, child] of Object.entries(value)) {
        if (key !== 'persistentStorage') inspectPersistentStorage(child, `${label}.${key}`);
    }
}

function assertCanonicalVolumeSource(source, label) {
    assert.equal(typeof source, 'string', `${label} source must be a string`);
    const normalized = path.posix.normalize(source);
    assert.equal(normalized, source, `${label} source must be lexically canonical`);
    assert.equal(path.posix.isAbsolute(source), false, `${label} source must be workspace-relative`);
    assert.equal(source.startsWith('.data/'), true, `${label} writable data must live below .data`);
}

test('every active top-level manifest declares only canonical writable storage', async () => {
    const entries = await fs.readdir(repoRoot, { withFileTypes: true });
    const manifests = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(repoRoot, entry.name, 'manifest.json');
        try {
            manifests.push([entry.name, JSON.parse(await fs.readFile(manifestPath, 'utf8'))]);
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    assert.ok(manifests.length > 0, 'expected active top-level manifests');

    for (const [agentName, manifest] of manifests) {
        const volumeSets = [['volumes', manifest.volumes], ...Object.entries(manifest.profiles || {}).map(
            ([profile, config]) => [`profiles.${profile}.volumes`, config?.volumes]
        )];
        for (const [location, volumes] of volumeSets) {
            for (const source of Object.keys(volumes || {})) {
                assertCanonicalVolumeSource(source, `${agentName}.${location}.${source}`);
            }
        }
        inspectPersistentStorage(manifest, agentName);
    }
});

test('Explorer relies on its global workspace grant without a fixed workspace alias', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'explorer', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.volumes || {}, {});
    assert.equal(manifest.profiles.default.preinstall, 'scripts/hooks/preinstall.sh');
    assert.equal(JSON.stringify(manifest).includes('/workspace/'), false);
});
