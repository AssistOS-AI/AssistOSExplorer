import { getStore, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { getAuthPolicy } from '../policy.mjs';
import { authGenerationOf, getUserById, getUserByEmail, getUserRoles, hasVerifiedMailbox, normalizeEmail, sanitizeUser } from '../users.mjs';
import { recordAudit } from '../audit.mjs';
import { getInstallationSetup } from '../setup.mjs';
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
// parent. Completion-side protocol handoffs stay with each adapter. Email codes
// here only sign existing accounts in; signup verification lives in signup.mjs.
function signInError(code, statusCode) {
    const messages = {
        account_not_found: 'No account can sign in with this email.',
        auth_method_disabled: 'This sign-in method is not available.',
        authentication_failed: 'Unable to sign in.',
    };
    return Object.assign(new Error(messages[code] || 'Unable to continue.'), { code, statusCode });
}

async function methodsFor(user, policy, emailAvailable) {
    const enabled = policy.enabledAuthMethods;
    const methods = { password: false, emailCode: false, passkey: false, totp: false };
    if (!user || user.status !== 'active') return methods;
    const credentials = await (await getStore()).getAuthMethodsObjectsByUserId(user.id) || [];
    const enrolled = (type) => credentials.some((method) => method.type === type && method.enabled === true);
    methods.password = enabled.includes('password') && enrolled('password');
    methods.emailCode = emailAvailable && enabled.includes('emailCode') && hasVerifiedMailbox(user);
    methods.passkey = enabled.includes('passkey') && enrolled('passkey');
    methods.totp = enabled.includes('totp') && enrolled('totp');
    return methods;
}

// Minimal, advisory discovery: existence, initial setup availability and usable
// local method types.
// A blocked account reports every method false, so no field distinguishes a
// missing enrollment from blocked status. No credential names, identifiers,
// counts, timestamps, roles or Google linkage; pending signups are invisible.
export async function discoverAccount({ parent, email, rateSource, validateParent, emailAvailable = false }) {
    let normalized;
    try { normalized = normalizeEmail(email); } catch { throw attemptError('invalid_email'); }
    if (validateParent) await validateParent();
    discoveryBudget({ parent, rateSource });
    const user = await getUserByEmail(normalized);
    const policy = await getAuthPolicy();
    return { exists: Boolean(user), methods: await methodsFor(user, policy, emailAvailable),
        initialPasswordSetup: !user && !(await getInstallationSetup()).complete && policy.enabledAuthMethods.includes('password') };
}

// Login codes go only to an active account's verified mailbox.
async function precheckLogin(email) {
    const policy = await getAuthPolicy();
    if (!policy.enabledAuthMethods.includes('emailCode')) throw signInError('auth_method_disabled', 404);
    const user = await getUserByEmail(email);
    if (!user || user.status !== 'active' || !hasVerifiedMailbox(user)) throw signInError('account_not_found', 404);
    return { userId: user.id, generation: authGenerationOf(user), emailVerifiedAt: user.emailVerifiedAt };
}

export async function startEmailSignIn({ parent, browserProof, email, purpose, rateSource, resend = false, validateParent, deliver = sendAuthCode }) {
    if (purpose !== 'login') throw attemptError('invalid_request');
    if (validateParent) await validateParent();
    const issued = await issueChallenge({ parent, browserProof, email, purpose, rateSource, resend, precheck: precheckLogin });
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

// Replays a committed completion (login or signup) to the same browser and
// parent after rechecking the account's status and generation.
export async function replayCompletion(payload) {
    const { userId, generation, handoff } = payload.completion || {};
    const user = await getUserById(userId);
    if (!user || user.status !== 'active' || generation !== authGenerationOf(user)) throw signInError('authentication_failed', 401);
    return { replayed: true, user: sanitizeUser(user), handoff: handoff || null };
}

// Verifies a login code and completes locally in one staged commit for the
// existing verified mailbox. `prepareHandoff` (SSO) stages the Router handoff
// code in the same commit, so a lost response can replay it for this
// browser/parent.
export function completeEmailSignIn({ parent, browserProof, code, validateParent, prepareHandoff }) {
    return serializePersisted('users', async () => {
        if (validateParent) await validateParent();
        const store = await getStore();
        const checked = await checkChallengeCode({ parent, browserProof, code, purpose: 'login' });
        if (checked.completed) return replayCompletion(checked.payload);
        const discard = async (error) => {
            await commitStagedPersistence(stageChallengeOutcome(store, parent, checked));
            throw error;
        };
        const policy = await getAuthPolicy();
        if (!policy.enabledAuthMethods.includes('emailCode')) return discard(signInError('auth_method_disabled', 404));
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
