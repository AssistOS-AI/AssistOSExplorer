import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productPermissions } from '../lib/product-permissions.mjs';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, flush, resetStoreForTests } from '../lib/store.mjs';
import { createUser, getUserRoles } from '../lib/users.mjs';
import { getUserCapabilities, authorizeCapability } from '../lib/authorization.mjs';
import { assertRegistrationRoleAllowed } from '../lib/policy.mjs';
import { explorerPermissions } from './helpers/product-permissions.mjs';

let folder, previousEnvironment;
beforeEach(async () => {
    previousEnvironment = { ...process.env };
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-products-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'product-permissions-test';
    delete process.env.USERPERSISTO_PRODUCT_PERMISSIONS;
});
afterEach(async () => {
    await resetStoreForTests();
    await rm(folder, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, key)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
});

test('neutral bootstrap grants provider administration but no implicit Explorer permission', async () => {
    await ensureSeedData();
    const store = await getStore();
    assert.equal(await store.hasPermission('explorer.access'), false);
    const admin = await createUser({ email: 'admin@example.test', roles: ['admin'] });
    const user = await createUser({ email: 'user@example.test', roles: ['user'] });
    const member = await createUser({ email: 'member@example.test', roles: ['selfRegistered'] });
    assert.deepEqual(await getUserCapabilities(user.id), []);
    assert.deepEqual(await getUserCapabilities(member.id), ['selfregistered.dashboard.access']);
    assert.equal((await authorizeCapability({ userId: admin.id, capability: 'admin.users.manage' })).allowed, true);
    assert.equal((await authorizeCapability({ userId: admin.id, capability: 'explorer.access' })).allowed, false);
    assert.equal((await store.getRoleByName('user')).description, 'User');
});

test('Explorer explicitly selects its provider profile and retains capability-based access', async () => {
    const explorer = JSON.parse(readFileSync(new URL('../../explorer/manifest.json', import.meta.url)));
    assert.deepEqual(explorer.enable.find(entry => entry?.agent === 'userPersistoAgent'), { agent: 'userPersistoAgent', profile: 'explorer' });
    assert.equal(explorer.routerAccess.requiredCapability, 'explorer.access');
    process.env.USERPERSISTO_PRODUCT_PERMISSIONS = JSON.stringify(explorerPermissions);
    await ensureSeedData();
    for (const role of ['admin', 'user', 'selfRegistered']) {
        const user = await createUser({ email: `${role}@example.test`, roles: [role] });
        const decision = await authorizeCapability({ userId: user.id, capability: explorer.routerAccess.requiredCapability });
        assert.equal(decision.allowed, role !== 'selfRegistered');
    }
});

test('configured product permissions work without a special application name', async () => {
    await ensureSeedData({ productPermissions: [{ capability: 'research.read', description: 'Read research', roles: ['user'] }] });
    const user = await createUser({ email: 'reader@example.test', roles: ['user'] });
    const admin = await createUser({ email: 'admin@example.test', roles: ['admin'] });
    assert.deepEqual(await getUserCapabilities(user.id), ['research.read']);
    assert.equal((await authorizeCapability({ userId: admin.id, capability: 'research.read' })).allowed, false);
});

test('restart preserves accounts, role IDs and existing grants when product configuration is absent', async () => {
    await ensureSeedData({ productPermissions: explorerPermissions });
    const store = await getStore();
    const role = await store.getRoleByName('user');
    const user = await createUser({ email: 'existing@example.test', roles: ['user'] });
    await store.updateRole(role.id, { description: 'Workspace member' });
    await flush();
    await resetStoreForTests();
    await ensureSeedData();
    assert.equal((await (await getStore()).getRoleByName('user')).id, role.id);
    assert.equal((await (await getStore()).getRoleByName('user')).description, 'User');
    assert.deepEqual(await getUserRoles(user.id), ['user']);
    assert.deepEqual(await getUserCapabilities(user.id), ['explorer.access']);
    await ensureSeedData({ productPermissions: explorerPermissions });
    assert.deepEqual(await getUserCapabilities(user.id), ['explorer.access']);
});

test('invalid declarations are refused before bootstrap writes roles or permissions', async () => {
    const good = { capability: 'app.access', description: 'Access app', roles: ['user'] };
    const invalid = ['', 'not-json', '{}', 'null', '[', ' '.repeat(16_385), null, {},
        [good, good], Array(101).fill(good), [{ ...good, roles: [] }],
        [{ ...good, roles: ['selfRegistered'] }], [{ ...good, roles: ['missing'] }],
        [{ ...good, roles: ['user', 'user'] }], [{ ...good, scope: 'admin' }],
        [{ ...good, capability: 'admin.users.manage' }], [{ ...good, capability: 'selfregistered.dashboard.access' }],
        [{ ...good, capability: '../escape' }], [{ ...good, description: ' ' }]];
    for (const input of invalid) {
        assert.throws(() => productPermissions(input));
        await assert.rejects(ensureSeedData({ productPermissions: input }));
    }
    assert.equal(await (await getStore()).hasRole('admin'), false);
    assert.equal(await (await getStore()).hasPermission('app.access'), false);
    assert.deepEqual(productPermissions('[]'), []);
});

test('product configuration cannot reuse a non-product permission', async () => {
    const store = await getStore();
    await store.createPermission({ capability: 'app.access', description: 'Protected access', scope: 'admin' });
    await flush();
    await assert.rejects(ensureSeedData({ productPermissions: [{ capability: 'app.access', description: 'Access app', roles: ['user'] }] }), /conflicts/);
    assert.equal(await store.hasRole('user'), false);
});

test('public signup refuses any extra application permission, not only Explorer', async () => {
    await ensureSeedData({ productPermissions: [{ capability: 'research.read', description: 'Read research', roles: ['user'] }] });
    await assertRegistrationRoleAllowed();
    const store = await getStore();
    const role = await store.getRoleByName('selfRegistered');
    const permission = await store.getPermissionByCapability('research.read');
    await store.createRolePermission({ key: `${role.id}:${permission.id}`, roleId: role.id, permissionId: permission.id });
    await flush();
    await assert.rejects(assertRegistrationRoleAllowed(), { code: 'registration_role_must_be_restricted', statusCode: 503 });
});

test('My Account markup and rendering contain no application launch controls', () => {
    for (const path of ['index.html', 'main.js', 'dashboard.css']) {
        const source = readFileSync(new URL(`../public/dashboard/${path}`, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /open-explorer|workspace-access-message|account-access|explorer\.access|Open Explorer/);
    }
});
