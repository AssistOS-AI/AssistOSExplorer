import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadDashboard(fetchImpl, contextOverrides = {}) {
    const source = await readFile(
        new URL('../../dashboard/js/app.mjs', import.meta.url),
        'utf8'
    );
    const storage = new Map();
    const listeners = new Map();
    const window = {
        location: {
            hash: '#logs',
            protocol: 'http:',
            host: 'localhost:7000',
            pathname: '/management/',
        },
        addEventListener(type, handler) {
            const handlers = listeners.get(type) || [];
            handlers.push(handler);
            listeners.set(type, handlers);
        },
        dispatchEvent(event) {
            for (const handler of listeners.get(event.type) || []) {
                handler(event);
            }
        },
        open() {},
    };

    const context = {
        window,
        location: window.location,
        sessionStorage: {
            getItem(key) {
                return storage.get(key) || null;
            },
            setItem(key, value) {
                storage.set(key, String(value));
            },
            removeItem(key) {
                storage.delete(key);
            },
        },
        fetch: fetchImpl,
        URLSearchParams,
        CustomEvent: class CustomEvent {
            constructor(type, init = {}) {
                this.type = type;
                this.detail = init.detail;
            }
        },
        renderMarkdown(value) {
            return String(value ?? '');
        },
        setTimeout: (...args) => setTimeout(...args),
        clearTimeout: (...args) => clearTimeout(...args),
        console,
        ...contextOverrides,
    };
    context.globalThis = context;
    window.window = window;

    vm.runInNewContext(source, context, {
        filename: 'src/dashboard/js/app.mjs',
    });
    return { window, listeners };
}

