import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    bindJobToLiveKitWorkerTransport,
    LIVEKIT_WORKER_MAX_RETRY,
    resolveLiveKitRouterTransport,
    resolveWorkerPort,
} from '../lib/runtime-config.mjs';

test('worker port uses the standard Ploinky PORT configuration', () => {
    assert.equal(resolveWorkerPort({ PORT: '7000' }), 7000);
});

test('worker port rejects missing, malformed, and out-of-range configuration', () => {
    for (const PORT of [undefined, '', '0', '8081x', '65536']) {
        assert.throws(() => resolveWorkerPort({ PORT }), /PORT must/);
    }
});

const generatedRouterEnvironment = {
    PLOINKY_ROUTER_URL: 'http://host.containers.internal:8080',
    PLOINKY_ROUTER_REQUEST_AUTHORITY: '127.0.0.1:8080',
    PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_URL: 'generated',
    PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_REQUEST_AUTHORITY: 'generated',
};

test('LiveKit signaling uses the runtime-generated Router transport contract', () => {
    const target = resolveLiveKitRouterTransport(generatedRouterEnvironment);
    assert.equal(target.routerUrl.href, 'http://host.containers.internal:8080/');
    assert.equal(target.requestAuthority, '127.0.0.1:8080');
    assert.equal(target.signalPath, '/base-agent-additional-server/liveKitServerAgent/7880/');
});

test('LiveKit signaling rejects non-generated or invalid Router transport values', () => {
    assert.throws(() => resolveLiveKitRouterTransport({}), /runtime-generated/);
    assert.throws(
        () => resolveLiveKitRouterTransport({ PLOINKY_ROUTER_URL: 'http://router' }),
        /runtime-generated/,
    );
    for (const PLOINKY_ROUTER_URL of [undefined, '', 'not-a-url', 'file:///tmp/router']) {
        assert.throws(
            () => resolveLiveKitRouterTransport({ ...generatedRouterEnvironment, PLOINKY_ROUTER_URL }),
            /PLOINKY_ROUTER_URL/,
        );
    }
});

test('LiveKit jobs use the exact loopback transport created for their process', () => {
    const context = { info: { url: 'ws://assignment.invalid/' } };
    const livekitUrl = 'ws://127.0.0.1:49152/base-agent-additional-server/liveKitServerAgent/7880/';
    assert.equal(bindJobToLiveKitWorkerTransport(context, { LIVEKIT_URL: livekitUrl }), livekitUrl);
    assert.equal(context.info.url, livekitUrl);
    for (const invalid of [
        'ws://host.containers.internal:8080/base-agent-additional-server/liveKitServerAgent/7880/',
        'ws://127.0.0.1:49152/rtc',
        'http://127.0.0.1:49152/base-agent-additional-server/liveKitServerAgent/7880/',
    ]) {
        assert.throws(
            () => bindJobToLiveKitWorkerTransport({ info: {} }, { LIVEKIT_URL: invalid }),
            /exact loopback/,
        );
    }
});

// @livekit/agents 1.3.4 waits min(2 * attempt, 10) seconds after each failed
// connection and exits once maxRetry connections have failed.
function toleratedLiveKitOutageSeconds(maxRetry) {
    return maxRetry <= 4 ? maxRetry * (maxRetry + 1) : 10 * maxRetry - 20;
}

test('LiveKit worker keeps reconnecting while a no-wait LiveKit restart is unroutable', () => {
    // The library default gave up after 80 s; after a workspace restart LiveKit
    // signaling stayed unroutable for at least 131 s while this worker ran.
    assert.equal(toleratedLiveKitOutageSeconds(10), 80);
    assert.equal(LIVEKIT_WORKER_MAX_RETRY, Number.MAX_SAFE_INTEGER);
    assert.ok(toleratedLiveKitOutageSeconds(LIVEKIT_WORKER_MAX_RETRY) > 365 * 24 * 60 * 60);
});

test('Meeting Secretary passes the reconnect budget to its LiveKit worker options', () => {
    const entrypoint = fs.readFileSync(
        fileURLToPath(new URL('../server/livekit-scribe.mjs', import.meta.url)),
        'utf8',
    );
    const options = /const serverOptions = new Options\(\{([\s\S]*?)\n\}\);/.exec(entrypoint)?.[1] || '';
    assert.match(options, /^ {4}maxRetry: LIVEKIT_WORKER_MAX_RETRY,$/m);
});

test('manifest shares the canonical LiveKit credentials in every profile', () => {
    const manifestUrl = new URL('../manifest.json', import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(fileURLToPath(manifestUrl), 'utf8'));
    for (const profile of Object.values(manifest.profiles)) {
        const names = profile.env.map((entry) => typeof entry === 'string' ? entry : entry.name);
        assert.ok(names.includes('LIVEKIT_API_KEY'));
        assert.ok(names.includes('LIVEKIT_API_SECRET'));
        assert.ok(!names.includes('SOUL_GATEWAY_URL'));
    }
    assert.notEqual(manifest.network?.mode, 'host');
});
