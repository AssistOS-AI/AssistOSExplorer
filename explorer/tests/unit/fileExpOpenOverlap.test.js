import test from 'node:test';
import assert from 'node:assert/strict';

import { FileExp } from '../../web-components/pages/file-exp/file-exp.js';
import { FileExpEntries } from '../../web-components/components/file-exp-entries/file-exp-entries.js';
import { createFileExpCaches } from '../../web-components/pages/file-exp/file-exp-caches.js';
import { createFileExpTooling } from '../../web-components/pages/file-exp/file-exp-tooling.js';
import { loadStateFromURL } from '../../web-components/pages/file-exp/file-exp-navigation-controller.js';
import { normalizePath, parentPath } from '../../web-components/pages/file-exp/file-exp-utils.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const textResult = (text) => ({ content: [{ type: 'text', text }] });
const jsonResult = (value) => ({ json: value });

// A FileExp with its real openFile, baseline and polling methods around stubbed rendering.
function createOpenHost(selectedPath) {
    const host = Object.create(FileExp.prototype);
    Object.assign(host, {
        state: {
            path: '/',
            selectedPath,
            allEntries: [],
            workspaceVersion: 0,
            pendingHighlight: null,
            isEditing: false,
            previewMode: 'code',
            selectedFileVersionKey: ''
        },
        caches: createFileExpCaches(),
        tooling: createFileExpTooling(),
        normalizePath,
        invalidations: 0,
        invalidate() { this.invalidations += 1; },
        refreshPreviewUi() {},
        setPreviewState(patch) { Object.assign(this.state, patch); },
        setPendingHighlight() {},
        isMarkdownFile: () => false,
        formatBytes: String,
        stopCurrentFileViewWatch() {},
        startCurrentFileViewWatch() {},
        syncWebViewForPath() {},
        showStatus() {}
    });
    return host;
}

function installToolStub() {
    const previousWindow = globalThis.window;
    const started = [];
    const gates = new Map();
    globalThis.window = {
        webSkel: {
            appServices: {
                callTool(agentName, toolName, args) {
                    started.push(toolName);
                    if (!gates.has(toolName)) gates.set(toolName, deferred());
                    return gates.get(toolName).promise;
                }
            }
        }
    };
    return {
        started,
        gate(toolName) {
            if (!gates.has(toolName)) gates.set(toolName, deferred());
            return gates.get(toolName);
        },
        restore() {
            if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
        }
    };
}

test('T8: opening a text file requests its info and its content together, and the baseline reuses that info', async () => {
    const tools = installToolStub();
    try {
        const host = createOpenHost('/notes/readme.txt');
        const opening = host.openFile('/notes/readme.txt', { showLoader: false, audit: false });
        await tick();

        assert.deepEqual(tools.started, ['get_file_info', 'read_text_file'], 'info first, content right after, both in flight');

        tools.gate('get_file_info').resolve(jsonResult({ size: 5, mtimeMs: 1759744800000, modified: '2026-10-06T10:00:00Z' }));
        tools.gate('read_text_file').resolve(textResult('hello'));
        assert.equal(await opening, true);

        assert.deepEqual(tools.started, ['get_file_info', 'read_text_file'], 'no second info request after the read');
        assert.equal(host.state.fileContent, 'hello');
        assert.equal(host.state.selectedFileVersionKey, '1759744800000:5', 'the baseline comes from the early info');
        assert.equal(host.state.selectedFileSize, 5);
        assert.equal(host.invalidations, 1);
    } finally {
        tools.restore();
    }
});

test('T8: a failed read leaves no unhandled rejection from the early info request', async () => {
    const tools = installToolStub();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const originalError = console.error;
    console.error = () => {};
    try {
        const host = createOpenHost('/notes/missing.txt');
        const opening = host.openFile('/notes/missing.txt', { showLoader: false, audit: false });
        await tick();
        tools.gate('get_file_info').reject(new Error('ENOENT: no such file'));
        tools.gate('read_text_file').reject(new Error('ENOENT: no such file'));

        assert.equal(await opening, false);
        await tick();
        await tick();
        assert.deepEqual(unhandled, []);
    } finally {
        console.error = originalError;
        process.off('unhandledRejection', onUnhandled);
        tools.restore();
    }
});

