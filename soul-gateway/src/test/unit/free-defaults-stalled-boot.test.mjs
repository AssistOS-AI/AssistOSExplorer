/**
 * A fresh gateway starts and serves every public tier even when the provider
 * catalog request and the public pricing directory both stall (they accept
 * the connection and never finish). `node:https` is replaced by a double and
 * the pricing directory is a local server, so no network is used.
 *
 * Requires `--experimental-test-module-mocks` (set by `npm test`).
 */

import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSignedSubjectKey } from '../fixtures/signed-subject-key.mjs';
import {
    applyProcessEnv,
    createHttpsDouble,
    freshGatewayEnv,
} from '../fixtures/fresh-gateway-boot.mjs';

const DISCOVERY_TIMEOUT_MS = 10_000;
const PRICING_TIMEOUT_MS = 5_000;
const PUBLIC_TIERS = ['fast', 'code', 'plan', 'write', 'deep', 'ultra', 'web-assist'];

const https = createHttpsDouble(() => null);
mock.module('node:https', {
    namedExports: { request: https.request, get: https.request },
    defaultExport: { request: https.request, get: https.request },
});

let pricingServer;
let pricingRequests = 0;
let gateway;
let bootMs;
let dataDir;
let restoreEnv;

before(async () => {
    pricingServer = createServer((_req, res) => {
        pricingRequests++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"data":[');
    });
    await new Promise((resolve) => pricingServer.listen(0, '127.0.0.1', resolve));
    dataDir = await mkdtemp(join(tmpdir(), 'soul-stalled-boot-'));
    restoreEnv = applyProcessEnv(
        freshGatewayEnv({
            dataDir,
            signed: makeSignedSubjectKey('agent:verification/stalled'),
            pricingDirectoryUrl: `http://127.0.0.1:${pricingServer.address().port}/models`,
        }),
        ['FREE_MODELS_ENABLED', 'LLM_DEFAULT_TIERS', 'OPENROUTER_API_KEY', 'PRICING_DIRECTORY_TIMEOUT_MS']
    );
    const { bootstrap } = await import('../../bootstrap.mjs');
    const started = Date.now();
    gateway = await bootstrap();
    bootMs = Date.now() - started;
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
    const { shutdown } = await import('../../shutdown.mjs');
    await shutdown(gateway.appCtx, gateway.server, 'test');
    restoreEnv();
    pricingServer.closeAllConnections();
    await new Promise((resolve) => pricingServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
});

describe('first start with stalled catalog and pricing directory', () => {
    it('finishes bootstrap within five seconds of the discovery and pricing timeouts', () => {
        assert.ok(
            https.requests.some((options) => options.hostname === 'openrouter.ai'),
            'catalog discovery was attempted'
        );
        assert.ok(pricingRequests >= 1, 'pricing directory was requested');
        assert.ok(
            bootMs <= DISCOVERY_TIMEOUT_MS + PRICING_TIMEOUT_MS + 5_000,
            `bootstrap took ${bootMs}ms`
        );
    });

    it('listens and serves health', async () => {
        const port = gateway.server.address().port;
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.equal(res.status, 200);
    });

    it('resolves all seven tiers in the first snapshot', () => {
        const snapshot = gateway.appCtx.services.snapshot;
        for (const tier of PUBLIC_TIERS) {
            const record = snapshot.models.get(tier);
            assert.ok(record, `${tier} missing`);
            assert.ok(record.children.length >= 3, `${tier} children`);
        }
    });
});
