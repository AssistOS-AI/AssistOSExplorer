/**
 * Live smoke tests for a Ploinky-hosted Soul Gateway.
 *
 * Defaults target the router service prefixes:
 *   GATEWAY_URL=http://localhost:8080
 *   GATEWAY_PUBLIC_BASE_URL=$GATEWAY_URL/services/soul-gateway/v1
 *   GATEWAY_MANAGEMENT_BASE_URL=$GATEWAY_URL/services/soul-gateway/management
 *   GATEWAY_HEALTH_URL=$GATEWAY_URL/public-services/soul-gateway-health/
 *
 * Public API tests need SOUL_GATEWAY_API_KEY or SOUL_API_KEY.
 * Management tests need either PLOINKY_AUTH_COOKIE for the router or
 * SG_TEST_PLOINKY_AUTH_INFO for direct protected-service header testing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const PUBLIC_BASE = process.env.GATEWAY_PUBLIC_BASE_URL || `${GATEWAY_URL}/services/soul-gateway/v1`;
const MANAGEMENT_BASE =
    process.env.GATEWAY_MANAGEMENT_BASE_URL || `${GATEWAY_URL}/services/soul-gateway/management`;
const HEALTH_URL =
    process.env.GATEWAY_HEALTH_URL || `${GATEWAY_URL}/public-services/soul-gateway-health/`;
const API_KEY = process.env.SOUL_GATEWAY_API_KEY || process.env.SOUL_API_KEY || '';
const PLOINKY_AUTH_COOKIE = process.env.PLOINKY_AUTH_COOKIE || '';
const TEST_PLOINKY_AUTH_INFO = process.env.SG_TEST_PLOINKY_AUTH_INFO || '';
const HAS_MANAGEMENT_AUTH = Boolean(PLOINKY_AUTH_COOKIE || TEST_PLOINKY_AUTH_INFO);

async function jsonFetch(url, opts = {}) {
    const res = await fetch(url, opts);
    return {
        status: res.status,
        data: await res.json().catch(() => null),
        headers: res.headers,
    };
}

function managementHeaders(body = null) {
    return {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(PLOINKY_AUTH_COOKIE ? { cookie: PLOINKY_AUTH_COOKIE } : {}),
        ...(TEST_PLOINKY_AUTH_INFO ? { 'x-ploinky-auth-info': TEST_PLOINKY_AUTH_INFO } : {}),
    };
}

function publicHeaders(includeApiKey = true) {
    return {
        'content-type': 'application/json',
        ...(includeApiKey && API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}),
    };
}

describe('Health', () => {
    it('GET public health returns ok', async () => {
        const { status, data } = await jsonFetch(HEALTH_URL);
        assert.equal(status, 200);
        assert.equal(data.ok, true);
        assert.ok(data.uptimeSeconds >= 0);
    });
});

describe('Management auth compatibility', () => {
    it('does not create Soul Gateway dashboard sessions', { skip: !HAS_MANAGEMENT_AUTH }, async () => {
        const { status, data } = await jsonFetch(`${MANAGEMENT_BASE}/auth/login`, {
            method: 'POST',
            headers: managementHeaders({ password: 'unused' }),
            body: JSON.stringify({ password: 'unused' }),
        });
        assert.equal(status, 410);
        assert.equal(data.ok, false);
        assert.equal(data.error.type, 'ploinky_auth_required');
    });
});

describe('Public API', () => {
    it('POST /chat/completions without API key returns 401', async () => {
        const { status } = await jsonFetch(`${PUBLIC_BASE}/chat/completions`, {
            method: 'POST',
            headers: publicHeaders(false),
            body: JSON.stringify({
                model: 'test',
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        assert.equal(status, 401);
    });

    it('GET /models without API key returns 401', async () => {
        const { status, data } = await jsonFetch(`${PUBLIC_BASE}/models`, {
            headers: publicHeaders(false),
        });
        assert.equal(status, 401);
        assert.equal(data.error.type, 'authentication_required');
    });

    it('GET /models returns a list with a configured API key', { skip: !API_KEY }, async () => {
        const { status, data } = await jsonFetch(`${PUBLIC_BASE}/models`, {
            headers: publicHeaders(true),
        });
        assert.equal(status, 200);
        assert.equal(data.object, 'list');
        assert.ok(Array.isArray(data.data));
    });

    it('POST with unknown model reaches API-key auth and model resolution', { skip: !API_KEY }, async () => {
        const { status, data } = await jsonFetch(`${PUBLIC_BASE}/chat/completions`, {
            method: 'POST',
            headers: publicHeaders(true),
            body: JSON.stringify({
                model: 'nonexistent/model-xyz',
                messages: [{ role: 'user', content: 'hello' }],
            }),
        });
        assert.equal(status, 404, `Expected 404, got ${status}: ${JSON.stringify(data)}`);
        assert.equal(data.error.type, 'model_not_found');
    });
});

describe('Management operator smoke', { skip: !HAS_MANAGEMENT_AUTH }, () => {
    it('GET /models succeeds with Ploinky admin identity', async () => {
        const { status, data } = await jsonFetch(`${MANAGEMENT_BASE}/models`, {
            headers: managementHeaders(),
        });
        assert.equal(status, 200);
        assert.ok(Array.isArray(data.data || data));
    });

    it('GET /management dashboard shell returns HTML with Ploinky admin identity', async () => {
        const res = await fetch(MANAGEMENT_BASE, {
            headers: managementHeaders(),
        });
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('content-type')?.includes('text/html'));
    });
});
