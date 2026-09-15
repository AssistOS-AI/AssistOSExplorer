import { randomBytes } from 'node:crypto';
import { completeEmailSignIn, startEmailSignIn } from '../../lib/auth/signIn.mjs';
import { resetEmailAttemptLimitsForTests } from '../../lib/auth/emailAttempts.mjs';
import { createLoginRequest, prepareSsoHandoff } from '../../lib/sso.mjs';

export function resetAuthLimitsForTests() {
    resetEmailAttemptLimitsForTests();
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
