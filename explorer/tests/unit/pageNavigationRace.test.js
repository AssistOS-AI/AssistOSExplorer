import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceManager } from '../../shared/libs/webskel/webskel.mjs';
import * as initialRoute from '../../services/runtime/initial-application-route.js';
import { loadDirectory, loadStateFromURL } from '../../web-components/pages/file-exp/file-exp-navigation-controller.js';
import { normalizePath, parentPath } from '../../web-components/pages/file-exp/file-exp-utils.js';
import { FileExp } from '../../web-components/pages/file-exp/file-exp.js';
import { createDomListenerRegistry } from '../../utils/domListenerRegistry.js';

const { mountInitialApplicationRoute } = initialRoute;

const ROUTE_ERROR = 'Explorer route presenter is not ready after page mount.';

// A missing module is an assertion failure, so every C1/C2 test fails on its own before the module exists.
async function loadGuards() {
    try {
        return await import('../../services/runtime/pageChangeGuards.js');
    } catch (error) {
        assert.fail(`pageChangeGuards.js could not be loaded: ${error.message}`);
    }
    return null;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function settlesWithin(promise, ms) {
    let timer;
    const outcome = await Promise.race([
        promise.then(() => 'settled', () => 'rejected'),
        new Promise((resolve) => {
            timer = setTimeout(() => resolve('pending'), ms);
        })
    ]);
    clearTimeout(timer);
    return outcome;
}

function restoreGlobal(name, previous) {
    if (previous === undefined) delete globalThis[name];
    else globalThis[name] = previous;
}

function makePage(localName) {
    return {
        localName,
        webSkelPresenter: undefined,
        hasAttribute: (name) => name === 'data-presenter'
    };
}

// A fake WebSkel whose page change inserts the page element synchronously and then returns the result of
// `change`, as the vendored changeToDynamicPage does on its success path.
function createHarness({ change, ensure, getPageRoot } = {}) {
    const root = { firstElementChild: null };
    const calls = [];
    const events = [];
    const registered = [];
    const harness = {
        root,
        calls,
        events,
        registered,
        labels: () => calls.map((call) => call.label),
        ensureComponentRegistered: ensure || (async (name) => {
            registered.push(name);
            events.push(`register:${name}`);
        }),
        getPageRoot: getPageRoot || (() => root),
        webSkel: {
            changeToDynamicPage(componentName, ...args) {
                const call = { label: `${componentName}:${args[0]}`, componentName, args, thisArg: this };
                calls.push(call);
                events.push(`webskel:${call.label}`);
                const context = { root, componentName, args, index: calls.length - 1, harness };
                if (change) return change.call(this, context);
                root.firstElementChild = makePage(componentName);
                return deferred().promise;
            }
        }
    };
    return harness;
}

function insertPage(root, componentName) {
    root.firstElementChild = makePage(componentName);
}

function installGuard(guards, harness) {
    guards.installPageChangeGuard(harness.webSkel, {
        ensureComponentRegistered: harness.ensureComponentRegistered,
        getPageRoot: harness.getPageRoot
    });
    return harness.webSkel.changeToDynamicPage;
}

// The verbatim shape of the inline wrapper that main.js carried before the page-change guard replaced it.
function installTodaysWrapper(webSkel, ensureComponentRegistered) {
    const originalChangeToDynamicPage = webSkel.changeToDynamicPage;
    if (typeof originalChangeToDynamicPage === 'function') {
        webSkel.changeToDynamicPage = async (componentName, ...args) => {
            await ensureComponentRegistered(componentName);
            return originalChangeToDynamicPage.call(webSkel, componentName, ...args);
        };
    }
}

test('T0 today\'s wrapper remounts a same-page history navigation during a pending mount (characterization)', async () => {
    const harness = createHarness();
    installTodaysWrapper(harness.webSkel, harness.ensureComponentRegistered);

    void harness.webSkel.changeToDynamicPage('file-exp', 'file-exp/a', null, true);
    await tick();
    void harness.webSkel.changeToDynamicPage('file-exp', 'file-exp/b', null, true);
    await tick();

    assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'file-exp:file-exp/b']);
    assert.deepEqual(harness.events, [
        'register:file-exp',
        'webskel:file-exp:file-exp/a',
        'register:file-exp',
        'webskel:file-exp:file-exp/b'
    ]);
});

