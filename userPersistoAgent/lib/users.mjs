import { getStore, flush } from './store.mjs';
import { recordAudit } from './audit.mjs';
import { serializePersisted as serialize } from './serial.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const USER_ID_RE = /^USER\.[0-9a-z]+$/i;
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

export function normalizeEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (normalized.length > 254 || !EMAIL_RE.test(normalized)) throw userError('invalid_email', 'A valid email address is required.');
    return normalized;
}

// Only a non-empty, verified mailbox is a sign-in credential. An unverified
// contact address, or the email-less configured administrator, never is.
export function hasVerifiedMailbox(user) {
    return Boolean(user && typeof user.email === 'string' && user.email && user.emailVerifiedAt);
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
    if (!key || !key.includes('@')) return null;
    return (await store.hasUser(key)) ? store.getUser(key) : null;
}

// Persisto resolves a missing id through the email index too. Account ids are
// always Persisto object ids, so an empty or email-shaped value is never one.
export async function getUserById(id) {
    if (typeof id !== 'string' || !USER_ID_RE.test(id)) return null;
    const store = await getStore();
    return (await store.hasUser(id)) ? store.getUser(id) : null;
}

function normalizeRoleNames(roles) {
    return [...new Set((Array.isArray(roles) ? roles : []).map(String).map((role) => role.trim()).filter(Boolean))];
}

// Runs every predictable account-creation check without mutating, so staged
// callers can validate before entering the fail-closed persistence boundary.
// The only email-less account is the configured-password administrator.
export async function assertNewUserAvailable({ email, username = '', roles = [], contactEmail = '', allowEmptyEmail = false }) {
    const store = await getStore();
    const normalizedEmail = allowEmptyEmail && email === '' ? '' : normalizeEmail(email);
    const normalizedUsername = normalizeUsername(username);
    const normalizedContact = contactEmail ? normalizeEmail(contactEmail) : '';
    if (normalizedEmail ? await getUserByEmail(normalizedEmail) : await store.hasUser('')) {
        throw userError('email_taken', 'Email is already in use.');
    }
    if (normalizedUsername && await findUserByUsername(store, normalizedUsername)) {
        throw userError('username_taken', 'Username is already in use.');
    }
    const roleNames = normalizeRoleNames(roles);
    if (!roleNames.length) throw userError('roles_required', 'At least one role is required.');
    for (const roleName of roleNames) {
        if (!(await store.getRoleByName(roleName))) throw userError('unknown_role', `Unknown role: ${roleName}`);
    }
    return { email: normalizedEmail, username: normalizedUsername, contactEmail: normalizedContact, roles: roleNames };
}

async function createUserInternal({
    email,
    username = '',
    displayName = '',
    source = 'internal',
    roles = ['user'],
    actorId = 'system',
    emailVerified = false,
    contactEmail = '',
    allowEmptyEmail = false,
}, { save = true } = {}) {
    const store = await getStore();
    const normalized = await assertNewUserAvailable({ email, username, roles, contactEmail, allowEmptyEmail });
    const timestamp = new Date().toISOString();
    const user = await store.createUser({
        email: normalized.email,
        username: normalized.username,
        displayName: String(displayName || '').trim(),
        contactEmail: normalized.contactEmail,
        status: 'active',
        source: String(source),
        createdAt: timestamp,
        updatedAt: timestamp,
        emailVerifiedAt: emailVerified && normalized.email ? timestamp : '',
        authGeneration: 0,
        loginAttempts: 0,
        lastLoginAttempt: '',
    });
    await setUserRolesInternal(user.id, normalized.roles, { actorId, audit: false, save });
    await recordAudit({ actorId, action: 'user.create', target: user.id, reason: source }, { save });
    if (save) await flush();
    return sanitizeUser(user);
}

// Internal domain and fixture helper. No HTTP route, runtime operation or tool
// creates arbitrary accounts; public accounts come from the setup decision.
export function createUser(input) {
    return serialize('users', () => createUserInternal(input));
}

// Trusted domain callers must hold the users lock and persistence scope, and
// poison the store if any staged mutation fails before the final snapshot save.
export function stageUser(input) {
    return createUserInternal(input, { save: false });
}

// Staged helper for credential replacement/revocation. Callers hold the users
// lock and persistence scope; sessions and proofs bound to the old generation fail.
export async function stageAuthGenerationIncrement(userId) {
    const store = await getStore();
    const user = await getUserById(userId);
    if (!user) return null;
    const authGeneration = (Number.isSafeInteger(user.authGeneration) ? user.authGeneration : 0) + 1;
    return store.updateUser(user.id, { authGeneration, updatedAt: new Date().toISOString() });
}

export function authGenerationOf(user) {
    return Number.isSafeInteger(user?.authGeneration) ? user.authGeneration : 0;
}

export function updateUser(userId, patch = {}, { actorId = 'system' } = {}) {
    return serialize('users', async () => {
        const store = await getStore();
        const user = await getUserById(userId);
        if (!user) throw userError('user_not_found', 'User not found.');
        const update = {};
        // Sign-in mailboxes change only through fresh proof of the new address.
        if (patch.email !== undefined && patch.email !== null) {
            const email = typeof patch.email === 'string' ? patch.email.trim().toLowerCase() : patch.email;
            if (email !== user.email) throw userError('email_change_unsupported', 'Email addresses cannot be changed here.');
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
                if (needle && ![user.email, user.contactEmail, user.username, user.displayName, user.id]
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
