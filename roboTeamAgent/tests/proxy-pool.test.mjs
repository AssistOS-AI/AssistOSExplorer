import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ProxyPool } from '../server/proxy-pool/proxy-pool.mjs';
import { SecretBox } from '../server/secret-box.mjs';
import webshare from '../server/proxy-pool/providers/webshare.mjs';
import staticList from '../server/proxy-pool/providers/static.mjs';
import { proxyProvider, publicProviders } from '../server/proxy-pool/providers/index.mjs';
import { localeForCountry, localeProfileFromLookup } from '../server/proxy-pool/locale-profile.mjs';

async function withPool(options, run) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-proxy-pool-'));
    const pool = new ProxyPool({ file: path.join(directory, 'pool.sqlite'), secretBox: new SecretBox('test-vault-key-0123456789'), ...options });
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

test('provider configuration and proxy credentials are stored sealed', () => withPool({}, async (pool, directory) => {
    const account = await addStatic(pool, 'Sealed', ['10.4.0.1']);
    const db = new DatabaseSync(path.join(directory, 'pool.sqlite'), { readOnly: true });
    try {
        const stored = JSON.stringify([db.prepare('SELECT * FROM accounts').all(), db.prepare('SELECT * FROM proxies').all()]);
        assert.doesNotMatch(stored, /secret0|user0/u);
        assert.match(stored, /rtv1:/u);
    } finally { db.close(); }
    assert.equal(pool.snapshot().accounts[0].summary, '1 proxy');
    const upstream = pool.acquire('robot-one');
    assert.equal(upstream.username, 'user0');
    assert.equal(upstream.password, 'secret0');
    assert.throws(() => pool.addAccount({ provider: 'static', config: staticConfig('10.4.0.1') }), error => error.statusCode === 409);
    assert.ok(account);
}));

test('a pool without the vault key refuses secrets and seals clear-text rows once the key arrives', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roboteam-proxy-legacy-'));
    const file = path.join(directory, 'pool.sqlite');
    try {
        const legacy = new DatabaseSync(file);
        legacy.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, config TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'enabled', health TEXT NOT NULL DEFAULT 'pending',
                last_error TEXT, last_sync_at TEXT, created_at TEXT NOT NULL);
            CREATE TABLE proxies (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                external_id TEXT NOT NULL, scheme TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
                username TEXT NOT NULL, password TEXT NOT NULL, country TEXT, city TEXT,
                available INTEGER NOT NULL DEFAULT 1, check_status TEXT, check_error TEXT, exit_ip TEXT, checked_at TEXT,
                UNIQUE(account_id, external_id));`);
        legacy.prepare('INSERT INTO accounts (id, provider, label, config, created_at) VALUES (?, ?, ?, ?, ?)')
            .run('pxa_0123456789ab', 'webshare', 'Old', JSON.stringify({ apiKey: 'legacy-key-9876' }), '2026-01-01T00:00:00.000Z');
        legacy.prepare(`INSERT INTO proxies (id, account_id, external_id, scheme, host, port, username, password)
            VALUES ('pxp_0123456789abcdef', 'pxa_0123456789ab', 'x', 'http', '10.5.0.1', 8080, 'olduser', 'oldpass')`).run();
        legacy.close();

        const locked = new ProxyPool({ file });
        assert.throws(() => locked.addAccount({ provider: 'static', config: staticConfig('10.5.0.2') }), error => error.statusCode === 503);
        assert.throws(() => locked.acquire('robot-one'), error => error.statusCode === 503);
        locked.close();

        const pool = new ProxyPool({ file, secretBox: new SecretBox('test-vault-key-0123456789') });
        pool.initialize();
        assert.equal(pool.snapshot().accounts[0].summary, 'API key …9876');
        assert.equal(pool.acquire('robot-one').password, 'oldpass');
        pool.close();
        const db = new DatabaseSync(file, { readOnly: true });
        const stored = JSON.stringify([db.prepare('SELECT * FROM accounts').all(), db.prepare('SELECT * FROM proxies').all()]);
        db.close();
        assert.doesNotMatch(stored, /legacy-key|olduser|oldpass/u);
        await assert.rejects(async () => new ProxyPool({ file, secretBox: new SecretBox('another-vault-key-0000') }).acquire('robot-one'), /cannot be decrypted/u);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a country maps to one locale and an unknown country stays English', () => {
    assert.deepEqual(localeForCountry('de'), { locale: 'de_DE.UTF-8', lang: 'de-DE' });
    assert.deepEqual(localeForCountry('US'), { locale: 'en_US.UTF-8', lang: 'en-US' });
    assert.deepEqual(localeForCountry('ZZ'), { locale: 'en_US.UTF-8', lang: 'en-US' });
    assert.deepEqual(localeProfileFromLookup({ timezone: { id: 'America/Los_Angeles' }, country_code: 'us' }),
        { timezone: 'America/Los_Angeles', locale: 'en_US.UTF-8', lang: 'en-US' });
    assert.deepEqual(localeProfileFromLookup({ timezone: { id: '../Etc/UTC' }, country_code: 'nope' }, 'DE'),
        { timezone: 'UTC', locale: 'de_DE.UTF-8', lang: 'de-DE' });
});

test('the exit-address locale is cached and a failed lookup is not', () => withPool({
    checkImpl: async () => ({ ok: true, exitIp: '203.0.113.9' }),
}, async (pool) => {
    const lookups = [];
    pool.localeImpl = async (_proxy, exitIp) => {
        lookups.push(exitIp);
        return exitIp === '203.0.113.9'
            ? { timezone: 'Europe/Berlin', locale: 'de_DE.UTF-8', lang: 'de-DE' }
            : { timezone: 'UTC', locale: 'en_US.UTF-8', lang: 'en-US', unresolved: true };
    };
    await addStatic(pool, 'Main', ['10.0.0.1']);
    const proxy = pool.acquire('robot-one');
    const expected = { timezone: 'Europe/Berlin', locale: 'de_DE.UTF-8', lang: 'de-DE' };
    assert.deepEqual({ ...await pool.localeFor(proxy) }, expected);
    assert.deepEqual({ ...await pool.localeFor(proxy) }, expected);
    assert.deepEqual(lookups, ['203.0.113.9']);
    pool.db.prepare('UPDATE proxies SET exit_ip = ? WHERE id = ?').run('203.0.113.10', proxy.id);
    pool.localeImpl = async () => ({ timezone: 'UTC', locale: 'en_US.UTF-8', lang: 'en-US', unresolved: true });
    assert.deepEqual(await pool.localeFor({ ...proxy, exitIp: '203.0.113.10' }), { timezone: 'UTC', locale: 'en_US.UTF-8', lang: 'en-US' });
    assert.equal(pool.db.prepare('SELECT COUNT(*) AS n FROM locale_cache').get().n, 1);
}));
