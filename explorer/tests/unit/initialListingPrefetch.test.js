import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    INITIAL_LISTING_PREFETCH_TTL_MS,
    clear,
    resolveInitialListingPaths,
    start,
    take
} from '../../services/runtime/initialListingPrefetch.js';
import { createFileExpTooling } from '../../web-components/pages/file-exp/file-exp-tooling.js';
import { FileExp } from '../../web-components/pages/file-exp/file-exp.js';
import { createFileExpCaches } from '../../web-components/pages/file-exp/file-exp-caches.js';
import { normalizePath } from '../../web-components/pages/file-exp/file-exp-utils.js';

afterEach(() => {
    clear();
});

const listing = (entries) => ({ content: [{ type: 'text', text: JSON.stringify(entries) }] });

function installTools(handler) {
    const calls = [];
    const previousWindow = globalThis.window;
    globalThis.window = {
        webSkel: {
            appServices: {
                async callTool(agentName, toolName, args) {
                    calls.push({ agentName, toolName, args });
                    return handler(calls.length, args);
                }
            }
        }
    };
    return {
        calls,
        restore() {
            if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
        }
    };
}

test('T5: take returns the prefetched listing once and null afterwards', async () => {
    const tools = installTools(() => listing([{ name: 'src', type: 'directory' }]));
    try {
        start(['/']);
        assert.equal(tools.calls.length, 1);
        assert.deepEqual(tools.calls[0], {
            agentName: 'explorer',
            toolName: 'list_directory_detailed',
            args: { path: '/' }
        });

        const taken = take('/');
        assert.ok(taken, 'the first take returns the promise');
        assert.deepEqual(await taken, { text: JSON.stringify([{ name: 'src', type: 'directory' }]) });
        assert.equal(take('/'), null, 'a listing is handed out once');
        assert.equal(tools.calls.length, 1);
    } finally {
        tools.restore();
    }
});

test('T5: the file browser consumes the prefetch once, then asks the server', async () => {
    const tools = installTools(() => listing([{ name: 'src', type: 'directory' }]));
    try {
        start(['/']);
        const tooling = createFileExpTooling();

        const first = await tooling.listDirectoryDetailed('/', { usePrefetch: true });
        assert.equal(tools.calls.length, 1, 'served by the prefetch');
        await tooling.listDirectoryDetailed('/', { usePrefetch: true });
        assert.equal(tools.calls.length, 2, 'the prefetch is single use');
        assert.deepEqual(first, { text: JSON.stringify([{ name: 'src', type: 'directory' }]) });
    } finally {
        tools.restore();
    }
});

test('T5: a rejected prefetch falls back to exactly one live call', async () => {
    const tools = installTools((count) => {
        if (count === 1) throw new Error('listing rejected');
        return listing([{ name: 'live', type: 'file' }]);
    });
    try {
        start(['/']);
        const tooling = createFileExpTooling();

        const result = await tooling.listDirectoryDetailed('/', { usePrefetch: true });
        assert.equal(tools.calls.length, 2, 'one failed prefetch plus one live call');
        assert.deepEqual(result, { text: JSON.stringify([{ name: 'live', type: 'file' }]) });
    } finally {
        tools.restore();
    }
});

test('T5: a prefetch older than 10 s is not used', async () => {
    const tools = installTools(() => listing([]));
    try {
        assert.equal(INITIAL_LISTING_PREFETCH_TTL_MS, 10000);
        start(['/', '/docs'], { now: () => 1000 });
        assert.ok(take('/docs', { now: () => 1000 + 9999 }), 'still fresh just before the limit');
        assert.equal(take('/', { now: () => 1000 + 10000 }), null, 'expired at 10 s');
        assert.equal(take('/', { now: () => 1000 }), null, 'an expired entry is dropped, not kept for later');

        const tooling = createFileExpTooling();
        start(['/'], { now: () => 0 });
        const before = tools.calls.length;
        await tooling.listDirectoryDetailed('/', { usePrefetch: false });
        assert.equal(tools.calls.length, before + 1, 'a caller that did not opt in always asks the server');
        assert.ok(take('/', { now: () => 1 }), 'and leaves the prefetch for a caller that did');
    } finally {
        tools.restore();
    }
});

test('T5: the first listing path of the route is read from the address like loadStateFromURL', () => {
    assert.deepEqual(resolveInitialListingPaths(''), ['/']);
    assert.deepEqual(resolveInitialListingPaths('#file-exp'), ['/']);
    assert.deepEqual(resolveInitialListingPaths('#file-exp/'), ['/']);
    assert.deepEqual(resolveInitialListingPaths('#file-exp/docs'), ['/']);
    assert.deepEqual(resolveInitialListingPaths('#file-exp/docs/guide/readme.md'), ['/', '/docs/guide']);
    assert.deepEqual(resolveInitialListingPaths('#file-exp/my%20docs/a.md'), ['/', '/my docs']);
    assert.deepEqual(resolveInitialListingPaths('#file-exp/Confidential/My%20Space/note'), ['/'],
        'confidential listings never use the filesystem tool');
});

test('T5: loadDirectoryContent lets only a first, uncached, uninvalidated load use the prefetch', async () => {
    const previousWindow = globalThis.window;
    globalThis.window = {};
    try {
        const caches = createFileExpCaches();
        const requests = [];
        const host = {
            caches,
            inflightDirListing: new Map(),
            state: { workspaceVersion: 0 },
            lastLoadError: null,
            normalizePath,
            joinPath: (base, name) => `${base === '/' ? '' : base}/${name}`,
            getCachedDirectoryContent: (path) => caches.dirListing.read(host, path),
            tooling: {
                async listDirectoryDetailed(path, options) {
                    requests.push({ path, options });
                    return { text: JSON.stringify([{ name: 'a.txt', type: 'file' }]) };
                }
            },
            showStatus() {}
        };
        const load = (path, options) => FileExp.prototype.loadDirectoryContent.call(host, path, options);

        await load('/proj');
        assert.deepEqual(requests.pop(), { path: '/proj', options: { usePrefetch: true } });

        await load('/proj', { skipCache: true });
        assert.deepEqual(requests.pop(), { path: '/proj', options: { usePrefetch: false } }, 'a refresh asks the server');

        caches.dirListing.invalidate(host, '/other');
        await load('/other');
        assert.deepEqual(requests.pop(), { path: '/other', options: { usePrefetch: false } }, 'a newer generation asks the server');
    } finally {
        if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    }
});
