import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSeedData } from '../lib/bootstrap.mjs';
import { getStore, flush, resetStoreForTests, setStoreFaultInjectorForTests } from '../lib/store.mjs';
import { createUser, getUserRoles, setUserRoles, updateUser } from '../lib/users.mjs';
import { getUserCapabilities } from '../lib/authorization.mjs';
import { createRole, updateRole, deleteRole, listRoleCatalog } from '../lib/roles.mjs';

let folder;
let actor;

beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'userpersisto-roles-'));
    process.env.PERSISTENCE_FOLDER = folder;
    process.env.USERPERSISTO_SETTINGS_KEY = 'test-role-settings';
    await ensureSeedData();
    const admin = await createUser({ email: 'role-admin@example.test', roles: ['admin'] });
    actor = { actorId: admin.id };
});

afterEach(async () => {
    await resetStoreForTests().catch(() => {});
    await rm(folder, { recursive: true, force: true });
});

test('role CRUD persists descriptions, capability bindings, assignment counts, and audit records', async () => {
    const initial = await listRoleCatalog(actor);
    assert.equal(initial.totalCount, 3);
    assert.ok(initial.roles.every((role) => role.builtin));
    assert.equal(initial.roles.find((role) => role.name === 'admin').userCount, 1);
    assert.deepEqual(Object.keys(initial.permissions[0]).sort(), ['capability', 'description', 'scope']);
    const role = await createRole({ name: ' books:editor ', description: ' Edit books ', capabilities: ['explorer.access', 'explorer.access'] }, actor);
    assert.deepEqual(role, {
        id: role.id, name: 'books:editor', description: 'Edit books', priority: 10,
        builtin: false, capabilities: ['explorer.access'], userCount: 0,
    });
    const reader = await createUser({ email: 'reader@example.test', roles: ['selfRegistered', role.name] });
    assert.deepEqual(await getUserCapabilities(reader.id), ['explorer.access', 'selfregistered.dashboard.access']);
    const updated = await updateRole({ roleId: role.id, description: 'Billing editor', capabilities: ['admin.billing.manage'] }, actor);
    assert.deepEqual(updated.capabilities, ['admin.billing.manage']);
    assert.equal(updated.description, 'Billing editor');
    assert.equal(updated.userCount, 1);
    assert.deepEqual(await getUserCapabilities(reader.id), ['admin.billing.manage', 'selfregistered.dashboard.access']);
    await resetStoreForTests();
    const reopened = await listRoleCatalog(actor);
    assert.deepEqual(reopened.roles.find((entry) => entry.id === role.id), updated);
    await assert.rejects(deleteRole({ roleId: role.id }, actor), { code: 'role_in_use', statusCode: 409 });
    await setUserRoles(reader.id, ['selfRegistered']);
    assert.deepEqual(await deleteRole({ roleId: role.id }, actor), { deleted: true, roleId: role.id });
    await resetStoreForTests();
    const store = await getStore();
    assert.equal(await store.getRoleByName(role.name), undefined);
    assert.deepEqual(await store.getRolePermsObjectsByRoleId(role.id) || [], []);
    const events = (await store.getAuditTrailObjectsByActorId(actor.actorId)).filter((event) => event.target === role.id);
    assert.deepEqual(events.map((event) => event.action).sort(), ['role.create', 'role.delete', 'role.update']);
});

test('a role may have no capabilities and partial updates preserve omitted fields', async () => {
    const role = await createRole({ name: 'empty_role-1.2' }, actor);
    assert.deepEqual(role.capabilities, []);
    const reader = await createUser({ email: 'empty@example.test', roles: [role.name] });
    assert.deepEqual(await getUserCapabilities(reader.id), []);
    await updateRole({ roleId: role.id, capabilities: ['explorer.access'] }, actor);
    const renamedDescription = await updateRole({ roleId: role.id, description: ' Read only ' }, actor);
    assert.deepEqual(renamedDescription.capabilities, ['explorer.access']);
    assert.equal(renamedDescription.name, role.name);
    const cleared = await updateRole({ roleId: role.id, capabilities: [] }, actor);
    assert.equal(cleared.description, 'Read only');
    assert.deepEqual(await getUserCapabilities(reader.id), []);
});

