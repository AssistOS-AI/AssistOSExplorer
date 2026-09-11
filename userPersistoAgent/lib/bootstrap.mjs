import { getStore, flush } from './store.mjs';

// Roles and capabilities only. No account is seeded: the first completed Google,
// verified-email or configured administrator-password sign-in claims setup.
const ROLES = [
    { name: 'admin', description: 'Full administration', priority: 1 },
    { name: 'user', description: 'Explorer user', priority: 2 },
    { name: 'selfRegistered', description: 'Self-registered dashboard user', priority: 3 }
];

const CAPABILITIES = [
    { capability: 'explorer.access', description: 'Access the Explorer workspace', scope: 'product', roles: ['admin', 'user'] },
    { capability: 'admin.users.manage', description: 'Manage users and roles', scope: 'admin', roles: ['admin'] },
    { capability: 'admin.agentSettings.manage', description: 'Manage agent settings', scope: 'admin', roles: ['admin'] },
    { capability: 'admin.billing.manage', description: 'Manage billing', scope: 'admin', roles: ['admin'] },
    { capability: 'selfregistered.dashboard.access', description: 'Access the self-registered dashboard', scope: 'product', roles: ['selfRegistered'] }
];

export async function ensureSeedData() {
    const store = await getStore();
    for (const role of ROLES) {
        if (!(await store.hasRole(role.name))) {
            await store.createRole(role);
        }
    }
    for (const { roles, ...perm } of CAPABILITIES) {
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
