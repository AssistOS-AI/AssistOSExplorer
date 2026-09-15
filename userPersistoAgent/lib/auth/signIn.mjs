import { getStore, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { getAuthPolicy } from '../policy.mjs';
import { authGenerationOf, getUserById, getUserByEmail, getUserRoles, hasVerifiedMailbox, normalizeEmail, sanitizeUser } from '../users.mjs';
import { prepareNewAccount, readInstallationSetup } from '../setup.mjs';
import { recordAudit } from '../audit.mjs';
import { sendAuthCode } from '../email-agent-client.mjs';
import {
    attemptError,
    cancelAttempt,
    checkChallengeCode,
    deliverCode,
    describeAttempt,
    developmentLogFallback,
    discoveryBudget,
    issueChallenge,
    readAttempt,
    recordDelivery,
    stageChallengeOutcome,
} from './emailAttempts.mjs';

// Protocol-neutral wizard operations shared by the Router SSO page and the
// OIDC interaction. A parent is `{ flow, id, expiresAt }`; every caller holds
// the parent lock and supplies `validateParent`, a locked read of the live
// parent. Completion-side protocol handoffs stay with each adapter.
function signInError(code, statusCode) {
    const messages = {
        account_exists: 'An account already uses this email. Sign in instead.',
        account_not_found: 'No account can sign in with this email.',
        registration_disabled: 'Registration is not available.',
        auth_method_disabled: 'This sign-in method is not available.',
        authentication_failed: 'Unable to sign in.',
    };
    return Object.assign(new Error(messages[code] || 'Unable to continue.'), { code, statusCode });
}

async function methodsFor(user, policy, emailAvailable) {
    const enabled = policy.enabledAuthMethods;
    const methods = { emailCode: false, passkey: false, totp: false };
    if (!user || user.status !== 'active') return methods;
    methods.emailCode = emailAvailable && enabled.includes('emailCode') && hasVerifiedMailbox(user);
    const credentials = await (await getStore()).getAuthMethodsObjectsByUserId(user.id) || [];
    methods.passkey = enabled.includes('passkey') && credentials.some((method) => method.type === 'passkey' && method.enabled === true);
    methods.totp = enabled.includes('totp') && credentials.some((method) => method.type === 'totp' && method.enabled === true);
    return methods;
}

// Minimal discovery: existence and usable local method types only. No
// credential names, identifiers, counts, timestamps, roles or Google linkage.
export async function discoverAccount({ parent, email, rateSource, validateParent, emailAvailable = false }) {
    let normalized;
    try { normalized = normalizeEmail(email); } catch { throw attemptError('invalid_email'); }
    if (validateParent) await validateParent();
    discoveryBudget({ parent, rateSource });
    const user = await getUserByEmail(normalized);
    return { exists: Boolean(user), methods: await methodsFor(user, await getAuthPolicy(), emailAvailable) };
}

// Checks the purpose against current state before any code is sent. Login
// codes go only to an active account's verified mailbox; registration codes
// only to an unused address while registration (or unclaimed setup) allows it.
async function precheckPurpose(purpose, email) {
    const policy = await getAuthPolicy();
    if (!policy.enabledAuthMethods.includes('emailCode')) throw signInError('auth_method_disabled', 404);
    const user = await getUserByEmail(email);
    if (purpose === 'register') {
        if (user) throw signInError('account_exists', 409);
        const setup = await readInstallationSetup(await getStore());
        if (setup.complete && !policy.selfRegistrationEnabled) throw signInError('registration_disabled', 403);
        return;
    }
    if (!user || user.status !== 'active' || !hasVerifiedMailbox(user)) throw signInError('account_not_found', 404);
    return { userId: user.id, generation: authGenerationOf(user), emailVerifiedAt: user.emailVerifiedAt };
}

export async function startEmailSignIn({ parent, browserProof, email, purpose, rateSource, resend = false, validateParent, deliver = sendAuthCode }) {
    if (validateParent) await validateParent();
    const issued = await issueChallenge({ parent, browserProof, email, purpose, rateSource, resend,
        precheck: (normalized) => precheckPurpose(purpose, normalized) });
    const outcome = await deliverCode(deliver, { to: issued.email, code: issued.code, correlationId: issued.correlationId });
    const delivery = developmentLogFallback({ to: issued.email, code: issued.code, delivery: outcome.delivery });
    const challenge = await recordDelivery({ parent, browserProof, generation: issued.generation, delivery,
        providerMessageId: outcome.providerMessageId, correlationId: issued.correlationId });
    if (delivery === 'failed') throw attemptError('delivery_failed', 502);
    if (!challenge) throw attemptError('attempt_invalid', 409);
    return { challenge };
}

export async function attemptStatus({ parent, browserProof }) {
    return describeAttempt(await readAttempt({ parent, browserProof }));
}

export function cancelSignIn({ parent, browserProof }) {
    return cancelAttempt({ parent, browserProof });
}

// Verifies the code and completes locally in one staged commit: registration
// creates the account through the setup decision; login resolves the existing
// verified mailbox. `prepareHandoff` (SSO) stages the Router handoff code in
// the same commit, so a lost response can replay it for this browser/parent.
export function completeEmailSignIn({ parent, browserProof, code, validateParent, prepareHandoff }) {
    return serializePersisted('users', async () => {
        if (validateParent) await validateParent();
        const store = await getStore();
        const checked = await checkChallengeCode({ parent, browserProof, code });
        if (checked.completed) {
            const { userId, generation, handoff } = checked.payload.completion || {};
            const user = await getUserById(userId);
            if (!user || user.status !== 'active' || generation !== authGenerationOf(user)) throw signInError('authentication_failed', 401);
            return { replayed: true, user: sanitizeUser(user), handoff: handoff || null };
        }
        const discard = async (error) => {
            await commitStagedPersistence(stageChallengeOutcome(store, parent, checked));
            throw error;
        };
        const policy = await getAuthPolicy();
        if (!policy.enabledAuthMethods.includes('emailCode')) return discard(signInError('auth_method_disabled', 404));
        if (checked.purpose === 'register') {
            // A late same-email account turns into sign-in; this registration
            // proof never authenticates an existing account.
            if (await getUserByEmail(checked.email)) return discard(signInError('account_exists', 409));
            let stageAccount;
            try {
                stageAccount = await prepareNewAccount({ email: checked.email, emailVerified: true, method: 'emailCode' });
            } catch (error) {
                if (error?.code === 'registration_disabled') return discard(signInError('registration_disabled', 403));
                throw error;
            }
            const stageHandoff = prepareHandoff ? await prepareHandoff() : null;
            return commitStagedPersistence(async () => {
                const account = await stageAccount();
                const handoff = stageHandoff ? await stageHandoff(account.user.id) : null;
                await stageChallengeOutcome(store, parent, checked, { userId: account.user.id, generation: authGenerationOf(account.user), handoff })();
                await recordAudit({ actorId: account.user.id, action: 'auth.emailcode.register', target: account.user.id, reason: parent.flow }, { save: false });
                return { user: account.user, roles: account.roles, created: true, initialAdministrator: account.initialAdministrator, handoff };
            });
        }
        const user = await getUserByEmail(checked.email);
        const account = checked.payload.account;
        if (!user || user.status !== 'active' || !hasVerifiedMailbox(user) || account?.userId !== user.id
            || account.generation !== authGenerationOf(user) || account.emailVerifiedAt !== user.emailVerifiedAt) {
            return discard(signInError('authentication_failed', 401));
        }
        const stageHandoff = prepareHandoff ? await prepareHandoff() : null;
        return commitStagedPersistence(async () => {
            const handoff = stageHandoff ? await stageHandoff(user.id) : null;
            await stageChallengeOutcome(store, parent, checked, { userId: user.id, generation: authGenerationOf(user), handoff })();
            await recordAudit({ actorId: user.id, action: 'auth.emailcode.verify', target: user.id, reason: parent.flow }, { save: false });
            return { user: sanitizeUser(user), roles: await getUserRoles(user.id), created: false, handoff };
        });
    });
}
