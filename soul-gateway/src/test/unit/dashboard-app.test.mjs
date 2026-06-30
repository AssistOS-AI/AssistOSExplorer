import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function installDashboardGlobals(fetchImpl) {
    const events = [];
    const storage = new Map();
    const previous = {
        window: globalThis.window,
        CustomEvent: globalThis.CustomEvent,
        fetch: globalThis.fetch,
        alert: globalThis.alert,
    };

    class TestCustomEvent {
        constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
        }
    }

    globalThis.CustomEvent = TestCustomEvent;
    globalThis.alert = () => {};
    globalThis.fetch = fetchImpl;
    globalThis.window = {
        location: {
            pathname: '/management/',
            search: '',
            hash: '',
            origin: 'http://127.0.0.1',
        },
        addEventListener() {},
        dispatchEvent(event) {
            events.push(event);
        },
        localStorage: {
            getItem(key) {
                return storage.has(key) ? storage.get(key) : null;
            },
            setItem(key, value) {
                storage.set(key, String(value));
            },
            removeItem(key) {
                storage.delete(key);
            },
        },
    };

    return {
        events,
        storage,
        restore() {
            if (previous.window === undefined) {
                delete globalThis.window;
            } else {
                globalThis.window = previous.window;
            }
            if (previous.CustomEvent === undefined) {
                delete globalThis.CustomEvent;
            } else {
                globalThis.CustomEvent = previous.CustomEvent;
            }
            if (previous.fetch === undefined) {
                delete globalThis.fetch;
            } else {
                globalThis.fetch = previous.fetch;
            }
            if (previous.alert === undefined) {
                delete globalThis.alert;
            } else {
                globalThis.alert = previous.alert;
            }
        },
    };
}

function jsonResponse(payload) {
    return {
        status: 200,
        redirected: false,
        url: 'http://127.0.0.1/management/mock',
        async json() {
            return payload;
        },
    };
}

describe('dashboard providers page', () => {
    it('uses tree rows with display labels while preserving raw provider items', async () => {
        const providers = [
            {
                id: 'p1',
                provider_key: 'agent:AchillesIDE/explorer',
                display_name: 'Ploinky agent agent:AchillesIDE/explorer',
                enabled: true,
            },
            {
                id: 'p2',
                provider_key: 'agent:AchillesIDE/gitAgent',
                display_name: 'Ploinky agent agent:AchillesIDE/gitAgent',
                enabled: false,
            },
            {
                id: 'p3',
                provider_key: 'axl-proxy',
                display_name: 'AXL Proxy',
                enabled: true,
            },
            {
                id: 'p4',
                provider_key: 'AchillesIDE',
                display_name: 'AchillesIDE',
                enabled: true,
            },
        ];
        const requests = [];
        const globals = installDashboardGlobals(async (url) => {
            requests.push(url);
            if (url === '/management/providers') {
                return jsonResponse({ data: providers });
            }
            if (url === '/management/providers/templates') {
                return jsonResponse({ templates: {} });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        try {
            const cacheKey = `${Date.now()}${Math.random()}`;
            await import(`../../dashboard/js/tree-view.js?test=${cacheKey}`);
            await import(`../../dashboard/js/app.mjs?test=${cacheKey}`);

            const page = globalThis.window.providersPage();
            await page.init();

            assert.deepEqual(requests, [
                '/management/providers',
                '/management/providers/templates',
            ]);
            assert.equal(
                page.providerDisplayKey(providers[0]),
                'AchillesIDE/explorer'
            );
            assert.equal(
                page.providerDisplayName(providers[0]),
                'Ploinky agent AchillesIDE/explorer'
            );

            const rows = page.providerTreeRows;
            assert.deepEqual(
                rows.map((row) => ({
                    type: row.rowType,
                    label: row.label,
                    depth: row.depth,
                    key: row.key,
                })),
                [
                    {
                        type: 'group',
                        label: 'AchillesIDE',
                        depth: 0,
                        key: 'AchillesIDE',
                    },
                    {
                        type: 'leaf',
                        label: 'explorer',
                        depth: 1,
                        key: 'agent:AchillesIDE/explorer',
                    },
                    {
                        type: 'leaf',
                        label: 'gitAgent',
                        depth: 1,
                        key: 'agent:AchillesIDE/gitAgent',
                    },
                    {
                        type: 'leaf',
                        label: 'AchillesIDE',
                        depth: 0,
                        key: 'AchillesIDE',
                    },
                    {
                        type: 'leaf',
                        label: 'AXL Proxy',
                        depth: 0,
                        key: 'axl-proxy',
                    },
                ]
            );
            assert.equal(rows[1].item, providers[0]);
            assert.equal(
                rows[1].item.provider_key,
                'agent:AchillesIDE/explorer'
            );
            assert.equal(rows[0].count, 2);
            assert.equal(rows[0].enabledCount, 1);
            assert.deepEqual(rows.map((row) => row.key), [
                'AchillesIDE',
                'agent:AchillesIDE/explorer',
                'agent:AchillesIDE/gitAgent',
                'AchillesIDE',
                'axl-proxy',
            ]);
            assert.deepEqual(rows.map((row) => page.providerTreeRowKey(row)), [
                'group:AchillesIDE',
                'provider:agent:AchillesIDE/explorer',
                'provider:agent:AchillesIDE/gitAgent',
                'provider:AchillesIDE',
                'provider:axl-proxy',
            ]);

            page.providerFilter = 'agent:AchillesIDE';
            assert.deepEqual(
                page.filteredProviders.map((provider) => provider.id),
                ['p1', 'p2']
            );
            page.providerFilter = 'AXL';
            assert.deepEqual(
                page.filteredProviders.map((provider) => provider.id),
                ['p3']
            );
            page.providerFilter = 'missing';
            assert.deepEqual(page.filteredProviders, []);
            assert.equal(
                page.providerEmptyMessage(),
                'No providers match filter'
            );
            page.providers = [];
            page.providerFilter = '';
            assert.equal(
                page.providerEmptyMessage(),
                'No providers configured. Click "Add Provider" to get started.'
            );
        } finally {
            globals.restore();
        }
    });

    it('notifies mounted model tables to refresh after provider model sync', async () => {
        const requests = [];
        const globals = installDashboardGlobals(async (url, options = {}) => {
            requests.push({ url, options });
            if (
                url === '/management/providers/p1/sync-models' &&
                options.method === 'POST'
            ) {
                return jsonResponse({
                    discovered: 1,
                    created: 1,
                    updated: 0,
                    disabled: 0,
                });
            }
            if (url === '/management/providers') {
                return jsonResponse({
                    data: [{ id: 'p1', provider_key: 'codex-api' }],
                });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        try {
            await import(
                `../../dashboard/js/app.mjs?test=${Date.now()}${Math.random()}`
            );
            const page = globalThis.window.providersPage();

            await page.syncModels({
                id: 'p1',
                provider_key: 'codex-api',
                display_name: 'Codex API',
            });

            assert.equal(requests.length, 2);
            assert.ok(
                globals.events.some(
                    (event) =>
                        event.type === 'provider-models-synced' &&
                        event.detail.providerId === 'p1'
                ),
                'provider sync should notify the models page to refetch rows'
            );
        } finally {
            globals.restore();
        }
    });
});