function neverConnectedChild() {
    return { isConnected: false, renderCompletePromise: new Promise(() => {}) };
}

test('T1 vendored WebSkel waits forever for a descendant that never connected (characterization)', async () => {
    assert.equal(typeof ResourceManager.prototype.waitForDescendantRenders, 'function');
    const resourceManager = new ResourceManager();
    const host = {};
    host.querySelectorAll = () => [host, neverConnectedChild()];

    const outcome = await settlesWithin(resourceManager.waitForDescendantRenders(host), 50);
    assert.equal(outcome, 'pending');
});

test('T2 the guard does not wait for descendants that are not connected', async () => {
    const guards = await loadGuards();
    const webSkel = { ResourceManager: new ResourceManager() };
    guards.installDetachedRenderGuard(webSkel);
    const host = {};
    host.querySelectorAll = () => [host, neverConnectedChild()];

    const outcome = await settlesWithin(webSkel.ResourceManager.waitForDescendantRenders(host), 50);
    assert.equal(outcome, 'settled');
});

test('T3 the guard waits for connected descendants and tolerates rejection', async () => {
    const guards = await loadGuards();
    const webSkel = { ResourceManager: new ResourceManager() };
    guards.installDetachedRenderGuard(webSkel);
    const pendingChild = deferred();
    const rejected = Promise.reject(new Error('child render failed'));
    rejected.catch(() => {});
    const host = {
        querySelectorAll: () => [
            { isConnected: true, renderCompletePromise: pendingChild.promise },
            { isConnected: true, renderCompletePromise: rejected }
        ]
    };

    const wait = webSkel.ResourceManager.waitForDescendantRenders(host);
    assert.equal(await settlesWithin(wait, 30), 'pending');
    pendingChild.resolve();
    assert.equal(await settlesWithin(wait, 200), 'settled');
    await wait;
});

test('T4 the guard skips the host and non-thenables', async () => {
    const guards = await loadGuards();
    const webSkel = { ResourceManager: new ResourceManager() };
    guards.installDetachedRenderGuard(webSkel);
    const host = { isConnected: true, renderCompletePromise: new Promise(() => {}) };
    host.querySelectorAll = () => [
        host,
        { isConnected: true, renderCompletePromise: null },
        { isConnected: true, renderCompletePromise: {} }
    ];

    assert.equal(await settlesWithin(webSkel.ResourceManager.waitForDescendantRenders(host), 50), 'settled');
});

test('T5 the render guard install is idempotent and validated', async () => {
    const guards = await loadGuards();
    const webSkel = { ResourceManager: new ResourceManager() };
    guards.installDetachedRenderGuard(webSkel);
    const first = webSkel.ResourceManager.waitForDescendantRenders;
    guards.installDetachedRenderGuard(webSkel);
    assert.equal(webSkel.ResourceManager.waitForDescendantRenders, first);

    assert.throws(() => guards.installDetachedRenderGuard({}), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Explorer render guard requires a WebSkel ResourceManager.');
        return true;
    });
    assert.throws(() => guards.installDetachedRenderGuard({ ResourceManager: {} }), Error);
});

test('T6 a same-page history navigation joins the pending mount', async () => {
    const guards = await loadGuards();
    const harness = createHarness();
    const wrapper = installGuard(guards, harness);

    void wrapper('file-exp', 'file-exp/a', null, true);
    await tick();
    assert.equal(harness.calls.length, 1);

    const joined = [
        wrapper('file-exp', 'file-exp/b', null, true),
        wrapper('file-exp', 'file-exp/b', null, true),
        wrapper('file-exp', 'file-exp/b', null, true)
    ];
    let timerFired = false;
    const timer = new Promise((resolve) => setTimeout(() => {
        timerFired = true;
        resolve();
    }, 0));
    const results = await Promise.all(joined);
    assert.equal(timerFired, false, 'joined calls must settle before a setTimeout(0) callback');
    assert.deepEqual(results, [undefined, undefined, undefined]);
    await timer;

    assert.equal(harness.calls.length, 1);
    assert.equal(harness.registered.length, 1);
});

