import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../../../', import.meta.url);
const optionalAgents = ['onlyOffice', 'webmeetScribeAgent', 'webmeetStt'];
const readManifest = async (agent) => JSON.parse(await fs.readFile(new URL(`${agent}/manifest.json`, root), 'utf8'));

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
            if (error.code === 'ENOENT' && agent.includes('/')) return;
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
    assert.ok(visited.has('webmeetInfra/liveKitServerAgent'));
    for (const agent of optionalAgents) {
        const manifest = await readManifest(agent);
        assert.ok(manifest.container, `${agent} must remain discoverable and runnable through Marketplace`);
    }
    const scribe = await readManifest('webmeetScribeAgent');
    assert.ok(scribe.enable.some((ref) => ref.split(/\s+/)[0] === 'webmeetInfra/liveKitServerAgent'));
});
