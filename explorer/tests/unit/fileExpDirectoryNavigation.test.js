import test from 'node:test';
import assert from 'node:assert/strict';

import { FileExpEntries } from '../../web-components/components/file-exp-entries/file-exp-entries.js';
import { createFileExpCaches } from '../../web-components/pages/file-exp/file-exp-caches.js';
import { FileExp } from '../../web-components/pages/file-exp/file-exp.js';
import { loadDirectory, refreshDirectory, loadStateFromURL } from '../../web-components/pages/file-exp/file-exp-navigation-controller.js';
import { normalizePath, parentPath } from '../../web-components/pages/file-exp/file-exp-utils.js';

test('tree directory navigation does not acquire the global loader', async () => {
    let revealedPath = null;
    const fileExp = {
        state: {
            path: '/',
            treeRootPath: '/',
            directoryViewMode: 'tree',
            directoryFilterQuery: '',
            isEditing: false
        },
        normalizePath,
        parentPath,
        withLoader() {
            throw new Error('Directory navigation must not use the global loader.');
        },
        updateNavigationLocation(path) {
            this.state.path = normalizePath(path);
        },
        async loadDirectoryContent(path) {
            assert.equal(path, '/');
            return [{ name: 'cached', path: '/cached', type: 'directory' }];
        },
        async setEntries(entries) {
            this.state.entries = entries;
        },
        renderBreadcrumbs() {},
        renderEntries() {},
        getEntriesPresenter() {
            return {
                async revealTreeDirectory(path) {
                    revealedPath = path;
                }
            };
        },
        directoryFilterController: {
            async rerunIfActive() {}
        },
        showStatus(message) {
            throw new Error(message);
        }
    };

    await loadDirectory(fileExp, '/cached');

    assert.equal(revealedPath, '/cached');
});

test('changing only the visible tree root preserves loaded directory children', () => {
    const treeViewState = {
        contextKey: '',
        expandedPaths: new Set(),
        childrenCache: new Map(),
        loadingPaths: new Set()
    };
    const host = { treeViewState };
    const entries = new FileExpEntries({ closest: () => ({ webSkelPresenter: host }) }, () => {});

    entries.snapshot = {
        treeRootPath: '/first',
        workspaceVersion: 1,
        filterSpecs: false,
        sortBy: 'name',
        sortDir: 'asc'
    };
    entries.syncTreeContext();
    treeViewState.childrenCache.set('/first/cached', [{ name: 'child' }]);

    entries.snapshot = { ...entries.snapshot, treeRootPath: '/second' };
    entries.syncTreeContext();

    assert.deepEqual(treeViewState.childrenCache.get('/first/cached'), [{ name: 'child' }]);

    entries.snapshot = { ...entries.snapshot, workspaceVersion: 2 };
    entries.syncTreeContext();
    assert.equal(treeViewState.childrenCache.size, 0);
});

test('directory cache invalidation advances the path generation', () => {
    const caches = createFileExpCaches();
    const fileExp = { normalizePath };

    assert.equal(caches.dirListing.getGeneration(fileExp, '/folder'), 0);
    caches.dirListing.invalidate(fileExp, '/folder');
    assert.equal(caches.dirListing.getGeneration(fileExp, '/folder'), 1);
});

test('background revalidation cannot commit after the directory generation changes', async () => {
    const caches = createFileExpCaches();
    let resolveListing;
    let commits = 0;
    let renders = 0;
    const fileExp = {
        caches,
        backgroundDirRevalidation: new Map(),
        state: {
            path: '/folder',
            treeRootPath: '/folder',
            directoryViewMode: 'tree',
            workspaceVersion: 3
        },
        treeViewState: {
            expandedPaths: new Set(),
            childrenCache: new Map()
        },
        normalizePath,
        loadDirectoryContent() {
            return new Promise((resolve) => { resolveListing = resolve; });
        },
        async setEntries() {
            commits += 1;
            return true;
        },
        renderEntries() {
            renders += 1;
        }
    };

    const pending = FileExp.prototype.scheduleDirectoryRevalidation.call(fileExp, '/folder');
    caches.dirListing.invalidate(fileExp, '/folder');
    resolveListing([{ name: 'stale', path: '/folder/stale', type: 'file' }]);
    await pending;

    assert.equal(commits, 0);
    assert.equal(renders, 0);
    assert.equal(caches.dirListing.read(fileExp, '/folder'), null);
});

test('an initial child load cannot restore tree data after a workspace mutation', async () => {
    const caches = createFileExpCaches();
    let resolveListing;
    const host = {
        caches,
        state: {
            directoryViewMode: 'tree',
            workspaceVersion: 1
        },
        treeViewState: {
            contextKey: '',
            expandedPaths: new Set(),
            childrenCache: new Map(),
            loadingPaths: new Set()
        },
        normalizePath,
        updateNavigationLocation() {},
        loadDirectoryContent() {
            return new Promise((resolve) => { resolveListing = resolve; });
        },
        sortEntries(entries) {
            return entries;
        },
        showStatus() {}
    };
    const entries = new FileExpEntries({ closest: () => ({ webSkelPresenter: host }) }, () => {});
    entries.patchRows = () => {};

    const pending = entries.toggleTreeDirectory({
        dataset: { entryPath: '/folder', type: 'directory' }
    });
    caches.dirListing.invalidate(host, '/folder');
    host.state.workspaceVersion += 1;
    resolveListing([{ name: 'stale', path: '/folder/stale', type: 'file' }]);
    await pending;

    assert.equal(host.treeViewState.childrenCache.has('/folder'), false);
});

