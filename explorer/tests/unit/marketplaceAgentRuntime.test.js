import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureMarketplaceAgentRunning } from '../../services/infrastructure/marketplaceAgentRuntime.js';

test('ensureMarketplaceAgentRunning enables a stopped agent with the CSRF proof', async () => {
    const calls = [];
    const previousFetch = globalThis.fetch;
    const previousLocation = globalThis.location;

    globalThis.location = { origin: 'http://localhost:8080' };
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url) === '/api/marketplace/agents' && !options.method) {
            return Response.json({
                ok: true,
                marketplace: { agents: [{ ref: 'webmeet/webmeetAgent', name: 'webmeetAgent', running: false }] }
            });
        }
        if (String(url) === '/auth/token') {
            return Response.json({
                ok: true,
                adminControl: { origin: 'http://localhost:8080', csrfToken: 'csrf-1' }
            });
        }
        if (String(url) === '/api/marketplace/agents' && options.method === 'POST') {
            return Response.json({
                ok: true,
                marketplace: { agents: [{ ref: 'webmeet/webmeetAgent', name: 'webmeetAgent', running: true }] }
            });
        }
        return new Response('', { status: 404 });
    };

    try {
        const agent = await ensureMarketplaceAgentRunning('webmeetAgent');
        assert.equal(agent.running, true);

        const post = calls.find((call) => call.options.method === 'POST');
        assert.ok(post);
        assert.equal(post.options.headers['x-ploinky-csrf-token'], 'csrf-1');
        assert.deepEqual(JSON.parse(post.options.body), {
            action: 'enable_agent',
            agentRef: 'webmeet/webmeetAgent'
        });
    } finally {
        globalThis.fetch = previousFetch;
        globalThis.location = previousLocation;
    }
});

test('ensureMarketplaceAgentRunning does not POST when the agent is already running', async () => {
    const calls = [];
    const previousFetch = globalThis.fetch;

    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        return Response.json({
            ok: true,
            marketplace: { agents: [{ ref: 'webmeet/webmeetAgent', name: 'webmeetAgent', running: true }] }
        });
    };

    try {
        await ensureMarketplaceAgentRunning('webmeetAgent');
        assert.equal(calls.filter((call) => call.options.method === 'POST').length, 0);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('closing during the startup snapshot aborts fetch and never enables the agent', async () => {
    const previousFetch = globalThis.fetch;
    const controller = new AbortController();
    const calls = [];
    globalThis.fetch = (url, options) => {
        calls.push(url);
        assert.equal(options.signal, controller.signal);
        return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
    };
    try {
        const pending = ensureMarketplaceAgentRunning('webmeetAgent', { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        assert.deepEqual(calls, ['/api/marketplace/agents']);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test('async activation refetches inventory after terminal success and preserves an authoritative starting state', async t => {
    const previousFetch = globalThis.fetch;
    const previousLocation = globalThis.location;
    const previousTimeout = globalThis.setTimeout;
    t.after(() => { globalThis.fetch = previousFetch; globalThis.location = previousLocation; globalThis.setTimeout = previousTimeout; });
    globalThis.location = { origin: 'http://localhost:8080' };
    globalThis.setTimeout = (callback, ms, ...args) => previousTimeout(callback, ms === 2_000 ? 1 : ms, ...args);
    const operation = { id: '11111111-1111-4111-8111-111111111111', agentRef: 'repo/worker', mode: '', state: 'pending' };
    let inventories = 0;
    let posts = 0;
    let polls = 0;
    globalThis.fetch = async (url, options = {}) => {
        if (url === '/auth/token') return Response.json({ ok: true, adminControl: { origin: 'http://localhost:8080', csrfToken: 'proof' } });
        if (options.method === 'POST') {
            posts++;
            assert.equal(inventories, 1);
            return Response.json({ ok: true, action: 'enable_agent', operation }, { status: 202 });
        }
        if (String(url).includes('?operation=')) {
            assert.equal(inventories, 1, 'accepted activation must not publish a running inventory');
            polls++;
            return Response.json({ ok: true, action: 'enable_agent', operation: { ...operation, state: polls === 1 ? 'pending' : 'succeeded' } });
        }
        inventories++;
        return Response.json({ ok: true, marketplace: { agents: [{ ref: 'repo/worker', running: false, status: inventories === 1 ? 'stopped' : 'starting' }] } });
    };
    const agent = await ensureMarketplaceAgentRunning('repo/worker');
    assert.equal(posts, 1);
    assert.equal(polls, 2);
    assert.equal(inventories, 2);
    assert.equal(agent.running, false);
    assert.equal(agent.status, 'starting');
});
