import { randomBytes } from 'node:crypto';
import { completeAdministratorPassword, resetAdministratorPasswordForTests } from '../../lib/auth/adminPassword.mjs';
import { completeEmailSignIn, startEmailSignIn } from '../../lib/auth/signIn.mjs';
import { resetEmailAttemptLimitsForTests } from '../../lib/auth/emailAttempts.mjs';
import { createLoginRequest, prepareSsoHandoff } from '../../lib/sso.mjs';

// A fresh deployment administrator password per process. Never a literal
// committed to source; tests read it back from the environment they set.
export function configureAdministratorPassword() {
    const password = `fixture-${randomBytes(18).toString('base64url')}`;
    process.env.USERPERSISTO_ADMIN_PASSWORD = password;
    resetAdministratorPasswordForTests();
    return password;
}

export function clearAdministratorPassword() {
    delete process.env.USERPERSISTO_ADMIN_PASSWORD;
    resetAdministratorPasswordForTests();
}

export function resetAuthLimitsForTests() {
    resetAdministratorPasswordForTests();
    resetEmailAttemptLimitsForTests();
}

// Claims or signs into the installation through the real configured
// administrator-password decision (no injected roles or sessions).
export async function claimAdministrator(password = process.env.USERPERSISTO_ADMIN_PASSWORD, options = {}) {
    return completeAdministratorPassword({ password, ...options });
}

export function newBrowserProof() {
    return randomBytes(32).toString('base64url');
}

// Completes the real verified-email path against a live SSO parent using a
// construction-time delivery capture. Returns the domain completion.
export async function signInWithEmailCode(email, { purpose = 'register', redirectUri = 'http://127.0.0.1/auth/callback', browserProof = newBrowserProof() } = {}) {
    const request = await createLoginRequest({ redirectUri });
    const parent = { flow: 'sso', id: request.providerState, expiresAt: Date.parse(request.expiresAt) };
    let delivered;
    await startEmailSignIn({ parent, browserProof, email, purpose, deliver: async (message) => {
        delivered = message;
        return { delivered: true, providerMessageId: 'fixture-message' };
    } });
    const result = await completeEmailSignIn({ parent, browserProof, code: delivered.code, prepareHandoff: () => prepareSsoHandoff(request.providerState) });
    return { ...result, request, delivered };
}

export function registerWithEmailCode(email, options = {}) {
    return signInWithEmailCode(email, { ...options, purpose: 'register' });
}
