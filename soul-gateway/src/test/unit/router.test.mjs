import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, parseUrl } from '../../core/path-router.mjs';

describe('createRouter', () => {
    it('matches static routes', () => {
        const router = createRouter();
        router.add('GET', '/healthz', 'healthHandler');
        const match = router.match('GET', '/healthz');
        assert.equal(match.handler, 'healthHandler');
        assert.deepEqual(match.params, {});
    });

    it('returns null for unmatched routes', () => {
        const router = createRouter();
        router.add('GET', '/healthz', 'h');
        assert.equal(router.match('GET', '/missing'), null);
        assert.equal(router.match('POST', '/healthz'), null);
    });

    it('matches parameterized routes', () => {
        const router = createRouter();
        router.add('GET', '/management/models/:modelId', 'getModel');
        const match = router.match('GET', '/management/models/abc-123');
        assert.equal(match.handler, 'getModel');
        assert.equal(match.params.modelId, 'abc-123');
    });

    it('matches multiple params', () => {
        const router = createRouter();
        router.add(
            'DELETE',
            '/management/providers/:providerId/accounts/:accountId',
            'delAccount'
        );
        const match = router.match(
            'DELETE',
            '/management/providers/p1/accounts/a2'
        );
        assert.equal(match.params.providerId, 'p1');
        assert.equal(match.params.accountId, 'a2');
    });

    it('decodes URI components in params', () => {
        const router = createRouter();
        router.add('GET', '/management/cooldowns/:model', 'getCooldown');
        const match = router.match(
            'GET',
            '/management/cooldowns/openai%2Fgpt-4o'
        );
        assert.equal(match.params.model, 'openai/gpt-4o');
    });

    it('leaves malformed URI params undecoded', () => {
        const router = createRouter();
        router.add('GET', '/management/cooldowns/:model', 'getCooldown');
        const match = router.match('GET', '/management/cooldowns/%E0%A4%A');
        assert.equal(match.params.model, '%E0%A4%A');
    });

    it('prefers first registered route', () => {
        const router = createRouter();
        router.add('GET', '/a', 'first');
        router.add('GET', '/a', 'second');
        assert.equal(router.match('GET', '/a').handler, 'first');
    });
});

describe('parseUrl', () => {
    it('parses path without query', () => {
        const { pathname, query } = parseUrl({ url: '/healthz' });
        assert.equal(pathname, '/healthz');
        assert.deepEqual(query, {});
    });

    it('parses path with query', () => {
        const { pathname, query } = parseUrl({
            url: '/api/logs?from=2026-01-01&limit=50',
        });
        assert.equal(pathname, '/api/logs');
        assert.equal(query.from, '2026-01-01');
        assert.equal(query.limit, '50');
    });

    it('handles missing url', () => {
        const { pathname } = parseUrl({});
        assert.equal(pathname, '/');
    });

    it('leaves malformed URI query components undecoded', () => {
        const { pathname, query } = parseUrl({
            url: '/api/logs?from=%E0%A4%A&%bad=value',
        });
        assert.equal(pathname, '/api/logs');
        assert.equal(query.from, '%E0%A4%A');
        assert.equal(query['%bad'], 'value');
    });
});
