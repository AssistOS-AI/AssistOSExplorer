import { getStore, commitStagedPersistence } from './store.mjs';
import { serializePersisted } from './serial.mjs';
import { requireActiveActor } from './authorization.mjs';
import { recordAudit } from './audit.mjs';

const BUILTIN_ROLES = new Set(['admin', 'user', 'selfRegistered']);
const ROLE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLE_ID_RE = /^ROLE\.[0-9a-z]+$/i;
const PAGE_SIZE = 500;

function roleError(code, message, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

function validateInput(input, fields) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((field) => !fields.includes(field))) {
        throw roleError('invalid_role_input', 'Invalid role fields.');
    }
}

function normalizeName(name) {
    if (typeof name !== 'string' || !ROLE_NAME_RE.test(name.trim())) {
        throw roleError('invalid_role_name', 'Role names must be 1–128 characters, start with a letter or number, and use only letters, numbers, dot, underscore, colon, or dash.');
    }
    return name.trim();
}

function normalizeDescription(description) {
    if (typeof description !== 'string' || description.length > 1000) {
        throw roleError('invalid_role_description', 'Role descriptions must be text of at most 1000 characters.');
    }
    return description.trim();
}

async function scanAll(store, type, sortBy = '') {
    const objects = [];
    while (true) {
        const page = await store.select(type, {}, { start: objects.length, pageSize: PAGE_SIZE, ...(sortBy ? { sortBy } : {}) });
        const entries = page.objects || [];
        objects.push(...entries);
        const count = Number(page.filteredCount ?? page.totalCount);
        if (entries.length < PAGE_SIZE || (Number.isFinite(count) && objects.length >= count)) return objects;
    }
}

async function resolveCapabilities(store, capabilities) {
    if (!Array.isArray(capabilities) || capabilities.some((capability) => typeof capability !== 'string' || !capability)) {
        throw roleError('invalid_role_capabilities', 'Capabilities must be an array of registered capability names.');
    }
    const permissions = [];
    for (const capability of [...new Set(capabilities)].sort()) {
        const permission = await store.getPermissionByCapability(capability);
        if (!permission) throw roleError('unknown_capability', `Unknown capability: ${capability}`);
        permissions.push(permission);
    }
    return permissions;
}

async function requireCustomRole(store, roleId) {
    // Persisto also accepts index values in getRole, but this contract uses ids.
    if (typeof roleId !== 'string' || !ROLE_ID_RE.test(roleId)) {
        throw roleError('invalid_role_id', 'A role id is required.');
    }
    if (!(await store.hasRole(roleId))) throw roleError('role_not_found', 'Role not found.', 404);
    const role = await store.getRole(roleId);
    // Persisto can retain a deleted object's cached id. Its live name index
    // must still identify this exact record, including after name reuse.
    const current = await store.getRoleByName(role.name);
    if (role.id !== roleId || current?.id !== roleId) throw roleError('role_not_found', 'Role not found.', 404);
    if (BUILTIN_ROLES.has(role.name)) throw roleError('builtin_role_protected', 'Built-in roles cannot be edited or deleted.', 403);
    return role;
}

function projectRole(role, capabilities = [], userCount = 0) {
    return {
        id: role.id,
        name: role.name,
        description: role.description || '',
        priority: role.priority || 0,
        builtin: BUILTIN_ROLES.has(role.name),
        capabilities: [...new Set(capabilities)].sort(),
        userCount,
    };
}

async function countRoleUsers(store, roleId) {
    const links = await scanAll(store, 'userRole');
    return new Set(links.filter((link) => link.roleId === roleId).map((link) => link.userId)).size;
}

// The same exclusion as account role assignment prevents orphaned assignments
// and makes persisted actor revocation take effect before each operation starts.
function withRoleAdministration(actorId, operation) {
    return serializePersisted('users', async () => {
        const actor = await requireActiveActor(actorId, 'admin.users.manage');
        return operation(await getStore(), actor.id);
    });
}

