import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import PersistoOidcAdapter, { readOidcDocument, writeOidcDocument } from '../lib/oidc/adapter.mjs';
import { decryptOidcPayload, encryptOidcPayload, getOrCreateOidcKeys } from '../lib/oidc/secrets.mjs';
import { getStore, flush, resetStoreForTests } from '../lib/store.mjs';
import { SNAPSHOT_FILE } from '../lib/durable-storage.mjs';
import { withPersistenceScope } from '../lib/persistence-scope.mjs';

let folder;
async function fixture() {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-oidc-storage-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'oidc-storage-test-key';
    const keys = await getOrCreateOidcKeys();
    await writeOidcDocument('Client', 'client-test', { enabled: true, metadata: { client_id: 'client-test' } });
    return keys;
}

async function grant(id = 'grant-test', clientId = 'client-test') {
    await new PersistoOidcAdapter('Grant').upsert(id, { jti: id, clientId, accountId: 'account-secret-id' }, 3600);
}

afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    if (folder) await rm(folder, { recursive: true, force: true });
    delete process.env.USERPERSISTO_SETTINGS_KEY;
});

test('OIDC records, secondary lookup, consumed state, and stable signing keys survive restart', async () => {
    const keys = await fixture();
    await grant();
    const codes = new PersistoOidcAdapter('AuthorizationCode');
    const session = new PersistoOidcAdapter('Session');
    const device = new PersistoOidcAdapter('DeviceCode');
    await codes.upsert('secret-authorization-code', { grantId: 'grant-test', clientId: 'client-test', jti: 'secret-authorization-code' }, 120);
    await session.upsert('secret-session-id', { uid: 'secret-session-uid', accountId: 'account-secret-id' }, 3600);
    await device.upsert('device-secret', { userCode: 'user-visible-code', clientId: 'client-test' }, 120);
    await codes.consume('secret-authorization-code');
    await resetStoreForTests();
    assert.ok((await codes.find('secret-authorization-code')).consumed);
    assert.equal((await session.findByUid('secret-session-uid')).accountId, 'account-secret-id');
    assert.equal((await device.findByUserCode('user-visible-code')).clientId, 'client-test');
    const reopenedKeys = await getOrCreateOidcKeys();
    assert.deepEqual(reopenedKeys, keys);
    const privateKey = createPrivateKey({ key: keys.jwks.keys[0], format: 'jwk' });
    const publicKey = createPublicKey({ key: reopenedKeys.jwks.keys[0], format: 'jwk' });
    assert.equal(verify('RSA-SHA256', Buffer.from('restart-test'), publicKey, sign('RSA-SHA256', Buffer.from('restart-test'), privateKey)), true);
});

test('snapshot encrypts opaque handles, token payloads, private signing keys, and cookie keys', async () => {
    const keys = await fixture();
    await grant();
    await new PersistoOidcAdapter('RefreshToken').upsert('plaintext-refresh-token', { grantId: 'grant-test', clientId: 'client-test', jti: 'plaintext-refresh-token', accountId: 'account-secret-id' }, 300);
    const snapshot = await readFile(join(folder, SNAPSHOT_FILE), 'utf8');
    for (const secret of ['plaintext-refresh-token', 'account-secret-id', keys.jwks.keys[0].d, ...keys.cookieKeys]) assert.equal(snapshot.includes(secret), false);
});

test('expiry is enforced across normal and secondary lookups, including restart', async (t) => {
    await fixture();
    const session = new PersistoOidcAdapter('Session');
    const device = new PersistoOidcAdapter('DeviceCode');
    await session.upsert('expiring-session', { uid: 'expiring-uid' }, 5);
    await device.upsert('expiring-device', { userCode: 'expiring-user-code' }, 5);
    await resetStoreForTests();
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 6000 });
    assert.equal(await session.findByUid('expiring-uid'), undefined);
    assert.equal(await device.findByUserCode('expiring-user-code'), undefined);
    assert.equal(await session.find('expiring-session'), undefined);
    assert.equal(await device.find('expiring-device'), undefined);
});

