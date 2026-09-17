import { randomBytes } from 'node:crypto';
import { completeEmailSignIn, startEmailSignIn } from '../../lib/auth/signIn.mjs';
import { completeSignup, startSignup } from '../../lib/auth/signup.mjs';
import { resetEmailAttemptLimitsForTests } from '../../lib/auth/emailAttempts.mjs';
import { resetKdfForTests, setKdfProfileForTests } from '../../lib/auth/password.mjs';
import { resetPasswordLimitsForTests } from '../../lib/auth/userPassword.mjs';
import { createLoginRequest, prepareSsoHandoff } from '../../lib/sso.mjs';

// A deliberately small scrypt profile keeps fixture signups fast. It is set only
// through the construction-time test seam; suites that assert the production
// profile pass `{ kdf: null }`.
export const TEST_KDF_PROFILE = Object.freeze({ N: 1024, r: 8, p: 1 });

export function resetAuthLimitsForTests({ kdf = TEST_KDF_PROFILE } = {}) {
    resetEmailAttemptLimitsForTests();
    resetPasswordLimitsForTests();
    resetKdfForTests();
    if (kdf) setKdfProfileForTests(kdf);
}

export function newBrowserProof() {
    return randomBytes(32).toString('base64url');
}

// A fresh password per call that meets the creation policy. Never a literal
// committed to source; callers read it back from the returned fixture.
export function newTestPassword() {
    return `fixture ${randomBytes(18).toString('base64url')}`;
}

function capture() {
    const messages = [];
    return {
        messages,
        deliver: async (message) => {
            messages.push(message);
            return { delivered: true, providerMessageId: 'fixture-message' };
        },
    };
}

// Signs up through the real pending-signup operations against a live SSO
// parent, with a construction-time delivery capture. On an unclaimed
// installation the first call claims the administrator.
export async function signUpWithPassword(email, { password = newTestPassword(), redirectUri = 'http://127.0.0.1/auth/callback', browserProof = newBrowserProof() } = {}) {
    const request = await createLoginRequest({ redirectUri });
    const parent = { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) };
    const mail = capture();
    await startSignup({ parent, browserProof, email, password, passwordConfirmation: password, deliver: mail.deliver });
    const delivered = mail.messages.at(-1);
    const result = await completeSignup({ parent, browserProof, code: delivered.code, prepareHandoff: () => prepareSsoHandoff(request.providerState) });
    return { ...result, request, delivered, password, browserProof };
}

// Signs an existing account with a verified mailbox in with a login code.
export async function signInWithEmailCode(email, { redirectUri = 'http://127.0.0.1/auth/callback', browserProof = newBrowserProof() } = {}) {
    const request = await createLoginRequest({ redirectUri });
    const parent = { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) };
    const mail = capture();
    await startEmailSignIn({ parent, browserProof, email, purpose: 'login', deliver: mail.deliver });
    const delivered = mail.messages.at(-1);
    const result = await completeEmailSignIn({ parent, browserProof, code: delivered.code, prepareHandoff: () => prepareSsoHandoff(request.providerState) });
    return { ...result, request, delivered };
}