describe('dashboard logs page', () => {
    it('loads the first selected key logs during initialization', async () => {
        const calls = [];
        const { window } = await loadDashboard(async (path) => {
            calls.push(String(path));
            if (String(path).startsWith('/management/logs/keys?')) {
                return {
                    status: 200,
                    async json() {
                        return {
                            data: [
                                {
                                    api_key_id: 'key-1',
                                    key_label: 'daniel',
                                    key_hint: 'sk-soul-test...0000',
                                    request_count: 4,
                                },
                            ],
                        };
                    },
                };
            }
            if (String(path).startsWith('/management/logs?')) {
                return {
                    status: 200,
                    async json() {
                        return {
                            data: [
                                {
                                    request_id: 'chatcmpl-test',
                                    api_key_id: 'key-1',
                                    requested_model: 'plan',
                                    status: 'succeeded',
                                    http_status: 200,
                                },
                            ],
                            total: 4,
                            limit: 50,
                            offset: 0,
                        };
                    },
                };
            }
            throw new Error(`unexpected dashboard fetch: ${path}`);
        });

        const page = window.logsPage();
        await page.init();

        assert.equal(page.selectedKey.key_label, 'daniel');
        assert.equal(page.logsTotal, 4);
        assert.equal(page.selectedLogs.length, 1);
        assert.ok(
            calls.some((path) =>
                path.includes('/management/logs?') &&
                path.includes('api_key_id=key-1')
            )
        );
    });

    it('uses audit log_id as table identity when request_id is shared', async () => {
        const { window } = await loadDashboard(async (path) => {
            const p = String(path);
            if (p.startsWith('/management/logs/keys?')) {
                return {
                    status: 200,
                    async json() {
                        return {
                            data: [
                                {
                                    api_key_id: 'key-1',
                                    key_label: 'daniel',
                                    key_hint: 'sk...',
                                    request_count: 2,
                                },
                            ],
                        };
                    },
                };
            }
            if (p.startsWith('/management/logs?')) {
                return {
                    status: 200,
                    async json() {
                        return {
                            data: [
                                {
                                    log_id: 'audit-row-new',
                                    request_id: 'chatcmpl-shared',
                                    api_key_id: 'key-1',
                                    requested_model: 'fast',
                                    status: 'succeeded',
                                    http_status: 200,
                                },
                                {
                                    log_id: 'audit-row-old',
                                    request_id: 'chatcmpl-shared',
                                    api_key_id: 'key-1',
                                    requested_model: 'fast',
                                    status: 'succeeded',
                                    http_status: 200,
                                },
                            ],
                            total: 2,
                            limit: 50,
                            offset: 0,
                        };
                    },
                };
            }
            throw new Error(`unexpected dashboard fetch: ${p}`);
        });

        const page = window.logsPage();
        await page.init();

        assert.deepEqual(
            page.selectedLogs.map((log) => log.id),
            ['audit-row-new', 'audit-row-old']
        );
    });

    it('renders a {type:"log", data} stream message into the logs list', async () => {
        const { window } = await loadDashboard(async (path) => {
            const p = String(path);
            if (p.startsWith('/management/logs/keys?')) {
                return { status: 200, async json() {
                    return { data: [{ api_key_id: 'key-1', key_label: 'daniel', key_hint: 'sk-...', request_count: 4 }] };
                } };
            }
            if (p.startsWith('/management/logs?')) {
                return { status: 200, async json() {
                    return { data: [{ request_id: 'chatcmpl-test', api_key_id: 'key-1', requested_model: 'plan', status: 'succeeded', http_status: 200 }], total: 4, limit: 50, offset: 0 };
                } };
            }
            throw new Error(`unexpected dashboard fetch: ${p}`);
        });

        const page = window.logsPage();
        await page.init();                       // selectedKey.list_id === 'key-1'; registers the 'soul-log' listener
        assert.equal(page.selectedKey.list_id, 'key-1');
        const before = page.selectedLogs.length;

        // Drive the EXACT server wire format through the client's handler.
        const raw = JSON.stringify({
            type: 'log',
            data: { request_id: 'live-1', api_key_id: 'key-1', requested_model: 'fast', status: 'succeeded', http_status: 200 },
        });
        window.app()._handleLogMessage(raw);     // parses envelope → dispatches 'soul-log' → logsPage inserts

        assert.equal(page.selectedLogs.length, before + 1);
        assert.equal(page.selectedLogs[0].request_id, 'live-1');
    });

    it('renders the first streamed log when the key list was initially empty', async () => {
        const { window } = await loadDashboard(async (path) => {
            const p = String(path);
            if (p.startsWith('/management/logs/keys?')) {
                return {
                    status: 200,
                    async json() {
                        return { data: [] };
                    },
                };
            }
            if (p.startsWith('/management/logs?')) {
                return {
                    status: 200,
                    async json() {
                        return { data: [], total: 0, limit: 50, offset: 0 };
                    },
                };
            }
            throw new Error(`unexpected dashboard fetch: ${p}`);
        });

        const page = window.logsPage();
        await page.init();

        assert.equal(page.keys.length, 0);
        assert.equal(page.selectedKey, null);
        assert.equal(page.selectedLogs.length, 0);

        const raw = JSON.stringify({
            type: 'log',
            data: {
                log_id: 'live-new-key-log',
                request_id: 'live-new-key-request',
                api_key_id: 'new-key-1',
                requested_model: 'fast',
                status: 'succeeded',
                http_status: 200,
                total_cost: 0,
            },
        });
        window.app()._handleLogMessage(raw);

        assert.equal(page.keys.length, 1);
        assert.equal(page.keys[0].list_id, 'new-key-1');
        assert.equal(page.keys[0].request_count, 1);
        assert.equal(page.selectedKey.list_id, 'new-key-1');
        assert.equal(page.logsTotal, 1);
        assert.equal(page.selectedLogs.length, 1);
        assert.equal(page.selectedLogs[0].id, 'live-new-key-log');
    });

    it('handles one streamed log once when logs page init runs repeatedly', async () => {
        const { window, listeners } = await loadDashboard(async (path) => {
            const p = String(path);
            if (p.startsWith('/management/logs/keys?')) {
                return {
                    status: 200,
                    async json() {
                        return {
                            data: [
                                {
                                    api_key_id: 'key-1',
                                    key_label: 'daniel',
                                    key_hint: 'sk...',
                                    request_count: 1,
                                    total_cost: 0,
                                },
                            ],
                        };
                    },
                };
            }
            if (p.startsWith('/management/logs?')) {
                return {
                    status: 200,
                    async json() {
                        return {
                            data: [
                                {
                                    log_id: 'old-log-id',
                                    request_id: 'old-request',
                                    api_key_id: 'key-1',
                                    requested_model: 'fast',
                                    status: 'succeeded',
                                    http_status: 200,
                                },
                            ],
                            total: 1,
                            limit: 50,
                            offset: 0,
                        };
                    },
                };
            }
            throw new Error(`unexpected dashboard fetch: ${p}`);
        });

        const page = window.logsPage();
        await page.init();
        await page.init();
        await page.init();

        assert.equal((listeners.get('soul-log') || []).length, 1);

        const raw = JSON.stringify({
            type: 'log',
            data: {
                log_id: 'live-log-id',
                request_id: 'live-request',
                api_key_id: 'key-1',
                requested_model: 'fast',
                status: 'succeeded',
                http_status: 200,
            },
        });
        window.app()._handleLogMessage(raw);

        assert.equal(page.keys[0].request_count, 2);
        assert.equal(page.logsTotal, 2);
        assert.deepEqual(
            page.selectedLogs.map((log) => log.id),
            ['live-log-id', 'old-log-id']
        );
    });

    it('does not open duplicate stream connections when app init runs repeatedly', async () => {
        const sockets = [];
        class FakeWebSocket {
            constructor(url) {
                this.url = url;
                sockets.push(this);
            }
            close() {
                this.closed = true;
            }
        }

        const { window } = await loadDashboard(
            async (path) => {
                throw new Error(`unexpected dashboard fetch: ${path}`);
            },
            {
                WebSocket: FakeWebSocket,
                setTimeout() {
                    return 123;
                },
                clearTimeout() {},
            }
        );

        const dashboard = window.app();
        dashboard.init();
        dashboard.init();

        assert.equal(sockets.length, 1);
        assert.equal(sockets[0].url, 'ws://localhost:7000/management/ws/logs');
    });
});
