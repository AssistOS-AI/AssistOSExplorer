import assert from 'node:assert/strict';
import test from 'node:test';
import { ProxyAgentClient } from '../server/proxy-pool/proxy-client.mjs';

function clientAnswering(answer) {
    const calls = [], logs = [];
    const client = new ProxyAgentClient({
        log: (line) => logs.push(line),
        createClient: async (agentName) => ({
            callTool: async (tool, args, options) => { calls.push({ agentName, tool, args, options }); return answer(tool, args); },
        }),
    });
    return { client, calls, logs };
}

const LEASE = { ok: true, active: true,
    proxy: { id: 'pxp_0123456789abcdef', scheme: 'http', host: '198.51.100.7', port: 6001, username: 'u', password: 'p', country: 'DE' },
    locale: { timezone: 'Europe/Berlin', locale: 'de_DE.UTF-8', lang: 'de-DE' } };

test('a lease from proxyAgent gives the robot its upstream proxy and exit locale', async () => {
    const { client, calls } = clientAnswering(() => LEASE);
    const lease = await client.lease('scout-a1b2c3', 'Scout');
    assert.deepEqual(lease, { upstream: LEASE.proxy, locale: LEASE.locale });
    assert.deepEqual(calls[0].args, { subject: 'scout-a1b2c3', label: 'Scout' }, 'the robot name labels the lease on the pool page');
    await client.lease('scout-a1b2c3');
    assert.deepEqual(calls[1].args, { subject: 'scout-a1b2c3' });
    assert.equal(calls[0].agentName, 'proxyAgent');
    assert.equal(calls[0].tool, 'proxy_lease');
});

test('robots connect directly when proxyAgent is missing, unreachable or has no usable proxy', async () => {
    assert.equal(await clientAnswering(() => ({ ok: true, active: false })).client.lease('scout-a1b2c3'), null);
    const missing = clientAnswering(() => { throw new Error('agent-to-agent call failed (status 404)'); });
    assert.equal(await missing.client.lease('scout-a1b2c3'), null);
    assert.match(missing.logs[0], /connects directly/u);
    assert.equal(await clientAnswering(() => ({ ok: false, status: 503, error: 'PROXY_AGENT_VAULT_KEY is not configured' })).client.lease('scout-a1b2c3'), null);
    assert.equal(await clientAnswering(() => ({ ok: true, active: true, proxy: { scheme: 'socks5', host: 'x', port: 1 } })).client.lease('scout-a1b2c3'), null);
    const unloadable = new ProxyAgentClient({ log: () => {}, createClient: async () => { throw new Error('Ploinky agent client is unavailable'); } });
    assert.equal(await unloadable.lease('scout-a1b2c3'), null);
});

test('only an active pool with nothing free keeps the workstation from starting', async () => {
    const { client } = clientAnswering(() => ({ ok: false, status: 409, error: 'No free proxy is available in the shared proxy pool.' }));
    await assert.rejects(client.lease('scout-a1b2c3'), error => error.statusCode === 409 && /No free proxy/u.test(error.message));
});

test('a missing locale falls back to the neutral profile', async () => {
    const { client } = clientAnswering(() => ({ ...LEASE, locale: undefined }));
    assert.deepEqual((await client.lease('scout-a1b2c3')).locale, { timezone: 'UTC', locale: 'en_US.UTF-8', lang: 'en-US' });
});

test('release and assignments never throw and report an unavailable proxyAgent', async () => {
    const down = clientAnswering(() => { throw new Error('unreachable'); });
    assert.equal(await down.client.release('scout-a1b2c3'), false);
    assert.deepEqual(await down.client.assignments(), { available: false, active: false, assignments: [] });
    const up = clientAnswering((tool) => tool === 'proxy_release' ? { ok: true, released: true } : { ok: true, active: true, assignments: [{ subject: 'scout-a1b2c3' }] });
    assert.equal(await up.client.release('scout-a1b2c3'), true);
    assert.deepEqual(await up.client.assignments(), { available: true, active: true, assignments: [{ subject: 'scout-a1b2c3' }] });
    assert.deepEqual(up.calls.at(-1).args, {}, 'without a robot list every robot of RoboTeam is listed');
});
