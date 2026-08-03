import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
    startScopedSoulBroker as startOpenCodeBroker,
} from '../opencodeAgent/scripts/scoped-soul-broker.mjs';
import {
    startScopedSoulBroker as startPiBroker,
} from '../piAgent/scripts/scoped-soul-broker.mjs';

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

function managedEnv(port) {
    return {
        PLOINKY_ROUTER_URL: `http://127.0.0.1:${port}`,
        PLOINKY_ROUTER_REQUEST_AUTHORITY: 'router.internal:8080',
        PLOINKY_AGENT_API_KEY: 'outer-generated-key',
        PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_URL: 'generated',
        PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_REQUEST_AUTHORITY: 'generated',
        PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY: 'generated',
    };
}

for (const [name, startBroker] of [
    ['OpenCode', startOpenCodeBroker],
    ['PI', startPiBroker],
]) {
    test(`${name} broker exposes only a scoped credential and forwards allowed models`, async (t) => {
        const received = [];
        const upstream = http.createServer((request, response) => {
            const chunks = [];
            request.on('data', (chunk) => chunks.push(chunk));
            request.on('end', () => {
                received.push({
                    url: request.url,
                    host: request.headers.host,
                    authorization: request.headers.authorization,
                    body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
                });
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end('{"ok":true}');
            });
        });
        await listen(upstream);
        t.after(() => close(upstream));
        const broker = await startBroker(managedEnv(upstream.address().port));
        t.after(() => broker.close());

        assert.deepEqual(Object.keys(broker.environment).sort(), [
            'PLOINKY_TASK_BROKER_KEY',
            'PLOINKY_TASK_BROKER_URL',
        ]);
        assert.equal(
            JSON.stringify(broker.environment).includes('outer-generated-key'),
            false
        );

        const unauthorized = await fetch(`${broker.environment.PLOINKY_TASK_BROKER_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'fast', messages: [] }),
        });
        assert.equal(unauthorized.status, 401);

        const invalidModel = await fetch(`${broker.environment.PLOINKY_TASK_BROKER_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${broker.environment.PLOINKY_TASK_BROKER_KEY}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ model: 'arbitrary-provider-model', messages: [] }),
        });
        assert.equal(invalidModel.status, 400);
        assert.equal(received.length, 0);

        const allowed = await fetch(`${broker.environment.PLOINKY_TASK_BROKER_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${broker.environment.PLOINKY_TASK_BROKER_KEY}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(allowed.status, 200);
        assert.deepEqual(await allowed.json(), { ok: true });
        assert.deepEqual(received, [{
            url: '/base-agent-additional-server/soul-gateway/7000/v1/chat/completions',
            host: 'router.internal:8080',
            authorization: 'Bearer outer-generated-key',
            body: { model: 'fast', messages: [{ role: 'user', content: 'hi' }] },
        }]);
    });

    test(`${name} broker fails closed on partial generated provenance`, async () => {
        await assert.rejects(
            startBroker({
                PLOINKY_ROUTER_URL: 'http://router.test',
                PLOINKY_ENV_SOURCE_PLOINKY_ROUTER_URL: 'generated',
            }),
            /requires generated provenance/
        );
        assert.equal(await startBroker({}), null);
    });
}
