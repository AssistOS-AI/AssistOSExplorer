import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    handleCreateProviderMiddlewareBinding,
    handleListProviderMiddlewareBindings,
} from '../../management/provider-middlewares-route.mjs';

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

function createMockReq(body) {
    const listeners = new Map();
    return {
        headers: { 'content-type': 'application/json' },
        on(event, handler) {
            listeners.set(event, handler);
            if (event === 'data') {
                process.nextTick(() =>
                    handler(Buffer.from(JSON.stringify(body)))
                );
            }
            if (event === 'end') {
                process.nextTick(() => handler());
            }
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
        // Sorted by sortOrder ascending
        assert.equal(body.bindings[0].id, 'binding-1');
        assert.equal(body.bindings[1].id, 'binding-2');
        assert.deepEqual(body.bindings[0], {
            id: 'binding-1',
            providerId: 'provider-1',
            middlewareKey: 'provider-prompt-injector',
            sortOrder: 10,
            enabled: true,
            settings: { content: 'hello' },
            createdAt: '2026-04-08T10:00:00.000Z',
            updatedAt: '2026-04-08T10:00:00.000Z',
        });
    });

    it('rejects unknown provider middleware keys on create', async () => {
        const req = createMockReq({
            middlewareKey: 'not-a-real-provider-middleware',
        });
        const res = createMockRes();

        await assert.rejects(
            () =>
                handleCreateProviderMiddlewareBinding({
                    req,
                    res,
                    params: { providerId: 'provider-1' },
                    appCtx: {
                        pool: {
                            async query() {
                                throw new Error(
                                    'should not reach middleware_bindings insert'
                                );
                            },
                        },
                        services: {
                            providerMiddlewareRegistry: {
                                get() {
                                    return null;
                                },
                            },
                            refreshRuntime: async () => ({}),
                        },
                    },
                }),
            /Unknown provider middleware 'not-a-real-provider-middleware'/
        );
    });
});
