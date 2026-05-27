import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readEnv } from '../../config/env.mjs';
import { DEFAULTS } from '../../config/defaults.mjs';

describe('readEnv', () => {
    it('returns defaults when no env vars set', () => {
        const env = readEnv({});
        assert.equal(env.PORT, 7000);
        assert.equal(env.HOST, '127.0.0.1');
        assert.equal(env.PG_POOL_MAX, 20);
        assert.equal(env.DEFAULT_RPM_LIMIT, 60);
        assert.equal(env.DEFAULT_DAILY_BUDGET_USD, 2.0);
        assert.equal(env.DATABASE_URL, null);
        assert.equal(env.SHUTDOWN_GRACE_MS, 30_000);
        assert.equal(
            env.LOCAL_LLM_ALIASES,
            'fast,axl/fast,plan,code,write,deep,ultra'
        );
        assert.equal(
            env.SOUL_GATEWAY_PROVIDER_BASE_URL,
            'https://soul.axiologic.dev/v1'
        );
        assert.equal(env.SOUL_GATEWAY_PROVIDER_DISCOVERY_MODE, 'auto');
        assert.equal(
            env.SOUL_GATEWAY_PROVIDER_ALIASES,
            'fast,axl/fast,plan,code,write,deep,ultra'
        );
    });

    it('reads overrides from env', () => {
        const env = readEnv({
            PORT: '9000',
            HOST: '0.0.0.0',
            DEFAULT_RPM_LIMIT: '120',
            HTTP_RETRY_JITTER_PCT: '0.15',
            SOUL_GATEWAY_PROVIDER_API_KEY: 'provider-secret',
            SOUL_GATEWAY_PROVIDER_BASE_URL: 'https://example.test/v1',
        });
        assert.equal(env.PORT, 9000);
        assert.equal(env.HOST, '0.0.0.0');
        assert.equal(env.DEFAULT_RPM_LIMIT, 120);
        assert.equal(env.HTTP_RETRY_JITTER_PCT, 0.15);
        assert.equal(env.SOUL_GATEWAY_PROVIDER_API_KEY, 'provider-secret');
        assert.equal(
            env.SOUL_GATEWAY_PROVIDER_BASE_URL,
            'https://example.test/v1'
        );
    });

    it('ignores invalid numbers', () => {
        const env = readEnv({ PORT: 'not-a-number' });
        assert.equal(env.PORT, 7000);
    });

    it('validates Ploinky derived master key format when provided', () => {
        const key = 'a'.repeat(64);
        const env = readEnv({ PLOINKY_DERIVED_MASTER_KEY: key });
        assert.equal(env.PLOINKY_DERIVED_MASTER_KEY, key);
        assert.throws(
            () => readEnv({ PLOINKY_DERIVED_MASTER_KEY: 'not-hex' }),
            /64-character hex string/,
        );
    });

    it('returns a frozen object', () => {
        const env = readEnv({});
        assert.throws(() => {
            env.PORT = 9999;
        });
    });
});

describe('DEFAULTS', () => {
    it('is frozen', () => {
        assert.throws(() => {
            DEFAULTS.requestIdPrefix = 'x-';
        });
    });

    it('has expected keys', () => {
        assert.equal(DEFAULTS.requestIdPrefix, 'chatcmpl-');
        assert.equal(DEFAULTS.apiKeyPrefix, 'sk-soul-');
        assert.equal(DEFAULTS.responseCacheTtlMs, 300_000);
    });
});