test('child revalidation delegates a local tree patch without rendering the host', async () => {
    const caches = createFileExpCaches();
    let updated = null;
    let renders = 0;
    const fileExp = {
        caches,
        backgroundDirRevalidation: new Map(),
        state: {
            path: '/',
            treeRootPath: '/',
            directoryViewMode: 'tree',
            workspaceVersion: 1,
            filterSpecs: false
        },
        treeViewState: {
            expandedPaths: new Set(['/folder']),
            childrenCache: new Map([['/folder', []]])
        },
        normalizePath,
        async loadDirectoryContent() {
            return [{ name: 'fresh', path: '/folder/fresh', type: 'file' }];
        },
        sortEntries(entries) {
            return entries;
        },
        getEntriesPresenter() {
            return {
                updateTreeDirectoryChildren(path, entries) {
                    updated = { path, entries };
                }
            };
        },
        renderEntries() {
            renders += 1;
        }
    };

    await FileExp.prototype.scheduleDirectoryRevalidation.call(fileExp, '/folder');

    assert.equal(updated.path, '/folder');
    assert.equal(updated.entries[0].name, 'fresh');
    assert.equal(renders, 0);
});


test('refresh replaces expanded child listings after skills are enabled or disabled', async () => {
    const child = '/.achilles-cli/.agents/skills';
    const caches = createFileExpCaches();
    let diskEntries = [{ name: 'enabled-skill', type: 'directory' }];
    const host = {
        state: { path: '/', treeRootPath: '/', directoryViewMode: 'tree' },
        treeViewState: { expandedPaths: new Set([child]), childrenCache: new Map([[child, []]]), loadingPaths: new Set() },
        caches, normalizePath,
        withLoader: operation => operation(),
        sortEntries: entries => entries,
        getCachedDirectoryContent: path => caches.dirListing.read(host, path),
        loadDirectoryContent: async path => path === child ? diskEntries : [],
        setEntries: async () => {}, renderEntries() {},
        getEntriesPresenter: () => presenter
    };
    const presenter = {
        getHostPresenter: () => host,
        getTreeViewState: () => host.treeViewState,
        patchRows() {},
        revealTreeDirectory: FileExpEntries.prototype.revealTreeDirectory
    };
    caches.dirListing.set(host, child, []);
    await refreshDirectory(host);
    assert.deepEqual(host.treeViewState.childrenCache.get(child), diskEntries);
    assert.ok(host.treeViewState.expandedPaths.has(child));
    diskEntries = [];
    await refreshDirectory(host);
    assert.deepEqual(host.treeViewState.childrenCache.get(child), []);
    assert.ok(host.treeViewState.expandedPaths.has(child));
});


for (const target of ['/project/.agents/skills', '/project/.agents/skills/SKILL.md']) {
    test(`page reload keeps workspace siblings and reveals ancestors for ${target}`, async () => {
        const previousWindow = globalThis.window;
        globalThis.window = { location: { hash: '#file-exp' + target } };
        try {
            const listings = new Map([
                ['/', [{ name: 'project', type: 'directory' }, { name: 'other-project', type: 'directory' }]],
                ['/project', [{ name: '.agents', type: 'directory' }]],
                ['/project/.agents', [{ name: 'skills', type: 'directory' }]],
                ['/project/.agents/skills', [{ name: 'SKILL.md', type: 'file' }]]
            ]);
            let openedFile;
            const host = {
                state: { path: '/', directoryViewMode: 'tree', treeRootPath: '/' },
                treeViewState: { expandedPaths: new Set(), childrenCache: new Map(), loadingPaths: new Set() },
                normalizePath, parentPath, caches: createFileExpCaches(),
                sortEntries: entries => entries,
                loadDirectoryContent: async path => listings.get(path) || [],
                updateNavigationLocation(path) { this.state.path = path; },
                setEntries: async entries => { host.state.entries = entries; },
                renderBreadcrumbs() {}, renderEntries() {},
                getEntriesPresenter: () => presenter,
                loadDirectory: path => loadDirectory(host, path),
                openFile: async path => { openedFile = path; },
                showStatus(message) { throw new Error(message); }
            };
            const presenter = {
                getHostPresenter: () => host,
                getTreeViewState: () => host.treeViewState,
                patchRows() {},
                revealTreeDirectory: FileExpEntries.prototype.revealTreeDirectory
            };
            await loadStateFromURL(host);
            assert.equal(host.state.treeRootPath, '/');
            assert.deepEqual(host.state.entries, listings.get('/'));
            for (const path of ['/project', '/project/.agents', '/project/.agents/skills']) {
                assert.ok(host.treeViewState.expandedPaths.has(path), path);
                assert.deepEqual(host.treeViewState.childrenCache.get(path), listings.get(path));
            }
            if (target.endsWith('.md')) assert.equal(openedFile, target);
        } finally {
            if (previousWindow === undefined) delete globalThis.window;
            else globalThis.window = previousWindow;
        }
    });
}
