/**
 * Helpers for tests that run the real `bootstrap()` on a fresh temporary
 * database with the free defaults enabled, without any network access.
 */

import { EventEmitter } from 'node:events';
import { join } from 'node:path';

/**
 * Environment for a fresh, isolated gateway. `PRICING_DIRECTORY_URL` must
 * always point at a local server: the default is the public catalog.
 */
export function freshGatewayEnv({ dataDir, signed, pricingDirectoryUrl, extra = {} }) {
    return {
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
        PRICING_DIRECTORY_URL: pricingDirectoryUrl,
        PROVIDER_MODEL_REFRESH_INTERVAL_MS: '0',
        ...extra,
    };
}

/**
 * Replace process.env entries for one test file; returns a restore function.
 */
export function applyProcessEnv(values, removeKeys = []) {
    const snapshot = { ...process.env };
    for (const key of removeKeys) delete process.env[key];
    Object.assign(process.env, values);
    return () => {
        for (const key of Object.keys(process.env)) {
            if (!(key in snapshot)) delete process.env[key];
        }
        Object.assign(process.env, snapshot);
    };
}

/**
 * A `node:https` request double. `respond(options)` returns `null` to stall
 * forever (until the caller aborts) or `{ status, body }` to answer.
 */
export function createHttpsDouble(respond) {
    const requests = [];
    function request(options, onResponse) {
        requests.push(options);
        const req = new EventEmitter();
        req.write = () => true;
        req.destroy = (err) => {
            if (err) setImmediate(() => req.emit('error', err));
        };
        options?.signal?.addEventListener?.('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            req.emit('error', error);
        }, { once: true });
        req.end = () => {
            const answer = respond(options);
            if (!answer) return;
            setImmediate(() => {
                const res = new EventEmitter();
                res.statusCode = answer.status;
                res.headers = { 'content-type': 'application/json' };
                onResponse?.(res);
                res.emit('data', Buffer.from(JSON.stringify(answer.body)));
                res.emit('end');
            });
        };
        return req;
    }
    return { request, requests };
}
