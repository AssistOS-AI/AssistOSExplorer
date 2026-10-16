/**
 * The pricing directory load is bounded, headers and body together, so a
 * stalled public catalog cannot hold a catalog sync (and therefore startup)
 * forever; the configured bound is clamped to what Node timers accept; and a
 * failed load is remembered so a stalled catalog costs one timeout per
 * backoff window instead of one per caller. Uses a local HTTP server only;
 * no network.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
    DEFAULT_PRICING_DIRECTORY_TIMEOUT_MS,
    MAX_PRICING_DIRECTORY_TIMEOUT_MS,
    PricingDirectory,
} from '../../runtime/policy/pricing-directory.mjs';

let server;
let base;
const requests = [];

before(async () => {
    server = createServer((req, res) => {
        requests.push(req.url);
        if (req.url === '/stall-body') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{"data":[');
            return;
        }
        if (req.url === '/stall-headers') return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'vendor/model', pricing: { prompt: '0', completion: '0' } }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

function countRequests(path) {
    return requests.filter((url) => url === path).length;
}

after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
});

describe('PricingDirectory load timeout', () => {
    it('defaults to five seconds', () => {
        assert.equal(DEFAULT_PRICING_DIRECTORY_TIMEOUT_MS, 5_000);
    });

    for (const path of ['/stall-body', '/stall-headers']) {
        it(`settles an initial load within a second of the timeout when the server stalls (${path})`, async () => {
            const directory = new PricingDirectory({ url: `${base}${path}`, timeoutMs: 400 });
            const started = Date.now();
            await assert.rejects(
                directory.refreshIfNeeded(),
                /pricing directory fetch timed out after 400ms/
            );
            const elapsed = Date.now() - started;
            assert.ok(elapsed < 400 + 1_000, `took ${elapsed}ms`);
            assert.equal(directory.size, 0);
        });
    }

    for (const timeoutMs of [MAX_PRICING_DIRECTORY_TIMEOUT_MS + 1, 1e21]) {
        it(`loads a healthy directory with a configured timeout of ${timeoutMs}`, async () => {
            const directory = new PricingDirectory({ url: `${base}/ok`, timeoutMs });
            await directory.refreshIfNeeded();
            assert.equal(directory.size, 1);
            assert.ok(directory.lookupModel(null, 'vendor/model'));
        });
    }

    it('keeps the previous entries when a later refresh times out', async () => {
        const warnings = [];
        const log = { warn() {}, error: (msg, data) => warnings.push({ msg, data }) };
        const directory = new PricingDirectory({ url: `${base}/ok`, timeoutMs: 400, log });
        await directory.refreshIfNeeded();
        assert.ok(directory.lookupModel(null, 'vendor/model'));

        const started = Date.now();
        await directory.load(`${base}/stall-body`);
        assert.ok(Date.now() - started < 1_400);
        assert.ok(directory.lookupModel(null, 'vendor/model'));
        assert.match(warnings[0].data.error, /timed out after 400ms/);
    });
});

describe('PricingDirectory failure backoff', () => {
    it('costs one timeout and one request for callers inside the window', async () => {
        const before = countRequests('/stall-headers');
        const directory = new PricingDirectory({
            url: `${base}/stall-headers`,
            timeoutMs: 300,
            failureBackoffMs: 5_000,
        });
        await assert.rejects(directory.refreshIfNeeded(), /timed out after 300ms/);

        const started = Date.now();
        for (let i = 0; i < 4; i++) {
            assert.equal(await directory.refreshIfNeeded(), directory);
        }
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 300, `four cached calls took ${elapsed}ms`);
        assert.equal(countRequests('/stall-headers') - before, 1);
        assert.equal(directory.size, 0);
    });

    it('shares one in-flight load between concurrent callers', async () => {
        const before = countRequests('/stall-body');
        const directory = new PricingDirectory({
            url: `${base}/stall-body`,
            timeoutMs: 300,
            failureBackoffMs: 5_000,
        });
        const results = await Promise.allSettled([
            directory.refreshIfNeeded(),
            directory.refreshIfNeeded(),
            directory.refreshIfNeeded(),
        ]);
        assert.deepEqual(
            results.map((result) => result.status),
            ['rejected', 'rejected', 'rejected']
        );
        assert.equal(countRequests('/stall-body') - before, 1);
    });

    it('tries again once the window has passed', async () => {
        const before = countRequests('/stall-headers');
        const directory = new PricingDirectory({
            url: `${base}/stall-headers`,
            timeoutMs: 200,
            failureBackoffMs: 150,
        });
        await assert.rejects(directory.refreshIfNeeded(), /timed out after 200ms/);
        await directory.refreshIfNeeded();
        assert.equal(countRequests('/stall-headers') - before, 1);

        await new Promise((resolve) => setTimeout(resolve, 200));
        await assert.rejects(directory.refreshIfNeeded(), /timed out after 200ms/);
        assert.equal(countRequests('/stall-headers') - before, 2);
    });

    it('clears the failure state on a later success', async () => {
        const directory = new PricingDirectory({
            url: `${base}/stall-headers`,
            timeoutMs: 200,
            failureBackoffMs: 10_000,
        });
        await assert.rejects(directory.refreshIfNeeded(), /timed out after 200ms/);
        await directory.load(`${base}/ok`);
        assert.equal(directory.size, 1);

        // The window would still be open, but the success cleared it, so a
        // stale directory reloads instead of being served from the failure.
        const before = countRequests('/ok');
        await directory.refreshIfNeeded(null, { force: true });
        assert.equal(countRequests('/ok') - before, 1);
        assert.ok(directory.lookupModel(null, 'vendor/model'));
    });
});
