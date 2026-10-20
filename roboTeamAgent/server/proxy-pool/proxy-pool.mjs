import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { proxyProvider, publicProviders } from './providers/index.mjs';
import { proxyAuthorization } from './proxy-relay.mjs';

const ACCOUNT_ID = /^pxa_[0-9a-f]{12}$/u;
const PROXY_ID = /^pxp_[0-9a-f]{16}$/u;
const ROBOT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const ACCOUNT_STATUSES = new Set(['enabled', 'draining', 'disabled']);
// Accounts are ranked by priority; the stored rank orders acquisition, lowest first.
const PRIORITY_RANKS = { high: 1, medium: 2, low: 3 };
const PRIORITY_NAMES = Object.fromEntries(Object.entries(PRIORITY_RANKS).map(([name, rank]) => [rank, name]));
const CHECK_HOST = 'api.ipify.org';
const CHECK_TIMEOUT_MS = 20000;
export const PROXY_SYNC_INTERVAL_MS = 30 * 60 * 1000;

function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

function priorityRank(value, fallback) {
    if (value === undefined || value === '') return fallback;
    const rank = PRIORITY_RANKS[String(value)];
    if (!rank) throw httpError(400, 'priority must be high, medium or low');
    return rank;
}

function proxyId(accountId, externalId) {
    return `pxp_${crypto.createHash('sha256').update(`${accountId}\0${externalId}`).digest('hex').slice(0, 16)}`;
}

function validProxy(entry) {
    return entry && entry.scheme === 'http' && typeof entry.host === 'string' && /^[A-Za-z0-9.:-]{1,253}$/u.test(entry.host)
        && Number.isInteger(entry.port) && entry.port > 0 && entry.port < 65536 && String(entry.externalId || '').length > 0;
}

