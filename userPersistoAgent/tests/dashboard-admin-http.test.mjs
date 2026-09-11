import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRouterSigner } from './helpers/router-fixture.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { createUser, getUserById, getUserRoles, updateUser, setUserRoles } from '../lib/users.mjs';
import { getStore, resetStoreForTests } from '../lib/store.mjs';
import { startService } from '../service/index.mjs';

const ORIGIN = 'https://account.example.test';
const PREFIX = '/service/dashboard';
let folder, server, base, sign, admin, member, blocked, usersManager, settingsManager;

before(async () => {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-dashboard-admin-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-dashboard-admin-settings';
    process.env.USERPERSISTO_OIDC_ISSUER = `${ORIGIN}/service/oidc`;
    for (const key of ['USERPERSISTO_AUTH_METHODS', 'USERPERSISTO_ALLOWED_REDIRECT_ORIGINS',
        'USERPERSISTO_DEFAULT_REGISTRATION_ROLE', 'USERPERSISTO_SELF_REGISTRATION_ENABLED',
        'USERPERSISTO_GOOGLE_CLIENT_ID', 'USERPERSISTO_GOOGLE_CLIENT_SECRET', 'USERPERSISTO_GOOGLE_REDIRECT_URI']) {
        delete process.env[key];
    }
    sign = await createRouterSigner();
    await ensureSeedData();
    admin = await createUser({ email: 'owner@example.test', roles: ['admin'], emailVerified: true });
    member = await createUser({ email: 'reader@example.test', displayName: 'Restricted Reader', roles: ['selfRegistered'] });
    blocked = await createUser({ email: 'blocked@example.test', roles: ['admin'] });
    await updateUser(blocked.id, { status: 'blocked' });
    const store = await getStore();
    for (const [name, capability] of [['usersManager', 'admin.users.manage'], ['settingsManager', 'admin.agentSettings.manage']]) {
        const role = await store.createRole({ name, description: name, priority: 10 });
        const permission = await store.getPermissionByCapability(capability);
        await store.createRolePermission({ key: `${role.id}:${permission.id}`, roleId: role.id, permissionId: permission.id });
    }
    // Every real account has a usable sign-in method; fixtures mirror that.
    usersManager = await createUser({ email: 'users-manager@example.test', roles: ['usersManager'], emailVerified: true });
    settingsManager = await createUser({ email: 'settings-manager@example.test', roles: ['settingsManager'], emailVerified: true });
    server = startService({ port: 0, host: '127.0.0.1' }, { emailStatus: async () => ({ available: true }) });
    if (!server.listening) await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await resetStoreForTests();
    if (folder) await rm(folder, { recursive: true, force: true });
});

async function request(path, { method = 'POST', body = {}, rawBody, userId = admin.id, headers = {}, claims, carrierUserId, authenticated = true } = {}) {
    const urlPath = `${PREFIX}${path}`;
    const raw = rawBody ?? (method === 'POST' ? JSON.stringify(body) : '');
    const response = await fetch(`${base}${urlPath}`, {
        method,
        headers: {
            ...(authenticated ? sign({ method, path: urlPath, rawBody: raw, userId, origin: ORIGIN, claims, carrierUserId }) : {}),
            ...headers,
        },
        ...(method === 'POST' ? { body: raw } : {}),
        redirect: 'manual',
    });
    const contentType = response.headers.get('content-type') || '';
    return { response, data: contentType.includes('application/json') ? await response.json() : await response.text() };
}

function adminRequest(endpoint, options) {
    return request(`/api/admin/${endpoint}`, options);
}

test('management documents and shared assets require a signed active user and persisted page capabilities', async () => {
    for (const path of ['/users.html', '/applications.html', '/authentication.html', '/admin.mjs', '/api.mjs', '/management.mjs']) {
        assert.equal((await request(path, { method: 'GET', authenticated: false })).response.status, 401, path);
        assert.equal((await request(path, { method: 'GET', userId: blocked.id })).response.status, 401, path);
    }
    for (const path of ['/users.html', '/applications.html', '/authentication.html']) {
        const denied = await request(path, { method: 'GET', userId: member.id });
        assert.equal(denied.response.status, 403, path);
        assert.equal(denied.data.error, 'admin_required');
        assert.equal((await request(path, { method: 'GET' })).response.status, 200, path);
    }
    assert.equal((await request('/users.html', { method: 'GET', userId: settingsManager.id })).response.status, 403);
    assert.equal((await request('/applications.html', { method: 'GET', userId: usersManager.id })).response.status, 403);
    assert.equal((await request('/authentication.html', { method: 'GET', userId: usersManager.id })).response.status, 403);
    assert.equal((await request('/', { method: 'GET', userId: member.id })).response.status, 200);
    for (const path of ['/admin.mjs', '/api.mjs']) {
        const asset = await request(path, { method: 'GET', userId: member.id });
        assert.equal(asset.response.status, 200);
        assert.match(asset.response.headers.get('content-type'), /^text\/javascript/);
    }
    assert.equal((await request('/unlisted.mjs', { method: 'GET' })).response.status, 404);
    assert.equal((await request('/api/admin/users/list', { method: 'GET' })).response.status, 404);
});

