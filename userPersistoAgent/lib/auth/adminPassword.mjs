import { createHash, randomBytes } from 'node:crypto';
import { getStore, commitStagedPersistence } from '../store.mjs';
import { serialize, serializePersisted } from '../serial.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { hashPassword, verifyPassword } from './password.mjs';
import { readInstallationSetup, prepareNewAccount } from '../setup.mjs';
import { getUserById, getUserRoles, sanitizeUser } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { stageCredentialGenerationAdvance } from './generation.mjs';
import { getEmailAuthCodeStatus } from '../email-agent-client.mjs';

// One deployment-configured secret, supplied through protected Ploinky
// configuration (`ploinky var`). There is no default and no second source.
export const ADMIN_PASSWORD_VARIABLE = 'USERPERSISTO_ADMIN_PASSWORD';
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 1024;
const STATE_KEY = 'auth.adminPassword.state';
const THROTTLE_KEY = 'auth.adminPassword.throttle';
const WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_FAILURE_LIMIT = 30;
const SOURCE_FAILURE_LIMIT = 5;
const MAX_TRACKED_SOURCES = 10_000;
const RATE_SOURCE = /^[a-f0-9]{64}$/;
const SHARED_SOURCE = 'shared';

const sourceFailures = new Map();
let synced = null;
let warnedInvalid = false;

function adminError(code, statusCode, extra = {}) {
    const messages = {
        admin_password_unavailable: 'Administrator sign-in is not available.',
        authentication_failed: 'Unable to sign in with that administrator password.',
        rate_limited: 'Too many attempts. Wait and try again.',
    };
    return Object.assign(new Error(messages[code] || 'Administrator sign-in failed.'), { code, statusCode, ...extra });
}

function configuredPassword() {
    const value = process.env[ADMIN_PASSWORD_VARIABLE];
    if (typeof value !== 'string' || !value) return '';
    if (value.length < ADMIN_PASSWORD_MIN_LENGTH || value.length > ADMIN_PASSWORD_MAX_LENGTH || !value.trim()) {
        if (!warnedInvalid) {
            warnedInvalid = true;
            console.warn(`[userPersisto] ${ADMIN_PASSWORD_VARIABLE} is set but is not ${ADMIN_PASSWORD_MIN_LENGTH}-${ADMIN_PASSWORD_MAX_LENGTH} characters; administrator password sign-in is unavailable.`);
        }
        return '';
    }
    return value;
}

export function isAdministratorPasswordConfigured() {
    return configuredPassword() !== '';
}

export function administratorPasswordVersion(state) {
    return createHash('sha256').update(JSON.stringify(['userpersisto:admin-password', state?.version || ''])).digest('hex');
}

async function readState(store) {
    const record = await store.getSystemSettingByKey(STATE_KEY);
    const value = record?.value;
    const valid = value && typeof value.passwordHash === 'string' && typeof value.version === 'string' && value.version;
    return { record, state: valid ? value : null };
}

// Aligns the durable verifier with the configured value. Replacing or removing
// the value rotates `version`, which invalidates retained proofs, and advances
// the designated administrator's generation, which revokes their sessions.
// Never call this while holding the persistence scope.
export function syncAdministratorPasswordState() {
    return serialize('admin-password', syncLocked);
}

