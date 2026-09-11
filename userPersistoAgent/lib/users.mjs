import { getStore, flush } from './store.mjs';
import { hashPassword, validatePassword } from './auth/password.mjs';
import { recordAudit } from './audit.mjs';
import { assertRegistrationRoleAllowed, getAuthPolicy } from './policy.mjs';
import { serializePersisted as serialize } from './serial.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const USER_STATUSES = new Set(['active', 'blocked']);
const PRIVATE_USER_FIELDS = new Set(['passwordHash', 'loginAttempts', 'lastLoginAttempt']);
const USER_SCAN_PAGE_SIZE = 500;

function userError(code, message = code) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = ['user_not_found'].includes(code) ? 404 : 400;
    return error;
}

export function sanitizeUser(user) {
    if (!user) return null;
    return Object.fromEntries(Object.entries(user).filter(([key]) => !PRIVATE_USER_FIELDS.has(key)));
}

function normalizeEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) throw userError('invalid_email', 'A valid email address is required.');
    return normalized;
}

function normalizeUsername(username) {
    const normalized = String(username || '').trim();
    if (!normalized) return '';
    if (!USERNAME_RE.test(normalized)) {
        throw userError('invalid_username', 'Username must be 3-64 characters and use letters, numbers, dot, underscore, or dash.');
    }
    return normalized;
}

async function findUserByUsername(store, username, excludeUserId = '') {
    const needle = String(username || '').trim().toLowerCase();
    if (!needle) return null;
    let start = 0;
    while (true) {
        const result = await store.select('user', {}, { start, pageSize: USER_SCAN_PAGE_SIZE });
        const objects = result.objects || [];
        const match = objects.find((candidate) => (
            candidate.id !== excludeUserId && String(candidate.username || '').trim().toLowerCase() === needle
        ));
        if (match) return match;
        start += objects.length;
        const totalCount = Number(result.filteredCount ?? result.totalCount);
        if (!objects.length || (Number.isFinite(totalCount) && start >= totalCount) || objects.length < USER_SCAN_PAGE_SIZE) return null;
    }
}

export async function getUserByEmail(email) {
    const store = await getStore();
    const key = String(email || '').trim().toLowerCase();
    if (!key) return null;
    return (await store.hasUser(key)) ? store.getUser(key) : null;
}

export async function getUserById(id) {
    const store = await getStore();
    return (await store.hasUser(id)) ? store.getUser(id) : null;
}

async function createUserInternal({
    email,
    username = '',
    displayName = '',
    source = 'admin',
    roles = ['user'],
    password = '',
    actorId = 'system',
    emailVerified = false,
}, { save = true } = {}) {
    const store = await getStore();
    const normalizedEmail = normalizeEmail(email);
    const normalizedUsername = normalizeUsername(username);
    if (await getUserByEmail(normalizedEmail)) throw userError('email_taken', 'Email is already in use.');
    if (normalizedUsername && await findUserByUsername(store, normalizedUsername)) {
        throw userError('username_taken', 'Username is already in use.');
    }
    const roleNames = [...new Set((Array.isArray(roles) ? roles : []).map(String).map((role) => role.trim()).filter(Boolean))];
    if (!roleNames.length) throw userError('roles_required', 'At least one role is required.');
    for (const roleName of roleNames) {
        if (!(await store.getRoleByName(roleName))) throw userError('unknown_role', `Unknown role: ${roleName}`);
    }
    const timestamp = new Date().toISOString();
    const user = await store.createUser({
        email: normalizedEmail,
        username: normalizedUsername,
        displayName: String(displayName || '').trim(),
        status: 'active',
        source: String(source),
        createdAt: timestamp,
        updatedAt: timestamp,
        emailVerifiedAt: emailVerified ? timestamp : '',
        passwordHash: password ? hashPassword(password) : '',
        loginAttempts: 0,
        lastLoginAttempt: '',
    });
    await setUserRolesInternal(user.id, roleNames, { actorId, audit: false, save });
    await recordAudit({ actorId, action: 'user.create', target: user.id, reason: source }, { save });
    if (save) await flush();
    return sanitizeUser(user);
}

export function createUser(input) {
    return serialize('users', () => createUserInternal(input));
}

// Trusted domain callers must hold the users lock and persistence scope, and
// poison the store if any staged mutation fails before the final snapshot save.
export function stageUser(input) {
    return createUserInternal(input, { save: false });
}

