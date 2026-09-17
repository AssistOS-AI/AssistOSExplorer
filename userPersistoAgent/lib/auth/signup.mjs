import { getStore, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { withPersistenceScope } from '../persistence-scope.mjs';
import { getAuthPolicy } from '../policy.mjs';
import { authGenerationOf, getUserByEmail, normalizeEmail } from '../users.mjs';
import { prepareNewAccount, readInstallationSetup } from '../setup.mjs';
import { recordAudit } from '../audit.mjs';
import { sendAuthCode } from '../email-agent-client.mjs';
import { hashSecret, parseVerifier, verifySecret } from './password.mjs';
import { stagePasswordCredential, validateNewPassword } from './userPassword.mjs';
import { replayCompletion } from './signIn.mjs';
import {
    MAX_CODE_FAILURES,
    MAX_SENDS_PER_ATTEMPT,
    assertEmailVerifyBudget,
    attemptError,
    checkChallengeCode,
    consumeMemoryBudget,
    deliverCode,
    developmentLogFallback,
    issueChallenge,
    rateSourceKey,
    readAttempt,
    recordDelivery,
    spendSendBudgets,
    stageChallengeOutcome,
} from './emailAttempts.mjs';

// Email-first password signup. A pending signup is browser- and parent-bound
// staging inside the encrypted attempt: the scrypt verifier of the chosen
// password and a verifier id that the emailed code is bound to. It owns no
// email, role, setup claim or session. Only the locked completion creates the
// account, its password credential and, on an unclaimed installation, the
// setup record, then signs the browser in. Retries never carry the password:
// the primary verifier is reused. Only an email-shaped mixed-case password
// needs one extra case-folded scrypt verifier, encrypted with the attempt, so
// changing the address can enforce the case-insensitive email exclusion.
const SIGNUP_KDF_PER_SOURCE = 10;
const SIGNUP_KDF_SHARED = 100;
const DELIVERY_PURPOSE = 'signup-verification';
const REFUSALS = new Set(['account_exists', 'registration_disabled', 'auth_method_disabled']);

function signupError(code, statusCode) {
    const messages = {
        account_exists: 'An account already uses this email. Log in instead.',
        registration_disabled: 'Registration is not available.',
        auth_method_disabled: 'This sign-in method is not available.',
    };
    return Object.assign(new Error(messages[code] || 'Unable to continue.'), { code, statusCode });
}

// Registration rules for a password signup, checked before any staging and
// again inside the completion: the password method enabled, the installation
// unclaimed or self-registration allowed, and the address unowned. Existence is
// disclosed only when registration is otherwise possible. Caller holds the
// persistence scope.
async function assertSignupAllowed(email) {
    const policy = await getAuthPolicy();
    if (!policy.enabledAuthMethods.includes('password')) throw signupError('auth_method_disabled', 404);
    const setup = await readInstallationSetup(await getStore());
    if (setup.complete && !policy.selfRegistrationEnabled) throw signupError('registration_disabled', 403);
    if (await getUserByEmail(email)) throw signupError('account_exists', 409);
}

// Cheap, read-only refusals before any KDF work. A policy or ownership refusal
// spends the same send budgets as a refused code request.
async function precheckStart({ parent, browserProof, email, rateSource }) {
    const payload = await readAttempt({ parent, browserProof });
    if (payload.status === 'completed') throw attemptError('attempt_invalid', 409);
    if (payload.failures >= MAX_CODE_FAILURES) throw attemptError('too_many_attempts', 429);
    if (payload.sends >= MAX_SENDS_PER_ATTEMPT) {
        throw attemptError('rate_limited', 429, { retryAfter: Math.max(1, Math.ceil((parent.expiresAt - Date.now()) / 1000)), reason: 'send_limit' });
    }
    try {
        await withPersistenceScope(() => assertSignupAllowed(email));
    } catch (error) {
        if (REFUSALS.has(error?.code)) spendSendBudgets(email, rateSource);
        throw error;
    }
    await assertEmailVerifyBudget(email);
}

function emailShapedPassword(normalized) {
    try { return normalizeEmail(normalized) === normalized.toLowerCase(); } catch { return false; }
}

function spendSignupKdfBudget(rateSource) {
    const source = rateSourceKey(rateSource);
    consumeMemoryBudget('signup-kdf-source', source, source === 'shared' ? SIGNUP_KDF_SHARED : SIGNUP_KDF_PER_SOURCE);
}

// Delivers the code outside every store lock and answers with the public
// challenge whatever the outcome, because the verifier is already staged. A
// known failure and an interrupted delivery are retried with Send again.
async function deliverSignupCode({ parent, browserProof, issued, deliver }) {
    const outcome = await deliverCode(deliver, { to: issued.email, code: issued.code, correlationId: issued.correlationId, purpose: DELIVERY_PURPOSE });
    const delivery = developmentLogFallback({ to: issued.email, code: issued.code, delivery: outcome.delivery });
    const challenge = await recordDelivery({ parent, browserProof, generation: issued.generation, delivery,
        providerMessageId: outcome.providerMessageId, correlationId: issued.correlationId, template: DELIVERY_PURPOSE });
    if (!challenge) throw attemptError('attempt_invalid', 409);
    return { challenge };
}

export async function startSignup({ parent, browserProof, email, password, passwordConfirmation, rateSource = '', validateParent, deliver = sendAuthCode }) {
    let normalizedEmail;
    try { normalizedEmail = normalizeEmail(email); } catch { throw attemptError('invalid_email'); }
    const { normalized } = validateNewPassword({ password, passwordConfirmation, email: normalizedEmail });
    if (validateParent) await validateParent();
    await precheckStart({ parent, browserProof, email: normalizedEmail, rateSource });
    spendSignupKdfBudget(rateSource);
    const validateAdmission = async () => {
        if (validateParent) await validateParent();
        await precheckStart({ parent, browserProof, email: normalizedEmail, rateSource });
    };
    const verifier = await hashSecret(normalized, { validateAdmission });
    let emailComparisonVerifier = '';
    if (emailShapedPassword(normalized)) {
        if (normalized === normalized.toLowerCase()) emailComparisonVerifier = verifier;
        else {
            spendSignupKdfBudget(rateSource);
            emailComparisonVerifier = await hashSecret(normalized.toLowerCase(), { validateAdmission });
        }
    }
    const issued = await issueChallenge({ parent, browserProof, email: normalizedEmail, purpose: 'register', rateSource,
        signup: { verifier, ...(emailComparisonVerifier ? { emailComparisonVerifier } : {}) }, precheck: async (address) => {
            if (validateParent) await validateParent();
            await assertSignupAllowed(address);
        } });
    return deliverSignupCode({ parent, browserProof, issued, deliver });
}

// Resend code / Send again: a new generation for the same address with the
// staged verifier kept. The cooldown is skipped after a failed or interrupted
// delivery; the send cap and budgets still apply.
export async function resendSignup({ parent, browserProof, rateSource = '', validateParent, deliver = sendAuthCode }) {
    if (validateParent) await validateParent();
    const issued = await issueChallenge({ parent, browserProof, purpose: 'register', rateSource, resend: true,
        signup: 'retain', precheck: assertSignupAllowed });
    return deliverSignupCode({ parent, browserProof, issued, deliver });
}

// Change email: a new generation bound to another address, keeping the staged
// verifier so the password is not requested again.
export async function changeSignupEmail({ parent, browserProof, email, rateSource = '', validateParent, deliver = sendAuthCode }) {
    let normalizedEmail;
    try { normalizedEmail = normalizeEmail(email); } catch { throw attemptError('invalid_email'); }
    if (validateParent) await validateParent();
    const pending = await readAttempt({ parent, browserProof });
    if (pending.status !== 'active' || pending.purpose !== 'register' || !pending.signup) throw attemptError('signup_restart_required', 409);
    const validateChange = async () => {
        if (validateParent) await validateParent();
        await precheckStart({ parent, browserProof, email: normalizedEmail, rateSource });
        const current = await readAttempt({ parent, browserProof });
        if (current.signup?.verifierId !== pending.signup.verifierId) throw attemptError('signup_restart_required', 409);
    };
    await validateChange();
    if (pending.signup.emailComparisonVerifier) {
        if (!parseVerifier(pending.signup.emailComparisonVerifier)) throw attemptError('signup_restart_required', 409);
        spendSignupKdfBudget(rateSource);
        if (await verifySecret(normalizedEmail, pending.signup.emailComparisonVerifier, { validateAdmission: validateChange })) {
            throw Object.assign(new Error('Choose a password different from your email address.'), {
                code: 'invalid_password', statusCode: 400, reason: 'equals_email',
            });
        }
    }
    const issued = await issueChallenge({ parent, browserProof, email: normalizedEmail, purpose: 'register', rateSource,
        signup: 'retain', precheck: async (address) => {
            if (validateParent) await validateParent();
            await assertSignupAllowed(address);
            const current = await readAttempt({ parent, browserProof });
            if (current.signup?.verifierId !== pending.signup.verifierId) throw attemptError('signup_restart_required', 409);
        } });
    return deliverSignupCode({ parent, browserProof, issued, deliver });
}

// Verifies the signup code and creates the account in one staged commit under
// the users lock, inside the caller's parent lock. A refusal after the proof
// was verified consumes it and erases the staged verifier; a registration
// proof never authenticates or modifies an existing account. `prepareHandoff`
// (SSO) stages the Router handoff in the same commit; OIDC finishes the
// interaction afterwards as a second persistence boundary.
export function completeSignup({ parent, browserProof, code, validateParent, prepareHandoff }) {
    return serializePersisted('users', async () => {
        if (validateParent) await validateParent();
        const store = await getStore();
        const checked = await checkChallengeCode({ parent, browserProof, code, purpose: 'register' });
        if (checked.completed) return replayCompletion(checked.payload);
        const discard = async (error) => {
            await commitStagedPersistence(stageChallengeOutcome(store, parent, checked));
            throw error;
        };
        try {
            await assertSignupAllowed(checked.email);
        } catch (error) {
            if (REFUSALS.has(error?.code)) return discard(error);
            throw error;
        }
        if (!parseVerifier(checked.signup.verifier)) return discard(attemptError('signup_restart_required', 409));
        let stageAccount;
        try {
            stageAccount = await prepareNewAccount({ email: checked.email, emailVerified: true, method: 'passwordSignup' });
        } catch (error) {
            if (error?.code === 'registration_disabled') return discard(signupError('registration_disabled', 403));
            throw error;
        }
        const stageHandoff = prepareHandoff ? await prepareHandoff() : null;
        return commitStagedPersistence(async () => {
            const account = await stageAccount();
            await stagePasswordCredential(store, { userId: account.user.id, verifier: checked.signup.verifier });
            const handoff = stageHandoff ? await stageHandoff(account.user.id) : null;
            await stageChallengeOutcome(store, parent, checked, { userId: account.user.id, generation: authGenerationOf(account.user), handoff })();
            await recordAudit({ actorId: account.user.id, action: 'auth.password.register', target: account.user.id, reason: parent.flow }, { save: false });
            return { user: account.user, roles: account.roles, created: true, initialAdministrator: account.initialAdministrator, handoff };
        });
    });
}
