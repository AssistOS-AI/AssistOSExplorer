import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProxyPool } from '../server/proxy-pool/proxy-pool.mjs';
import webshare from '../server/proxy-pool/providers/webshare.mjs';
import staticList from '../server/proxy-pool/providers/static.mjs';
import { proxyProvider, publicProviders } from '../server/proxy-pool/providers/index.mjs';

async function withPool(options, run) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-proxy-pool-'));
    const pool = new ProxyPool({ file: path.join(directory, 'pool.sqlite'), ...options });
    try { return await run(pool, directory); } finally { pool.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

function staticConfig(...hosts) {
    return { proxies: hosts.map((host, index) => `http://user${index}:secret${index}@${host}:8080 de`).join('\n') };
}

async function addStatic(pool, label, hosts, extra = {}) {
    const id = pool.addAccount({ provider: 'static', label, config: staticConfig(...hosts), ...extra });
    assert.equal((await pool.syncAccount(id)).ok, true);
    return id;
}

function jsonResponse(status, body) {
    return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test('Webshare listing follows pages and maps direct proxies', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
        requests.push({ url, authorization: init.headers.authorization });
        const page = Number(new URL(url).searchParams.get('page'));
        return jsonResponse(200, page === 1
            ? { next: 'more', results: [{ id: 'a1', proxy_address: '1.2.3.4', port: 6001, username: 'u', password: 'p', country_code: 'de', city_name: 'Berlin', valid: true }] }
            : { next: null, results: [{ id: 'a2', proxy_address: '5.6.7.8', port: 6002, username: 'u', password: 'p', country_code: 'US', valid: false }] });
    };
    const config = webshare.normalizeConfig({ apiKey: ' abcdefgh1234 ' });
    const proxies = await webshare.listProxies(config, { fetchImpl });
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /^https:\/\/proxy\.webshare\.io\/api\/v2\/proxy\/list\/\?mode=direct&page=1&page_size=100$/u);
    assert.equal(requests[0].authorization, 'Token abcdefgh1234');
    assert.deepEqual(proxies[0], { externalId: 'a1', scheme: 'http', host: '1.2.3.4', port: 6001, username: 'u', password: 'p', country: 'DE', city: 'Berlin', available: true });
    assert.equal(proxies[1].available, false);
    assert.equal(webshare.describeConfig(config), 'API key …1234');
    await assert.rejects(webshare.listProxies(config, { fetchImpl: async () => jsonResponse(401, {}) }), error => error.credentialsRejected === true);
    assert.throws(() => webshare.normalizeConfig({ apiKey: 'no spaces allowed' }), /API key is invalid/u);
});

test('manual proxy lists accept http URLs with optional countries only', async () => {
    const config = staticList.normalizeConfig({ proxies: 'http://a:b%40c@10.0.0.1:3128 fr\n\nhttp://10.0.0.2:8080\n' });
    const proxies = await staticList.listProxies(config);
    assert.deepEqual(proxies.map(proxy => [proxy.host, proxy.port, proxy.username, proxy.password, proxy.country]), [
        ['10.0.0.1', 3128, 'a', 'b@c', 'FR'], ['10.0.0.2', 8080, '', '', null]]);
    assert.throws(() => staticList.normalizeConfig({ proxies: 'socks5://10.0.0.1:1080' }), /must use http/u);
    assert.throws(() => staticList.normalizeConfig({ proxies: 'http://10.0.0.1' }), /host and a port/u);
    assert.throws(() => staticList.normalizeConfig({ proxies: '' }), /required/u);
    assert.throws(() => proxyProvider('unknown'), /provider is invalid/u);
    assert.deepEqual(publicProviders().map(provider => provider.id), ['webshare', 'static']);
});

test('an inactive pool leaves workstations unproxied and an active one assigns stable proxies', () => withPool({}, async (pool) => {
    assert.equal(pool.acquire('robot-one'), null);
    const account = await addStatic(pool, 'Main', ['10.0.0.1', '10.0.0.2']);
    const first = pool.acquire('robot-one');
    assert.equal(first.host, '10.0.0.1');
    assert.equal(first.username, 'user0');
    assert.deepEqual(pool.acquire('robot-one'), first);
    assert.equal(pool.acquire('robot-two').host, '10.0.0.2');
    await assert.rejects(async () => pool.acquire('robot-three'), error => error.statusCode === 409 && /No free proxy/u.test(error.message));
    assert.equal(pool.release('robot-two'), true);
    assert.equal(pool.acquire('robot-three').host, '10.0.0.2');
    pool.updateAccount(account, { status: 'disabled' });
    assert.equal(pool.acquire('robot-one'), null);
}));

