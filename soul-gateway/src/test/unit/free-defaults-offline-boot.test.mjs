/**
 * A fresh gateway boots with every public tier even when the provider
 * catalog cannot be reached. `node:https` is mocked to fail like an offline
 * host, so this test never touches the network.
 *
 * Requires `--experimental-test-module-mocks` (set by `npm test`).
 */

import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeSignedSubjectKey } from '../fixtures/signed-subject-key.mjs';

const attemptedHosts = [];

function offlineRequest(options) {
    attemptedHosts.push(options?.hostname || String(options));
    const req = new EventEmitter();
    req.write = () => true;
    req.end = () => {
        setImmediate(() => {
            const error = new Error('getaddrinfo ENOTFOUND openrouter.ai');
            error.code = 'ENOTFOUND';
            req.emit('error', error);
        });
    };
    req.destroy = () => {};
    return req;
}

mock.module('node:https', {
    namedExports: { request: offlineRequest, get: offlineRequest },
    defaultExport: { request: offlineRequest, get: offlineRequest },
});

let gateway;
let base;
let signed;
let dataDir;
let envSnapshot;

before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'soul-offline-boot-'));
    signed = makeSignedSubjectKey('agent:verification/offline');
    envSnapshot = { ...process.env };
    for (const key of ['FREE_MODELS_ENABLED', 'LLM_DEFAULT_TIERS', 'OPENROUTER_API_KEY']) {
        delete process.env[key];
    }
    Object.assign(process.env, {
        PORT: '0',
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        CREDENTIALS_DIR: join(dataDir, 'credentials'),
        SQLITE_PATH: join(dataDir, 'gateway.sqlite3'),
        ENCRYPTION_KEY: '6'.repeat(64),
        PLOINKY_AGENT_API_PUBLIC_KEY: signed.publicKeyBase64url,
        PLOINKY_ROUTER_URL: 'http://127.0.0.1:9',
        PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway',
        PLOINKY_AGENT_PRINCIPAL: 'agent:proxies/soul-gateway',
        PLOINKY_AGENT_SECRET: '7'.repeat(64),
        PLOINKY_AGENT_API_KEY: signed.apiKey,
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'generated',
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY: 'generated',
        OAUTH_ADAPTERS_ENABLED: '',
        SHUTDOWN_GRACE_MS: '50',
        TOKEN_REFRESH_INTERVAL_MS: '0',
        PRICING_REFRESH_INTERVAL_MS: '0',
        PRICING_DIRECTORY_URL: 'http://127.0.0.1:9/none',
        PROVIDER_MODEL_REFRESH_INTERVAL_MS: '0',
    });
    const { bootstrap } = await import('../../bootstrap.mjs');
    gateway = await bootstrap();
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${gateway.server.address().port}`;
});

after(async () => {
    const { shutdown } = await import('../../shutdown.mjs');
    await shutdown(gateway.appCtx, gateway.server, 'test');
    for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    await rm(dataDir, { recursive: true, force: true });
});

describe('offline first start', () => {
    it('attempted the catalog refresh and survived its failure', () => {
        assert.ok(attemptedHosts.includes('openrouter.ai'), JSON.stringify(attemptedHosts));
    });

    it('has every public tier with enabled free children in the runtime snapshot', () => {
        const snapshot = gateway.appCtx.services.snapshot;
        for (const tier of ['fast', 'code', 'plan', 'write', 'deep', 'ultra', 'web-assist']) {
            const record = snapshot.models.get(tier);
            assert.ok(record, `${tier} missing`);
            assert.equal(record.strategyKind, 'cascade');
            assert.ok(record.children.length >= 3, `${tier} children`);
            for (const child of record.children) {
                const childModel = snapshot.models.get(child.modelKey);
                assert.ok(childModel?.enabled, child.modelKey);
                assert.equal(childModel.providerKey, 'openrouter-free');
            }
        }
        assert.equal(snapshot.models.has('ploinky/proxies/default-local-llm'), false);
    });

    it('lists the tiers through the signed-auth public API without exposing credentials', async () => {
        const res = await fetch(`${base}/v1/models`, {
            headers: { authorization: `Bearer ${signed.apiKey}` },
        });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.doesNotMatch(text, /sk-or-v1-/);
        const ids = JSON.parse(text).data.map((model) => model.id);
        for (const tier of ['fast', 'code', 'plan', 'write', 'deep', 'ultra', 'web-assist']) {
            assert.ok(ids.includes(tier), `${tier} not listed`);
        }
        assert.equal(ids.some((id) => id.includes('default-local-llm')), false);

        const anonymous = await fetch(`${base}/v1/models`);
        assert.equal(anonymous.status, 401);
    });

    it('recorded durable completion so a restart does not reinstall', async () => {
        const { rows } = await gateway.appCtx.pool.query(
            "SELECT bootstrap_key, metadata FROM gateway_bootstrap_state WHERE bootstrap_key = 'free-model-defaults'"
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].metadata.bundledCredential, true);
    });
});