test('deleted ids stay invalid in the same process after their name is recreated and reassigned', async () => {
    const role = await createRole({ name: 'reusable-role', capabilities: ['explorer.access'] }, actor);
    await deleteRole({ roleId: role.id }, actor);
    assert.equal((await listRoleCatalog(actor)).roles.some((entry) => entry.id === role.id), false);
    await assert.rejects(deleteRole({ roleId: role.id }, actor), { code: 'role_not_found', statusCode: 404 });
    await assert.rejects(updateRole({ roleId: role.id, description: 'restore deleted' }, actor), { code: 'role_not_found', statusCode: 404 });
    const reader = await createUser({ email: 'reuse-reader@example.test', roles: ['selfRegistered'] });
    await assert.rejects(setUserRoles(reader.id, [role.name]), { code: 'unknown_role' });
    const replacement = await createRole({ name: role.name, capabilities: ['admin.billing.manage'] }, actor);
    assert.notEqual(replacement.id, role.id);
    await setUserRoles(reader.id, [replacement.name]);
    await assert.rejects(deleteRole({ roleId: role.id }, actor), { code: 'role_not_found', statusCode: 404 });
    await assert.rejects(updateRole({ roleId: role.id, capabilities: ['explorer.access'] }, actor), { code: 'role_not_found', statusCode: 404 });
    const store = await getStore();
    assert.equal((await store.getRoleByName(role.name)).id, replacement.id);
    assert.deepEqual((await store.getUserRolesObjectsByUserId(reader.id)).map((link) => link.roleId), [replacement.id]);
    assert.deepEqual(await getUserCapabilities(reader.id), ['admin.billing.manage']);
    assert.equal((await listRoleCatalog(actor)).roles.find((entry) => entry.id === replacement.id).userCount, 1);
    await resetStoreForTests();
    assert.deepEqual(await getUserCapabilities(reader.id), ['admin.billing.manage']);
    assert.equal((await listRoleCatalog(actor)).roles.some((entry) => entry.id === role.id), false);
});

test('role validation rejects malformed, unknown, duplicate, and immutable fields without poisoning storage', async () => {
    for (const name of ['', ' ', ':editor', '-editor', 'read write', '<editor>', 'ședitor', 'x'.repeat(129), null, 42]) {
        await assert.rejects(createRole({ name }, actor), { code: 'invalid_role_name', statusCode: 400 });
    }
    for (const description of [null, 42, {}, 'x'.repeat(1001)]) {
        await assert.rejects(createRole({ name: 'description', description }, actor), { code: 'invalid_role_description' });
    }
    for (const capabilities of [null, {}, '', [42], [null], ['']]) {
        await assert.rejects(createRole({ name: 'capabilities', capabilities }, actor), { code: 'invalid_role_capabilities' });
    }
    for (const capability of ['unknown.capability', ' explorer.access ', 'EXPLORER.ACCESS']) {
        await assert.rejects(createRole({ name: 'capabilities', capabilities: [capability] }, actor), { code: 'unknown_capability' });
    }
    for (const input of [null, [], 'role', { name: 'extra', actorId: actor.actorId }, { name: 'extra', priority: 1 }]) {
        await assert.rejects(createRole(input, actor), { code: 'invalid_role_input' });
    }
    const role = await createRole({ name: 'valid', description: 'x'.repeat(1000) }, actor);
    await assert.rejects(createRole({ name: ' valid ' }, actor), { code: 'role_name_taken', statusCode: 409 });
    await assert.rejects(createRole({ name: 'admin' }, actor), { code: 'role_name_taken', statusCode: 409 });
    await assert.rejects(updateRole({ roleId: role.id, name: 'renamed' }, actor), { code: 'invalid_role_input' });
    await assert.rejects(updateRole({ roleId: role.id, priority: 1 }, actor), { code: 'invalid_role_input' });
    await assert.rejects(updateRole({ roleId: role.id }, actor), { code: 'no_changes_requested' });
    await assert.rejects(updateRole({ roleId: role.id, description: null }, actor), { code: 'invalid_role_description' });
    await assert.rejects(updateRole({ roleId: role.id, capabilities: ['missing'] }, actor), { code: 'unknown_capability' });
    await assert.rejects(deleteRole({ roleId: role.id, force: true }, actor), { code: 'invalid_role_input' });
    for (const roleId of ['', 'admin', null, 42, 'ROLE.x/other']) {
        await assert.rejects(deleteRole({ roleId }, actor), { code: 'invalid_role_id', statusCode: 400 });
    }
    await assert.rejects(updateRole({ roleId: 'ROLE.zzzzzzz', description: '' }, actor), { code: 'role_not_found', statusCode: 404 });
    await assert.rejects(deleteRole({ roleId: 'ROLE.zzzzzzz' }, actor), { code: 'role_not_found', statusCode: 404 });
    assert.equal((await listRoleCatalog(actor)).totalCount, 4);
    assert.equal((await createRole({ name: 'x'.repeat(128) }, actor)).name.length, 128);
    const indexAlias = await createRole({ name: 'ROLE.alias' }, actor);
    await assert.rejects(deleteRole({ roleId: indexAlias.name }, actor), { code: 'role_not_found', statusCode: 404 });
    await assert.rejects(updateRole({ roleId: indexAlias.name, description: 'wrong id' }, actor), { code: 'role_not_found', statusCode: 404 });
    assert.equal((await listRoleCatalog(actor)).roles.find((entry) => entry.id === indexAlias.id).name, indexAlias.name);
});

