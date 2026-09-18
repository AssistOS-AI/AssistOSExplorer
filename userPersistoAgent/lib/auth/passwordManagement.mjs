import { getStore, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { getAuthPolicy } from '../policy.mjs';
import { authGenerationOf, getUserById } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { stageCredentialGenerationAdvance } from './generation.mjs';
import { consumeMemoryBudget } from './emailAttempts.mjs';
import { hashSecret } from './password.mjs';
import { readPasswordCredential, stagePasswordCredential, validateNewPassword } from './userPassword.mjs';
import { assertOperationAllowedFor, stageGrantConsumption } from './operationGrants.mjs';

// My Account password set and change: normal credential management for the
// signed-in actor, authorized by one fresh `password.set` operation grant. An
// unverified account may change the password it already owns; a first password
// still needs a verified mailbox. There is no administrator-set password.
const OPERATION = 'password.set';
const ACCOUNT_KDF_LIMIT = 5;

function managementError(code, statusCode) {
    const messages = {
        user_not_active: 'Account is not active.',
        auth_method_disabled: 'This sign-in method is not available.',
        operation_grant_required: 'Confirm it is you before changing sign-in methods.',
    };
    return Object.assign(new Error(messages[code] || 'Unable to continue.'), { code, statusCode });
}

async function activeActor(userId) {
    const user = await getUserById(userId);
    if (!user || user.status !== 'active') throw managementError('user_not_active', 403);
    return user;
}

async function assertPasswordEnabled() {
    if (!(await getAuthPolicy()).enabledAuthMethods.includes('password')) throw managementError('auth_method_disabled', 404);
}

function credentialState(credential) {
    return credential ? String(credential.record.credential?.version || '') : '';
}

// 1. Predictable input failures never touch the grant.
// 2. Read-only checks before any KDF. A valid grant is only looked up, so it
//    stays available; a missing or foreign grant is refused untouched; an
//    already invalid grant of this account is deleted under the existing rule.
// 3. The per-account KDF budget, then hashing outside every store lock.
// 4. Under the users lock the grant is read again and revalidated with the
//    actor, mailbox, policy, generation and credential state, then deleted in
//    the same commit that writes the credential. Two requests with one grant
//    serialize here: the second finds no grant and writes nothing, even for a
//    first set that leaves the generation unchanged.
export async function setAccountPassword({ userId, grant, password, passwordConfirmation }) {
    const actor = await activeActor(userId);
    const { normalized } = validateNewPassword({ password, passwordConfirmation, email: actor.email });
    const inspectGrant = () => serializePersisted('users', async () => {
        const user = await activeActor(userId);
        await assertOperationAllowedFor(await getStore(), user, OPERATION);
        await assertPasswordEnabled();
        const staged = await stageGrantConsumption({ userId, operation: OPERATION, grant });
        if (!staged.valid) {
            await commitStagedPersistence(staged.consume);
            throw managementError('operation_grant_required', 403);
        }
        return { generation: staged.generation, credential: credentialState(await readPasswordCredential(await getStore(), userId)) };
    });
    const observed = await inspectGrant();
    consumeMemoryBudget('password-set-account', userId, ACCOUNT_KDF_LIMIT);
    const verifier = await hashSecret(normalized, { validateAdmission: inspectGrant });
    return serializePersisted('users', async () => {
        const store = await getStore();
        const staged = await stageGrantConsumption({ userId, operation: OPERATION, grant });
        const refuse = async (error) => {
            await commitStagedPersistence(staged.consume);
            throw error;
        };
        const user = staged.user;
        if (!user || user.status !== 'active') return refuse(managementError('user_not_active', 403));
        try { await assertOperationAllowedFor(store, user, OPERATION); } catch (error) { return refuse(error); }
        if (!(await getAuthPolicy()).enabledAuthMethods.includes('password')) return refuse(managementError('auth_method_disabled', 404));
        const current = await readPasswordCredential(store, userId);
        if (!staged.valid || staged.generation !== observed.generation || authGenerationOf(user) !== observed.generation
            || credentialState(current) !== observed.credential) {
            return refuse(managementError('operation_grant_required', 403));
        }
        const replacing = Boolean(current);
        await commitStagedPersistence(async () => {
            await staged.consume();
            await stagePasswordCredential(store, { userId, verifier });
            // Replacing a password revokes sessions and bound proofs; a first
            // set replaces nothing and keeps the generation.
            if (replacing) await stageCredentialGenerationAdvance(userId);
            await recordAudit({ actorId: userId, action: replacing ? 'auth.password.change' : 'auth.password.set', target: userId }, { save: false });
        });
        return { ok: true, changed: replacing };
    });
}
