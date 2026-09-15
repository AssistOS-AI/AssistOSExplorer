import test from 'node:test';
import assert from 'node:assert/strict';

import { createExplorerSearchAdapter } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/chat-autocomplete/explorer-search-adapter.js';

test('Explorer search adapter requests raw search_files payloads without the global loader', async () => {
    const calls = [];
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name, args, options) => {
            calls.push({ name, args, options });
            if (name === 'search_files') {
                return { content: [{ type: 'text', text: JSON.stringify({ results: [{ path: '/docs', kind: 'folder' }] }) }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify({ isDirectory: true }) }] };
        }
    });

    const results = await adapter.searchPaths('docs');
    assert.equal(results.length, 1);
    assert.equal(calls[0].name, 'search_files');
    assert.equal(calls[0].args.includeKind, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.excludePatterns.includes('.data'));
    assert.deepEqual(calls[0].options, { raw: true, withLoader: false });
});

test('Explorer search adapter preserves file and folder kinds from one search response', async () => {
    const calls = [];
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name, args) => {
            calls.push({ name, args });
            if (name === 'search_files') {
                return { content: [{ type: 'text', text: JSON.stringify({ results: [
                    { path: '/docs', kind: 'folder' },
                    { path: '/docs/readme.md', kind: 'file' }
                ] }) }] };
            }
            throw new Error('Unexpected per-result metadata request');
        }
    });

    const results = await adapter.searchPaths('docs');
    assert.deepEqual(results.map((entry) => `${entry.kind}:${entry.path}`), [
        'folder:docs',
        'file:docs/readme.md'
    ]);
    assert.equal(calls.length, 1);
});

test('Explorer search adapter scopes nested folder searches to the selected folder', async () => {
    const calls = [];
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name, args, options) => {
            calls.push({ name, args, options });
            if (name === 'search_files') {
                return { json: { results: [{ path: '/docs/api.md', kind: 'file' }] } };
            }
            return { json: { isFile: true, isDirectory: false } };
        }
    });

    await adapter.searchPaths('docs/api');
    assert.equal(calls[0].name, 'search_files');
    assert.equal(calls[0].args.path, '/docs');
    assert.equal(calls[0].args.pattern, 'api');
});

test('Explorer search adapter accepts typed results encoded as JSON text', async () => {
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name) => {
            if (name === 'search_files') {
                return JSON.stringify({ results: [{ path: '/notes.md', kind: 'file' }] });
            }
            return JSON.stringify({ isFile: true });
        }
    });

    const results = await adapter.searchPaths('notes');
    assert.deepEqual(results, [{
        path: 'notes.md',
        label: 'notes.md',
        displayPath: 'notes.md',
        kind: 'file'
    }]);
});

test('a full suggestion page requires one RPC without file-metadata fanout', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => ({
        path: `/docs/operation-${index}.md`, kind: 'file'
    }));
    const calls = [];
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name, args) => {
            calls.push(name);
            assert.equal(name, 'search_files');
            assert.equal(args.includeKind, true);
            assert.equal(args.maxResults, 50);
            return { json: { results: entries, truncated: true } };
        }
    });
    assert.equal((await adapter.searchPaths('op')).length, 50);
    assert.deepEqual(calls, ['search_files']);
});

test('malformed, untyped, duplicate and unrelated entries cause no metadata requests', async () => {
    let calls = 0;
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name) => {
            calls++;
            assert.equal(name, 'search_files');
            return { json: { results: [
                null, '/notes.md', { path: '/notes-link', kind: 'other' },
                { path: '/notes.md', kind: 'file' }, { path: '/notes.md', kind: 'file' },
                { path: '/different.md', kind: 'file' }, { path: 42, kind: 'file' }
            ] } };
        }
    });
    assert.deepEqual((await adapter.searchPaths('notes')).map(entry => entry.path), ['notes.md']);
    assert.equal(calls, 1);
});
