import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadDashboard(fetchImpl) {
    const source = await readFile(
        new URL('../../dashboard/js/app.mjs', import.meta.url),
        'utf8'
    );
    const storage = new Map();
    const listeners = new Map();
    const window = {
        location: { hash: '#logs', protocol: 'http:', host: 'localhost:8042' },
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
        console,
    };
    context.globalThis = context;
    window.window = window;

    vm.runInNewContext(source, context, {
        filename: 'src/dashboard/js/app.mjs',
    });
    return { window };
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
});
