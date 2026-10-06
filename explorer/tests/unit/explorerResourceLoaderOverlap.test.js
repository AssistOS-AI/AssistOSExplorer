import test from 'node:test';
import assert from 'node:assert/strict';

import { installExplorerResourceLoader } from '../../services/runtime/explorerResourceLoader.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

function createHarness({ rootDir = '/explorer/web-components', components, importModule } = {}) {
    const loadCalls = [];
    const requested = [];
    const htmlGate = deferred();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        if (String(url).endsWith('.html')) await htmlGate.promise;
        return {
            ok: true,
            status: 200,
            async text() { return String(url).endsWith('.html') ? '<main>ready</main>' : '.ready {}'; }
        };
    };
    const webSkel = {
        configs: { rootDir },
        ResourceManager: {
            ...(components ? { components } : {}),
            async loadComponent(component) {
                loadCalls.push(component);
                return { html: component.loadedTemplate, css: component.loadedCSSs };
            }
        }
    };
    installExplorerResourceLoader(webSkel, { retryOptions: { retries: 0, delayMs: 0 }, importModule });
    return {
        webSkel,
        loadCalls,
        requested,
        releaseHtml: htmlGate.resolve,
        restore() { globalThis.fetch = originalFetch; }
    };
}

const fileExp = () => ({ name: 'file-exp', type: 'pages', presenterClassName: 'FileExp' });

test('T6: the presenter import starts while the template fetch is still pending and reaches WebSkel', async () => {
    const imported = [];
    const presenterModule = { FileExp: class FileExp {} };
    const harness = createHarness({
        importModule: async (url) => { imported.push(url); return presenterModule; }
    });
    try {
        const loading = harness.webSkel.ResourceManager.loadComponent(fileExp());
        await tick();
        assert.deepEqual(imported, ['/explorer/web-components/pages/file-exp/file-exp.js']);
        assert.equal(harness.loadCalls.length, 0, 'the template has not arrived, so WebSkel has not been called');

        harness.releaseHtml();
        await loading;
        assert.equal(harness.loadCalls.length, 1);
        assert.equal(harness.loadCalls[0].presenterModule, presenterModule);
        assert.equal(harness.loadCalls[0].loadedTemplate, '<main>ready</main>');
        assert.deepEqual(harness.loadCalls[0].loadedCSSs, ['.ready {}']);
    } finally {
        harness.restore();
    }
});

test('T6: two overlapping calls for one component share one fetch pair, one import and one WebSkel call', async () => {
    const imported = [];
    const harness = createHarness({
        importModule: async (url) => { imported.push(url); return { FileExp: class FileExp {} }; }
    });
    try {
        const first = harness.webSkel.ResourceManager.loadComponent(fileExp());
        const second = harness.webSkel.ResourceManager.loadComponent(fileExp());
        harness.releaseHtml();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        assert.equal(harness.requested.length, 2, harness.requested.join(', '));
        assert.equal(imported.length, 1);
        assert.equal(harness.loadCalls.length, 1);
        assert.equal(firstResult, secondResult);
    } finally {
        harness.restore();
    }
});

test('T6: a failed load is not remembered, so the next call fetches again', async () => {
    let failing = true;
    const originalFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async (url) => {
        requested.push(String(url));
        return failing
            ? { ok: false, status: 404, async text() { return ''; } }
            : { ok: true, status: 200, async text() { return 'x'; } };
    };
    try {
        const loadCalls = [];
        const webSkel = {
            configs: { rootDir: '/explorer/web-components' },
            ResourceManager: { async loadComponent(component) { loadCalls.push(component); return {}; } }
        };
        installExplorerResourceLoader(webSkel, { retryOptions: { retries: 0, delayMs: 0 }, importModule: async () => ({}) });

        await assert.rejects(webSkel.ResourceManager.loadComponent(fileExp()), /Failed to load/);
        failing = false;
        await webSkel.ResourceManager.loadComponent(fileExp());
        assert.equal(loadCalls.length, 1);
        assert.ok(requested.length >= 4, `fetched again: ${requested.length}`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('T6: no early import without a presenter, with a supplied module, or for a relative root', async () => {
    const imported = [];
    const importModule = async (url) => { imported.push(url); return {}; };

    let harness = createHarness({ importModule });
    try {
        harness.releaseHtml();
        await harness.webSkel.ResourceManager.loadComponent({ name: 'plain', type: 'components' });
        await harness.webSkel.ResourceManager.loadComponent({ ...fileExp(), name: 'given', presenterModule: { FileExp: class {} } });
    } finally {
        harness.restore();
    }
    harness = createHarness({ rootDir: './web-components', importModule });
    try {
        harness.releaseHtml();
        await harness.webSkel.ResourceManager.loadComponent(fileExp());
        assert.equal(harness.loadCalls[0].presenterModule, undefined, 'WebSkel resolves a relative root itself');
    } finally {
        harness.restore();
    }
    assert.deepEqual(imported, []);
});

test('T6: a failed early import leaves the import to WebSkel', async () => {
    const harness = createHarness({
        importModule: async () => { throw new Error('module unavailable'); }
    });
    try {
        harness.releaseHtml();
        await harness.webSkel.ResourceManager.loadComponent(fileExp());
        assert.equal(harness.loadCalls.length, 1);
        assert.equal(harness.loadCalls[0].presenterModule, undefined);
    } finally {
        harness.restore();
    }
});

test('T6: a component WebSkel already holds is not fetched again', async () => {
    const harness = createHarness({ components: { 'file-exp': { isPromiseFulfilled: true } } });
    try {
        await harness.webSkel.ResourceManager.loadComponent(fileExp());
        assert.deepEqual(harness.requested, []);
        assert.equal(harness.loadCalls.length, 1);
    } finally {
        harness.restore();
    }
});