test('robots spread across accounts of the highest priority and stay on draining accounts', () => withPool({}, async (pool) => {
    const backup = await addStatic(pool, 'Backup', ['10.9.0.1'], { priority: 'low' });
    const first = await addStatic(pool, 'First', ['10.1.0.1', '10.1.0.2']);
    const second = await addStatic(pool, 'Second', ['10.2.0.1', '10.2.0.2']);
    const accounts = ['robot-a', 'robot-b', 'robot-c', 'robot-d'].map(robot => pool.acquire(robot).accountId);
    assert.deepEqual(accounts, [first, second, first, second]);
    assert.equal(pool.acquire('robot-e').accountId, backup);
    assert.deepEqual(pool.snapshot().accounts.map(account => account.priority), ['medium', 'medium', 'low']);
    assert.throws(() => pool.updateAccount(backup, { priority: 200 }), error => error.statusCode === 400);
    pool.updateAccount(backup, { priority: 'high' });
    assert.equal(pool.snapshot().accounts[0].id, backup);
    pool.updateAccount(first, { status: 'draining' });
    assert.equal(pool.acquire('robot-a').accountId, first);
    pool.release('robot-a');
    await assert.rejects(async () => pool.acquire('robot-a'), error => error.statusCode === 409);
    pool.updateAccount(first, { status: 'disabled' });
    await assert.rejects(async () => pool.acquire('robot-c'), error => error.statusCode === 409);
    assert.equal(pool.snapshot().accounts.find(account => account.id === first).assignedCount, 0);
}));

test('sync replaces vanished proxies and rejected credentials take an account out of rotation', () => withPool({}, async (pool) => {
    let listing = [{ id: 'p1', proxy_address: '1.1.1.1', port: 1000, username: 'u', password: 'p', valid: true },
        { id: 'p2', proxy_address: '2.2.2.2', port: 2000, username: 'u', password: 'p', valid: true }];
    let status = 200;
    pool.fetchImpl = async () => jsonResponse(status, { next: null, results: listing });
    const account = pool.addAccount({ provider: 'webshare', config: { apiKey: 'key-123456' } });
    assert.deepEqual(await pool.syncAccount(account), { ok: true, proxies: 2, skipped: 0 });
    assert.equal(pool.acquire('robot-one').host, '1.1.1.1');
    listing = [listing[1], { id: 'p3', proxy_address: '3.3.3.3', port: 3000, username: 'u', password: 'p', valid: true }];
    await pool.syncAccount(account);
    assert.equal(pool.assignedProxyId('robot-one'), null);
    assert.equal(pool.acquire('robot-one').host, '2.2.2.2');
    status = 401;
    assert.equal((await pool.syncAccount(account)).ok, false);
    assert.equal(pool.snapshot().accounts[0].health, 'rejected');
    await assert.rejects(async () => pool.acquire('robot-one'), error => error.statusCode === 409);
    assert.throws(() => pool.addAccount({ provider: 'webshare', config: { apiKey: 'key-123456' } }), error => error.statusCode === 409);
}));

test('a failed check moves the robot and the snapshot never exposes credentials', () => withPool({
    checkImpl: async (proxy) => proxy.host === '10.0.0.1' ? { ok: false, error: 'proxy answered 407' } : { ok: true, exitIp: '203.0.113.9' },
}, async (pool) => {
    await addStatic(pool, 'Main', ['10.0.0.1', '10.0.0.2']);
    const held = pool.acquire('robot-one');
    assert.deepEqual(await pool.checkProxy(held.id), { ok: false, error: 'proxy answered 407' });
    assert.equal(pool.acquire('robot-one').host, '10.0.0.2');
    const snapshot = pool.snapshot();
    assert.equal(snapshot.active, true);
    assert.equal(snapshot.accounts[0].summary, '2 proxies');
    assert.deepEqual(Object.keys(snapshot.proxies[0]).sort(), ['accountId', 'assignedAt', 'available', 'checkError', 'checkStatus', 'checkedAt', 'city', 'country', 'exitIp', 'host', 'id', 'port', 'robotId'].sort());
    assert.doesNotMatch(JSON.stringify(snapshot), /secret|user0/u);
    assert.deepEqual(await pool.checkProxy(snapshot.proxies[1].id), { ok: true, exitIp: '203.0.113.9' });
    await assert.rejects(pool.checkProxy('pxp_0000000000000000'), error => error.statusCode === 404);
}));

test('the pool database is private to the service', () => withPool({}, async (pool) => {
    pool.initialize();
    assert.equal((await fs.stat(pool.file)).mode & 0o777, 0o600);
}));
