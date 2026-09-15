import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { minimatch } from 'minimatch';
import { z } from 'zod';

import { createCacheHelpers } from '../../utils/filesystem-utils.mjs';
import { createSchemas } from '../../utils/server/schemas.mjs';
import { createStructureIndex } from '../../utils/server/structure-index.mjs';
import { createWorkspaceSearch } from '../../utils/server/workspace-search.mjs';
import { createToolHandlers } from '../../utils/server/tool-handlers.mjs';

const schemas = createSchemas(z);
const decode = response => JSON.parse(response.content[0].text);

async function fixture(run) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-search-kinds-'));
    try {
        await fs.mkdir(path.join(root, 'op-folder'));
        await fs.mkdir(path.join(root, 'op-excluded'));
        await fs.mkdir(path.join(root, '.data'));
        for (const name of ['op-file.md', 'op-folder/op-note.txt', 'op-excluded/op-hidden.txt', '.data/op-private.txt', '.secrets', 'op-keys.secrets']) {
            await fs.writeFile(path.join(root, name), 'fixture');
        }
        await fs.symlink(path.join(root, 'op-file.md'), path.join(root, 'op-file-link'));
        await fs.symlink(path.join(root, 'op-folder'), path.join(root, 'op-folder-link'));
        await fs.symlink(path.join(root, 'absent'), path.join(root, 'op-broken-link'));
        const cache = createCacheHelpers({ readFileContent: file => fs.readFile(file, 'utf8'), config: { ttlMs: 60_000 } });
        const index = createStructureIndex({ fs, path, listDirectoryDetailedWithCache: cache.listDirectoryDetailedWithCache });
        let directoryReads = 0;
        const search = createWorkspaceSearch({
            fs, path, readline, minimatch, workspaceRoot: root,
            validatePath: async value => value, getAllowedDirectories: () => [root],
            readFileWithCache: cache.readFileWithCache, writeFileContent: fs.writeFile, cacheConfig: cache.cacheConfig,
            indexDirectory: async directory => { directoryReads += 1; return index.indexDirectory(directory); },
            structureIndex: index.structureIndex, dirIndexTtlMs: 60_000,
            defaultExcludes: ['.data'], maxTextSearchFileBytes: 1024,
        });
        await run({ root, search, index, directoryReads: () => directoryReads });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
}

const options = { pattern: 'op', excludePatterns: ['**/op-excluded', '**/op-excluded/**'], maxResults: 50 };

test('search_files schema defaults to paths and accepts only a boolean includeKind', async () => {
    const descriptor = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    const published = descriptor.tools.find(tool => tool.name === 'search_files');
    assert.deepEqual(published.inputSchema.includeKind, { type: 'boolean', optional: true });
    assert.equal(schemas.SearchFilesArgsSchema.parse({ path: '/', pattern: 'op' }).includeKind, false);
    assert.equal(schemas.SearchFilesArgsSchema.parse({ path: '/', pattern: 'op', includeKind: true }).includeKind, true);
    for (const includeKind of ['true', 1, null, {}]) {
        assert.equal(schemas.SearchFilesArgsSchema.safeParse({ path: '/', pattern: 'op', includeKind }).success, false);
    }
    for (const maxResults of [0, -1, 20_001]) {
        assert.equal(schemas.SearchFilesArgsSchema.safeParse({ path: '/', pattern: 'op', includeKind: true, maxResults }).success, false);
    }
});