async function syncLocked() {
    const password = configuredPassword();
    const digest = password ? createHash('sha256').update(password).digest('hex') : '';
    const store = await getStore();
    if (synced && synced.store === store && synced.digest === digest) return synced.state;
    const removing = !password && (await readState(store)).state;
    const emailAvailable = removing ? (await getEmailAuthCodeStatus()).available === true : false;
    return withPersistenceScope(async () => {
        const { record, state: current } = await readState(store);
        let next = current;
        if (password && (!current || !verifyPassword(password, current.passwordHash))) {
            next = { passwordHash: hashPassword(password), version: randomBytes(16).toString('hex'), updatedAt: new Date().toISOString() };
        } else if (!password) {
            next = null;
        }
        if (next !== current || (!next && record)) {
            const setup = await readInstallationSetup(store);
            const administrator = current && setup.initialAdministratorId ? await getUserById(setup.initialAdministratorId) : null;
            await commitStagedPersistence(async () => {
                if (next && record) await store.updateSystemSetting(record.id, { value: next, updatedAt: next.updatedAt, updatedBy: 'configuration' });
                else if (next) await store.createSystemSetting({ key: STATE_KEY, value: next, updatedAt: next.updatedAt, updatedBy: 'configuration' });
                else if (record) await store.deleteSystemSetting(record.id);
                if (administrator) await stageCredentialGenerationAdvance(administrator.id);
                await recordAudit({ actorId: 'configuration', action: next ? 'auth.adminPassword.configured' : 'auth.adminPassword.removed', target: administrator?.id || '' }, { save: false });
            });
            if (!next && administrator && !(await administratorHasOtherMethod(administrator, emailAvailable))) {
                // Removing the variable is recoverable only by configuring it again.
                console.warn(`[userPersisto] ${ADMIN_PASSWORD_VARIABLE} was removed and the designated administrator has no other usable sign-in method; set it again and restart to regain administrator access.`);
            }
        }
        synced = { store, digest, state: next };
        return next;
    });
}

async function administratorHasOtherMethod(administrator, emailAvailable) {
    const { usableSignInMethods } = await import('../policy.mjs');
    return (await usableSignInMethods(administrator, { includeAdministratorPassword: false, emailAvailable })).length > 0;
}

export function resetAdministratorPasswordForTests() {
    synced = null;
    warnedInvalid = false;
    sourceFailures.clear();
}

function sourceKey(rateSource) {
    return typeof rateSource === 'string' && RATE_SOURCE.test(rateSource) ? rateSource : SHARED_SOURCE;
}

function liveWindow(entry, now) {
    return entry && now - entry.windowStartedAt < WINDOW_MS ? entry : null;
}

function sourceLimited(key, now) {
    const entry = liveWindow(sourceFailures.get(key), now);
    if (entry) return entry.failures >= SOURCE_FAILURE_LIMIT ? entry : null;
    sourceFailures.delete(key);
    if (sourceFailures.size < MAX_TRACKED_SOURCES) return null;
    for (const [candidate, value] of sourceFailures) if (!liveWindow(value, now)) sourceFailures.delete(candidate);
    // A saturated table fails closed for untracked sources instead of forgetting.
    return sourceFailures.size >= MAX_TRACKED_SOURCES ? { windowStartedAt: now } : null;
}

function retryAfter(entry, now) {
    return Math.max(1, Math.ceil((entry.windowStartedAt + WINDOW_MS - now) / 1000));
}

async function readGlobalThrottle(store, now) {
    const record = await store.getSystemSettingByKey(THROTTLE_KEY);
    const value = record?.value;
    const live = value && Number.isSafeInteger(value.windowStartedAt) && Number.isSafeInteger(value.failures)
        && now - value.windowStartedAt < WINDOW_MS && value.windowStartedAt <= now;
    return { record, value: live ? value : { windowStartedAt: now, failures: 0 } };
}

async function recordFailure(key, now) {
    const entry = liveWindow(sourceFailures.get(key), now) || { windowStartedAt: now, failures: 0 };
    entry.failures += 1;
    sourceFailures.set(key, entry);
    await withPersistenceScope(async () => {
        const store = await getStore();
        const { record, value } = await readGlobalThrottle(store, now);
        const next = { windowStartedAt: value.windowStartedAt, failures: value.failures + 1 };
        await commitStagedPersistence(async () => {
            if (record) await store.updateSystemSetting(record.id, { value: next, updatedAt: new Date(now).toISOString(), updatedBy: 'throttle' });
            else await store.createSystemSetting({ key: THROTTLE_KEY, value: next, updatedAt: new Date(now).toISOString(), updatedBy: 'throttle' });
            await recordAudit({ actorId: 'anonymous', action: 'auth.adminPassword.verify', result: 'denied', reason: 'invalid_credentials' }, { save: false });
        });
    });
}