test('T7 a programmatic same-page change is not joined', async () => {
    const guards = await loadGuards();
    const harness = createHarness();
    const wrapper = installGuard(guards, harness);

    void wrapper('file-exp', 'file-exp/a', null, true);
    await tick();
    void wrapper('file-exp', 'file-exp');
    await tick();
    void wrapper('file-exp', 'file-exp', null, false);
    await tick();

    assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'file-exp:file-exp', 'file-exp:file-exp']);
});

test('T8 a history navigation to another page is not joined', async () => {
    const guards = await loadGuards();
    const harness = createHarness();
    const wrapper = installGuard(guards, harness);

    void wrapper('file-exp', 'file-exp/a', null, true);
    await tick();
    void wrapper('other-page', 'other-page', null, true);
    await tick();
    assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'other-page:other-page']);

    const joined = await wrapper('other-page', 'other-page/x', null, true);
    assert.equal(joined, undefined);
    assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'other-page:other-page']);
});

test('T8b the last request wins when page changes interleave', async () => {
    const guards = await loadGuards();
    const expected = ['file-exp:file-exp/a', 'other-page:other-page', 'file-exp:file-exp/c'];

    // (a) each request in its own macrotask, as browser popstate events arrive.
    {
        const harness = createHarness();
        const wrapper = installGuard(guards, harness);
        void wrapper('file-exp', 'file-exp/a', null, true);
        await tick();
        void wrapper('file-exp', 'file-exp/b', null, true);
        await tick();
        void wrapper('other-page', 'other-page', null, true);
        await tick();
        void wrapper('file-exp', 'file-exp/c', null, true);
        await tick();
        assert.deepEqual(harness.labels(), expected, 'separate macrotasks');
        assert.equal(harness.root.firstElementChild.localName, 'file-exp');
    }

    // (b) all three in one tick: other-page is still registering when file-exp/c arrives, so the third
    // request must not join the file-exp mount that other-page is about to replace (join condition 6).
    {
        const harness = createHarness();
        const wrapper = installGuard(guards, harness);
        void wrapper('file-exp', 'file-exp/a', null, true);
        await tick();
        void wrapper('file-exp', 'file-exp/b', null, true);
        void wrapper('other-page', 'other-page', null, true);
        void wrapper('file-exp', 'file-exp/c', null, true);
        await tick();
        assert.deepEqual(harness.labels(), expected, 'one tick');
        assert.equal(harness.root.firstElementChild.localName, 'file-exp');
    }
});

test('T9 page data or a non-boolean preserveHash prevents joining', async () => {
    const guards = await loadGuards();
    const harness = createHarness();
    const wrapper = installGuard(guards, harness);

    void wrapper('file-exp', 'file-exp/a', { id: 1 }, true);
    await tick();
    // The pending mount carries page data, so a dataless history request is not joined.
    void wrapper('file-exp', 'file-exp/b', null, true);
    await tick();
    // A request that carries page data is not joined either.
    void wrapper('file-exp', 'file-exp/c', { id: 2 }, true);
    await tick();
    // Re-establish a dataless pending mount, then send non-boolean preserveHash values.
    void wrapper('file-exp', 'file-exp/d', null, true);
    await tick();
    void wrapper('file-exp', 'file-exp/e', null, 'true');
    await tick();
    void wrapper('file-exp', 'file-exp/f', null, 1);
    await tick();

    assert.deepEqual(harness.labels(), [
        'file-exp:file-exp/a',
        'file-exp:file-exp/b',
        'file-exp:file-exp/c',
        'file-exp:file-exp/d',
        'file-exp:file-exp/e',
        'file-exp:file-exp/f'
    ]);
});

