import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { proxyAccountCounts, proxyPoolSummary, proxyState } from '../public/proxy-pool.js';

test('proxy pool presentation names counts and proxy states', () => {
    assert.equal(proxyAccountCounts({ proxyCount: 10, availableCount: 9, assignedCount: 3 }), '10 proxies · 9 available · 3 in use');
    assert.equal(proxyAccountCounts({ proxyCount: 1, availableCount: 1, assignedCount: 0 }), '1 proxy · 1 available · 0 in use');
    assert.equal(proxyPoolSummary({ proxies: [{}], accounts: [{}, {}] }), '1 proxy · 2 accounts');
    assert.deepEqual(proxyState({ available: false, robotId: 'a' }), { label: 'Unavailable', tone: 'error' });
    assert.deepEqual(proxyState({ available: true, checkStatus: 'failed' }), { label: 'Check failed', tone: 'error' });
    assert.deepEqual(proxyState({ available: true, robotId: 'robot-one' }), { label: 'In use', tone: 'busy' });
    assert.deepEqual(proxyState({ available: true }), { label: 'Free', tone: 'ok' });
});

test('the Proxies tab is served and wired into the dashboard', async () => {
    const [app, server] = await Promise.all([
        readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
        readFile(new URL('../server/http-server.mjs', import.meta.url), 'utf8'),
    ]);
    assert.match(app, /proxyPool\.setContext\(canCreateRobots\)/);
    assert.match(app, /proxies: 'proxiesTab'/);
    assert.match(server, /pathname === '\/proxy-pool\.js'/);
});
