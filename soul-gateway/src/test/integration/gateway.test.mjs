/**
 * Integration tests for the Soul Gateway v2.
 *
 * These tests run against a live gateway instance at GATEWAY_URL (default: http://localhost:8042).
 * Prerequisites:
 *   - Gateway is running with PostgreSQL connected
 *   - Schema is initialized (migrations applied)
 *   - DASHBOARD_PASSWORD is set (default: soulpass!321)
 *
 * Run: GATEWAY_URL=http://localhost:8042 node --test src/test/integration/gateway.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.GATEWAY_URL || 'http://localhost:8042';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'soulpass!321';

let adminToken = '';

async function api(method, path, body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    return {
        status: res.status,
        data: await res.json().catch(() => null),
        headers: res.headers,
    };
}

// ── Health ───────────────────────────────────────────────────────────

describe('Health', () => {
    it('GET /healthz returns ok with db status', async () => {
        const { status, data } = await api('GET', '/healthz');
        assert.equal(status, 200);
        assert.equal(data.ok, true);
        assert.equal(data.db, true);
        assert.ok(data.snapshotGeneration >= 1);
        assert.ok(data.uptimeSeconds >= 0);
    });
});

// ── Auth ─────────────────────────────────────────────────────────────

describe('Dashboard Auth', () => {
    it('POST /management/auth/login succeeds with correct password', async () => {
        const { status, data } = await api('POST', '/management/auth/login', {
            password: DASHBOARD_PASSWORD,
        });
        assert.equal(status, 200);
        assert.equal(data.ok, true);
        assert.ok(data.token);
        assert.ok(data.csrfToken);
        assert.ok(data.expiresAt > Date.now());
        adminToken = data.token;
    });

    it('POST /management/auth/login fails with wrong password', async () => {
        const { status } = await api('POST', '/management/auth/login', {
            password: 'wrong',
        });
        assert.equal(status, 401);
    });

    it('GET /management/auth/session validates token', async () => {
        const { status, data } = await api('GET', '/management/auth/session');
        assert.equal(status, 200);
        assert.equal(data.authenticated, true);
    });
});

// ── Models ───────────────────────────────────────────────────────────

describe('Public API — /v1/models', () => {
    it('GET /v1/models returns a list', async () => {
        const { status, data } = await api('GET', '/v1/models');
        assert.equal(status, 200);
        assert.equal(data.object, 'list');
        assert.ok(Array.isArray(data.data));
    });
});

describe('Management — Models', () => {
    it('GET /management/models returns models array', async () => {
        const { status, data } = await api('GET', '/management/models');
        assert.equal(status, 200);
        assert.ok(Array.isArray(data.data || data));
    });
});

// ── Providers ────────────────────────────────────────────────────────

describe('Management — Providers', () => {
    it('GET /management/providers returns providers', async () => {
        const { status, data } = await api('GET', '/management/providers');
        assert.equal(status, 200);
        assert.ok(Array.isArray(data.data || data));
    });

    it('GET /management/providers/templates returns templates', async () => {
        const { status, data } = await api(
            'GET',
            '/management/providers/templates'
        );
        assert.equal(status, 200);
        assert.ok(data);
    });
});

// ── Tiers ────────────────────────────────────────────────────────────
//
// These tests create the tier row they depend on inside a before() hook
// so the suite does not rely on undocumented production data being
// pre-imported into the test database.  A random tierKey keeps the
// suite re-runnable even when a previous run leaked state.

describe('Management — Tiers', () => {
    const seededTierKey = `axl/it-${Math.random().toString(36).slice(2, 10)}`;
    let seededTierId = null;

    before(async () => {
        // Create a tier with no models — just enough for the listing
        // assertion.  We do NOT depend on any particular model row existing
        // in the test DB.
        const { status, data } = await api('POST', '/management/tiers', {
            tierKey: seededTierKey,
            displayName: 'integration test tier',
            description: 'created by gateway.test.mjs — safe to delete',
            maxModelAttempts: 3,
            enabled: true,
        });
        if (status === 201 && data?.tier?.id) {
            seededTierId = data.tier.id;
        }
    });

    it('GET /management/tiers returns an array including the seeded tier', async () => {
        const { status, data } = await api('GET', '/management/tiers');
        assert.equal(status, 200);
        const tiers = data.data || data;
        assert.ok(Array.isArray(tiers));
        const seeded = tiers.find(
            (t) => (t.tier_key || t.tierKey) === seededTierKey
        );
        assert.ok(
            seeded,
            `seeded tier '${seededTierKey}' should appear in /management/tiers`
        );
    });

    it('seeded tier has a model membership array (possibly empty)', async () => {
        const { data } = await api('GET', '/management/tiers');
        const tiers = data.data || data;
        const seeded = tiers.find(
            (t) => (t.tier_key || t.tierKey) === seededTierKey
        );
        if (seeded) {
            assert.ok(
                'models' in seeded || 'model_refs' in seeded,
                'tier should carry a models array'
            );
        }
    });

    // Leave the seeded tier in place — cleanup would require a DELETE
    // endpoint call that is tested elsewhere.  Random key prevents
    // accumulation from dominating the listing.
});

// ── Keys ─────────────────────────────────────────────────────────────

describe('Management — Keys', () => {
    let createdKeyId;

    it('POST /management/keys creates a new key', async () => {
        const { status, data } = await api('POST', '/management/keys', {
            label: 'integration-test-key',
            rpm_limit: 30,
            daily_budget_usd: 1.0,
        });
        assert.ok(
            [200, 201].includes(status),
            `Expected 200/201, got ${status}: ${JSON.stringify(data)}`
        );
        assert.ok(data.key || data.plaintextKey);
        createdKeyId = data.key?.id;
    });

    it('GET /management/keys lists keys', async () => {
        const { status, data } = await api('GET', '/management/keys');
        assert.equal(status, 200);
        const keys = data.data || data;
        assert.ok(Array.isArray(keys));
    });
});

// ── Metrics ──────────────────────────────────────────────────────────

describe('Management — Metrics', () => {
    it('GET /management/metrics/system returns system metrics', async () => {
        const { status, data } = await api('GET', '/management/metrics/system');
        assert.equal(status, 200);
        assert.ok(data.process);
        assert.ok(data.db);
        assert.ok(data.process.rss > 0);
    });
});

// ── Logs ─────────────────────────────────────────────────────────────

describe('Management — Logs', () => {
    it('GET /management/logs returns paginated logs', async () => {
        const { status, data } = await api('GET', '/management/logs?limit=5');
        assert.equal(status, 200);
        assert.ok(
            data.data !== undefined ||
                data.rows !== undefined ||
                Array.isArray(data)
        );
    });
});

// ── Chat Completions (pipeline integration) ──────────────────────────

describe('Public API — /v1/chat/completions', () => {
    let clientKey = '';

    before(async () => {
        // Create a test API key for client auth
        const { data } = await api('POST', '/management/keys', {
            label: 'pipeline-test-key',
            rpm_limit: 60,
        });
        clientKey = data.plaintextKey || '';
    });

    function clientApi(method, path, body = null) {
        const headers = { 'Content-Type': 'application/json' };
        if (clientKey) headers['Authorization'] = `Bearer ${clientKey}`;
        const opts = { method, headers };
        if (body) opts.body = JSON.stringify(body);
        return fetch(`${BASE}${path}`, opts).then(async (res) => ({
            status: res.status,
            data: await res.json().catch(() => null),
        }));
    }

    it('POST without auth returns 401', async () => {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'test',
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        assert.equal(res.status, 401);
    });

    it('POST with unknown model returns 404', async () => {
        const { status, data } = await clientApi(
            'POST',
            '/v1/chat/completions',
            {
                model: 'nonexistent/model-xyz',
                messages: [{ role: 'user', content: 'hello' }],
            }
        );
        assert.equal(
            status,
            404,
            `Expected 404, got ${status}: ${JSON.stringify(data)}`
        );
        assert.equal(data.error.type, 'model_not_found');
    });

    it('POST with a known tier name reaches execution stage', async () => {
        // We seed our own cascade-model-backed tier via the management API
        // above, but that tier has no models so it exhausts immediately.
        // What this test really wants to prove is that the request pipeline
        // can *route* to a cascade (a "tier" in the legacy language) without
        // returning 404 at the resolve-model stage.  Any tier seeded in the
        // previous describe block satisfies that — look it up dynamically
        // instead of hard-coding `axl/fast`.
        const tiersRes = await api('GET', '/management/tiers');
        const tiers = tiersRes.data?.data || tiersRes.data || [];
        if (!Array.isArray(tiers) || tiers.length === 0) {
            // No tiers configured at all — skip: nothing to route to.
            return;
        }
        const tierKey = tiers[0].tier_key || tiers[0].tierKey;
        assert.ok(
            tierKey,
            'management API should surface a tier_key we can target'
        );

        const { status, data } = await clientApi(
            'POST',
            '/v1/chat/completions',
            {
                model: tierKey,
                messages: [{ role: 'user', content: 'Say hello' }],
            }
        );
        // Accepted outcomes:
        //   200                     full success
        //   404                     no enabled child models (tier exhausted)
        //   429 / 502 / 503 / 504   provider error — routing worked
        //   500                     execution engine issue (providers not connected)
        // What we explicitly do NOT accept is a 404 with `model_not_found` —
        // that would mean request resolution failed before even reaching
        // the cascade middleware.
        assert.ok(
            [200, 404, 429, 500, 502, 503, 504].includes(status),
            `Expected pipeline to reach execution, got ${status}: ${JSON.stringify(data)}`
        );
        if (status === 404) {
            // If we got 404, the error type should reflect tier exhaustion
            // or a missing child — NOT a top-level model-not-found.
            assert.notEqual(
                data?.error?.type,
                'model_not_found',
                'tier cascade should not 404 with model_not_found — it reached resolve-model successfully'
            );
        }
    });
});

// ── Dashboard ────────────────────────────────────────────────────────

describe('Dashboard', () => {
    it('GET /management returns HTML', async () => {
        const res = await fetch(`${BASE}/management`);
        assert.equal(res.status, 200);
        const ct = res.headers.get('content-type');
        assert.ok(ct.includes('text/html'));
    });

    it('GET /management/css/app.css returns CSS', async () => {
        const res = await fetch(`${BASE}/management/css/app.css`);
        assert.equal(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('text/css'));
    });
});
