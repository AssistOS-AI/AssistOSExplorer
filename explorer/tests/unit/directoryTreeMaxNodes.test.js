import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { buildDirectoryTree } from '../../utils/server/directory-tree.mjs';

function createIndex(layout) {
    return async (dir) => layout[dir] || [];
}

function countEntries(nodes) {
    return nodes.reduce((total, node) => total + 1 + countEntries(node.children || []), 0);
}

test('directory_tree counts files and directories toward maxNodes', async () => {
    const files = Array.from({ length: 50 }, (_, index) => ({ name: `file-${index}.txt`, type: 'file' }));
    const indexDirectory = createIndex({ '/root': files });

    const tree = await buildDirectoryTree({ rootPath: '/root', indexDirectory, path, maxDepth: 4, maxNodes: 10 });

    assert.equal(tree.length, 10);
    assert.equal(countEntries(tree), 10);
});

test('directory_tree stops at maxNodes across nested directories', async () => {
    const indexDirectory = createIndex({
        '/root': [{ name: 'a', type: 'directory' }, { name: 'b', type: 'directory' }],
        '/root/a': Array.from({ length: 5 }, (_, index) => ({ name: `a${index}`, type: 'file' })),
        '/root/b': Array.from({ length: 5 }, (_, index) => ({ name: `b${index}`, type: 'file' })),
    });

    const tree = await buildDirectoryTree({ rootPath: '/root', indexDirectory, path, maxDepth: 4, maxNodes: 4 });

    assert.equal(countEntries(tree), 4);
});

test('directory_tree returns everything when maxNodes is large enough', async () => {
    const indexDirectory = createIndex({
        '/root': [{ name: 'a', type: 'directory' }, { name: 'z.txt', type: 'file' }],
        '/root/a': [{ name: 'inner.txt', type: 'file' }],
    });

    const tree = await buildDirectoryTree({ rootPath: '/root', indexDirectory, path, maxDepth: 4, maxNodes: 3 });

    assert.deepEqual(tree, [
        { name: 'a', type: 'directory', children: [{ name: 'inner.txt', type: 'file' }] },
        { name: 'z.txt', type: 'file' },
    ]);
});
