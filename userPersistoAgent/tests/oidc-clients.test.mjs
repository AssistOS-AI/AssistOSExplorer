import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, updateUser, setUserRoles } from '../lib/users.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { runTool, hasTool } from '../tools/registry.mjs';
import { createOidcClient, deleteOidcClient, getClientMetadata, listOidcClients, rotateOidcClientSecret, updateOidcClient } from '../lib/oidc/clients.mjs';
import PersistoOidcAdapter from '../lib/oidc/adapter.mjs';
import { SNAPSHOT_FILE } from '../lib/durable-storage.mjs';

let folder;
let actorId;
async function fixture() {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-oidc-clients-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'oidc-client-test-settings-key';
    await ensureSeedData();
    actorId = (await createUser({ email: 'oidc-admin@example.test', roles: ['admin'] })).id;
    return { actorId };
}

function browser(overrides = {}) {
    return { client_id: 'browser-client', client_name: 'Browser application', redirect_uris: ['https://client.example.test/callback'], post_logout_redirect_uris: ['https://client.example.test/'], ...overrides };
}

async function artifacts(clientId) {
    const grantId = `grant-${clientId}`;
    await new PersistoOidcAdapter('Grant').upsert(grantId, { jti: grantId, clientId, accountId: actorId }, 3600);
    for (const model of ['AuthorizationCode', 'AccessToken', 'RefreshToken']) {
        await new PersistoOidcAdapter(model).upsert(`${model}-${clientId}`, { clientId, grantId }, 300);
    }
    await new PersistoOidcAdapter('ClientCredentials').upsert(`service-${clientId}`, { clientId }, 300);
}

async function assertRevoked(clientId) {
    assert.equal(await new PersistoOidcAdapter('Grant').find(`grant-${clientId}`), undefined);
    for (const model of ['AuthorizationCode', 'AccessToken', 'RefreshToken']) {
        assert.equal(await new PersistoOidcAdapter(model).find(`${model}-${clientId}`), undefined);
    }
    assert.equal(await new PersistoOidcAdapter('ClientCredentials').find(`service-${clientId}`), undefined);
}

afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    if (folder) await rm(folder, { recursive: true, force: true });
    delete process.env.USERPERSISTO_SETTINGS_KEY;
    delete process.env.USERPERSISTO_OIDC_ISSUER;
});

test('confidential client registration returns a secret once and stores it encrypted across restart', async () => {
    const context = await fixture();
    const created = await createOidcClient(browser(), context);
    assert.ok(created.client_secret.length >= 43);
    assert.equal(created.client.client_secret, undefined);
    assert.equal(created.client.enabled, true);
    assert.deepEqual(created.client.response_types, ['code']);
    const listed = await listOidcClients({}, context);
    assert.equal(listed.items.length, 1);
    assert.equal(JSON.stringify(listed).includes(created.client_secret), false);
    assert.equal((await readFile(join(folder, SNAPSHOT_FILE), 'utf8')).includes(created.client_secret), false);
    await resetStoreForTests();
    assert.equal((await getClientMetadata('browser-client')).client_secret, created.client_secret);
    const updated = await updateOidcClient('browser-client', { client_name: 'Renamed browser' }, context);
    assert.equal(JSON.stringify(updated).includes(created.client_secret), false);
    assert.equal((await getClientMetadata('browser-client')).client_name, 'Renamed browser');
});

test('public PKCE client and separate confidential machine client register with bounded grants', async () => {
    const context = await fixture();
    const publicClient = await createOidcClient(browser({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], scope: 'openid profile offline_access' }), context);
    assert.equal(publicClient.client_secret, undefined);
    assert.equal((await getClientMetadata('browser-client')).client_secret, undefined);
    const machine = await createOidcClient({ client_id: 'machine-client', grant_types: ['client_credentials'], token_endpoint_auth_method: 'client_secret_post', scope: 'api' }, context);
    assert.deepEqual(machine.client.response_types, []);
    assert.deepEqual(machine.client.redirect_uris, []);
    assert.ok(machine.client_secret);
    await assert.rejects(rotateOidcClientSecret('browser-client', context), { code: 'invalid_client_metadata' });
    await assert.rejects(updateOidcClient('browser-client', { token_endpoint_auth_method: 'client_secret_basic' }, context), { code: 'invalid_client_metadata' });
});

