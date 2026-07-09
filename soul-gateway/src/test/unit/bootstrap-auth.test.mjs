import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function snapshotEnv() {
    return { ...process.env };
}

function restoreEnv(snapshot) {
    for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) {
            delete process.env[key];
        }
    }
    Object.assign(process.env, snapshot);
}

describe('bootstrap auth environment', () => {
    it('accepts current Ploinky agent identity without the removed derived master key', async () => {
        const envSnapshot = snapshotEnv();
        const dir = await mkdtemp(join(tmpdir(), 'soul-bootstrap-auth-'));
        let appCtx;
        try {
            Object.assign(process.env, {
                PORT: '0',
                HOST: '127.0.0.1',
                DATA_DIR: dir,
                SQLITE_PATH: join(dir, 'soul-gateway.sqlite3'),
                ENCRYPTION_KEY: '8'.repeat(64),
                API_KEY_HASH_PEPPER: 'test-pepper',
                OAUTH_ADAPTERS_ENABLED: '',
                PLOINKY_AGENT_API_PUBLIC_KEY: 'test-public-key',
                PLOINKY_ROUTER_URL: 'http://127.0.0.1:9',
                PLOINKY_AGENT_ID: 'agent:proxies/soul-gateway',
                PLOINKY_AGENT_PRINCIPAL: 'agent:proxies/soul-gateway',
                PLOINKY_AGENT_SECRET: '9'.repeat(64),
                PLOINKY_AGENT_API_KEY: 'agent:proxies/soul-gateway|sig',
                PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'generated',
                PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY: 'generated',
            });
            delete process.env.PLOINKY_DERIVED_MASTER_KEY;

            const { bootstrap } = await import(
                `../../bootstrap.mjs?bootstrapAuth=${Date.now()}`
            );
            ({ appCtx } = await bootstrap());

            assert.equal(
                appCtx.config.env.PLOINKY_AGENT_SECRET,
                '9'.repeat(64)
            );
        } finally {
            appCtx?.services?.jobScheduler?.stop?.();
            if (appCtx?.services?.ploinkyDiscoveryTimer) {
                clearInterval(appCtx.services.ploinkyDiscoveryTimer);
            }
            await appCtx?.pool?.end?.();
            restoreEnv(envSnapshot);
            await rm(dir, { recursive: true, force: true });
        }
    });
});