// Verifies a candidate against the configured secret. All attempts share one
// lock, the durable global budget works before any account exists, and the
// per-source budget uses only the Router's trusted rate-source partition.
export function verifyAdministratorPassword({ password, rateSource = '' }) {
    return serialize('admin-password', async () => {
        const state = await syncLocked();
        if (!state) throw adminError('admin_password_unavailable', 404);
        if (typeof password !== 'string' || password.length > ADMIN_PASSWORD_MAX_LENGTH) throw adminError('authentication_failed', 400);
        const now = Date.now();
        const key = sourceKey(rateSource);
        const limitedSource = sourceLimited(key, now);
        if (limitedSource) throw adminError('rate_limited', 429, { retryAfter: retryAfter(limitedSource, now) });
        const global = await withPersistenceScope(async () => (await readGlobalThrottle(await getStore(), now)).value);
        if (global.failures >= GLOBAL_FAILURE_LIMIT) throw adminError('rate_limited', 429, { retryAfter: retryAfter(global, now) });
        // Shorter candidates cannot match the configured length bound; they are
        // refused without hashing and without spending the shared budget.
        if (password.length < ADMIN_PASSWORD_MIN_LENGTH || !verifyPassword(password, state.passwordHash)) {
            if (password.length >= ADMIN_PASSWORD_MIN_LENGTH) await recordFailure(key, now);
            throw adminError('authentication_failed', 401);
        }
        if (key !== SHARED_SOURCE) sourceFailures.delete(key);
        return { credentialVersion: administratorPasswordVersion(state) };
    });
}

// Read-only; safe inside the persistence scope. The designated administrator
// must still exist, be active and hold the admin role.
export async function resolveDesignatedAdministrator(store = null) {
    const persisto = store || await getStore();
    const setup = await readInstallationSetup(persisto);
    if (!setup.complete || !setup.initialAdministratorId) return null;
    const user = await getUserById(setup.initialAdministratorId);
    if (!user || user.status !== 'active') return null;
    return (await getUserRoles(user.id)).includes('admin') ? user : null;
}

export async function administratorPasswordUsableFor(userId) {
    if (!isAdministratorPasswordConfigured() || typeof userId !== 'string' || !userId) return false;
    return (await resolveDesignatedAdministrator())?.id === userId;
}

// Rechecks, under the caller's persistence scope, that a proof obtained earlier
// still matches the current configured credential and designated account.
export async function assertAdministratorPasswordProof(store, { userId, credentialVersion }) {
    const { state } = await readState(store);
    const administrator = await resolveDesignatedAdministrator(store);
    return Boolean(isAdministratorPasswordConfigured() && state && administrator && administrator.id === userId
        && credentialVersion === administratorPasswordVersion(state));
}

// Authenticates the configured administrator password and completes locally.
// Before setup it creates the dedicated email-less administrator together with
// the setup record; afterwards it only resolves the designated administrator.
// It never selects, promotes or creates any other account. Callers hold the
// parent lock; `validateParent` is a locked read of the live parent.
export async function completeAdministratorPassword({ password, rateSource, contactEmail = '', validateParent }) {
    if (validateParent) await validateParent();
    const proof = await verifyAdministratorPassword({ password, rateSource });
    return serializePersisted('users', async () => {
        const store = await getStore();
        if (validateParent) await validateParent();
        const { state } = await readState(store);
        if (!state || administratorPasswordVersion(state) !== proof.credentialVersion) throw adminError('authentication_failed', 401);
        const setup = await readInstallationSetup(store);
        if (!setup.complete) {
            const stage = await prepareNewAccount({
                email: '',
                username: 'administrator',
                displayName: 'Administrator',
                contactEmail: typeof contactEmail === 'string' ? contactEmail.trim() : '',
                emailVerified: false,
                method: 'adminPassword',
                source: 'initial-admin-password',
            });
            return commitStagedPersistence(async () => {
                const created = await stage();
                await recordAudit({ actorId: created.user.id, action: 'auth.adminPassword.login', target: created.user.id }, { save: false });
                return { user: created.user, roles: created.roles, created: true, initialAdministrator: created.initialAdministrator };
            });
        }
        const administrator = await resolveDesignatedAdministrator(store);
        if (!administrator) throw adminError('authentication_failed', 401);
        await recordAudit({ actorId: administrator.id, action: 'auth.adminPassword.login', target: administrator.id });
        return { user: sanitizeUser(administrator), roles: await getUserRoles(administrator.id), created: false, initialAdministrator: false };
    });
}