test('admin APIs reject absent or forged authentication, inactive accounts, and caller-claimed privileges', async () => {
    for (const endpoint of ['users/list', 'applications/list', 'policy/get', 'google/status']) {
        const absent = await adminRequest(endpoint, { authenticated: false, headers: {
            origin: ORIGIN, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'account.example.test', 'content-type': 'application/json',
        } });
        assert.equal(absent.response.status, 401, endpoint);
        for (const userId of [blocked.id, 'missing-user']) {
            assert.equal((await adminRequest(endpoint, { userId })).response.status, 401, endpoint);
        }
        const spoofed = await adminRequest(endpoint, { userId: member.id, carrierUserId: admin.id, body: {
            actorUserId: admin.id, actorId: admin.id, roles: ['admin'], capabilities: ['admin.users.manage', 'admin.agentSettings.manage'],
            context: { actorUserId: admin.id },
        }, claims: { actor: { kind: 'user', id: `user:${member.id}`, roles: ['admin'], capabilities: ['admin.users.manage', 'admin.agentSettings.manage'] } } });
        assert.equal(spoofed.response.status, 403, endpoint);
        const unsigned = await adminRequest(endpoint, { headers: {
            'x-ploinky-auth-info': JSON.stringify({ user: { id: admin.id, roles: ['admin'] } }),
        } });
        assert.equal(unsigned.response.status, 401, endpoint);
    }
    assert.equal((await adminRequest('users/list', { userId: usersManager.id })).response.status, 200);
    assert.equal((await adminRequest('users/list', { userId: settingsManager.id })).response.status, 403);
    assert.equal((await adminRequest('policy/get', { userId: settingsManager.id })).response.status, 200);
    assert.equal((await adminRequest('policy/get', { userId: usersManager.id })).response.status, 403);
    await setUserRoles(usersManager.id, ['user']);
    assert.equal((await adminRequest('users/list', { userId: usersManager.id })).response.status, 403);
    await setUserRoles(usersManager.id, ['usersManager']);
});

test('admin requests enforce exact-origin JSON, body bounds, signed integrity, and a fixed route map', async () => {
    for (const origin of ['', 'null', 'https://other.example.test', `${ORIGIN}/`, `${ORIGIN}, https://other.example.test`]) {
        assert.equal((await adminRequest('users/update', { headers: { origin } })).response.status, 403);
    }
    assert.equal((await adminRequest('users/update', { headers: { 'content-type': 'text/plain' } })).response.status, 415);
    for (const rawBody of ['null', '[]', '"name"', '{broken']) {
        assert.equal((await adminRequest('users/update', { rawBody })).response.status, 400);
    }
    assert.equal((await adminRequest('users/update', { body: { displayName: 'x'.repeat(65536) } })).response.status, 413);
    const tampered = await adminRequest('users/update', { body: { userId: member.id, displayName: 'tampered' }, headers:
        sign({ method: 'POST', path: `${PREFIX}/api/admin/users/update`, rawBody: '{}', userId: admin.id }),
    });
    assert.equal(tampered.response.status, 401);
    for (const endpoint of ['tool', 'users/create', 'users/password', 'users/password/delete', 'userpersisto_user_create', 'applications/get']) {
        assert.equal((await adminRequest(endpoint, { body: { tool: 'userpersisto_user_create', email: 'arbitrary@example.test' } })).response.status, 404);
    }
    const headers = sign({ method: 'POST', path: `${PREFIX}/api/admin/users/list`, rawBody: '{}', userId: admin.id });
    assert.equal((await adminRequest('users/list', { headers })).response.status, 200);
    assert.equal((await adminRequest('users/list', { headers })).response.status, 401);
});

