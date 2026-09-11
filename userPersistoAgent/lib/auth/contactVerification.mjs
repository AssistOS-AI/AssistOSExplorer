import { getStore, commitStagedPersistence } from '../store.mjs';
import { serializePersisted } from '../serial.mjs';
import { recordAudit } from '../audit.mjs';
import { authGenerationOf, getUserByEmail, getUserById, hasVerifiedMailbox, normalizeEmail } from '../users.mjs';
import { sendAuthCode } from '../email-agent-client.mjs';
import { attemptError } from './emailAttempts.mjs';
import { checkAccountCode, readAccountChallenge, sendAccountCode } from './accountCodes.mjs';
import { consumeOperationGrant } from './operationGrants.mjs';

// The configured-password administrator starts without a sign-in mailbox; its
// optional contact address is unverified and is never a sign-in, Google-link or
// recovery authority. After fresh re-authentication the account proves an
// address with a code, which then becomes its verified sign-in email. This never
// replaces an existing verified mailbox (there is no general email change).
function contactError(code, statusCode) {
    const messages = {
        email_taken: 'Another account already uses this email.',
        sign_in_email_exists: 'This account already has a verified sign-in email.',
        email_change_unsupported: 'Only the address already on this account can be verified.',
        user_not_active: 'Account is not active.',
    };
    return Object.assign(new Error(messages[code] || 'Unable to verify this email.'), { code, statusCode });
}

function assertEligible(user, email) {
    if (hasVerifiedMailbox(user)) throw contactError('sign_in_email_exists', 409);
    if (user.email && user.email !== email) throw contactError('email_change_unsupported', 400);
}

export async function startContactVerification({ userId, email, grant, resend = false, deliver = sendAuthCode }) {
    let normalized;
    try { normalized = normalizeEmail(email); } catch { throw attemptError('invalid_email'); }
    // Predictable refusals come first so they do not spend the grant.
    let user = await getUserById(userId);
    if (!user || user.status !== 'active') throw contactError('user_not_active', 403);
    assertEligible(user, normalized);
    if (await getUserByEmail(normalized)) throw contactError('email_taken', 409);
    let generation;
    if (resend) {
        // A resend continues the proof started with a grant for the same address.
        const pending = await readAccountChallenge({ userId, purpose: 'contact-verify' });
        if (!pending || pending.meta.email !== normalized || pending.meta.generation !== authGenerationOf(user)) throw attemptError('attempt_invalid', 409);
        generation = pending.meta.generation;
    } else {
        ({ user, generation } = await consumeOperationGrant({ userId, operation: 'contact.verify', grant }));
        assertEligible(user, normalized);
    }
    const challenge = await sendAccountCode({ userId: user.id, purpose: 'contact-verify', email: normalized, operation: 'contact.verify',
        accountGeneration: generation, resend, deliver });
    return { challenge };
}

// Verifies the code and installs the proven address as the verified sign-in
// email in one staged commit, rechecking eligibility and uniqueness under the
// users lock. Nothing is replaced, so the account generation is unchanged.
export function completeContactVerification({ userId, code }) {
    return serializePersisted('users', async () => {
        const user = await getUserById(userId);
        if (!user || user.status !== 'active') throw contactError('user_not_active', 403);
        const checked = await checkAccountCode({ userId, purpose: 'contact-verify', code, operation: 'contact.verify' });
        const email = checked.meta.email;
        const discard = async (error) => {
            await commitStagedPersistence(checked.consume);
            throw error;
        };
        if (checked.meta.generation !== authGenerationOf(user)) return discard(attemptError('attempt_invalid', 409));
        try { assertEligible(user, email); } catch (error) { return discard(error); }
        if (await getUserByEmail(email)) return discard(contactError('email_taken', 409));
        const store = await getStore();
        const now = new Date().toISOString();
        await commitStagedPersistence(async () => {
            await checked.consume();
            // The email is the unique index key; only the indexed setter re-keys it.
            if (user.email !== email) await store.setEmailForUser(user.id, email);
            await store.updateUser(user.id, { emailVerifiedAt: now, contactEmail: email, updatedAt: now });
            await recordAudit({ actorId: user.id, action: 'user.email.verify', target: user.id, reason: 'contact-verification' }, { save: false });
        });
        return { ok: true, email };
    });
}