function createDeepLinkHost({ treeMode, openResult }) {
    const calls = [];
    const gates = new Map();
    const host = {
        state: { path: '/', directoryViewMode: treeMode ? 'tree' : 'list', treeRootPath: '/', isEditing: false },
        treeViewState: { expandedPaths: new Set(), childrenCache: new Map(), loadingPaths: new Set() },
        normalizePath,
        parentPath,
        caches: createFileExpCaches(),
        invalidations: 0,
        invalidate() { this.invalidations += 1; },
        gate(path) {
            if (!gates.has(path)) gates.set(path, deferred());
            return gates.get(path);
        },
        loadDirectoryContent(path) {
            calls.push(path);
            return host.gate(path).promise;
        },
        updateNavigationLocation(path) { this.state.path = path; },
        setEntries: async () => {},
        renderBreadcrumbs() {},
        renderEntries() {},
        sortEntries: (entries) => entries,
        getEntriesPresenter: () => null,
        // The real openFile invalidates once when it succeeds.
        async openFile() {
            if (openResult) this.invalidate();
            return openResult;
        },
        async loadDirectory() {},
        showStatus() {}
    };
    return { host, calls };
}

test('T8: the deep-link path invalidates exactly once when openFile succeeds', async () => {
    const previousWindow = globalThis.window;
    const previousHistory = globalThis.history;
    globalThis.window = { location: { hash: '#file-exp/notes/readme.txt' } };
    globalThis.history = { pushState() {} };
    try {
        const { host } = createDeepLinkHost({ treeMode: false, openResult: true });
        host.gate('/notes').resolve([{ name: 'readme.txt', type: 'file' }]);
        await loadStateFromURL(host);
        assert.equal(host.invalidations, 1);
    } finally {
        if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
        if (previousHistory === undefined) delete globalThis.history; else globalThis.history = previousHistory;
    }
});

test('T8: the deep-link path invalidates once itself when openFile fails', async () => {
    const previousWindow = globalThis.window;
    const previousHistory = globalThis.history;
    globalThis.window = { location: { hash: '#file-exp/notes/readme.txt' } };
    globalThis.history = { pushState() {} };
    try {
        const { host } = createDeepLinkHost({ treeMode: false, openResult: false });
        host.gate('/notes').resolve([{ name: 'readme.txt', type: 'file' }]);
        await loadStateFromURL(host);
        assert.equal(host.invalidations, 1);
    } finally {
        if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
        if (previousHistory === undefined) delete globalThis.history; else globalThis.history = previousHistory;
    }
});

test('T8: in tree mode the deep link requests the parent and root listings together', async () => {
    const previousWindow = globalThis.window;
    globalThis.window = { location: { hash: '#file-exp/notes/readme.txt' } };
    try {
        const { host, calls } = createDeepLinkHost({ treeMode: true, openResult: true });
        const loading = loadStateFromURL(host);
        await tick();
        assert.deepEqual([...calls].sort(), ['/', '/notes'], 'both listings are in flight before either resolves');

        host.gate('/notes').resolve([{ name: 'readme.txt', type: 'file' }]);
        host.gate('/').resolve([{ name: 'notes', type: 'directory' }]);
        await loading;
        assert.equal(calls.filter((path) => path === '/').length, 2, 'loadTreeContext still asks for the root; the host shares the request');
    } finally {
        if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    }
});