test('all builtin role descriptions and capabilities are protected from mutation and deletion', async () => {
    const initial = await listRoleCatalog(actor);
    for (const role of initial.roles) {
        await assert.rejects(updateRole({ roleId: role.id, description: 'replacement', capabilities: [] }, actor), { code: 'builtin_role_protected', statusCode: 403 });
        await assert.rejects(deleteRole({ roleId: role.id }, actor), { code: 'builtin_role_protected', statusCode: 403 });
    }
    assert.deepEqual(await listRoleCatalog(actor), initial);
});

test('every operation authenticates a persisted active actor and ignores claimed authority', async () => {
    const reader = await createUser({ email: 'unprivileged@example.test', roles: ['selfRegistered'] });
    const role = await createRole({ name: 'protected' }, actor);
    const operations = [
        (context) => listRoleCatalog(context),
        (context) => createRole({ name: 'unauthorized' }, context),
        (context) => updateRole({ roleId: role.id, description: 'unauthorized' }, context),
        (context) => deleteRole({ roleId: role.id }, context),
    ];
    for (const operation of operations) {
        await assert.rejects(operation(), { code: 'authentication_required', statusCode: 401 });
        await assert.rejects(operation({ actorId: 'USER.zzzzzzz' }), { code: 'invalid_session', statusCode: 401 });
        await assert.rejects(operation({ actorId: reader.id, roles: ['admin'], capabilities: ['admin.users.manage'] }), { code: 'admin_required', statusCode: 403 });
    }
    await updateUser(reader.id, { status: 'blocked' });
    for (const operation of operations) {
        await assert.rejects(operation({ actorId: reader.id }), { code: 'invalid_session', statusCode: 401 });
    }
});

test('persisted capabilities authorize custom administrators and queued revocation wins before a later operation', async () => {
    const managerRole = await createRole({ name: 'roles-manager', capabilities: ['admin.users.manage'] }, actor);
    const manager = await createUser({ email: 'manager@example.test', roles: [managerRole.name] });
    const delegated = { actorId: manager.id };
    await createRole({ name: 'delegated' }, delegated);
    const [revoked, denied] = await Promise.allSettled([
        setUserRoles(manager.id, ['selfRegistered']),
        createRole({ name: 'after-revocation' }, delegated),
    ]);
    assert.equal(revoked.status, 'fulfilled');
    assert.equal(denied.status, 'rejected');
    assert.equal(denied.reason.code, 'admin_required');
    await setUserRoles(manager.id, [managerRole.name]);
    const [changed, catalogDenied] = await Promise.allSettled([
        updateRole({ roleId: managerRole.id, capabilities: [] }, actor),
        listRoleCatalog(delegated),
    ]);
    assert.equal(changed.status, 'fulfilled');
    assert.equal(catalogDenied.status, 'rejected');
    assert.equal(catalogDenied.reason.code, 'admin_required');
    assert.equal(await (await getStore()).getRoleByName('after-revocation'), undefined);
});

test('concurrent duplicate creation commits exactly one role', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => createRole({ name: 'racing-role', capabilities: ['explorer.access'] }, actor)));
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.ok(attempts.filter((attempt) => attempt.status === 'rejected').every((attempt) => attempt.reason.code === 'role_name_taken'));
    await resetStoreForTests();
    assert.equal((await listRoleCatalog(actor)).roles.filter((role) => role.name === 'racing-role').length, 1);
});

test('role deletion and assignment share exclusion, leaving either a complete assignment or a rejected unknown role', async () => {
    const user = await createUser({ email: 'race@example.test', roles: ['selfRegistered'] });
    const assigned = await createRole({ name: 'assigned-first' }, actor);
    const [assignment, blockedDeletion] = await Promise.allSettled([
        setUserRoles(user.id, [assigned.name]),
        deleteRole({ roleId: assigned.id }, actor),
    ]);
    assert.equal(assignment.status, 'fulfilled');
    assert.equal(blockedDeletion.status, 'rejected');
    assert.equal(blockedDeletion.reason.code, 'role_in_use');
    assert.deepEqual(await getUserRoles(user.id), [assigned.name]);
    const removed = await createRole({ name: 'deleted-first' }, actor);
    const [deletion, blockedAssignment] = await Promise.allSettled([
        deleteRole({ roleId: removed.id }, actor),
        setUserRoles(user.id, [removed.name]),
    ]);
    assert.equal(deletion.status, 'fulfilled');
    assert.equal(blockedAssignment.status, 'rejected');
    assert.equal(blockedAssignment.reason.code, 'unknown_role');
    await resetStoreForTests();
    assert.deepEqual(await getUserRoles(user.id), [assigned.name]);
    assert.equal((await listRoleCatalog(actor)).roles.find((role) => role.id === assigned.id).userCount, 1);
});

