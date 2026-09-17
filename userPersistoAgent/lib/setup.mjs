import { getStore } from './store.mjs';
import { assertNewUserAvailable, stageUser } from './users.mjs';
import { assertRegistrationRoleAllowed, getAuthPolicy, REGISTRATION_ROLE } from './policy.mjs';
import { recordAudit } from './audit.mjs';

export const SETUP_KEY = 'installation.setup';
const SETUP_METHODS = new Set(['google', 'emailCode', 'adminPassword']);

function setupError(code, message, statusCode = 403) {
    return Object.assign(new Error(message), { code, statusCode });
}

// The committed record is the only authority for first-owner assignment. A
// malformed record fails closed as claimed; it never reopens public ownership.
export async function readInstallationSetup(store) {
    const record = await store.getSystemSettingByKey(SETUP_KEY);
    if (!record) return { complete: false, initialAdministratorId: '', method: '', completedAt: '' };
    const value = record.value && typeof record.value === 'object' ? record.value : {};
    return {
        complete: true,
        initialAdministratorId: typeof value.initialAdministratorId === 'string' ? value.initialAdministratorId : '',
        method: SETUP_METHODS.has(value.method) ? value.method : '',
        completedAt: typeof value.completedAt === 'string' ? value.completedAt : '',
    };
}

export async function getInstallationSetup() {
    return readInstallationSetup(await getStore());
}

// Callers hold serializePersisted('users') from this check through the staged
// commit, after live-parent and proof checks. The returned stage function only
// writes: the unclaimed installation gets its administrator and setup record
// together; a claimed installation gets exactly `selfRegistered`.
export async function prepareNewAccount({
    email,
    username = '',
    displayName = '',
    contactEmail = '',
    emailVerified = false,
    method,
    source,
}) {
    if (!SETUP_METHODS.has(method)) throw setupError('invalid_setup_method', 'Unsupported account creation method.', 500);
    const store = await getStore();
    const setup = await readInstallationSetup(store);
    let roles;
    if (!setup.complete) {
        roles = ['admin'];
    } else {
        const policy = await getAuthPolicy();
        if (!policy.selfRegistrationEnabled) throw setupError('registration_disabled', 'Self-registration is disabled.');
        await assertRegistrationRoleAllowed(REGISTRATION_ROLE, store);
        roles = [REGISTRATION_ROLE];
    }
    const allowEmptyEmail = method === 'adminPassword' && !setup.complete;
    await assertNewUserAvailable({ email, username, roles, contactEmail, allowEmptyEmail });
    const initialAdministrator = !setup.complete;
    return async () => {
        const actorId = initialAdministrator ? 'initial-setup' : 'self-registration';
        const user = await stageUser({
            email,
            username,
            displayName,
            contactEmail,
            source: source || (initialAdministrator ? `initial-${method}` : `${method}-self-registration`),
            roles,
            actorId,
            emailVerified,
            allowEmptyEmail,
        });
        if (initialAdministrator) {
            const completedAt = new Date().toISOString();
            await store.createSystemSetting({
                key: SETUP_KEY,
                value: { complete: true, initialAdministratorId: user.id, method, completedAt },
                updatedAt: completedAt,
                updatedBy: user.id,
            });
            await recordAudit({ actorId: user.id, action: 'installation.setup.complete', target: user.id, reason: method }, { save: false });
        }
        return { user, roles, initialAdministrator };
    };
}