test('T10 joining ends when the mount settles, the presenter exists, or the element was replaced; a null root never joins', async () => {
    const guards = await loadGuards();

    // The mount settled.
    {
        const mount = deferred();
        const harness = createHarness({
            change({ root, componentName }) {
                insertPage(root, componentName);
                return mount.promise;
            }
        });
        const wrapper = installGuard(guards, harness);
        void wrapper('file-exp', 'file-exp/a', null, true);
        await tick();
        mount.resolve();
        await tick();
        void wrapper('file-exp', 'file-exp/b', null, true);
        await tick();
        assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'file-exp:file-exp/b'], 'settled mount');
    }

    // The presenter exists.
    {
        const harness = createHarness();
        const wrapper = installGuard(guards, harness);
        void wrapper('file-exp', 'file-exp/a', null, true);
        await tick();
        harness.root.firstElementChild.webSkelPresenter = {};
        void wrapper('file-exp', 'file-exp/b', null, true);
        await tick();
        assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'file-exp:file-exp/b'], 'presenter exists');
    }

    // The element was replaced by another element of the same tag.
    {
        const harness = createHarness();
        const wrapper = installGuard(guards, harness);
        void wrapper('file-exp', 'file-exp/a', null, true);
        await tick();
        harness.root.firstElementChild = makePage('file-exp');
        void wrapper('file-exp', 'file-exp/b', null, true);
        await tick();
        assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'file-exp:file-exp/b'], 'replaced element');
    }

    // The page root is null.
    {
        const harness = createHarness({ getPageRoot: () => null });
        const wrapper = installGuard(guards, harness);
        void wrapper('file-exp', 'file-exp/a', null, true);
        await tick();
        void wrapper('file-exp', 'file-exp/b', null, true);
        await tick();
        assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'file-exp:file-exp/b'], 'null root');
    }

    // A rejected tag inserted no element, so the pending element is null and nothing can join.
    {
        const harness = createHarness({
            change() {
                return deferred().promise;
            }
        });
        const wrapper = installGuard(guards, harness);
        void wrapper('file-exp', 'file-exp/a', null, true);
        await tick();
        void wrapper('file-exp', 'file-exp/b', null, true);
        await tick();
        assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'file-exp:file-exp/b'], 'nothing inserted');
    }
});

test('T11 a registration failure is isolated', async () => {
    const guards = await loadGuards();
    const registered = [];
    const harness = createHarness({
        ensure: async (name) => {
            registered.push(name);
            if (name === 'admin-page') {
                throw Object.assign(new Error('Administrator access is required.'), { code: 'ADMIN_REQUIRED' });
            }
        }
    });
    const wrapper = installGuard(guards, harness);

    void wrapper('file-exp', 'file-exp/a', null, true);
    await tick();
    await assert.rejects(
        () => wrapper('admin-page', 'admin-page', null, true),
        (error) => error.code === 'ADMIN_REQUIRED'
    );
    assert.deepEqual(harness.labels(), ['file-exp:file-exp/a']);

    // The failed registration released the in-flight counter, so the pending mount is still joinable.
    assert.equal(await wrapper('file-exp', 'file-exp/b', null, true), undefined);
    assert.deepEqual(harness.labels(), ['file-exp:file-exp/a']);

    void wrapper('file-exp', 'file-exp');
    await tick();
    assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'file-exp:file-exp']);
});

test('T12 a page change that never settles, or that rejects, does not delay later ones', async () => {
    const guards = await loadGuards();

    for (const mode of ['never settles', 'rejects']) {
        const harness = createHarness({
            change({ root, componentName, index }) {
                insertPage(root, componentName);
                if (index !== 0) return Promise.resolve();
                return mode === 'rejects' ? Promise.reject(new Error('mount failed')) : new Promise(() => {});
            }
        });
        const wrapper = installGuard(guards, harness);
        const first = wrapper('file-exp', 'file-exp/a', null, true);
        const firstOutcome = mode === 'rejects'
            ? assert.rejects(first, /mount failed/)
            : Promise.resolve();
        await tick();

        let timerFired = false;
        setTimeout(() => {
            timerFired = true;
        }, 0);
        await Promise.all([
            wrapper('other-page', 'other-page'),
            wrapper('file-exp', 'file-exp')
        ]);
        assert.equal(timerFired, false, `${mode}: later changes must not wait for a timer`);
        assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'other-page:other-page', 'file-exp:file-exp'], mode);
        await firstOutcome;
    }
});

