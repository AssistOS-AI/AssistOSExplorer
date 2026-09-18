import { getStore, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { getAuthPolicy } from '../policy.mjs';
import { prepareNewAccount, readInstallationSetup } from '../setup.mjs';
import { authGenerationOf, getUserByEmail, normalizeEmail } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { hashSecret } from './password.mjs';
import { loginWithUserPassword, stagePasswordCredential } from './userPassword.mjs';
import { consumeMemoryBudget, prepareDirectCompletion, rateSourceKey, readAttempt } from './emailAttempts.mjs';
import { replayCompletion } from './signIn.mjs';

const failed = () => Object.assign(new Error('Unable to sign in.'), { code: 'authentication_failed', statusCode: 401 });

// The durable setup record is authoritative even if all accounts are removed.
// This is a one-time account creation exception, never a shared login secret.
export function initialPasswordSetupAvailable() {
    return withPersistenceScope(async () => !(await readInstallationSetup(await getStore())).complete
        && (await getAuthPolicy()).enabledAuthMethods.includes('password'));
}

export async function loginWithInitialPassword(options) {
    const { parent, browserProof, password, rateSource = '', validateParent, prepareHandoff } = options;
    // Creation requires the literal password, without trimming or normalization.
    // Every other presentation follows the ordinary per-account verifier path.
    if (password !== 'admin') return loginWithUserPassword(options);
    let email;
    try { email = normalizeEmail(options.email); } catch { throw failed(); }
    if (validateParent) await validateParent();
    if (browserProof) {
        const attempt = await readAttempt({ parent, browserProof });
        if (attempt.status === 'completed' && attempt.completion?.method === 'initialPassword' && attempt.completion.email === email) {
            return replayCompletion(attempt);
        }
    }
    if (!(await initialPasswordSetupAvailable())) return loginWithUserPassword(options);
    const validateCreation = async () => {
        if (validateParent) await validateParent();
        await withPersistenceScope(async () => {
            if (!(await initialPasswordSetupAvailable()) || await getUserByEmail(email)) throw failed();
            const attempt = await readAttempt({ parent, browserProof });
            if (attempt.status === 'completed') throw failed();
        });
    };
    await validateCreation();
    const source = rateSourceKey(rateSource);
    consumeMemoryBudget('initial-password-source', source, source === 'shared' ? 100 : 10);
    const verifier = await hashSecret(password, { validateAdmission: validateCreation });
    return serializePersisted('users', async () => {
        await validateCreation();
        const store = await getStore();
        const stageAccount = await prepareNewAccount({ email, emailVerified: false, method: 'initialPassword' });
        const stageCompletion = await prepareDirectCompletion({ parent, browserProof, email, method: 'initialPassword' });
        const stageHandoff = prepareHandoff ? await prepareHandoff() : null;
        return commitStagedPersistence(async () => {
            const account = await stageAccount();
            await stagePasswordCredential(store, { userId: account.user.id, verifier });
            const handoff = stageHandoff ? await stageHandoff(account.user.id) : null;
            await stageCompletion({ userId: account.user.id, generation: authGenerationOf(account.user), handoff });
            await recordAudit({ actorId: account.user.id, action: 'auth.password.initial_setup', target: account.user.id, reason: parent.flow }, { save: false });
            return { ok: true, ...account, created: true, generation: authGenerationOf(account.user), handoff };
        });
    });
}
