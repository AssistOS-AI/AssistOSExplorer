import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function installDashboardGlobals(fetchImpl, options = {}) {
    const events = [];
    const listeners = new Map();
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
    const storageApi = {
        getItem(key) {
            return storage.has(key) ? storage.get(key) : null;
        },
        setItem(key, value) {
            storage.set(key, String(value));
        },
        removeItem(key) {
            storage.delete(key);
        },
    };
    const testWindow = {
        location: {
            pathname: '/management/',
            search: '',
            hash: '',
            origin: 'http://127.0.0.1',
        },
        addEventListener(type, handler) {
            const handlers = listeners.get(type) || [];
            handlers.push(handler);
            listeners.set(type, handlers);
        },
        removeEventListener(type, handler) {
            const handlers = listeners.get(type) || [];
            listeners.set(
                type,
                handlers.filter((candidate) => candidate !== handler)
            );
        },
        dispatchEvent(event) {
            events.push(event);
            for (const handler of listeners.get(event.type) || []) {
                handler(event);
            }
            return true;
        },
    };
    Object.defineProperty(testWindow, 'localStorage', {
        configurable: true,
        get() {
            if (options.localStorageThrows) {
                throw new Error('blocked storage');
            }
            return storageApi;
        },
    });
    globalThis.window = testWindow;

    return {
        events,
        listeners,
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

describe('dashboard app shell', () => {
    it('syncs external hash changes into the visible page', async () => {
        const globals = installDashboardGlobals(async (url) => {
            throw new Error(`unexpected request: ${url}`);
        });

        try {
            const cacheKey = `${Date.now()}${Math.random()}`;
            await import(`../../dashboard/js/app.mjs?test=${cacheKey}`);

            const shell = globalThis.window.app();
            shell.connectWs = () => {};
            shell.init();

            assert.equal(shell.page, 'providers');
            assert.equal(
                globals.listeners.get('hashchange')?.length,
                1,
                'app should register one hashchange listener'
            );

            globalThis.window.location.hash = '#models';
            globalThis.window.dispatchEvent(new CustomEvent('hashchange'));

            assert.equal(shell.page, 'models');
            assert.ok(
                globals.events.some(
                    (event) =>
                        event.type === 'page-change' &&
                        event.detail === 'models'
                ),
                'external hash changes should notify mounted tab components'
            );
        } finally {
            globals.restore();
        }
    });
});

describe('dashboard tree persistence', () => {
    it('initializes providers and models when localStorage is unavailable', async () => {
        const globals = installDashboardGlobals(
            async (url) => {
                if (url === '/management/providers') {
                    return jsonResponse({
                        data: [
                            {
                                id: 'p1',
                                provider_key: 'agent:AchillesIDE/explorer',
                                display_name:
                                    'Ploinky agent agent:AchillesIDE/explorer',
                                enabled: true,
                            },
                        ],
                    });
                }
                if (url === '/management/providers/templates') {
                    return jsonResponse({ templates: {} });
                }
                if (url === '/management/models') {
                    return jsonResponse({
                        data: [
                            {
                                id: 'm1',
                                model_key: 'AchillesIDE/explorer',
                                display_name: 'Explorer Default',
                                enabled: true,
                                tags: [],
                            },
                        ],
                    });
                }
                if (url === '/management/models/providers') {
                    return jsonResponse({ data: [] });
                }
                if (url === '/management/models/tags') {
                    return jsonResponse({ data: [] });
                }
                throw new Error(`unexpected request: ${url}`);
            },
            { localStorageThrows: true }
        );

        try {
            const cacheKey = `${Date.now()}${Math.random()}`;
            await import(`../../dashboard/js/tree-view.js?test=${cacheKey}`);
            await import(`../../dashboard/js/app.mjs?test=${cacheKey}`);

            const providers = globalThis.window.providersPage();
            await providers.init();
            assert.equal(providers.providers.length, 1);
            assert.equal(
                providers.providerTreeRows.some(
                    (row) =>
                        row.rowType === 'leaf' &&
                        row.key === 'agent:AchillesIDE/explorer'
                ),
                true
            );

            const models = globalThis.window.modelsPage();
            await models.init();
            assert.equal(models.models.length, 1);
            assert.equal(
                models.modelTreeRows.some(
                    (row) =>
                        row.rowType === 'leaf' &&
                        row.key === 'AchillesIDE/explorer'
                ),
                true
            );
        } finally {
            globals.restore();
        }
    });
});

describe('dashboard activity page', () => {
    it('keeps expanded logs and details independent for each API key', async () => {
        const requests = [];
        const globals = installDashboardGlobals(async (url) => {
            requests.push(String(url));
            if (String(url).startsWith('/management/metrics/activity?')) {
                return jsonResponse({
                    by_key: [
                        {
                            api_key_id: 'key-a',
                            key_label: 'Key A',
                            key_hint: 'a',
                            request_count: 2,
                        },
                        {
                            api_key_id: 'key-b',
                            key_label: 'Key B',
                            key_hint: 'b',
                            request_count: 3,
                        },
                    ],
                });
            }

            if (String(url).startsWith('/management/logs?')) {
                const params = new URLSearchParams(String(url).split('?')[1]);
                const keyId = params.get('api_key_id');
                return jsonResponse({
                    total: 1,
                    data: [
                        {
                            id: `${keyId}-log`,
                            request_id: `${keyId}-request`,
                            started_at: '2026-06-30T12:00:00Z',
                            resolved_model: 'fast',
                        },
                    ],
                });
            }

            if (String(url).startsWith('/management/logs/key-a-request')) {
                return jsonResponse({
                    log: {
                        id: 'key-a-log',
                        request_id: 'key-a-request',
                        request_payload: {
                            messages: [
                                { role: 'system', content: 'Planner rules' },
                                { role: 'user', content: 'Earlier request' },
                                { role: 'assistant', content: 'Earlier answer' },
                                { role: 'user', content: 'A' },
                            ],
                        },
                        response_payload: {
                            choices: [
                                {
                                    message: { content: 'A response' },
                                    finish_reason: 'stop',
                                },
                            ],
                        },
                    },
                });
            }

            if (String(url).startsWith('/management/logs/key-b-request')) {
                return jsonResponse({
                    log: {
                        id: 'key-b-log',
                        request_id: 'key-b-request',
                        request_payload: {
                            messages: [{ role: 'user', content: 'B' }],
                        },
                        response_payload: {
                            choices: [
                                {
                                    message: { content: 'B response' },
                                    finish_reason: 'stop',
                                },
                            ],
                        },
                    },
                });
            }

            throw new Error(`unexpected request: ${url}`);
        });

        try {
            const cacheKey = `${Date.now()}${Math.random()}`;
            await import(`../../dashboard/js/app.mjs?test=${cacheKey}`);

            const page = globalThis.window.activityPage();
            await page.init();

            const [keyA, keyB] = page.keyData;
            await page.toggleKey(keyA);
            await page.toggleKey(keyB);

            assert.equal(keyA._expanded, true);
            assert.equal(keyB._expanded, true);
            assert.deepEqual(
                keyA._logs.map((log) => log.id),
                ['key-a-log']
            );
            assert.deepEqual(
                keyB._logs.map((log) => log.id),
                ['key-b-log']
            );

            await page.toggleDetail(keyA, keyA._logs[0]);
            await page.toggleDetail(keyB, keyB._logs[0]);

            assert.equal(keyA._expandedDetail, 'key-a-log');
            assert.equal(keyB._expandedDetail, 'key-b-log');
            assert.match(
                keyA._logs[0]._detail.response_content,
                /A response/
            );
            assert.deepEqual(
                keyA._logs[0]._detail.request_messages,
                [
                    { role: 'system', content: 'Planner rules' },
                    { role: 'user', content: 'Earlier request' },
                    { role: 'assistant', content: 'Earlier answer' },
                    { role: 'user', content: 'A' },
                ]
            );
            assert.match(
                keyB._logs[0]._detail.response_content,
                /B response/
            );

            await page.toggleKey(keyA);

            assert.equal(keyA._expanded, false);
            assert.deepEqual(keyA._logs, []);
            assert.equal(keyB._expanded, true);
            assert.deepEqual(
                keyB._logs.map((log) => log.id),
                ['key-b-log']
            );
            assert.equal(keyB._expandedDetail, 'key-b-log');
            assert.deepEqual(
                requests.filter((url) => url.startsWith('/management/logs?')),
                [
                    '/management/logs?api_key_id=key-a&limit=50&offset=0&sort=started_at&order=desc',
                    '/management/logs?api_key_id=key-b&limit=50&offset=0&sort=started_at&order=desc',
                ]
            );
        } finally {
            globals.restore();
        }
    });
});

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
            page.providerTreeExpanded = new Set();
            assert.deepEqual(
                page.providerTreeRows.map((row) => ({
                    type: row.rowType,
                    key: row.key,
                    expanded: row.expanded,
                })),
                [
                    {
                        type: 'group',
                        key: 'AchillesIDE',
                        expanded: true,
                    },
                    {
                        type: 'leaf',
                        key: 'agent:AchillesIDE/explorer',
                        expanded: undefined,
                    },
                    {
                        type: 'leaf',
                        key: 'agent:AchillesIDE/gitAgent',
                        expanded: undefined,
                    },
                ]
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

describe('dashboard models page', () => {
    function modelFixtures() {
        return [
            {
                id: 'm1',
                model_key: 'axl-proxy/mistral/codestral-2508',
                display_name: 'Codestral 2508',
                enabled: true,
                is_free: false,
                tags: ['coding'],
            },
            {
                id: 'm2',
                model_key: 'axl-proxy/mistral/codestral-latest',
                display_name: 'Codestral Latest',
                enabled: true,
                is_free: true,
                tags: ['coding'],
            },
            {
                id: 'm3',
                model_key: 'axl-proxy/copilot-agents/codexAgent',
                display_name: 'Codex Agent',
                enabled: false,
                is_free: false,
                tags: ['agentic'],
            },
            {
                id: 'm4',
                model_key: 'AchillesIDE/explorer',
                display_name: 'AchillesIDE Explorer',
                enabled: true,
                is_free: false,
                tags: [],
            },
        ];
    }

    async function initModelsPage(models = modelFixtures()) {
        const requests = [];
        const globals = installDashboardGlobals(async (url) => {
            requests.push(url);
            if (url === '/management/models') {
                return jsonResponse({ data: models });
            }
            if (url === '/management/models/providers') {
                return jsonResponse({ data: [] });
            }
            if (url === '/management/models/tags') {
                return jsonResponse({ data: ['agentic', 'coding'] });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        const cacheKey = `${Date.now()}${Math.random()}`;
        await import(`../../dashboard/js/tree-view.js?test=${cacheKey}`);
        await import(`../../dashboard/js/app.mjs?test=${cacheKey}`);

        const page = globalThis.window.modelsPage();
        await page.init();

        return { globals, models, page, requests };
    }

    it('keeps filtered model counts flat after model filters', async () => {
        const { globals, page, requests } = await initModelsPage();

        try {
            assert.deepEqual(requests, [
                '/management/models',
                '/management/models/providers',
                '/management/models/tags',
            ]);

            assert.equal(page.filteredModels.length, 4);

            page.modelEnabledOnly = true;
            assert.equal(page.filteredModels.length, 3);
            assert.deepEqual(
                page.filteredModels.map((model) => model.id),
                ['m1', 'm2', 'm4']
            );

            page.modelEnabledOnly = false;
            page.freeOnly = true;
            assert.equal(page.filteredModels.length, 1);
            assert.deepEqual(
                page.filteredModels.map((model) => model.id),
                ['m2']
            );

            page.freeOnly = false;
            page.tagFilter = 'coding';
            assert.equal(page.filteredModels.length, 2);
            assert.deepEqual(
                page.filteredModels.map((model) => model.id),
                ['m1', 'm2']
            );
        } finally {
            globals.restore();
        }
    });

    it('builds model tree rows while preserving raw model objects and namespaced keys', async () => {
        const { globals, models, page } = await initModelsPage();

        try {
            const rows = page.modelTreeRows;
            assert.deepEqual(
                rows.map((row) => ({
                    type: row.rowType,
                    label: row.label,
                    depth: row.depth,
                    key: row.key,
                    modelKey: row.item?.model_key,
                })),
                [
                    {
                        type: 'group',
                        label: 'AchillesIDE',
                        depth: 0,
                        key: 'AchillesIDE',
                        modelKey: undefined,
                    },
                    {
                        type: 'leaf',
                        label: 'explorer',
                        depth: 1,
                        key: 'AchillesIDE/explorer',
                        modelKey: 'AchillesIDE/explorer',
                    },
                    {
                        type: 'group',
                        label: 'axl-proxy',
                        depth: 0,
                        key: 'axl-proxy',
                        modelKey: undefined,
                    },
                    {
                        type: 'leaf',
                        label: 'copilot-agents/codexAgent',
                        depth: 1,
                        key: 'axl-proxy/copilot-agents/codexAgent',
                        modelKey: 'axl-proxy/copilot-agents/codexAgent',
                    },
                    {
                        type: 'group',
                        label: 'mistral',
                        depth: 1,
                        key: 'axl-proxy/mistral',
                        modelKey: undefined,
                    },
                    {
                        type: 'leaf',
                        label: 'codestral-2508',
                        depth: 2,
                        key: 'axl-proxy/mistral/codestral-2508',
                        modelKey: 'axl-proxy/mistral/codestral-2508',
                    },
                    {
                        type: 'leaf',
                        label: 'codestral-latest',
                        depth: 2,
                        key: 'axl-proxy/mistral/codestral-latest',
                        modelKey: 'axl-proxy/mistral/codestral-latest',
                    },
                ]
            );
            assert.equal(rows[1].item, models[3]);
            assert.equal(rows[3].item, models[2]);
            assert.equal(rows[5].item, models[0]);
            assert.equal(rows[6].item, models[1]);

            assert.equal(
                page.modelTreeRowKey({ rowType: 'group', path: 'axl-proxy' }),
                'group:axl-proxy'
            );
            assert.deepEqual(rows.map((row) => page.modelTreeRowKey(row)), [
                'group:AchillesIDE',
                'model:AchillesIDE/explorer',
                'group:axl-proxy',
                'model:axl-proxy/copilot-agents/codexAgent',
                'group:axl-proxy/mistral',
                'model:axl-proxy/mistral/codestral-2508',
                'model:axl-proxy/mistral/codestral-latest',
            ]);
            assert.ok(page.modelTreeRowKey(rows[1]).startsWith('model:'));
        } finally {
            globals.restore();
        }
    });

    it('matches model tree filters against tags and raw or display text', async () => {
        const { globals, page } = await initModelsPage();

        try {
            page.modelFilter = 'coding';
            assert.deepEqual(
                page.filteredModels.map((model) => model.id),
                ['m1', 'm2']
            );
            page.modelTreeExpanded = new Set();
            assert.deepEqual(
                page.modelTreeRows.map((row) => ({
                    type: row.rowType,
                    key: row.key,
                    expanded: row.expanded,
                })),
                [
                    {
                        type: 'group',
                        key: 'axl-proxy',
                        expanded: true,
                    },
                    {
                        type: 'group',
                        key: 'axl-proxy/mistral',
                        expanded: true,
                    },
                    {
                        type: 'leaf',
                        key: 'axl-proxy/mistral/codestral-2508',
                        expanded: undefined,
                    },
                    {
                        type: 'leaf',
                        key: 'axl-proxy/mistral/codestral-latest',
                        expanded: undefined,
                    },
                ]
            );

            page.modelFilter = 'AchillesIDE';
            assert.deepEqual(
                page.filteredModels.map((model) => model.id),
                ['m4']
            );
        } finally {
            globals.restore();
        }
    });

    it('keeps tag-filtered model tree matches visible under collapsed groups', async () => {
        const { globals, page } = await initModelsPage();

        try {
            page.modelTreeExpanded = new Set();
            page.tagFilter = 'coding';

            assert.equal(page.hasActiveModelFilters, true);
            assert.deepEqual(
                page.modelTreeRows.map((row) => ({
                    type: row.rowType,
                    key: row.key,
                    expanded: row.expanded,
                })),
                [
                    {
                        type: 'group',
                        key: 'axl-proxy',
                        expanded: true,
                    },
                    {
                        type: 'group',
                        key: 'axl-proxy/mistral',
                        expanded: true,
                    },
                    {
                        type: 'leaf',
                        key: 'axl-proxy/mistral/codestral-2508',
                        expanded: undefined,
                    },
                    {
                        type: 'leaf',
                        key: 'axl-proxy/mistral/codestral-latest',
                        expanded: undefined,
                    },
                ]
            );
        } finally {
            globals.restore();
        }
    });
});