test('cold, warm and partially expired indexes return the same typed files and folders without extra metadata reads', () => fixture(async ({ root, search, index, directoryReads }) => {
    const typed = await search.searchFilesWithinWorkspace(root, { ...options, includeKind: true });
    const expected = [
        { path: '/op-file.md', kind: 'file' }, { path: '/op-file-link', kind: 'file' },
        { path: '/op-folder', kind: 'folder' }, { path: '/op-folder/op-note.txt', kind: 'file' },
        { path: '/op-folder-link', kind: 'folder' }, { path: '/op-folder-link/op-note.txt', kind: 'file' },
    ];
    const byPath = (a, b) => a.path.localeCompare(b.path);
    assert.deepEqual([...typed.results].sort(byPath), expected.sort(byPath));
    assert.equal(typed.truncated, false);
    const coldReads = directoryReads();
    assert.ok(coldReads > 0);
    assert.deepEqual(await search.searchFilesWithinWorkspace(root, { ...options, includeKind: true }), typed);
    assert.equal(directoryReads(), coldReads, 'a warm index provides all result kinds without any new directory/metadata reads');

    const strings = await search.searchFilesWithinWorkspace(root, options);
    assert.deepEqual(strings.results.filter(item => item !== '/op-broken-link'), typed.results.map(item => item.path));
    assert.ok(strings.results.includes('/op-broken-link'), 'default search retains its old unsupported-entry behavior');
    assert.equal(strings.truncated, false);
    assert.deepEqual(await search.searchFilesWithinWorkspace(root, { ...options, includeKind: false }), strings);
    index.structureIndex.get(path.join(root, 'op-folder')).cachedAt = 0;
    assert.deepEqual(await search.searchFilesWithinWorkspace(root, { ...options, includeKind: true }), typed);
    assert.ok(directoryReads() > coldReads, 'an expired child rebuilds the whole result without duplicate partial-index rows');
}));

test('typed search preserves protected names, exclusions, glob matching, root denial and result limits', () => fixture(async ({ root, search }) => {
    for (const includeKind of [false, true]) {
        const guarded = await search.searchFilesWithinWorkspace(root, { ...options, pattern: '*', includeKind });
        const paths = guarded.results.map(item => typeof item === 'string' ? item : item.path);
        assert.ok(paths.every(item => !item.includes('.secrets') && !item.includes('op-excluded') && !item.includes('.data')));
        const limited = await search.searchFilesWithinWorkspace(root, { ...options, pattern: '*.md', maxResults: 1, includeKind });
        assert.deepEqual(limited, { results: [includeKind ? { path: '/op-file.md', kind: 'file' } : '/op-file.md'], truncated: true });
        assert.deepEqual(await search.searchFilesWithinWorkspace(root, { ...options, pattern: '  ', includeKind }), { results: [], truncated: false });
        await assert.rejects(search.searchFilesWithinWorkspace(path.dirname(root), { ...options, includeKind }), /outside allowed directories/);
    }
    const brokenOnly = await search.searchFilesWithinWorkspace(root, { ...options, pattern: 'op-broken', includeKind: true, maxResults: 1 });
    assert.deepEqual(brokenOnly, { results: [], truncated: false }, 'an unsupported type must not invent a kind or exhaust the result limit');
}));

test('search_files cache and concurrent request sharing separate typed and default results', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    const cache = new Map();
    const handler = createToolHandlers({
        fs, path, workspaceRoot: os.tmpdir(), schemas, validatePath: async value => value,
        buildCacheKey: (name, args) => JSON.stringify([name, args]), searchFilesCache: cache,
        searchFilesWithinWorkspace: async (_root, args) => {
            calls.push(args.includeKind);
            await gate;
            return { results: args.includeKind ? [{ path: '/op-note.txt', kind: 'file' }] : ['/op-note.txt'], truncated: false };
        },
    }).search_files;
    const args = { path: os.tmpdir(), pattern: 'op' };
    const pending = [handler(args), handler({ ...args, includeKind: false }), handler({ ...args, includeKind: true }), handler({ ...args, includeKind: true })];
    await new Promise(resolve => setImmediate(resolve));
    release();
    const results = (await Promise.all(pending)).map(decode);
    assert.deepEqual(calls, [false, true], 'same-mode requests share work; different response modes cannot share an in-flight result');
    const plain = { results: ['/op-note.txt'], truncated: false };
    const typed = { results: [{ path: '/op-note.txt', kind: 'file' }], truncated: false };
    assert.deepEqual(results, [plain, plain, typed, typed]);
    assert.equal(cache.size, 2);
    assert.deepEqual(decode(await handler(args)), plain);
    assert.deepEqual(decode(await handler({ ...args, includeKind: true })), typed);
    assert.deepEqual(calls, [false, true], 'neither cached response type starts another traversal');
    await handler({ ...args, includeKind: true, workspaceVersion: 1 });
    assert.deepEqual(calls, [false, true, true], 'workspace version still invalidates typed cached results');
    await assert.rejects(handler({ ...args, includeKind: 'true' }), /Invalid arguments for search_files/);
});
