import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    readEnv,
    assertSignedSubjectAuthConfig,
} from '../../config/env.mjs';
import { DEFAULTS } from '../../config/defaults.mjs';

const PLOINKY_ENV = {
    PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY: 'pub-key-abc',
    PLOINKY_ROUTER_URL: 'http://127.0.0.1:8080',
    PLOINKY_AGENT_ID: 'soul-gateway',
    PLOINKY_AGENT_PRINCIPAL: 'agent:soul-gateway',
    PLOINKY_AGENT_SECRET: 'agent-secret-xyz',
    PLOINKY_AGENT_API_KEY: 'agent-api-key',
    PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'workspace.secrets',
    PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY: 'workspace.env',
    PLOINKY_ENV_SOURCE_PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY: 'router.config',
};

function makeLogSpy() {
    const warnings = [];
    const errors = [];
    return {
        warnings,
        errors,
        log: {
            warn: (...args) => warnings.push(args),
            error: (...args) => errors.push(args),
        },
    };
}

describe('readEnv', () => {
    it('returns defaults when no env vars set', () => {
        const env = readEnv({});
        assert.equal(env.PORT, 7000);
        assert.equal(env.HOST, '127.0.0.1');
        assert.equal(env.SQLITE_PATH, './data/soul-gateway.sqlite3');
        assert.equal(env.DEFAULT_RPM_LIMIT, 60);
        assert.equal(env.DEFAULT_DAILY_BUDGET_USD, 2.0);
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

    it('defaults all Ploinky signed-subject fields to null', () => {
        const env = readEnv({});
        assert.equal(env.PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY, null);
        assert.equal(env.PLOINKY_ROUTER_URL, null);
        assert.equal(env.PLOINKY_AGENT_ID, null);
        assert.equal(env.PLOINKY_AGENT_PRINCIPAL, null);
        assert.equal(env.PLOINKY_AGENT_SECRET, null);
        assert.equal(env.PLOINKY_AGENT_API_KEY, null);
        assert.equal(env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY, null);
        assert.equal(env.PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY, null);
        assert.equal(
            env.PLOINKY_ENV_SOURCE_PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY,
            null
        );
    });

    it('parses all Ploinky signed-subject fields from env', () => {
        const env = readEnv({ ...PLOINKY_ENV });
        assert.equal(
            env.PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY,
            'pub-key-abc'
        );
        assert.equal(env.PLOINKY_ROUTER_URL, 'http://127.0.0.1:8080');
        assert.equal(env.PLOINKY_AGENT_ID, 'soul-gateway');
        assert.equal(env.PLOINKY_AGENT_PRINCIPAL, 'agent:soul-gateway');
        assert.equal(env.PLOINKY_AGENT_SECRET, 'agent-secret-xyz');
        assert.equal(env.PLOINKY_AGENT_API_KEY, 'agent-api-key');
        assert.equal(
            env.PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY,
            'workspace.secrets'
        );
        assert.equal(
            env.PLOINKY_ENV_SOURCE_SOUL_GATEWAY_API_KEY,
            'workspace.env'
        );
        assert.equal(
            env.PLOINKY_ENV_SOURCE_PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY,
            'router.config'
        );
    });

    it('returns a frozen object', () => {
        const env = readEnv({});
        assert.throws(() => {
            env.PORT = 9999;
        });
    });
});

describe('assertSignedSubjectAuthConfig', () => {
    it('passes when all required Ploinky env is present', () => {
        const config = readEnv({ ...PLOINKY_ENV });
        const spy = makeLogSpy();
        assert.doesNotThrow(() =>
            assertSignedSubjectAuthConfig(config, { log: spy.log })
        );
        assert.equal(spy.warnings.length, 0);
        assert.equal(spy.errors.length, 0);
    });

    it('throws and names the missing public key', () => {
        const config = readEnv({
            ...PLOINKY_ENV,
            PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY: undefined,
        });
        const spy = makeLogSpy();
        assert.throws(
            () => assertSignedSubjectAuthConfig(config, { log: spy.log }),
            /PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY/
        );
    });

    it('throws when the router URL is missing', () => {
        const config = readEnv({
            ...PLOINKY_ENV,
            PLOINKY_ROUTER_URL: undefined,
        });
        const spy = makeLogSpy();
        assert.throws(
            () => assertSignedSubjectAuthConfig(config, { log: spy.log }),
            /PLOINKY_ROUTER_URL/
        );
    });

    it('does not throw for a missing router URL when ALLOW_UNAUTHENTICATED=true', () => {
        const config = readEnv({
            ...PLOINKY_ENV,
            PLOINKY_ROUTER_URL: undefined,
            ALLOW_UNAUTHENTICATED: 'true',
        });
        const spy = makeLogSpy();
        assert.doesNotThrow(() =>
            assertSignedSubjectAuthConfig(config, { log: spy.log })
        );
    });

    it('names every missing required variable in the error', () => {
        const config = readEnv({});
        let thrown;
        try {
            assertSignedSubjectAuthConfig(config, { log: makeLogSpy().log });
        } catch (err) {
            thrown = err;
        }
        assert.ok(thrown, 'expected an error to be thrown');
        assert.match(thrown.message, /PLOINKY_SOUL_GATEWAY_API_PUBLIC_KEY/);
        assert.match(thrown.message, /PLOINKY_ROUTER_URL/);
        assert.match(thrown.message, /PLOINKY_AGENT_ID/);
        assert.match(thrown.message, /PLOINKY_AGENT_SECRET/);
    });

    it('starts in development mode without Ploinky env and logs that signed-subject auth is disabled', () => {
        const config = readEnv({ ALLOW_UNAUTHENTICATED: 'true' });
        const spy = makeLogSpy();
        assert.doesNotThrow(() =>
            assertSignedSubjectAuthConfig(config, { log: spy.log })
        );
        assert.equal(spy.warnings.length, 1);
        const message = String(spy.warnings[0][0]);
        assert.match(message, /ALLOW_UNAUTHENTICATED/);
        assert.match(message, /DISABLED/);
        assert.match(message, /development/i);
    });

    it('treats ALLOW_UNAUTHENTICATED=1 and =yes as development mode', () => {
        for (const value of ['1', 'yes']) {
            const config = readEnv({ ALLOW_UNAUTHENTICATED: value });
            const spy = makeLogSpy();
            assert.doesNotThrow(() =>
                assertSignedSubjectAuthConfig(config, { log: spy.log })
            );
            assert.equal(spy.warnings.length, 1);
        }
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