test('redirect registration rejects unsafe or noncanonical URLs and accepts exact loopback URLs', async () => {
    const context = await fixture();
    for (const uri of ['http://client.example.test/callback', 'https://client.example.test/callback#x', 'https://client.example.test/callback#', 'https://user:pass@client.example.test/callback', 'https://*.example.test/callback', 'https://client.example.test/%2A', 'https://CLIENT.example.test/callback', 'https://client.example.test:443/callback', 'https://client.example.test', 'javascript:alert(1)', 'http://localhost.evil.test/callback', 'http://127.0.0.1.evil.test/callback', 'http://127.0.0.2/callback']) {
        await assert.rejects(createOidcClient(browser({ redirect_uris: [uri] }), context), { code: 'invalid_client_metadata' }, uri);
    }
    for (const [index, uri] of ['http://localhost:3000/callback', 'http://127.0.0.1:3000/callback', 'http://[::1]:3000/callback'].entries()) {
        await createOidcClient(browser({ client_id: `loopback-${index}`, redirect_uris: [uri] }), context);
    }
    assert.equal((await listOidcClients({}, context)).total, 3);
});

test('metadata rejects caller secrets, unsupported grants/scopes, implicit flow and unsafe combinations', async () => {
    const context = await fixture();
    for (const patch of [
        { client_secret: 'caller-supplied' },
        { client_id: 'x' },
        { grant_types: ['password'] },
        { grant_types: ['implicit'] },
        { response_types: ['id_token'] },
        { grant_types: ['refresh_token'] },
        { scope: 'openid dangerous' },
        { scope: 'openid offline_access' },
        { enabled: 'true' },
        { token_endpoint_auth_method: 'private_key_jwt' },
        { token_endpoint_auth_method: 'none', grant_types: ['client_credentials'] },
        { grant_types: ['client_credentials'], scope: 'openid', redirect_uris: [], post_logout_redirect_uris: [] },
        { grant_types: ['authorization_code', 'client_credentials'] },
        { redirect_uris: [] },
    ]) await assert.rejects(createOidcClient(browser(patch), context), { code: 'invalid_client_metadata' });
    assert.equal((await listOidcClients({}, context)).total, 0);
});

test('all OIDC tools enforce current persisted administrative capability and ignore supplied roles', async () => {
    await fixture();
    const user = await createUser({ email: 'oidc-user@example.test', roles: ['user'] });
    const tools = [
        ['userpersisto_oidc_clients_list', {}],
        ['userpersisto_oidc_client_create', browser()],
        ['userpersisto_oidc_client_update', { client_id: 'browser-client', enabled: false }],
        ['userpersisto_oidc_client_delete', { client_id: 'browser-client' }],
        ['userpersisto_oidc_client_rotate_secret', { client_id: 'browser-client' }],
        ['userpersisto_oidc_status', {}],
    ];
    const config = JSON.parse(await readFile(new URL('../mcp-config.json', import.meta.url), 'utf8'));
    for (const [name, args] of tools) {
        assert.equal(hasTool(name), true);
        assert.ok(config.tools.some((tool) => tool.name === name));
        await assert.rejects(runTool(name, args, { actorRoles: ['admin'] }), { code: 'authentication_required' });
        await assert.rejects(runTool(name, args, { actorUserId: user.id, actorRoles: ['admin'] }), { code: 'admin_required' });
    }
    const otherAdmin = await createUser({ email: 'oidc-admin-two@example.test', roles: ['admin'] });
    await setUserRoles(actorId, ['user'], { actorId: otherAdmin.id });
    await assert.rejects(runTool('userpersisto_oidc_clients_list', {}, { actorUserId: actorId, actorRoles: ['admin'] }), { code: 'admin_required' });
    await createUser({ email: 'oidc-admin-three@example.test', roles: ['admin'] });
    await updateUser(otherAdmin.id, { status: 'blocked' });
    await assert.rejects(runTool('userpersisto_oidc_clients_list', {}, { actorUserId: otherAdmin.id, actorRoles: ['admin'] }), { code: 'invalid_session' });
});

test('client list pagination preserves all clients and validates bounds', async () => {
    const context = await fixture();
    for (let index = 0; index < 5; index += 1) await createOidcClient(browser({ client_id: `client-${index}`, token_endpoint_auth_method: 'none' }), context);
    const first = await listOidcClients({ start: 0, pageSize: 2 }, context);
    const middle = await listOidcClients({ start: 2, pageSize: 2 }, context);
    const last = await listOidcClients({ start: 4, pageSize: 2 }, context);
    assert.equal(first.total, 5);
    assert.equal(first.hasMore, true);
    assert.equal(last.hasMore, false);
    assert.equal(new Set([...first.items, ...middle.items, ...last.items].map((client) => client.client_id)).size, 5);
    for (const args of [{ start: -1 }, { start: 1.5 }, { pageSize: 0 }, { pageSize: 501 }]) await assert.rejects(listOidcClients(args, context), { code: 'invalid_client_metadata' });
});

