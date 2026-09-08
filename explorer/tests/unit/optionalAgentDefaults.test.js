import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const optionalAgents = ['onlyOffice', 'webmeetScribeAgent', 'webmeetStt'];
const readManifest = async (agent) => JSON.parse(await fs.readFile(new URL(`${agent.replace(/^AchillesIDE\//, '')}/manifest.json`, root), 'utf8'));

test('Explorer local dependency graph excludes optional agents while retaining their Marketplace manifests', async () => {
    const visited = new Set();
    async function visit(agent) {
        if (visited.has(agent)) return;
        visited.add(agent);
        let manifest;
        try {
            manifest = await readManifest(agent);
        } catch (error) {
            // External repositories are resolved by Ploinky at startup.
            if (error.code === 'ENOENT' && agent.includes('/') && !agent.startsWith('AchillesIDE/')) return;
            throw error;
        }
        for (const entry of manifest.enable || []) {
            const ref = (typeof entry === 'string' ? entry : entry.agent).split(/\s+/)[0];
            assert.equal(optionalAgents.includes(ref.split('/').at(-1)), false, `${agent} must not auto-enable ${ref}`);
            await visit(ref);
        }
    }
    await visit('explorer');
    assert.ok(visited.has('webmeetAgent'));
    assert.ok(visited.has('AchillesIDE/liveKitServerAgent'));
    for (const agent of optionalAgents) {
        const manifest = await readManifest(agent);
        assert.ok(manifest.container, `${agent} must remain discoverable and runnable through Marketplace`);
    }
    const scribe = await readManifest('webmeetScribeAgent');
    assert.ok(scribe.enable.some((ref) => ref.split(/\s+/)[0] === 'AchillesIDE/liveKitServerAgent'));
});

test('Explorer and WebMeet share the local LiveKit runtime without installing retired stack repositories', async () => {
    const livekitRef = 'AchillesIDE/liveKitServerAgent';
    for (const agent of ['explorer', 'webmeetAgent', 'webmeetScribeAgent']) {
        const manifest = await readManifest(agent);
        const livekitEdges = manifest.enable.filter((entry) => (
            (typeof entry === 'string' ? entry : entry.agent).split(/\s+/)[0] === livekitRef
        ));
        assert.deepEqual(livekitEdges, [agent === 'webmeetScribeAgent' ? livekitRef : `${livekitRef} no-wait`]);
        for (const retired of ['basic', ['webmeet', 'Infra'].join('')]) {
            assert.equal(Object.hasOwn(manifest.repos || {}, retired), false);
            assert.equal(manifest.enable.some((entry) => (
                (typeof entry === 'string' ? entry : entry.agent).startsWith(`${retired}/`)
            )), false);
        }
    }
    const livekit = await readManifest(livekitRef);
    assert.equal(livekit.container, 'docker.io/assistos/livekit-server-agent@sha256:fc05e4349bc1eab5a1f28ad4bd8a7ec3324867bdaf526eb55c4cdb7031b46eea');
    assert.deepEqual(livekit.network, { mode: 'host' });
    assert.equal(livekit.start, 'sh /code/scripts/start-livekit-server-agent.sh');
    assert.equal(livekit.health.readiness.script, 'healthcheck.sh');
});
