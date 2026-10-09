import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function readManifest() {
    return JSON.parse(await fs.readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
}

test('Explorer manifest has no agent-owned edge publication hooks', async () => {
    const manifest = await readManifest();
    const profiles = manifest.profiles || {};
    const profile = profiles.default;

    assert.deepEqual(Object.keys(profiles), ['default']);
    assert.ok(profile, 'default profile should exist');

    assert.equal(Object.hasOwn(profile, 'enable'), false);
    assert.equal(Object.hasOwn(profile, 'configProviders'), false);
});

test('Explorer manifest contains no removed publication contract', async () => {
    const manifest = await readManifest();
    const serialized = JSON.stringify(manifest);

    assert.equal(Object.hasOwn(manifest.repos || {}, 'basic'), false);
    assert.equal(manifest.enable.some((entry) => String(entry?.agent || entry).includes('basic/webtty')), false);
    const removedAgentNames = ['web', 'publishing'].join('-') + '|' + ['cloud', 'flared'].join('');
    const removedOnlyOfficePrefix = ['ONLYOFFICE', '(?:PUBLIC|INTERNAL|CALLBACK_BASE)', 'URL'].join('_');
    const removedWebMeetPrefix = ['WEBMEET', '[A-Z0-9_]*', 'LIVEKIT', '[A-Z0-9_]*'].join('_');
    assert.doesNotMatch(serialized, new RegExp(removedAgentNames, 'i'));
    assert.doesNotMatch(serialized, new RegExp(removedOnlyOfficePrefix));
    assert.doesNotMatch(serialized, new RegExp(removedWebMeetPrefix));
    assert.equal(Object.hasOwn(manifest, ['additional', 'Server', 'Port'].join('')), false);
    assert.equal(Object.hasOwn(manifest, ['open', 'Ports'].join('')), false);
    assert.doesNotMatch(serialized, /(?:base-agent-additional-server\/webtty|\b7681\b)/);
});

test('Explorer graph does not declare or enable the container-image-builds repository', async () => {
    const manifest = await readManifest();

    assert.equal(Object.hasOwn(manifest.repos || {}, 'container-image-builds'), false);
    assert.equal(JSON.stringify(manifest.repos || {}).includes('container-image-builds'), false);
    assert.equal(manifest.enable.some((entry) => (
        String(entry?.agent || entry).split(/\s+/)[0].startsWith('container-image-builds/')
    )), false);
});