// Asks an IP echo service through the proxy itself and reports the address the internet sees.
export function checkProxyExit(proxy, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        const authorization = proxyAuthorization(proxy);
        const finish = (result) => { clearTimeout(timer); resolve(result); };
        const timer = setTimeout(() => { request.destroy(); finish({ ok: false, error: 'timed out' }); }, timeoutMs);
        const request = http.request({
            host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${CHECK_HOST}:443`, agent: false,
            headers: { host: `${CHECK_HOST}:443`, ...(authorization ? { 'proxy-authorization': authorization } : {}) },
        });
        request.once('connect', (response, socket) => {
            if (response.statusCode !== 200) { socket.destroy(); return finish({ ok: false, error: `proxy answered ${response.statusCode}` }); }
            const echo = https.get({
                host: CHECK_HOST, path: '/?format=json', agent: false,
                createConnection: () => tls.connect({ socket, servername: CHECK_HOST }),
            }, (reply) => {
                let body = '';
                reply.setEncoding('utf8');
                reply.on('data', chunk => { body = `${body}${chunk}`.slice(0, 4096); });
                reply.once('end', () => {
                    socket.destroy();
                    try {
                        const ip = String(JSON.parse(body).ip || '');
                        finish(ip ? { ok: true, exitIp: ip } : { ok: false, error: 'echo service gave no address' });
                    } catch { finish({ ok: false, error: 'echo service answer was unreadable' }); }
                });
            });
            echo.once('error', (error) => { socket.destroy(); finish({ ok: false, error: error.message }); });
        });
        request.once('error', (error) => finish({ ok: false, error: error.message }));
        request.end();
    });
}

// The shared pool of proxies, drawn from any number of provider accounts. Each robot that opens a
// browser or desktop holds at most one proxy, and keeps it across sessions while it stays usable,
// so the address websites see is stable. Records live in SQLite beside the other RoboTeam state;
// credentials never leave this process except as the relay's upstream Proxy-Authorization.
export class ProxyPool {
    constructor({ file, fetchImpl = fetch, checkImpl = checkProxyExit, now = () => new Date() } = {}) {
        if (!file) throw new Error('proxy pool file is required');
        this.file = file;
        this.fetchImpl = fetchImpl;
        this.checkImpl = checkImpl;
        this.now = now;
        this.syncing = new Map();
        this.timer = null;
    }

    initialize() {
        if (this.db) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        if (fs.lstatSync(path.dirname(this.file)).isSymbolicLink() || (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink())) {
            throw new Error('Unsafe proxy pool database path');
        }
        this.db = new DatabaseSync(this.file);
        fs.chmodSync(this.file, 0o600);
        this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, config TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'enabled',
                health TEXT NOT NULL DEFAULT 'pending', last_error TEXT, last_sync_at TEXT, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS proxies (
                id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                external_id TEXT NOT NULL, scheme TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
                username TEXT NOT NULL, password TEXT NOT NULL, country TEXT, city TEXT,
                available INTEGER NOT NULL DEFAULT 1, check_status TEXT, check_error TEXT, exit_ip TEXT, checked_at TEXT,
                UNIQUE(account_id, external_id));
            CREATE TABLE IF NOT EXISTS assignments (
                robot_id TEXT PRIMARY KEY, proxy_id TEXT NOT NULL UNIQUE REFERENCES proxies(id) ON DELETE CASCADE,
                assigned_at TEXT NOT NULL);`);
    }

    close() {
        this.stopAutoSync();
        this.db?.close();
        this.db = null;
    }

    _transaction(operation) {
        this.initialize();
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = operation(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }

    _account(id) {
        if (!ACCOUNT_ID.test(String(id))) throw httpError(404, 'proxy account not found');
        this.initialize();
        const account = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
        if (!account) throw httpError(404, 'proxy account not found');
        return account;
    }

    // While any account is enabled or draining, every robot workstation must run behind a proxy.
    isActive() {
        this.initialize();
        return Boolean(this.db.prepare("SELECT 1 FROM accounts WHERE status != 'disabled' LIMIT 1").get());
    }

    providers() { return publicProviders(); }

    // Administrator view. Credentials and provider configuration are never part of it.
    snapshot() {
        this.initialize();
        const accounts = this.db.prepare(`SELECT a.*,
                (SELECT COUNT(*) FROM proxies p WHERE p.account_id = a.id) AS proxy_count,
                (SELECT COUNT(*) FROM proxies p WHERE p.account_id = a.id AND p.available = 1) AS available_count,
                (SELECT COUNT(*) FROM assignments s JOIN proxies p ON p.id = s.proxy_id WHERE p.account_id = a.id) AS assigned_count
            FROM accounts a ORDER BY a.priority, a.created_at`).all().map(account => ({
            id: account.id,
            provider: account.provider,
            providerLabel: proxyProvider(account.provider).label,
            label: account.label,
            summary: proxyProvider(account.provider).describeConfig(JSON.parse(account.config)),
            priority: PRIORITY_NAMES[account.priority] || 'medium',
            status: account.status,
            health: account.health,
            lastError: account.last_error,
            lastSyncAt: account.last_sync_at,
            createdAt: account.created_at,
            proxyCount: account.proxy_count,
            availableCount: account.available_count,
            assignedCount: account.assigned_count,
        }));
        const proxies = this.db.prepare(`SELECT p.*, s.robot_id, s.assigned_at FROM proxies p
            LEFT JOIN assignments s ON s.proxy_id = p.id
            JOIN accounts a ON a.id = p.account_id ORDER BY a.priority, a.created_at, p.country, p.host, p.port`).all().map(proxy => ({
            id: proxy.id,
            accountId: proxy.account_id,
            host: proxy.host,
            port: proxy.port,
            country: proxy.country,
            city: proxy.city,
            available: proxy.available === 1,
            checkStatus: proxy.check_status,
            checkError: proxy.check_error,
            exitIp: proxy.exit_ip,
            checkedAt: proxy.checked_at,
            robotId: proxy.robot_id || null,
            assignedAt: proxy.assigned_at || null,
        }));
        return { active: accounts.some(account => account.status !== 'disabled'), accounts, proxies };
    }

    addAccount(input = {}) {
        let provider, config;
        try {
            provider = proxyProvider(String(input.provider || ''));
            config = provider.normalizeConfig(input.config || {});
        } catch (error) { throw httpError(400, error.message); }
        const label = String(input.label || '').trim() || provider.label;
        if (label.length > 80) throw httpError(400, 'account label must be at most 80 characters');
        const priority = priorityRank(input.priority, PRIORITY_RANKS.medium);
        const id = `pxa_${crypto.randomBytes(6).toString('hex')}`;
        this._transaction(() => {
            const duplicate = this.db.prepare('SELECT id FROM accounts WHERE provider = ? AND config = ?').get(provider.id, JSON.stringify(config));
            if (duplicate) throw httpError(409, 'this proxy account is already in the pool');
            this.db.prepare('INSERT INTO accounts (id, provider, label, config, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)')
                .run(id, provider.id, label, JSON.stringify(config), priority, this.now().toISOString());
        });
        return id;
    }

    updateAccount(id, input = {}) {
        const account = this._account(id);
        const label = input.label === undefined ? account.label : String(input.label).trim();
        if (!label || label.length > 80) throw httpError(400, 'account label must contain 1 to 80 characters');
        const priority = priorityRank(input.priority, account.priority);
        const status = input.status === undefined ? account.status : String(input.status);
        if (!ACCOUNT_STATUSES.has(status)) throw httpError(400, 'status must be enabled, draining or disabled');
        this.db.prepare('UPDATE accounts SET label = ?, priority = ?, status = ? WHERE id = ?').run(label, priority, status, id);
    }

    removeAccount(id) {
        this._account(id);
        this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    }

    // One provider call per account; concurrent requests for the same account share it.
    syncAccount(id) {
        if (this.syncing.has(id)) return this.syncing.get(id);
        const pending = this._syncAccount(id).finally(() => this.syncing.delete(id));
        this.syncing.set(id, pending);
        return pending;
    }

    async _syncAccount(id) {
        const account = this._account(id);
        const provider = proxyProvider(account.provider);
        const syncedAt = this.now().toISOString();
        let entries;
        try {
            entries = await provider.listProxies(JSON.parse(account.config), { fetchImpl: this.fetchImpl });
        } catch (error) {
            const rejected = error?.credentialsRejected === true;
            if (!this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) throw httpError(404, 'proxy account not found');
            this.db.prepare('UPDATE accounts SET health = ?, last_error = ?, last_sync_at = ? WHERE id = ?')
                .run(rejected ? 'rejected' : 'error', String(error?.message || error).slice(0, 500), syncedAt, id);
            return { ok: false, error: String(error?.message || error) };
        }
        const proxies = entries.filter(validProxy);
        this._transaction(() => {
            if (!this.db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) throw httpError(404, 'proxy account not found');
            const keep = new Set();
            const upsert = this.db.prepare(`INSERT INTO proxies (id, account_id, external_id, scheme, host, port, username, password, country, city, available)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET scheme = excluded.scheme, host = excluded.host, port = excluded.port,
                    username = excluded.username, password = excluded.password, country = excluded.country,
                    city = excluded.city, available = excluded.available`);
            for (const entry of proxies) {
                const proxy = proxyId(id, entry.externalId);
                keep.add(proxy);
                upsert.run(proxy, id, String(entry.externalId), entry.scheme, entry.host, entry.port,
                    String(entry.username || ''), String(entry.password || ''), entry.country || null, entry.city || null, entry.available === false ? 0 : 1);
            }
            for (const { id: existing } of this.db.prepare('SELECT id FROM proxies WHERE account_id = ?').all(id)) {
                if (!keep.has(existing)) this.db.prepare('DELETE FROM proxies WHERE id = ?').run(existing);
            }
            this.db.prepare("UPDATE accounts SET health = 'ok', last_error = NULL, last_sync_at = ? WHERE id = ?").run(syncedAt, id);
        });
        return { ok: true, proxies: proxies.length, skipped: entries.length - proxies.length };
    }

    async syncAll() {
        this.initialize();
        const ids = this.db.prepare("SELECT id FROM accounts WHERE status != 'disabled'").all().map(row => row.id);
        const results = await Promise.allSettled(ids.map(id => this.syncAccount(id)));
        return results.map((result, index) => ({ accountId: ids[index], ...(result.status === 'fulfilled' ? result.value : { ok: false, error: result.reason?.message }) }));
    }

    startAutoSync(intervalMs = PROXY_SYNC_INTERVAL_MS, log = () => {}) {
        this.stopAutoSync();
        const run = () => this.syncAll().then(results => {
            for (const result of results) if (!result.ok) log(`proxy account ${result.accountId} sync failed: ${result.error}`);
        }).catch(error => log(`proxy pool sync failed: ${error?.message || error}`));
        void run();
        this.timer = setInterval(run, intervalMs);
        this.timer.unref?.();
    }

    stopAutoSync() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    // The proxy a robot workstation must use, or null while the pool is inactive. A robot keeps its
    // proxy while the proxy and its account stay usable; otherwise it receives the free proxy of the
    // highest-priority, least-loaded enabled account. Draining accounts keep their robots but take no
    // new ones. With the pool active and nothing free, the workstation does not start.
    acquire(robotId) {
        if (!ROBOT_ID.test(String(robotId))) throw httpError(400, 'Invalid robot ID.');
        const assigned = this._transaction(() => {
            if (!this.db.prepare("SELECT 1 FROM accounts WHERE status != 'disabled' LIMIT 1").get()) return null;
            const usable = `a.health != 'rejected' AND p.available = 1 AND (p.check_status IS NULL OR p.check_status != 'failed')`;
            const current = this.db.prepare(`SELECT p.* FROM assignments s JOIN proxies p ON p.id = s.proxy_id JOIN accounts a ON a.id = p.account_id
                WHERE s.robot_id = ? AND a.status IN ('enabled', 'draining') AND ${usable}`).get(robotId);
            if (current) return this._publicUpstream(current);
            this.db.prepare('DELETE FROM assignments WHERE robot_id = ?').run(robotId);
            const candidate = this.db.prepare(`SELECT p.* FROM proxies p JOIN accounts a ON a.id = p.account_id
                WHERE a.status = 'enabled' AND ${usable} AND NOT EXISTS (SELECT 1 FROM assignments s WHERE s.proxy_id = p.id)
                ORDER BY a.priority,
                    (SELECT COUNT(*) FROM assignments s JOIN proxies q ON q.id = s.proxy_id WHERE q.account_id = a.id),
                    a.created_at, p.host, p.port
                LIMIT 1`).get();
            // The unusable assignment stays released even when nothing replaces it.
            if (!candidate) return false;
            this.db.prepare('INSERT INTO assignments (robot_id, proxy_id, assigned_at) VALUES (?, ?, ?)').run(robotId, candidate.id, this.now().toISOString());
            return this._publicUpstream(candidate);
        });
        if (assigned === false) throw httpError(409, 'No free proxy is available in the shared proxy pool. Add a proxy account, enable one, or release a proxy held by another robot.');
        return assigned;
    }

    _publicUpstream(row) {
        return { id: row.id, accountId: row.account_id, scheme: row.scheme, host: row.host, port: row.port,
            username: row.username, password: row.password, country: row.country };
    }

    release(robotId) {
        if (!ROBOT_ID.test(String(robotId))) throw httpError(400, 'Invalid robot ID.');
        this.initialize();
        return this.db.prepare('DELETE FROM assignments WHERE robot_id = ?').run(robotId).changes > 0;
    }

    assignedProxyId(robotId) {
        this.initialize();
        return this.db.prepare('SELECT proxy_id FROM assignments WHERE robot_id = ?').get(robotId)?.proxy_id || null;
    }

    // A failed check takes the proxy out of rotation (its robot moves at the next workstation start);
    // a later successful check returns it.
    async checkProxy(id) {
        if (!PROXY_ID.test(String(id))) throw httpError(404, 'proxy not found');
        this.initialize();
        const row = this.db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
        if (!row) throw httpError(404, 'proxy not found');
        const result = await this.checkImpl(this._publicUpstream(row));
        this.db.prepare('UPDATE proxies SET check_status = ?, check_error = ?, exit_ip = ?, checked_at = ? WHERE id = ?')
            .run(result.ok ? 'ok' : 'failed', result.ok ? null : String(result.error || 'check failed').slice(0, 300),
                result.ok ? result.exitIp : null, this.now().toISOString(), id);
        return result.ok ? { ok: true, exitIp: result.exitIp } : { ok: false, error: result.error };
    }
}

export const proxyPoolInternals = { proxyId };
