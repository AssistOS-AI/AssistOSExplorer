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
        if (String(url) === '/api/marketplace' && !options.method) {
            return Response.json({
                ok: true,
                marketplace: { agents: [{ ref: 'AchillesIDE/webmeetAgent', name: 'webmeetAgent', running: false }] }
            });
        }
        if (String(url) === '/auth/token') {
            return Response.json({
                ok: true,
                adminControl: { origin: 'http://localhost:8080', csrfToken: 'csrf-1' }
            });
        }
        if (String(url) === '/api/marketplace' && options.method === 'POST') {
            return Response.json({
                ok: true,
                marketplace: { agents: [{ ref: 'AchillesIDE/webmeetAgent', name: 'webmeetAgent', running: true }] }
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
            agentRef: 'AchillesIDE/webmeetAgent'
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
            marketplace: { agents: [{ ref: 'AchillesIDE/webmeetAgent', name: 'webmeetAgent', running: true }] }
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
        assert.deepEqual(calls, ['/api/marketplace']);
    } finally {
        globalThis.fetch = previousFetch;
    }
});
