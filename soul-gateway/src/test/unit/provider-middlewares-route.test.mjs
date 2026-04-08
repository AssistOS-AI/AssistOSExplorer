import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleListProviderMiddlewareBindings } from '../../management/provider-middlewares-route.mjs';

function createMockRes() {
    return {
        statusCode: null,
        headers: {},
        body: '',
        writeHead(status, headers) {
            this.statusCode = status;
            Object.assign(this.headers, headers);
        },
        end(data = '') {
            this.body += data;
        },
    };
}

describe('provider-middlewares-route', () => {
    it('returns provider bindings as a flat ordered array', async () => {
        const pool = {
            async query(sql, params) {
                assert.match(sql, /middleware_bindings/);
                assert.deepEqual(params, ['provider', 'provider-1']);
                return {
                    rows: [
                        {
                            id: 'binding-2',
                            target_id: 'provider-1',
                            middleware_key: 'provider-response-filter',
                            sort_order: 20,
                            enabled: false,
                            settings: {},
                            created_at: '2026-04-08T10:05:00.000Z',
                            updated_at: '2026-04-08T10:05:00.000Z',
                        },
                        {
                            id: 'binding-1',
                            target_id: 'provider-1',
                            middleware_key: 'provider-prompt-injector',
                            sort_order: 10,
                            enabled: true,
                            settings: { content: 'hello' },
                            created_at: '2026-04-08T10:00:00.000Z',
                            updated_at: '2026-04-08T10:00:00.000Z',
                        },
                    ],
                };
            },
        };

        const res = createMockRes();

        await handleListProviderMiddlewareBindings({
            res,
            params: { providerId: 'provider-1' },
            appCtx: { pool },
        });

        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(Object.keys(body), ['bindings']);
        assert.equal(body.bindings.length, 2);
        // Sorted by sort_order ascending
        assert.equal(body.bindings[0].id, 'binding-1');
        assert.equal(body.bindings[1].id, 'binding-2');
        assert.deepEqual(body.bindings[0], {
            id: 'binding-1',
            provider_id: 'provider-1',
            middleware_key: 'provider-prompt-injector',
            sort_order: 10,
            enabled: true,
            settings: { content: 'hello' },
            created_at: '2026-04-08T10:00:00.000Z',
            updated_at: '2026-04-08T10:00:00.000Z',
        });
    });
});