test('updating an existing session replaces its secondary identifiers', async () => {
    await fixture();
    const sessions = new PersistoOidcAdapter('Session');
    await sessions.upsert('session', { uid: 'old-uid', accountId: 'old-account' }, 300);
    await sessions.upsert('session', { uid: 'new-uid', accountId: 'new-account' }, 300);
    assert.equal(await sessions.findByUid('old-uid'), undefined);
    assert.equal((await sessions.findByUid('new-uid')).accountId, 'new-account');
    await sessions.destroy('session');
    assert.equal(await sessions.findByUid('new-uid'), undefined);
});

test('ordinary writes collect unused expired records in bounded batches and preserve live revocation markers', async (t) => {
    await fixture();
    await grant();
    await new PersistoOidcAdapter('Grant').destroy('grant-test');
    const sessions = new PersistoOidcAdapter('Session');
    for (let index = 0; index < 125; index += 1) await sessions.upsert(`unused-${index}`, { uid: `unused-uid-${index}` }, 1);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
    await sessions.upsert('live-one', { uid: 'live-uid-one' }, 3600);
    const store = await getStore();
    assert.equal((await store.select('oidcRecord', { model: 'Session' })).totalCount > 0, true);
    assert.equal((await store.getOidcModelsObjectsByModel('Session')).length, 26);
    await sessions.upsert('live-two', { uid: 'live-uid-two' }, 3600);
    assert.equal((await store.getOidcModelsObjectsByModel('Session')).length, 2);
    assert.ok(await readOidcDocument('RevokedGrant', 'grant-test'));
    await resetStoreForTests();
    assert.equal((await (await getStore()).getOidcModelsObjectsByModel('Session')).length, 2);
    assert.ok(await sessions.find('live-one'));
});

test('concurrent code consumption has one winner and duplicate use revokes its grant', async () => {
    await fixture();
    await grant();
    const codes = new PersistoOidcAdapter('AuthorizationCode');
    await codes.upsert('single-use-code', { clientId: 'client-test', grantId: 'grant-test' }, 120);
    const results = await Promise.allSettled([codes.consume('single-use-code'), codes.consume('single-use-code')]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.error, 'invalid_grant');
    assert.equal(await new PersistoOidcAdapter('Grant').find('grant-test'), undefined);
    assert.equal(await codes.find('single-use-code'), undefined);
    await assert.rejects(new PersistoOidcAdapter('AccessToken').upsert('late-token', { grantId: 'grant-test', clientId: 'client-test' }, 120), { error: 'invalid_grant' });
});

test('consumed tokens cannot be reset by a later upsert', async () => {
    await fixture();
    await grant();
    const refresh = new PersistoOidcAdapter('RefreshToken');
    const payload = { grantId: 'grant-test', clientId: 'client-test' };
    await refresh.upsert('refresh', payload, 300);
    await refresh.consume('refresh');
    await refresh.upsert('refresh', payload, 300);
    assert.ok((await refresh.find('refresh')).consumed);
});

test('grant revocation removes every artifact and survives restart without touching another grant', async () => {
    await fixture();
    await grant('grant-one');
    await grant('grant-two');
    for (const model of ['AuthorizationCode', 'AccessToken', 'RefreshToken']) {
        const adapter = new PersistoOidcAdapter(model);
        await adapter.upsert(`${model}-one`, { grantId: 'grant-one', clientId: 'client-test' }, 300);
        await adapter.upsert(`${model}-two`, { grantId: 'grant-two', clientId: 'client-test' }, 300);
    }
    await new PersistoOidcAdapter('AccessToken').revokeByGrantId('grant-one');
    await resetStoreForTests();
    for (const model of ['AuthorizationCode', 'AccessToken', 'RefreshToken']) {
        const adapter = new PersistoOidcAdapter(model);
        assert.equal(await adapter.find(`${model}-one`), undefined);
        assert.ok(await adapter.find(`${model}-two`));
    }
    await assert.rejects(grant('grant-one'), { error: 'invalid_grant' });
});

