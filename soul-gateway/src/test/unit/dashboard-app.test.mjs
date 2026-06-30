import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function installDashboardGlobals(fetchImpl) {
    const events = [];
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
    };

    return {
        events,
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
