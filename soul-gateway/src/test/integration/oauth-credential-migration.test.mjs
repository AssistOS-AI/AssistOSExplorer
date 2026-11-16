import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../../db/sqlite-db.mjs';
import { migrateOAuthCredentialPaths } from '../../runtime/providers/oauth/credential-path-migration.mjs';
import { OAuthCredentialStore } from '../../runtime/providers/oauth/credential-store.mjs';
import { OAuthManager } from '../../runtime/providers/oauth-manager.mjs';
import * as accountsDao from '../../db/dao/provider-accounts-dao.mjs';

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'oauth-path-migration-'));
    const pool = await openDatabase({ SQLITE_PATH: join(root, 'test.sqlite') });
    t.after(async () => { await pool.end(); await rm(root, { recursive: true, force: true }); });
    await pool.exec(`CREATE TABLE provider_accounts (
        id TEXT PRIMARY KEY, credentials_path TEXT, metadata TEXT DEFAULT '{}',
        access_token_expires_at TEXT, refresh_token_expires_at TEXT,
        updated_at TEXT, deleted_at TEXT, status TEXT DEFAULT 'active'
    )`);
    const log = { info() {}, warn() {}, error() {} };
    const baseDir = join(root, 'credentials');
    const store = new OAuthCredentialStore({ baseDir, encryptionKey: randomBytes(32), log });
    const add = async (id, source) => pool.query(
        'INSERT INTO provider_accounts (id, credentials_path) VALUES ($1, $2)', [id, source]
    );
    const migrate = () => migrateOAuthCredentialPaths({ pool, baseDir, store, log });
    return { root, pool, baseDir, store, log, add, migrate };
}

test('migrates references once, preserves ciphertext, and refresh reads and writes the new file', async t => {
    const f = await fixture(t);
    const file = await f.store.allocatePath('provider', 'account');
    await f.store.write(file, { accessToken: 'old-access', refreshToken: 'old-refresh' });
    const before = await readFile(file);
    await f.add('account', '/data/credentials/provider/account.json.enc');
    await f.add('custom', '/custom/credentials/account.json.enc');
    await f.add('similar', '/data/credentials-other/account.json.enc');
    assert.deepEqual(await f.migrate(), { migrated: 1, missing: 0 });
    assert.deepEqual(await f.migrate(), { migrated: 0, missing: 0 });
    assert.deepEqual(await readFile(file), before);
    assert.equal((await accountsDao.findById(f.pool, 'account')).credentials_path, file);
    assert.equal((await accountsDao.findById(f.pool, 'custom')).credentials_path, '/custom/credentials/account.json.enc');
    assert.equal((await accountsDao.findById(f.pool, 'similar')).credentials_path, '/data/credentials-other/account.json.enc');
    const manager = new OAuthManager({
        pool: f.pool, accountsDao, oauthCredentialStore: f.store, log: f.log,
        accountPool: { async markRefreshing() {}, async markActive() {}, async markErrored() {} },
    });
    manager.registerAdapter({
        key: 'test', flowType: 'auth_code_pkce', async startFlow() {}, async handleCallback() {},
        async refreshTokens(tokens) {
            assert.equal(tokens.refreshToken, 'old-refresh');
            assert.equal(tokens.accessToken, 'old-access');
            return { accessToken: 'new-access', refreshToken: 'new-refresh' };
        },
    });
    await manager.refreshTokens('account', 'test');
    assert.equal((await f.store.read(file)).refreshToken, 'new-refresh');
});

test('missing relocated files retain their reference and migrate when restored', async t => {
    const f = await fixture(t);
    const old = '/data/credentials/provider/missing.json.enc';
    await f.add('missing', old);
    assert.deepEqual(await f.migrate(), { migrated: 0, missing: 1 });
    assert.equal((await accountsDao.findById(f.pool, 'missing')).credentials_path, old);
    const file = await f.store.allocatePath('provider', 'missing');
    await f.store.write(file, { refreshToken: 'restored' });
    assert.deepEqual(await f.migrate(), { migrated: 1, missing: 0 });
});

for (const kind of ['traversal', 'symlink', 'corrupt']) {
    test(`unsafe ${kind} rolls back all reference updates`, async t => {
        const f = await fixture(t);
        const file = await f.store.allocatePath('provider', 'valid');
        await f.store.write(file, { refreshToken: 'valid' });
        await f.add('valid', '/data/credentials/provider/valid.json.enc');
        let old = '/data/credentials/provider/invalid.json.enc';
        if (kind === 'traversal') old = '/data/credentials/../outside.json.enc';
        if (kind === 'symlink') await symlink(file, join(f.baseDir, 'provider/invalid.json.enc'));
        if (kind === 'corrupt') await writeFile(join(f.baseDir, 'provider/invalid.json.enc'), '{}');
        await f.add('invalid', old);
        await assert.rejects(f.migrate());
        assert.equal((await accountsDao.findById(f.pool, 'valid')).credentials_path, '/data/credentials/provider/valid.json.enc');
    });
}