test('T13 page changes requested inside a pending mount do not deadlock', async () => {
    const guards = await loadGuards();
    const nested = [];
    const harness = createHarness({
        async change({ root, componentName, index, harness: self }) {
            insertPage(root, componentName);
            if (index !== 0) return 'nested';
            await Promise.resolve();
            nested.push(await self.webSkel.changeToDynamicPage('file-exp', 'file-exp/b', null, true));
            nested.push(await self.webSkel.changeToDynamicPage('file-exp', 'file-exp'));
            nested.push(await self.webSkel.changeToDynamicPage('other-page', 'other-page'));
            return 'outer';
        }
    });
    const wrapper = installGuard(guards, harness);

    // A FIFO queue that makes each page change wait for the previous one would time out here: the nested
    // calls would wait for the outer mount, and the outer mount waits for them.
    let timer;
    const outer = await Promise.race([
        wrapper('file-exp', 'file-exp/a', null, true),
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('outer page change deadlocked')), 500);
        })
    ]);
    clearTimeout(timer);

    assert.equal(outer, 'outer');
    assert.deepEqual(harness.labels(), ['file-exp:file-exp/a', 'file-exp:file-exp', 'other-page:other-page']);
    assert.equal(nested[0], undefined, 'the nested history-style call joins the pending mount');
    assert.deepEqual(nested.slice(1), ['nested', 'nested']);
});

test('T14 pass-through keeps arguments, order, and result; the page-change install is idempotent', async () => {
    const guards = await loadGuards();
    const result = { mounted: true };
    const harness = createHarness({
        change({ root, componentName }) {
            insertPage(root, componentName);
            return Promise.resolve(result);
        }
    });
    const first = installGuard(guards, harness);
    guards.installPageChangeGuard(harness.webSkel, {
        ensureComponentRegistered: harness.ensureComponentRegistered,
        getPageRoot: harness.getPageRoot
    });
    assert.equal(harness.webSkel.changeToDynamicPage, first);

    const data = { id: 7 };
    const resolved = await harness.webSkel.changeToDynamicPage('file-exp', 'file-exp/x', data, false);

    assert.equal(resolved, result);
    assert.deepEqual(harness.events, ['register:file-exp', 'webskel:file-exp:file-exp/x']);
    assert.equal(harness.calls[0].thisArg, harness.webSkel);
    assert.equal(harness.calls[0].args.length, 3);
    assert.equal(harness.calls[0].args[0], 'file-exp/x');
    assert.equal(harness.calls[0].args[1], data);
    assert.equal(harness.calls[0].args[2], false);

    const noFunction = {};
    guards.installPageChangeGuard(noFunction, {
        ensureComponentRegistered: harness.ensureComponentRegistered,
        getPageRoot: harness.getPageRoot
    });
    assert.equal(noFunction.changeToDynamicPage, undefined);
    assert.throws(() => guards.installPageChangeGuard(
        { changeToDynamicPage() {} },
        { getPageRoot: harness.getPageRoot }
    ), TypeError);
    assert.throws(() => guards.installPageChangeGuard(
        { changeToDynamicPage() {} },
        { ensureComponentRegistered: harness.ensureComponentRegistered }
    ), TypeError);
});

function createPageContent() {
    return {
        firstElementChild: null,
        querySelector: () => null
    };
}

test('T15 bootstrap accepts a WebSkel page that replaced the initial page', async () => {
    const pageContent = createPageContent();
    let calls = 0;
    const webSkel = {
        async changeToDynamicPage() {
            calls += 1;
            pageContent.firstElementChild = makePage('other-page');
        }
    };
    const route = { pageName: 'file-exp', url: 'file-exp/first', preserveHash: true };

    assert.equal(await mountInitialApplicationRoute({ webSkel, pageContent, route }), null);
    assert.equal(calls, 1);

    const foreignContent = createPageContent();
    const foreignWebSkel = {
        async changeToDynamicPage() {
            foreignContent.firstElementChild = { localName: 'div', hasAttribute: () => false };
        }
    };
    await assert.rejects(
        () => mountInitialApplicationRoute({ webSkel: foreignWebSkel, pageContent: foreignContent, route }),
        { message: ROUTE_ERROR }
    );
});

