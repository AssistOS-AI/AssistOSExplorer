import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noWaitRuntimes, resolveExplorerGraph } from './explorer-graph.mjs';

function workspace(t, manifests) {
    const explorerRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-wait-mode-'));
    t.after(() => fs.rmSync(explorerRepo, { recursive: true, force: true }));
    for (const [agent, manifest] of Object.entries(manifests)) {
        const directory = path.join(explorerRepo, agent);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    }
    return resolveExplorerGraph({ explorerRepo });
}

test('background status propagates from a no-wait parent to its global child and descendants', (t) => {
    const { runtimes } = workspace(t, {
        explorer: { enable: ['optional no-wait', 'required global'] },
        optional: { enable: ['worker global'] },
        worker: { enable: ['leaf'] },
        leaf: {},
        required: {},
    });
    assert.deepEqual(noWaitRuntimes(runtimes).sort(), [
        'AchillesIDE/leaf', 'AchillesIDE/optional', 'AchillesIDE/worker',
    ]);
    assert.equal(runtimes.get('AchillesIDE/worker').flags.has('global'), true);
    assert.equal(runtimes.get('AchillesIDE/required').flags.has('no-wait'), false);
    assert.equal(runtimes.get('AchillesIDE/explorer').flags.has('no-wait'), false);
});

for (const enable of [['optional no-wait', 'required'], ['required', 'optional no-wait']]) {
    test(`a shared blocking path wins for a node and its descendants (${enable.join(', ')})`, (t) => {
        const { runtimes } = workspace(t, {
            explorer: { enable },
            optional: { enable: ['shared global'] },
            required: { enable: ['shared'] },
            shared: { enable: ['leaf'] },
            leaf: {},
        });
        assert.deepEqual(noWaitRuntimes(runtimes), ['AchillesIDE/optional']);
    });
}

for (const enable of [['shared no-wait', 'shared global'], ['shared global', 'shared no-wait']]) {
    test(`a blocking declaration wins when the same parent repeats an edge (${enable.join(', ')})`, (t) => {
        const { runtimes } = workspace(t, {
            explorer: { enable },
            shared: { enable: ['leaf'] },
            leaf: {},
        });
        assert.deepEqual(noWaitRuntimes(runtimes), []);
    });
}

test('an explicit no-wait edge remains background when its parent has a blocking path', (t) => {
    const { runtimes } = workspace(t, {
        explorer: { enable: ['optional no-wait', 'required'] },
        optional: { enable: ['shared'] },
        required: { enable: ['shared'] },
        shared: { enable: ['leaf no-wait'] },
        leaf: {},
    });
    assert.deepEqual(noWaitRuntimes(runtimes).sort(), ['AchillesIDE/leaf', 'AchillesIDE/optional']);
});