export async function getSetupStatus() {
    const store = await getStore();
    const result = await store.select('user', {}, { start: 0, pageSize: 1 });
    const totalCount = Number(result.totalCount ?? result.filteredCount ?? result.objects.length);
    const policy = await getAuthPolicy();
    return {
        needsInitialAdmin: totalCount === 0,
        userCount: totalCount,
        selfRegistrationEnabled: policy.selfRegistrationEnabled,
        enabledAuthMethods: policy.enabledAuthMethods,
        defaultAuthMethod: policy.enabledAuthMethods[0] || 'password',
    };
}

export function registerUser({ email, password }, { allowInitialAdmin = true } = {}) {
    return serialize('users', async () => {
        validatePassword(password);
        const store = await getStore();
        const existing = await store.select('user', {}, { start: 0, pageSize: 1 });
        const firstUser = Number(existing.totalCount ?? existing.filteredCount ?? existing.objects.length) === 0;
        if (firstUser && !allowInitialAdmin) {
            throw Object.assign(userError('initial_setup_required', 'Complete initial owner setup before self-registration.'), { statusCode: 403 });
        }
        const policy = await getAuthPolicy();
        if (!firstUser && !policy.selfRegistrationEnabled) {
            throw Object.assign(userError('registration_disabled', 'Self-registration is disabled.'), { statusCode: 403 });
        }
        if (!firstUser) await assertRegistrationRoleAllowed(policy.defaultRegistrationRole, store);
        const roles = [firstUser ? 'admin' : policy.defaultRegistrationRole];
        const user = await createUserInternal({
            email,
            password,
            source: firstUser ? 'initial-setup' : 'self-registration',
            roles,
            actorId: firstUser ? 'initial-setup' : 'self-registration',
        });
        return { user, roles, firstUser };
    });
}

export function updateUser(userId, patch = {}, { actorId = 'system' } = {}) {
    return serialize('users', async () => {
        const store = await getStore();
        const user = await getUserById(userId);
        if (!user) throw userError('user_not_found', 'User not found.');
        const update = {};
        if (patch.email !== undefined) {
            const email = normalizeEmail(patch.email);
            const owner = await getUserByEmail(email);
            if (owner && owner.id !== user.id) throw userError('email_taken', 'Email is already in use.');
            if (email !== user.email) {
                update.email = email;
                update.emailVerifiedAt = '';
            }
        }
        if (patch.username !== undefined) {
            const username = normalizeUsername(patch.username);
            if (username && await findUserByUsername(store, username, user.id)) throw userError('username_taken', 'Username is already in use.');
            update.username = username;
        }
        if (patch.displayName !== undefined) update.displayName = String(patch.displayName || '').trim();
        if (patch.status !== undefined) {
            if (!USER_STATUSES.has(patch.status)) throw userError('invalid_status', `Invalid status: ${patch.status}`);
            if (patch.status === 'blocked' && (await getUserRoles(user.id)).includes('admin')) {
                await assertAnotherActiveAdmin(user.id);
            }
            update.status = patch.status;
        }
        if (!Object.keys(update).length) throw userError('no_changes_requested', 'No changes were submitted.');
        const changedFields = Object.keys(update);
        const indexedEmail = update.email;
        delete update.email;
        if (indexedEmail !== undefined) await store.setEmailForUser(user.id, indexedEmail);
        update.updatedAt = new Date().toISOString();
        const next = await store.updateUser(user.id, update);
        await recordAudit({ actorId, action: 'user.update', target: user.id, reason: changedFields.join(',') });
        await flush();
        return sanitizeUser(next);
    });
}

export async function listUsers({ start = 0, pageSize = 50, search = '', excludeOnlyRole = '', includeRoleCounts = false } = {}) {
    if (typeof search !== 'string' || search.length > 200
        || typeof excludeOnlyRole !== 'string' || excludeOnlyRole.length > 128
        || typeof includeRoleCounts !== 'boolean') {
        throw userError('invalid_user_filter', 'Invalid user search or role filter.');
    }
    const needle = search.trim().toLowerCase();
    start = Number.isInteger(start) && start >= 0 ? start : 0;
    pageSize = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 500) : 50;
    const store = await getStore();
    if (needle || excludeOnlyRole || includeRoleCounts) {
        const users = [];
        const singleRoleCounts = Object.create(null);
        let offset = 0;
        let totalCount = 0;
        while (true) {
            const result = await store.select('user', {}, { sortBy: 'createdAt', start: offset, pageSize: USER_SCAN_PAGE_SIZE });
            const objects = result.objects || [];
            for (const user of objects) {
                const roles = await getUserRoles(user.id);
                if (roles.length === 1) singleRoleCounts[roles[0]] = (singleRoleCounts[roles[0]] || 0) + 1;
                if (excludeOnlyRole && roles.length === 1 && roles[0] === excludeOnlyRole) continue;
                if (needle && ![user.email, user.username, user.displayName, user.id]
                    .some(value => String(value || '').toLowerCase().includes(needle))) continue;
                if (totalCount >= start && users.length < pageSize) users.push({ ...sanitizeUser(user), roles });
                totalCount++;
            }
            offset += objects.length;
            const count = Number(result.filteredCount ?? result.totalCount);
            if (!objects.length || objects.length < USER_SCAN_PAGE_SIZE || (Number.isFinite(count) && offset >= count)) break;
        }
        return { users, totalCount, ...(includeRoleCounts ? { singleRoleCounts } : {}) };
    }
    const result = await store.select('user', {}, {
        sortBy: 'createdAt',
        start,
        pageSize,
    });
    const users = await Promise.all(result.objects.map(async (user) => ({
        ...sanitizeUser(user),
        roles: await getUserRoles(user.id),
    })));
    return { users, totalCount: result.filteredCount ?? result.totalCount ?? users.length };
}