test('T16 bootstrap still fails without a presenter', async () => {
    const pageContent = { querySelector: () => ({ webSkelPresenter: null }) };
    await assert.rejects(
        () => mountInitialApplicationRoute({
            webSkel: { async changeToDynamicPage() {} },
            pageContent,
            route: { pageName: 'file-exp', url: 'file-exp', preserveHash: false }
        }),
        { message: ROUTE_ERROR }
    );
});

test('T17 bootstrap still fails when nothing is mounted', async () => {
    const pageContent = { firstElementChild: null, querySelector: () => null };
    await assert.rejects(
        () => mountInitialApplicationRoute({
            webSkel: { async changeToDynamicPage() {} },
            pageContent,
            route: { pageName: 'file-exp', url: 'file-exp', preserveHash: false }
        }),
        { message: ROUTE_ERROR }
    );
});

test('T18 a detached file-exp page does not load its route', async () => {
    const previousWindow = globalThis.window;
    const previousHistory = globalThis.history;
    const calls = [];
    globalThis.window = { location: { hash: '#file-exp/a' } };
    globalThis.history = {
        pushState: (...args) => calls.push(['pushState', ...args]),
        replaceState: (...args) => calls.push(['replaceState', ...args])
    };
    try {
        const host = {
            element: { isConnected: false },
            state: { path: '/', isEditing: false, directoryViewMode: 'list' },
            normalizePath,
            parentPath,
            loadDirectoryContent: async (path) => {
                calls.push(['loadDirectoryContent', path]);
                return [{ name: 'a', type: 'directory' }];
            },
            loadDirectory: async (path) => calls.push(['loadDirectory', path]),
            openFile: async (path) => calls.push(['openFile', path]),
            cancelEdit: async () => calls.push(['cancelEdit']),
            showStatus: (...args) => calls.push(['showStatus', ...args]),
            invalidate: () => calls.push(['invalidate'])
        };

        await loadStateFromURL(host);

        assert.deepEqual(calls, []);
    } finally {
        restoreGlobal('window', previousWindow);
        restoreGlobal('history', previousHistory);
    }
});

test('T19 a page detached during a route load does not write history', async () => {
    const previousWindow = globalThis.window;
    const previousHistory = globalThis.history;
    const pushes = [];
    globalThis.window = { location: { hash: '#file-exp/a' } };
    globalThis.history = {
        pushState: (...args) => pushes.push(args),
        replaceState: (...args) => pushes.push(args)
    };
    try {
        const rootListing = deferred();
        const host = {
            element: { isConnected: true },
            state: { path: '/', directoryViewMode: 'list', isEditing: false, directoryFilterQuery: '' },
            normalizePath,
            parentPath,
            loadDirectoryContent: (path) => (path === '/' ? rootListing.promise : Promise.resolve([])),
            loadDirectory: (path) => loadDirectory(host, path),
            setEntries: async () => {},
            dispatchUi() {},
            dispatchPreview() {},
            invalidate() {},
            showStatus() {}
        };

        const load = loadStateFromURL(host);
        await tick();
        globalThis.window.location.hash = '#other-page';
        host.element.isConnected = false;
        rootListing.resolve([{ name: 'a', type: 'directory' }]);
        await load;

        assert.deepEqual(pushes, []);
    } finally {
        restoreGlobal('window', previousWindow);
        restoreGlobal('history', previousHistory);
    }
});

test('T20 updateNavigationLocation writes history only for a connected or unknown element', async () => {
    const previousWindow = globalThis.window;
    const previousHistory = globalThis.history;
    const pushes = [];
    globalThis.window = { location: { hash: '#file-exp/' } };
    globalThis.history = {
        pushState: (...args) => pushes.push(args),
        replaceState: (...args) => pushes.push(args)
    };
    try {
        const counts = [];
        for (const element of [{ isConnected: false }, { isConnected: true }, undefined]) {
            const host = Object.create(FileExp.prototype);
            host.state = { path: '/', selectedPath: null };
            host.normalizePath = normalizePath;
            host.renderBreadcrumbs = () => {};
            host.element = element;
            const before = pushes.length;
            host.updateNavigationLocation('/docs', { invalidate: false });
            counts.push(pushes.length - before);
        }
        assert.deepEqual(counts, [0, 1, 1]);
    } finally {
        restoreGlobal('window', previousWindow);
        restoreGlobal('history', previousHistory);
    }
});

