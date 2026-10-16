import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const htmlPath = new URL('../../dashboard/index.html', import.meta.url);
const html = readFileSync(htmlPath, 'utf8');

function installGlobals(hash) {
    const requests = [];
    const previous = {
        window: globalThis.window,
        fetch: globalThis.fetch,
        location: globalThis.location,
    };
    globalThis.window = {
        location: {
            pathname: '/management/',
            search: '',
            hash,
            origin: 'http://127.0.0.1',
        },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
            return true;
        },
    };
    globalThis.location = {
        protocol: 'http:',
        host: '127.0.0.1',
    };
    globalThis.fetch = async (url) => {
        requests.push(String(url));
        return {
            status: 200,
            redirected: false,
            url: String(url),
            async json() {
                return [];
            },
        };
    };
    return {
        requests,
        restore() {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        },
    };
}

async function loadDashboard() {
    const key = `${Date.now()}${Math.random()}`;
    await import(`../../dashboard/js/tree-view.js?lazy=${key}`);
    await import(`../../dashboard/js/app.mjs?lazy=${key}`);
    return globalThis.window;
}

describe('dashboard markup init wiring', () => {
    it('does not call init() from x-init (Alpine already calls it)', () => {
        const matches = html.match(/x-init="init\(\)"/g) || [];
        assert.equal(matches.length, 0);
    });

    it('gives every lazy tab component its own page id', () => {
        const factories = [...html.matchAll(/x-data="(\w+Page)\('(\w+)'\)"/g)];
        const ids = factories.map((m) => m[2]).sort();
        assert.deepEqual(ids, [
            'activity', 'blacklist', 'costs', 'errors', 'export', 'keys',
            'logs', 'middlewares', 'models', 'providers', 'tiers',
        ]);
    });
});

describe('dashboard lazy tab initialisation', () => {
    it('skips the initial fetch while the tab is not active', async () => {
        const globals = installGlobals('');
        try {
            const win = await loadDashboard();
            const names = [
                'logsPage', 'costsPage', 'activityPage', 'errorsPage',
                'modelsPage', 'tiersPage', 'keysPage', 'blacklistPage',
                'middlewaresPage', 'exportPage',
            ];
            for (const name of names) {
                const page = win[name](name.replace(/Page$/, ''));
                await page.init();
            }
            assert.deepEqual(globals.requests, []);
        } finally {
            globals.restore();
        }
    });

    it('loads the landing tab on mount and refreshes on every page-change', async () => {
        const globals = installGlobals('');
        try {
            const win = await loadDashboard();
            const page = win.providersPage('providers');
            await page.init();
            assert.equal(globals.requests.length, 2);
            await page.init();
            assert.equal(globals.requests.length, 4);
        } finally {
            globals.restore();
        }
    });

    it('loads a deep-linked tab and defers it otherwise', async () => {
        const globals = installGlobals('#blacklist');
        try {
            const win = await loadDashboard();
            const providers = win.providersPage('providers');
            await providers.init();
            assert.equal(globals.requests.length, 0);

            const blacklist = win.blacklistPage('blacklist');
            await blacklist.init();
            assert.equal(globals.requests.length, 1);
            assert.match(globals.requests[0], /blacklist\/rules/);

            win.location.hash = '#providers';
            await providers.init();
            assert.equal(globals.requests.length, 3);
        } finally {
            globals.restore();
        }
    });

    it('loads once-only tabs a single time and ignores unknown hashes', async () => {
        const globals = installGlobals('#export');
        try {
            const win = await loadDashboard();
            const page = win.exportPage('export');
            await page.init();
            const afterFirst = globals.requests.length;
            assert.ok(afterFirst > 0);
            await page.init();
            assert.equal(globals.requests.length, afterFirst);

            win.location.hash = '#bogus';
            const providers = win.providersPage('providers');
            await providers.init();
            assert.equal(globals.requests.length, afterFirst + 2);
        } finally {
            globals.restore();
        }
    });

    it('keeps components created without a page id eager', async () => {
        const globals = installGlobals('#models');
        try {
            const win = await loadDashboard();
            await win.blacklistPage().init();
            assert.equal(globals.requests.length, 1);
        } finally {
            globals.restore();
        }
    });
});