export async function listRoles() {
    const store = await getStore();
    const result = await store.select('role', {}, { sortBy: 'priority', start: 0, pageSize: 500 });
    return result.objects.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description || '',
        priority: role.priority || 0,
    }));
}

export async function getUserRoles(userId) {
    const store = await getStore();
    const links = await store.getUserRolesObjectsByUserId(userId) || [];
    const names = [];
    for (const link of links) {
        const role = await store.getRole(link.roleId);
        if (role) names.push(role.name);
    }
    return names.sort();
}

async function assertAnotherActiveAdmin(excludedUserId) {
    const store = await getStore();
    let start = 0;
    while (true) {
        const result = await store.select('user', {}, { start, pageSize: USER_SCAN_PAGE_SIZE });
        const objects = result.objects || [];
        for (const candidate of objects) {
            if (candidate.id === excludedUserId || candidate.status !== 'active') continue;
            if ((await getUserRoles(candidate.id)).includes('admin')) return;
        }
        start += objects.length;
        const totalCount = Number(result.filteredCount ?? result.totalCount);
        if (!objects.length || (Number.isFinite(totalCount) && start >= totalCount) || objects.length < USER_SCAN_PAGE_SIZE) break;
    }
    throw userError('last_admin_required', 'At least one active admin user is required.');
}

async function setUserRolesInternal(userId, roleNames, { actorId = 'system', audit = true, save = true } = {}) {
    const store = await getStore();
    const user = await getUserById(userId);
    if (!user) throw userError('user_not_found', 'User not found.');
    if (!Array.isArray(roleNames)) throw userError('roles_must_be_array', 'Roles must be an array.');
    const uniqueNames = [...new Set(roleNames.map(String).map((name) => name.trim()).filter(Boolean))];
    if (!uniqueNames.length) throw userError('roles_required', 'At least one role is required.');
    const currentNames = await getUserRoles(userId);
    if (currentNames.includes('admin') && !uniqueNames.includes('admin')) await assertAnotherActiveAdmin(userId);
    const roles = [];
    for (const name of uniqueNames) {
        const role = await store.getRoleByName(name);
        if (!role) throw userError('unknown_role', `Unknown role: ${name}`);
        roles.push(role);
    }
    const existing = await store.getUserRolesObjectsByUserId(userId) || [];
    const existingByRoleId = new Map(existing.map((link) => [link.roleId, link]));
    const requestedRoleIds = new Set(roles.map((role) => role.id));

    // Add every new role before deleting obsolete links. Persisto has no
    // multi-record transaction, so this ordering avoids a transient roleless
    // account if a later write fails.
    for (const role of roles) {
        if (!existingByRoleId.has(role.id)) {
            await store.createUserRole({ key: `${userId}:${role.id}`, userId, roleId: role.id });
        }
    }
    for (const link of existing) {
        if (!requestedRoleIds.has(link.roleId)) await store.deleteUserRole(link.key);
    }
    if (audit) await recordAudit({ actorId, action: 'user.roles.update', target: userId, reason: uniqueNames.join(',') }, { save });
    if (save) await flush();
    return uniqueNames.sort();
}

export function setUserRoles(userId, roleNames, options = {}) {
    return serialize('users', () => setUserRolesInternal(userId, roleNames, options));
}

export async function deactivateUser(userId, { actorId = 'system' } = {}) {
    const user = await updateUser(userId, { status: 'blocked' }, { actorId });
    return { ...user, roles: await getUserRoles(userId) };
}