test('T21 bootstrap defers to a pending popstate-originated same-page mount', async () => {
    const guards = await loadGuards();
    const harness = createHarness();
    const wrapper = installGuard(guards, harness);

    void wrapper('file-exp', 'file-exp/second', null, true);
    await tick();

    const result = await mountInitialApplicationRoute({
        webSkel: harness.webSkel,
        pageContent: Object.assign(harness.root, { querySelector: () => null }),
        route: { pageName: 'file-exp', url: 'file-exp/first', preserveHash: true }
    });

    assert.equal(result, null);
    assert.deepEqual(harness.labels(), ['file-exp:file-exp/second']);
});

test('T22 bootstrap defers to a different page mounted before it', async () => {
    let calls = 0;
    const pageContent = { firstElementChild: makePage('other-page'), querySelector: () => null };
    const result = await mountInitialApplicationRoute({
        webSkel: {
            async changeToDynamicPage() {
                calls += 1;
            }
        },
        pageContent,
        route: { pageName: 'file-exp', url: 'file-exp/first', preserveHash: true }
    });

    assert.equal(result, null);
    assert.equal(calls, 0);
});

test('T23 a detached FileExp binds no document listener in afterRender', async () => {
    const previousDocument = globalThis.document;
    const listenerCalls = [];
    globalThis.document = {
        addEventListener: (...args) => listenerCalls.push(args),
        removeEventListener() {}
    };
    try {
        const makeHost = (isConnected) => {
            const host = Object.create(FileExp.prototype);
            host.element = { isConnected };
            host.domListenerRegistry = createDomListenerRegistry();
            host.breadcrumbCalls = 0;
            host.renderBreadcrumbs = () => {
                host.breadcrumbCalls += 1;
            };
            return host;
        };

        const detached = makeHost(false);
        await detached.afterRender();
        assert.equal(listenerCalls.length, 0);
        assert.equal(detached.breadcrumbCalls, 0);

        // A connected page still runs the layout work. The minimal fake fails later, which is expected.
        const connected = makeHost(true);
        try {
            await connected.afterRender();
        } catch {
            // The fake host lacks the state that the rest of the layout pass needs.
        }
        assert.equal(connected.breadcrumbCalls, 1);
    } finally {
        restoreGlobal('document', previousDocument);
    }
});

test('T24 bootstrap keeps a newer navigation and its address when the route policy denies the initial page', async () => {
    assert.equal(typeof initialRoute.resolveDeniedAdminRoute, 'function');
    const replaced = [];
    const windowRef = {
        location: { pathname: '/explorer/', search: '?x=1' },
        history: { replaceState: (...args) => replaced.push(args) }
    };
    const deniedRoute = { pageName: 'admin-page', url: 'admin-page', preserveHash: true };

    // A newer navigation already mounted a WebSkel page: the address stays as the user left it.
    const newerPage = { firstElementChild: makePage('other-page'), querySelector: () => null };
    const kept = initialRoute.resolveDeniedAdminRoute({ route: deniedRoute, pageContent: newerPage, windowRef });
    assert.equal(replaced.length, 0);
    assert.deepEqual({ ...kept }, deniedRoute);

    let calls = 0;
    const result = await mountInitialApplicationRoute({
        webSkel: {
            async changeToDynamicPage() {
                calls += 1;
            }
        },
        pageContent: newerPage,
        route: kept
    });
    assert.equal(result, null);
    assert.equal(calls, 0);

    // An empty page root keeps today's behaviour: the address is cleaned and the route falls back to file-exp.
    const emptyPage = { firstElementChild: null, querySelector: () => null };
    const fallback = initialRoute.resolveDeniedAdminRoute({ route: deniedRoute, pageContent: emptyPage, windowRef });
    assert.deepEqual(replaced, [[null, '', '/explorer/?x=1']]);
    assert.deepEqual({ ...fallback }, { pageName: 'file-exp', url: 'file-exp', preserveHash: false });
});

function bootRouteFixture() {
    const known = new Set(['file-exp', 'paragraph-html-preview', 'other-page']);
    return { known, isWebSkelComponent: (name) => known.has(name) };
}

