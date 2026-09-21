/**
 * Two real boots on one database: the first with the free defaults disabled,
 * the second with them enabled. The public tiers must then be usable and the
 * baseline models must join the auto tag tiers created by the first boot.
 * `node:https` is mocked offline, so this test never touches the network.
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

let dataDir;
let envSnapshot;
let signed;

function bootEnv(extra) {
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
        ...extra,
    });
}

async function bootOnce(extra) {
    bootEnv(extra);
    const { bootstrap } = await import('../../bootstrap.mjs');
    const { shutdown } = await import('../../shutdown.mjs');
    const booted = await bootstrap();
    const snapshot = booted.appCtx.services.snapshot;
    const tiers = {};
    for (const key of ['fast', 'free', 'vision', 'plan']) {
        const record = snapshot.models.get(key);
        tiers[key] = record ? record.children.map((child) => child.modelKey) : null;
    }
    const { rows } = await booted.appCtx.pool.query(
        "SELECT metadata FROM models WHERE model_key = 'fast'"
    );
    await shutdown(booted.appCtx, booted.server, 'test');
    return { tiers, fastMetadata: rows[0]?.metadata || null };
}

before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'soul-enable-later-'));
    signed = makeSignedSubjectKey('agent:verification/enable-later');
    envSnapshot = { ...process.env };
    for (const key of ['LLM_DEFAULT_TIERS', 'OPENROUTER_API_KEY']) delete process.env[key];
});

after(async () => {
    for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
    await rm(dataDir, { recursive: true, force: true });
});

describe('enabling the free defaults after a disabled first start', () => {
    it('installs usable public tiers and fills the existing auto tag tiers', async () => {
        const disabled = await bootOnce({ FREE_MODELS_ENABLED: 'false' });
        assert.equal(disabled.tiers.fast, null, 'no auto tag tier claims the public fast tier name');
        assert.deepEqual(disabled.tiers.free, []);

        const enabled = await bootOnce({ FREE_MODELS_ENABLED: 'true' });
        assert.equal(enabled.fastMetadata.seededBy, 'free-model-defaults');
        assert.equal(enabled.tiers.fast.length, 3);
        assert.ok(enabled.tiers.fast.every((key) => key.startsWith('openrouter-free/')));
        assert.equal(enabled.tiers.free.length, 9, 'baseline models joined the free tag tier');
        assert.ok(enabled.tiers.vision.length >= 5, 'vision-capable baseline models joined the vision tag tier');
        assert.equal(enabled.tiers.plan.length, 4);
    });

    it('completes the tag join on the next start after a crash right after the install', async () => {
        // Recreate the state a crash between the install commit and the tag
        // join leaves behind: installed defaults, empty tag tiers, no join marker.
        const { openDatabase } = await import('../../db/sqlite-db.mjs');
        const db = await openDatabase({ SQLITE_PATH: join(dataDir, 'gateway.sqlite3') });
        await db.query("DELETE FROM gateway_bootstrap_state WHERE bootstrap_key = 'free-model-defaults-tag-tiers'");
        await db.query("DELETE FROM model_children WHERE parent_model_id IN (SELECT id FROM models WHERE model_key IN ('free', 'vision'))");
        await db.end();

        const restarted = await bootOnce({ FREE_MODELS_ENABLED: 'true' });
        assert.equal(restarted.tiers.free.length, 9);
        assert.ok(restarted.tiers.vision.length >= 5);
        assert.equal(restarted.tiers.fast.length, 3);
    });

    it('does not re-add models an administrator removed from a tag tier', async () => {
        const { openDatabase } = await import('../../db/sqlite-db.mjs');
        const db = await openDatabase({ SQLITE_PATH: join(dataDir, 'gateway.sqlite3') });
        await db.query("DELETE FROM model_children WHERE parent_model_id = (SELECT id FROM models WHERE model_key = 'free')");
        await db.end();
        const restarted = await bootOnce({ FREE_MODELS_ENABLED: 'true' });
        assert.deepEqual(restarted.tiers.free, []);
    });
});