test('parallel provider model revocations inside one request scope are idempotent', async () => {
    await fixture();
    await grant();
    const models = ['AuthorizationCode', 'AccessToken', 'RefreshToken'];
    for (const model of models) await new PersistoOidcAdapter(model).upsert(`${model}-parallel`, { clientId: 'client-test', grantId: 'grant-test' }, 300);
    await withPersistenceScope(() => Promise.all([
        ...models.map((model) => new PersistoOidcAdapter(model).revokeByGrantId('grant-test')),
        new PersistoOidcAdapter('Grant').destroy('grant-test'),
    ]));
    for (const model of models) assert.equal(await new PersistoOidcAdapter(model).find(`${model}-parallel`), undefined);
    await resetStoreForTests();
    await assert.rejects(grant(), { error: 'invalid_grant' });
});

test('missing, changed, or corrupt encryption keys fail closed without regeneration', async () => {
    const original = await fixture();
    const before = await readFile(join(folder, SNAPSHOT_FILE), 'utf8');
    delete process.env.USERPERSISTO_SETTINGS_KEY;
    await assert.rejects(getOrCreateOidcKeys(), { code: 'oidc_storage_key_unavailable' });
    process.env.USERPERSISTO_SETTINGS_KEY = 'wrong-retained-key';
    await assert.rejects(getOrCreateOidcKeys(), { code: 'oidc_storage_decryption_failed' });
    await assert.rejects(readOidcDocument('Client', 'client-test'), { code: 'oidc_storage_decryption_failed' });
    assert.equal(await readFile(join(folder, SNAPSHOT_FILE), 'utf8'), before);
    process.env.USERPERSISTO_SETTINGS_KEY = 'oidc-storage-test-key';
    assert.deepEqual(await getOrCreateOidcKeys(), original);
    const store = await getStore();
    const settings = await store.getSystemSettingByKey('oidc.signing-material.v1');
    await store.deleteSystemSetting(settings.id);
    await flush();
    await assert.rejects(getOrCreateOidcKeys(), { code: 'oidc_signing_keys_missing' });
});

test('encryption binds ciphertext to its record and detects corruption', async () => {
    await fixture();
    const blob = encryptOidcPayload({ secret: 'secret-data' }, 'context-a');
    assert.deepEqual(decryptOidcPayload(blob, 'context-a'), { secret: 'secret-data' });
    assert.throws(() => decryptOidcPayload(blob, 'context-b'), { code: 'oidc_storage_decryption_failed' });
    assert.throws(() => decryptOidcPayload(`${blob}.extra`, 'context-a'), { code: 'oidc_storage_decryption_failed' });
});

test('failed durable token write rejects and restart retains only the prior committed token', async () => {
    await fixture();
    const sessions = new PersistoOidcAdapter('Session');
    await sessions.upsert('durable-session', { uid: 'committed-uid' }, 300);
    const backup = `${folder}-saved`;
    await rename(folder, backup);
    await writeFile(folder, 'not a directory');
    try {
        await assert.rejects(sessions.upsert('failed-session', { uid: 'uncommitted-uid' }, 300), { code: 'persistence_unavailable' });
        await assert.rejects(sessions.find('durable-session'), { code: 'persistence_unavailable' });
    } finally {
        await rm(folder);
        await rename(backup, folder);
    }
    await resetStoreForTests();
    assert.ok(await sessions.find('durable-session'));
    assert.equal(await sessions.find('failed-session'), undefined);
});

test('generic adapter supports durable encrypted login challenges and does not expose registration writes', async () => {
    await fixture();
    const challenges = new PersistoOidcAdapter('LoginChallenge');
    await challenges.upsert('challenge-secret', { correlation: 'interaction-secret', method: 'passkey' }, 300);
    await resetStoreForTests();
    assert.equal((await challenges.find('challenge-secret')).method, 'passkey');
    await challenges.destroy('challenge-secret');
    assert.equal(await challenges.find('challenge-secret'), undefined);
    await assert.rejects(new PersistoOidcAdapter('Client').upsert('injected-client', {}), { error: 'invalid_client_metadata' });
});