test('disable and reenable revoke old tokens and fresh adapter lookup sees current enablement', async () => {
    const context = await fixture();
    await createOidcClient(browser(), context);
    await artifacts('browser-client');
    assert.ok(await getClientMetadata('browser-client'));
    await updateOidcClient('browser-client', { enabled: false }, context);
    assert.equal(await getClientMetadata('browser-client'), undefined);
    await assertRevoked('browser-client');
    await updateOidcClient('browser-client', { enabled: true }, context);
    assert.ok(await getClientMetadata('browser-client'));
    await assertRevoked('browser-client');
});

test('secret rotation replaces the credential and revokes every grant and token across restart', async () => {
    const context = await fixture();
    const created = await createOidcClient(browser(), context);
    await artifacts('browser-client');
    const rotated = await rotateOidcClientSecret('browser-client', context);
    assert.notEqual(rotated.client_secret, created.client_secret);
    assert.equal(rotated.client.client_secret, undefined);
    await resetStoreForTests();
    assert.equal((await getClientMetadata('browser-client')).client_secret, rotated.client_secret);
    await assertRevoked('browser-client');
    const snapshot = await readFile(join(folder, SNAPSHOT_FILE), 'utf8');
    assert.equal(snapshot.includes(rotated.client_secret), false);
    assert.equal(snapshot.includes(created.client_secret), false);
});

test('deletion revokes only the selected client and survives restart', async () => {
    const context = await fixture();
    await createOidcClient(browser(), context);
    await createOidcClient(browser({ client_id: 'other-client' }), context);
    await artifacts('browser-client');
    await artifacts('other-client');
    assert.deepEqual(await deleteOidcClient('browser-client', context), { ok: true, client_id: 'browser-client' });
    await resetStoreForTests();
    assert.equal(await getClientMetadata('browser-client'), undefined);
    await assertRevoked('browser-client');
    assert.ok(await new PersistoOidcAdapter('AccessToken').find('AccessToken-other-client'));
    await assert.rejects(new PersistoOidcAdapter('ClientCredentials').upsert('late-deleted-client-token', { clientId: 'browser-client' }, 300), { error: 'invalid_client' });
});

test('concurrent duplicate client registration has exactly one durable winner', async () => {
    const context = await fixture();
    const attempts = await Promise.allSettled([createOidcClient(browser(), context), createOidcClient(browser(), context)]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.find((result) => result.status === 'rejected').reason.code, 'oidc_client_exists');
    await resetStoreForTests();
    assert.equal((await listOidcClients({}, context)).total, 1);
});

test('failed client mutation cannot persist a new secret without its token revocations', async () => {
    const context = await fixture();
    const created = await createOidcClient(browser(), context);
    await artifacts('browser-client');
    const backup = `${folder}-saved`;
    await rename(folder, backup);
    await writeFile(folder, 'not a directory');
    try {
        await assert.rejects(rotateOidcClientSecret('browser-client', context), { code: 'persistence_unavailable' });
    } finally {
        await rm(folder);
        await rename(backup, folder);
    }
    await resetStoreForTests();
    assert.equal((await getClientMetadata('browser-client')).client_secret, created.client_secret);
    assert.ok(await new PersistoOidcAdapter('AccessToken').find('AccessToken-browser-client'));
});

test('administrator status reports only explicit issuer configuration', async () => {
    await fixture();
    const context = { actorUserId: actorId };
    assert.deepEqual(await runTool('userpersisto_oidc_status', {}, context), { enabled: false, issuer: '', discoveryUrl: '' });
    process.env.USERPERSISTO_OIDC_ISSUER = 'https://issuer.example.test/service/oidc';
    assert.deepEqual(await runTool('userpersisto_oidc_status', {}, context), { enabled: true, issuer: process.env.USERPERSISTO_OIDC_ISSUER, discoveryUrl: 'https://issuer.example.test/service/oidc/.well-known/openid-configuration' });
    assert.equal((await (await getStore()).select('oidcRecord')).totalCount, 0);
});