export function listRoleCatalog({ actorId } = {}) {
    return withRoleAdministration(actorId, async (store) => {
        const roles = await scanAll(store, 'role', 'priority');
        const permissions = await scanAll(store, 'permission', 'capability');
        const permissionNames = new Map(permissions.map((permission) => [permission.id, permission.capability]));
        const capabilitiesByRole = new Map();
        for (const link of await scanAll(store, 'rolePermission')) {
            const capability = permissionNames.get(link.permissionId);
            if (!capability) continue;
            if (!capabilitiesByRole.has(link.roleId)) capabilitiesByRole.set(link.roleId, []);
            capabilitiesByRole.get(link.roleId).push(capability);
        }
        const usersByRole = new Map();
        for (const link of await scanAll(store, 'userRole')) {
            if (!usersByRole.has(link.roleId)) usersByRole.set(link.roleId, new Set());
            usersByRole.get(link.roleId).add(link.userId);
        }
        return {
            roles: roles.map((role) => projectRole(role, capabilitiesByRole.get(role.id), usersByRole.get(role.id)?.size)),
            permissions: permissions.map((permission) => ({
                capability: permission.capability,
                description: permission.description || '',
                scope: permission.scope || '',
            })),
            totalCount: roles.length,
        };
    });
}

export function createRole(input, { actorId } = {}) {
    return withRoleAdministration(actorId, async (store, activeActorId) => {
        validateInput(input, ['name', 'description', 'capabilities']);
        const name = normalizeName(input.name);
        const description = normalizeDescription(input.description === undefined ? '' : input.description);
        const permissions = await resolveCapabilities(store, input.capabilities === undefined ? [] : input.capabilities);
        if (await store.getRoleByName(name)) throw roleError('role_name_taken', 'A role with this name already exists.', 409);
        return commitStagedPersistence(async () => {
            const role = await store.createRole({ name, description, priority: 10 });
            for (const permission of permissions) {
                await store.createRolePermission({ key: `${role.id}:${permission.id}`, roleId: role.id, permissionId: permission.id });
            }
            await recordAudit({ actorId: activeActorId, action: 'role.create', target: role.id, reason: name }, { save: false });
            return projectRole(role, permissions.map((permission) => permission.capability));
        });
    });
}

export function updateRole(input, { actorId } = {}) {
    return withRoleAdministration(actorId, async (store, activeActorId) => {
        validateInput(input, ['roleId', 'description', 'capabilities']);
        const role = await requireCustomRole(store, input.roleId);
        const patch = {};
        if (input.description !== undefined) patch.description = normalizeDescription(input.description);
        const permissions = input.capabilities === undefined ? null : await resolveCapabilities(store, input.capabilities);
        if (!Object.keys(patch).length && permissions === null) throw roleError('no_changes_requested', 'No role changes were submitted.');
        const existing = await store.getRolePermsObjectsByRoleId(role.id) || [];
        const currentCapabilities = [];
        for (const link of existing) {
            const permission = await store.getPermission(link.permissionId);
            if (permission) currentCapabilities.push(permission.capability);
        }
        const userCount = await countRoleUsers(store, role.id);
        return commitStagedPersistence(async () => {
            if (Object.keys(patch).length) await store.updateRole(role.id, patch);
            if (permissions !== null) {
                const desired = new Set(permissions.map((permission) => permission.id));
                const previous = new Set(existing.map((link) => link.permissionId));
                for (const permission of permissions) {
                    if (!previous.has(permission.id)) await store.createRolePermission({ key: `${role.id}:${permission.id}`, roleId: role.id, permissionId: permission.id });
                }
                for (const link of existing) {
                    if (!desired.has(link.permissionId)) await store.deleteRolePermission(link.key);
                }
            }
            await recordAudit({ actorId: activeActorId, action: 'role.update', target: role.id, reason: [...Object.keys(patch), ...(permissions === null ? [] : ['capabilities'])].join(',') }, { save: false });
            return projectRole({ ...role, ...patch }, permissions === null ? currentCapabilities : permissions.map((permission) => permission.capability), userCount);
        });
    });
}

export function deleteRole(input, { actorId } = {}) {
    return withRoleAdministration(actorId, async (store, activeActorId) => {
        validateInput(input, ['roleId']);
        const role = await requireCustomRole(store, input.roleId);
        if (await countRoleUsers(store, role.id)) throw roleError('role_in_use', 'Remove this role from all users before deleting it.', 409);
        const links = await store.getRolePermsObjectsByRoleId(role.id) || [];
        return commitStagedPersistence(async () => {
            for (const link of links) await store.deleteRolePermission(link.key);
            await store.deleteRole(role.id);
            await recordAudit({ actorId: activeActorId, action: 'role.delete', target: role.id, reason: role.name }, { save: false });
            return { deleted: true, roleId: role.id };
        });
    });
}