test('T25 bootstrap adopts the navigation that WebSkel ignored before the page root existed', () => {
    const previousWindow = globalThis.window;
    delete globalThis.window;
    try {
        assert.equal(typeof initialRoute.resolveBootRoute, 'function');
        const { isWebSkelComponent } = bootRouteFixture();
        const capturedRoute = initialRoute.resolveInitialHashedRoute('#file-exp/Confidential');

        const route = initialRoute.resolveBootRoute({
            capturedRoute,
            currentHash: '#paragraph-html-preview',
            roomEntry: null,
            isWebSkelComponent
        });

        assert.deepEqual({ ...route }, {
            pageName: 'paragraph-html-preview',
            url: 'paragraph-html-preview',
            preserveHash: true
        });
        assert.equal(Object.isFrozen(route), true);
    } finally {
        restoreGlobal('window', previousWindow);
    }
});

test('T26 bootstrap keeps the captured route when the address did not change', () => {
    assert.equal(typeof initialRoute.resolveBootRoute, 'function');
    const { isWebSkelComponent } = bootRouteFixture();
    const capturedRoute = initialRoute.resolveInitialHashedRoute('#file-exp/Confidential');

    const route = initialRoute.resolveBootRoute({
        capturedRoute,
        currentHash: '#file-exp/Confidential',
        isWebSkelComponent
    });

    assert.equal(route, capturedRoute);
});

test('T27 bootstrap keeps the captured route for an empty, unknown, or runtime-wait address', () => {
    assert.equal(typeof initialRoute.resolveBootRoute, 'function');
    const { isWebSkelComponent } = bootRouteFixture();
    const capturedRoute = initialRoute.resolveInitialHashedRoute('#file-exp/Confidential');

    for (const currentHash of ['#no-such-page/x', '', '#']) {
        const route = initialRoute.resolveBootRoute({ capturedRoute, currentHash, isWebSkelComponent });
        assert.equal(route, capturedRoute, `current hash ${JSON.stringify(currentHash)}`);
    }

    // A late runtime-wait hash is never adopted, even by a predicate that would accept it.
    const route = initialRoute.resolveBootRoute({
        capturedRoute,
        currentHash: '#agent-runtime-wait?label=Explorer',
        isWebSkelComponent: () => true
    });
    assert.equal(route, capturedRoute);
});

test('T28 bootstrap without a captured route adopts a known page or falls back to the defaults', () => {
    assert.equal(typeof initialRoute.resolveBootRoute, 'function');
    const { isWebSkelComponent } = bootRouteFixture();
    const plain = (route) => ({ ...route });

    assert.deepEqual(
        plain(initialRoute.resolveBootRoute({ currentHash: '#other-page', isWebSkelComponent })),
        { pageName: 'other-page', url: 'other-page', preserveHash: true }
    );
    for (const currentHash of ['', '#no-such-page/x']) {
        assert.deepEqual(
            plain(initialRoute.resolveBootRoute({ currentHash, isWebSkelComponent })),
            { pageName: 'file-exp', url: 'file-exp', preserveHash: false },
            `current hash ${JSON.stringify(currentHash)}`
        );
    }
    assert.deepEqual(
        plain(initialRoute.resolveBootRoute({ currentHash: '', roomEntry: { roomId: 'room_x' }, isWebSkelComponent })),
        { pageName: 'webmeet-dashboard', url: 'webmeet-dashboard', preserveHash: false }
    );
    assert.deepEqual(
        plain(initialRoute.resolveBootRoute()),
        { pageName: 'file-exp', url: 'file-exp', preserveHash: false }
    );
});

test('T29 bootstrap adopts a deeper address of the same page', () => {
    assert.equal(typeof initialRoute.resolveBootRoute, 'function');
    const { isWebSkelComponent } = bootRouteFixture();
    const capturedRoute = initialRoute.resolveInitialHashedRoute('#file-exp/Confidential');

    const route = initialRoute.resolveBootRoute({
        capturedRoute,
        currentHash: '#file-exp/Confidential/My%20Space',
        isWebSkelComponent
    });

    assert.deepEqual({ ...route }, {
        pageName: 'file-exp',
        url: 'file-exp/Confidential/My%20Space',
        preserveHash: true
    });
});
