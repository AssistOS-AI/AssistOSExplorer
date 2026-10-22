import { getStore, flush } from './store.mjs';
import { productPermissions } from './product-permissions.mjs';

// Roles and capabilities only. No account or credential is seeded: the first
// completed initial-password setup, verified signup or Google sign-in claims setup.
const ROLES = [
    { name: 'admin', description: 'Full administration', priority: 1 },
    { name: 'user', description: 'User', priority: 2 },
    { name: 'selfRegistered', description: 'Self-registered dashboard user', priority: 3 }
];

const CAPABILITIES = [
    { capability: 'admin.users.manage', description: 'Manage users and roles', scope: 'admin', roles: ['admin'] },
    { capability: 'admin.agentSettings.manage', description: 'Manage agent settings', scope: 'admin', roles: ['admin'] },
    { capability: 'admin.billing.manage', description: 'Manage billing', scope: 'admin', roles: ['admin'] },
    { capability: 'selfregistered.dashboard.access', description: 'Access the self-registered dashboard', scope: 'product', roles: ['selfRegistered'] }
];

export async function ensureSeedData(options = {}) {
    const configured = productPermissions(options.productPermissions);
    const store = await getStore();
    for (const permission of configured) {
        const existing = await store.getPermissionByCapability(permission.capability);
        if (existing && existing.scope !== 'product') {
            throw new Error('Configured product permission conflicts with a non-product permission.');
        }
    }
    for (const role of ROLES) {
        if (!(await store.hasRole(role.name))) {
            await store.createRole(role);
        } else {
            const existing = await store.getRoleByName(role.name);
            if (existing.description !== role.description) {
                await store.updateRole(existing.id, { description: role.description });
            }
        }
    }
    for (const { roles, ...perm } of [...CAPABILITIES, ...configured]) {
        if (!(await store.hasPermission(perm.capability))) {
            await store.createPermission(perm);
        }
        const permission = await store.getPermissionByCapability(perm.capability);
        for (const roleName of roles) {
            const role = await store.getRoleByName(roleName);
            const key = `${role.id}:${permission.id}`;
            if (!(await store.hasRolePermission(key))) {
                await store.createRolePermission({ key, roleId: role.id, permissionId: permission.id });
            }
        }
    }
    await flush();
}