function createRevealHost({ filterSpecs = false } = {}) {
    const calls = [];
    const gates = new Map();
    const caches = createFileExpCaches();
    const host = {
        state: { path: '/', treeRootPath: '/', directoryViewMode: 'tree', filterSpecs, workspaceVersion: 0 },
        treeViewState: { expandedPaths: new Set(), childrenCache: new Map(), loadingPaths: new Set() },
        caches,
        normalizePath,
        sortEntries: (entries) => entries,
        getCachedDirectoryContent: (path) => caches.dirListing.read(host, path),
        filterEntriesForSpecs: async (entries) => entries,
        showStatus() {},
        gate(path) {
            if (!gates.has(path)) gates.set(path, deferred());
            return gates.get(path);
        },
        // Like the real host, one request per path is shared and its result is cached.
        loadDirectoryContent(path) {
            if (!gates.has(path) || !gates.get(path).requested) {
                calls.push(path);
                host.gate(path).requested = true;
                host.gate(path).promise.then((entries) => caches.dirListing.set(host, path, entries));
            }
            return host.gate(path).promise;
        }
    };
    const presenter = {
        getHostPresenter: () => host,
        getTreeViewState: () => host.treeViewState,
        patchRows() {},
        revealTreeDirectory: FileExpEntries.prototype.revealTreeDirectory
    };
    return { host, presenter, calls };
}

test('T9: revealing a deep path requests every ancestor listing before the first one resolves', async () => {
    const { host, presenter, calls } = createRevealHost();
    const revealing = presenter.revealTreeDirectory('/a/b/c/d');
    await tick();
    assert.deepEqual(calls, ['/a', '/a/b', '/a/b/c']);

    for (const path of ['/a', '/a/b', '/a/b/c', '/a/b/c/d']) {
        host.gate(path).resolve([{ name: 'child', path: `${path}/child`, type: 'file' }]);
    }
    await revealing;
    assert.deepEqual(calls, ['/a', '/a/b', '/a/b/c', '/a/b/c/d'], 'the serial reveal shares the prefetched listings');
    for (const path of ['/a', '/a/b', '/a/b/c', '/a/b/c/d']) {
        assert.ok(host.treeViewState.expandedPaths.has(path), path);
        assert.equal(host.treeViewState.childrenCache.get(path).length, 1, path);
    }
});

test('T9: a filtered tree keeps the serial reveal', async () => {
    const { host, presenter, calls } = createRevealHost({ filterSpecs: true });
    const revealing = presenter.revealTreeDirectory('/a/b/c/d');
    await tick();
    assert.deepEqual(calls, ['/a'], 'only the first ancestor is requested while it is pending');

    for (const path of ['/a', '/a/b', '/a/b/c', '/a/b/c/d']) {
        host.gate(path).resolve([]);
        await tick();
    }
    await revealing;
    assert.deepEqual(calls, ['/a', '/a/b', '/a/b/c', '/a/b/c/d']);
});

test('T9: ancestors that are already loaded are not requested again', async () => {
    const { host, presenter, calls } = createRevealHost();
    host.treeViewState.childrenCache.set('/a', []);
    const revealing = presenter.revealTreeDirectory('/a/b/c/d');
    await tick();
    assert.deepEqual(calls, ['/a/b', '/a/b/c']);
    for (const path of ['/a/b', '/a/b/c', '/a/b/c/d']) host.gate(path).resolve([]);
    await revealing;
});

test('F9: the editor external-change poll skips a hidden tab', async () => {
    const previousDocument = globalThis.document;
    let infoRequests = 0;
    const host = Object.assign(Object.create(FileExp.prototype), {
        state: { isEditing: true, selectedPath: '/notes/readme.txt', selectedFileVersionKey: 'v1' },
        async refreshSelectedFileVersionInfo() {
            infoRequests += 1;
            return { versionKey: 'v1' };
        }
    });
    try {
        globalThis.document = { hidden: true };
        await host.pollEditorExternalModification();
        assert.equal(infoRequests, 0, 'hidden tab: no request');
        assert.equal(host.editorExternalWatchInFlight, undefined);

        globalThis.document = { hidden: false };
        await host.pollEditorExternalModification();
        assert.equal(infoRequests, 1, 'visible tab: the check runs');
    } finally {
        if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    }
});