test('catalog scans roles, capabilities, role-permission links, and user assignments beyond 500 records', async () => {
    const store = await getStore();
    let lastRole;
    for (let index = 0; index < 505; index++) {
        const role = await store.createRole({ name: `custom-${index}`, description: 'Custom', priority: 10 });
        const permission = await store.createPermission({ capability: `custom.permission.${index}`, description: 'Custom capability', scope: 'product' });
        await store.createRolePermission({ key: `${role.id}:${permission.id}`, roleId: role.id, permissionId: permission.id });
        await store.createUserRole({ key: `${actor.actorId}:${role.id}`, roleId: role.id, userId: actor.actorId });
        lastRole = role;
    }
    await flush();
    const catalog = await listRoleCatalog(actor);
    assert.equal(catalog.totalCount, 508);
    assert.equal(catalog.permissions.length, 510);
    const last = catalog.roles.find((role) => role.id === lastRole.id);
    assert.deepEqual(last.capabilities, ['custom.permission.504']);
    assert.equal(last.userCount, 1);
    assert.ok(catalog.permissions.some((permission) => permission.capability === 'custom.permission.504'));
    await assert.rejects(deleteRole({ roleId: lastRole.id }, actor), { code: 'role_in_use' });
});

test('each role mutation saves one snapshot including its audit event', async () => {
    let saves = 0;
    setStoreFaultInjectorForTests((phase, name) => {
        if (phase === 'before' && name === 'forceSave') saves++;
    });
    const role = await createRole({ name: 'one-save', capabilities: ['explorer.access'] }, actor);
    assert.equal(saves, 1);
    await updateRole({ roleId: role.id, description: 'Updated', capabilities: ['admin.billing.manage'] }, actor);
    assert.equal(saves, 2);
    await deleteRole({ roleId: role.id }, actor);
    assert.equal(saves, 3);
});

test('staged creation failure and final save failure fail closed without publishing partial state after restart', async () => {
    for (const failingMethod of ['createRolePermission', 'createAuditEvent', 'forceSave']) {
        setStoreFaultInjectorForTests((phase, name) => {
            if (phase === 'before' && name === failingMethod) throw new Error('injected role persistence failure');
        });
        await assert.rejects(createRole({ name: 'failed-role', capabilities: ['explorer.access'] }, actor), { code: 'persistence_unavailable', statusCode: 503 });
        await assert.rejects(listRoleCatalog(actor), { code: 'persistence_unavailable' });
        await resetStoreForTests();
        const catalog = await listRoleCatalog(actor);
        assert.equal(catalog.totalCount, 3);
        assert.equal(catalog.roles.some((role) => role.name === 'failed-role'), false);
        const events = await (await getStore()).getAuditTrailObjectsByActorId(actor.actorId) || [];
        assert.equal(events.some((event) => event.action === 'role.create'), false);
    }
});

test('failed permission replacement or deletion retains the complete previous role after restart', async () => {
    const original = await createRole({ name: 'durable-role', capabilities: ['explorer.access'] }, actor);
    setStoreFaultInjectorForTests((phase, name) => {
        if (phase === 'after' && name === 'deleteRolePermission') throw new Error('injected permission removal failure');
    });
    await assert.rejects(updateRole({ roleId: original.id, description: 'Uncommitted', capabilities: ['admin.billing.manage'] }, actor), { code: 'persistence_unavailable' });
    await resetStoreForTests();
    assert.deepEqual((await listRoleCatalog(actor)).roles.find((role) => role.id === original.id), original);
    setStoreFaultInjectorForTests((phase, name) => {
        if (phase === 'after' && name === 'deleteRole') throw new Error('injected role removal failure');
    });
    await assert.rejects(deleteRole({ roleId: original.id }, actor), { code: 'persistence_unavailable' });
    await resetStoreForTests();
    assert.deepEqual((await listRoleCatalog(actor)).roles.find((role) => role.id === original.id), original);
    const events = await (await getStore()).getAuditTrailObjectsByActorId(actor.actorId);
    assert.deepEqual(events.filter((event) => event.target === original.id).map((event) => event.action), ['role.create']);
});
