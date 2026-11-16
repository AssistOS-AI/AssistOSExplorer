import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const explorerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function read(relativePath) {
    return fs.readFile(path.join(explorerRoot, relativePath), 'utf8');
}

test('Explorer private writers use their canonical .data/agents/explorer locations only', async () => {
    const runtime = await read('utils/server/tool-runtime.mjs');
    const handlers = await read('utils/server/tool-handlers.mjs');
    const definitions = await read('utils/server/tool-definitions.mjs');
    const markdownStore = await read('utils/server/markdown-crdt/markdown-crdt-store.mjs');
    const scriptaStore = await read('utils/server/markdown-crdt/scripta-crdt-service.mjs');
    const avatarStore = await read('utils/server/avatar-settings/avatar-settings-store.mjs');
    const boundary = await read('utils/server/private-data-boundary.mjs');

    assert.match(runtime, /process.env.EXPLORER_DATA_ROOT[\s\S]*'search-jobs'/);
    assert.doesNotMatch(runtime, /explorer-search-jobs/);
    assert.match(handlers, /process.env.EXPLORER_DATA_ROOT[\s\S]*'plugin-settings\.json'/);
    assert.doesNotMatch(handlers, /explorer-plugin-settings\.json/);
    assert.match(definitions, /private Explorer home/);
    assert.match(markdownStore, /\['\.data', 'agents', 'explorer', 'automerge', 'documents'\]/);
    assert.doesNotMatch(markdownStore, /'\.ploinky', 'data'/);
    assert.match(scriptaStore, /'\.data',[\s\S]*'agents',[\s\S]*'explorer',[\s\S]*'scripta-collaboration'/);
    assert.doesNotMatch(scriptaStore, /'\.ploinky',[\s\S]*'data',[\s\S]*'scripta-collaboration'/);
    assert.match(avatarStore, /\.data\/agents\/explorer\/avatar-overrides\.json/);
    assert.doesNotMatch(avatarStore, /explorer-agent-avatar-overrides\.json/);
    assert.match(boundary, /PRIVATE_ROOT_SEGMENTS = Object\.freeze\(\['\.data', 'agents', 'explorer'\]\)/);
    for (const consumer of [handlers, markdownStore, scriptaStore, avatarStore]) {
        assert.match(consumer, /private-data-boundary\.mjs/);
    }
});