test('user search hides selfRegistered-only accounts by default and allows finding and promoting one', async () => {
    const initial = await adminRequest('users/list', { body: { excludeOnlyRole: 'selfRegistered', includeRoleCounts: true } });
    assert.equal(initial.response.status, 200);
    assert.equal(initial.data.result.singleRoleCounts.selfRegistered, 1);
    assert.equal(initial.data.result.users.some((user) => user.id === member.id), false);
    for (const search of ['READER@EXAMPLE.TEST', 'restricted reader', member.id]) {
        const found = await adminRequest('users/list', { body: { search, includeRoleCounts: true, pageSize: 1 } });
        assert.equal(found.data.result.totalCount, 1);
        assert.deepEqual(found.data.result.users.map((user) => user.id), [member.id]);
        assert.deepEqual(found.data.result.users[0].roles, ['selfRegistered']);
        assert.doesNotMatch(JSON.stringify(found.data), /passwordHash|loginAttempts|lastLoginAttempt/);
    }
    const promoted = await adminRequest('users/roles', { body: { userId: member.id, roles: ['user'], actorUserId: member.id } });
    assert.equal(promoted.response.status, 200);
    assert.deepEqual(await getUserRoles(member.id), ['user']);
    const refreshed = (await adminRequest('users/list', { body: { excludeOnlyRole: 'selfRegistered', includeRoleCounts: true } })).data.result;
    assert.equal(refreshed.users.some((user) => user.id === member.id), true);
    assert.equal(refreshed.singleRoleCounts.selfRegistered || 0, 0);
    const store = await getStore();
    const events = await store.select('auditEvent', { target: member.id }, { pageSize: 100 });
    assert.ok(events.objects.some((event) => event.actorId === admin.id && event.action === 'user.roles.update'));
});

test('user administration ignores authority and protected fields, deactivates reversibly, and protects the final administrator', async () => {
    const managed = await createUser({ email: 'managed@example.test', roles: ['user'], emailVerified: true });
    const userId = managed.id;
    const updated = await adminRequest('users/update', { body: {
        userId, displayName: 'Managed Reader', roles: ['admin'], passwordHash: 'injected-hash', actorId: member.id, email: 'hijacked@example.test',
    } });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.data.result.displayName, 'Managed Reader');
    assert.equal(updated.data.result.email, 'managed@example.test', 'sign-in email is not an editable field');
    assert.deepEqual(await getUserRoles(userId), ['user']);
    assert.doesNotMatch(JSON.stringify(updated.data), /passwordHash|injected-hash/);
    const emailOnly = await adminRequest('users/update', { body: { userId, email: 'hijacked@example.test' } });
    assert.equal(emailOnly.response.status, 400);
    assert.equal((await getUserById(userId)).email, 'managed@example.test');
    assert.ok((await getUserById(userId)).emailVerifiedAt);
    const deleted = await adminRequest('users/delete', { body: { userId, status: 'active', email: 'overridden@example.test' } });
    assert.equal(deleted.response.status, 200);
    assert.equal((await getUserById(userId)).status, 'blocked');
    assert.equal((await getUserById(userId)).email, 'managed@example.test');
    assert.equal((await adminRequest('users/list', { userId })).response.status, 401);
    assert.equal((await adminRequest('users/roles', { body: { userId, roles: ['selfRegistered'] } })).response.status, 200);
    assert.equal((await getUserById(userId)).status, 'blocked');
    assert.equal((await adminRequest('users/update', { body: { userId, status: 'active' } })).response.status, 200);
    assert.equal((await request('/api/profile', { method: 'GET', userId })).response.status, 200);
    for (const [endpoint, body] of [
        ['users/delete', { userId: admin.id }],
        ['users/update', { userId: admin.id, status: 'blocked' }],
        ['users/roles', { userId: admin.id, roles: ['user'] }],
    ]) {
        const result = await adminRequest(endpoint, { body });
        assert.equal(result.response.status, 400, endpoint);
        assert.equal(result.data.error, 'last_admin_required', endpoint);
    }
    assert.equal((await getUserById(admin.id)).status, 'active');
    assert.deepEqual(await getUserRoles(admin.id), ['admin']);
});

test('no administrator can create accounts or set passwords through the dashboard', async () => {
    const before = (await adminRequest('users/list', { body: { includeRoleCounts: true } })).data.result.totalCount;
    for (const userId of [admin.id, usersManager.id]) {
        for (const [endpoint, body] of [
            ['users/create', { email: 'created@example.test', password: 'created-test-password', roles: ['admin'] }],
            ['users/password', { userId: member.id, newPassword: 'replacement-test-password' }],
        ]) {
            const result = await adminRequest(endpoint, { userId, body });
            assert.equal(result.response.status, 404, endpoint);
        }
    }
    assert.equal((await adminRequest('users/list', { body: { includeRoleCounts: true } })).data.result.totalCount, before);
    const store = await getStore();
    assert.equal((await store.select('auditEvent', { action: 'auth.password.set' }, { pageSize: 10 })).objects.length, 0);
    assert.equal(Object.hasOwn(await getUserById(member.id), 'passwordHash'), false);
});

test('applications support sanitized CRUD, one-time secret rotation, public clients, and persisted capability checks', async () => {
    const created = await adminRequest('applications/create', { body: {
        client_id: 'dashboard-test', client_name: 'Dashboard test', redirect_uris: ['https://app.example.test/callback'],
        client_secret: 'caller-secret', actorId: member.id, actorUserId: member.id,
    } });
    assert.equal(created.response.status, 200);
    assert.equal(created.data.result.client.client_id, 'dashboard-test');
    const secret = created.data.result.client_secret;
    assert.ok(secret);
    assert.notEqual(secret, 'caller-secret');
    const list = await adminRequest('applications/list', { body: { pageSize: 1, start: 0 } });
    assert.equal(list.data.result.total, 1);
    assert.equal(list.data.result.items.length, 1);
    assert.equal(JSON.stringify(list.data).includes(secret), false);
    assert.equal(Object.hasOwn(list.data.result.items[0], 'client_secret'), false);
    const changed = await adminRequest('applications/update', { body: { client_id: 'dashboard-test', client_name: 'Changed', enabled: false } });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.data.result.client.enabled, false);
    assert.equal(changed.data.result.client.client_name, 'Changed');
    const rotated = await adminRequest('applications/rotate', { body: { client_id: 'dashboard-test' } });
    assert.equal(rotated.response.status, 200);
    assert.ok(rotated.data.result.client_secret);
    assert.notEqual(rotated.data.result.client_secret, secret);
    const publicClient = await adminRequest('applications/create', { body: {
        client_id: 'dashboard-public', token_endpoint_auth_method: 'none', redirect_uris: ['https://public.example.test/callback'],
    } });
    assert.equal(publicClient.response.status, 200);
    assert.equal(Object.hasOwn(publicClient.data.result, 'client_secret'), false);
    assert.equal((await adminRequest('applications/rotate', { body: { client_id: 'dashboard-public' } })).response.status, 400);
    assert.equal((await adminRequest('applications/delete', { body: { client_id: 'dashboard-test' }, userId: member.id })).response.status, 403);
    assert.equal((await adminRequest('applications/delete', { body: { client_id: 'dashboard-test' } })).response.status, 200);
    assert.equal((await adminRequest('applications/delete', { body: { client_id: 'dashboard-test' } })).response.status, 404);
    const store = await getStore();
    const events = await store.select('auditEvent', { target: 'dashboard-test' }, { pageSize: 100 });
    assert.ok(events.objects.length >= 4);
    assert.ok(events.objects.every((event) => event.actorId === admin.id));
});

test('policy and provider status use fixed whitelisted fields and preserve operator-only configuration', async () => {
    const initial = await adminRequest('policy/get');
    assert.equal(initial.response.status, 200);
    assert.deepEqual(initial.data.result.enabledAuthMethods, ['emailCode', 'passkey', 'totp', 'google']);
    assert.equal(initial.data.result.registrationRole, 'selfRegistered');
    const saved = await adminRequest('policy/set', { userId: settingsManager.id, body: {
        enabledAuthMethods: ['emailCode', 'totp'], selfRegistrationEnabled: false,
        defaultRegistrationRole: 'selfRegistered', allowedRedirectOrigins: [ORIGIN],
        googleClientSecret: 'ignored-secret', USERPERSISTO_GOOGLE_CLIENT_SECRET: 'ignored-secret', actorId: admin.id,
    } });
    assert.equal(saved.response.status, 200);
    assert.deepEqual(saved.data.result.enabledAuthMethods, ['emailCode', 'totp']);
    assert.equal(Object.hasOwn(saved.data.result, 'defaultRegistrationRole'), false);
    assert.equal(saved.data.result.selfRegistrationEnabled, false);
    const store = await getStore();
    const stored = await store.getSystemSettingByKey('auth.policy');
    assert.equal(stored.updatedBy, settingsManager.id);
    assert.equal(JSON.stringify(stored).includes('ignored-secret'), false);
    const google = await adminRequest('google/status');
    assert.equal(google.response.status, 200);
    assert.equal(google.data.result.configured, false);
    assert.equal(JSON.stringify(google.data).includes('ignored-secret'), false);
    const oidc = await adminRequest('applications/status');
    assert.equal(oidc.response.status, 200);
    assert.equal(oidc.data.result.issuer, process.env.USERPERSISTO_OIDC_ISSUER);
    const retired = await adminRequest('policy/set', { body: { enabledAuthMethods: ['password'] } });
    assert.equal(retired.response.status, 400);
    assert.equal(retired.data.error, 'invalid_auth_method');
    await adminRequest('policy/set', { body: { defaultRegistrationRole: 'admin', selfRegistrationEnabled: true } });
    assert.equal(JSON.stringify(await store.getSystemSettingByKey('auth.policy')).includes('defaultRegistrationRole'), false);
});
