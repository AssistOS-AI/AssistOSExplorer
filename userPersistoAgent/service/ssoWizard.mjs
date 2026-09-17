import { serialize } from '../lib/serial.mjs';
import { authGenerationOf } from '../lib/users.mjs';
import { cancelGoogleTransactionForParent } from './googleAuth.mjs';
import { getLoginRequest, issueAuthCodeLocked, isAuthCodeLive, prepareSsoHandoff } from '../lib/sso.mjs';
import { attemptStatus, cancelSignIn, completeEmailSignIn, discoverAccount, startEmailSignIn } from '../lib/auth/signIn.mjs';
import { changeSignupEmail, completeSignup, resendSignup, startSignup } from '../lib/auth/signup.mjs';
import { loginWithUserPassword } from '../lib/auth/userPassword.mjs';
import { readCompletion } from '../lib/auth/emailAttempts.mjs';
import { wizardConfiguration } from '../lib/auth/wizardConfig.mjs';
import * as passkey from '../lib/auth/passkey.mjs';
import * as totp from '../lib/auth/totp.mjs';
import { isAuthMethodEnabled } from '../lib/policy.mjs';
import { getEmailAuthCodeStatus, sendAuthCode } from '../lib/email-agent-client.mjs';
import {
    assertSameOrigin,
    ensureBrowserProof,
    forwardedSecure,
    forwardedServicePath,
    rateSourceOf,
    readBrowserProof,
} from '../lib/auth/browserBinding.mjs';

// Router SSO adapter for the shared wizard. JSON completion returns the handoff
// code for the stored Router callback; the Router keeps its own state and
// initiating-browser binding. Every operation holds sso-request:<requestId>.
const ROUTES = new Set([
    '/service/auth/attempt',
    '/service/auth/attempt/cancel',
    '/service/auth/discover',
    '/service/auth/password/login',
    '/service/auth/signup/start',
    '/service/auth/signup/resend',
    '/service/auth/signup/email',
    '/service/auth/signup/verify',
    '/service/auth/email-code/start',
    '/service/auth/email-code/verify',
    '/service/auth/passkey/options',
    '/service/auth/passkey/verify',
    '/service/auth/totp/verify',
]);
// Operations that may send mail probe EmailAgent readiness outside every lock.
const EMAIL_PROBES = new Set([
    '/service/auth/attempt',
    '/service/auth/discover',
    '/service/auth/email-code/start',
    '/service/auth/signup/start',
    '/service/auth/signup/resend',
    '/service/auth/signup/email',
]);
const SIGNUP_DELIVERY = new Set(['/service/auth/signup/start', '/service/auth/signup/resend', '/service/auth/signup/email']);
const REPLAYABLE = new Set(['/service/auth/attempt', '/service/auth/email-code/verify', '/service/auth/signup/verify']);

function fail(code, statusCode, extra = {}) {
    return Object.assign(new Error(code), { code, statusCode, ...extra });
}

function text(body, name, max) {
    const value = body[name];
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > max) throw fail('invalid_request', 400);
    return value;
}

// Passwords are passed through unmodified and never truncated; the domain
// applies the raw, encoding and resource bounds with its specific refusals.
function secret(body, name) {
    return body[name];
}

function callbackPayload(issued, state) {
    return { ok: true, code: issued.code, redirectUri: issued.redirectUri, state: String(state || '') };
}

export function isSsoWizardRoute(path) {
    return ROUTES.has(path);
}

export function createSsoWizardHandlers({ deliverEmail = sendAuthCode, emailStatus = getEmailAuthCodeStatus } = {}) {
    async function liveParent(requestId) {
        const request = await getLoginRequest(requestId);
        return { flow: 'sso', id: requestId, expiresAt: Date.parse(request.expiresAt) };
    }

    // A browser whose completed response was lost can replay its own staged
    // handoff while that code is still unconsumed; otherwise it starts again.
    async function replay(req, requestId, state) {
        const completion = await readCompletion({ flow: 'sso', id: requestId, browserProof: readBrowserProof(req) });
        if (!completion?.handoff || !(await isAuthCodeLive({ providerState: requestId, code: completion.handoff.code }))) return null;
        return { ...callbackPayload(completion.handoff, state), replayed: true };
    }

    function requireBrowserProof(req) {
        const browserProof = readBrowserProof(req);
        if (!browserProof) throw fail('attempt_invalid', 400);
        return browserProof;
    }

    async function handle(req, res, path, body, sendJson) {
        if (!ROUTES.has(path)) return false;
        assertSameOrigin(req);
        const requestId = text(body, 'requestId', 128).trim();
        const state = text(body, 'state', 512);
        if (!requestId) throw fail('login_request_invalid', 400);
        const emailAvailable = EMAIL_PROBES.has(path) && (await emailStatus()).available === true;
        await serialize(`sso-request:${requestId}`, async () => {
            let parent;
            try {
                parent = await liveParent(requestId);
            } catch (error) {
                if (REPLAYABLE.has(path) && ['login_request_invalid', 'login_request_expired'].includes(error?.code)) {
                    const replayed = await replay(req, requestId, state);
                    if (replayed) return sendJson(res, 200, path === '/service/auth/attempt' ? { ok: true, completed: true, handoff: replayed } : replayed);
                }
                throw error;
            }
            const validateParent = async () => { await getLoginRequest(requestId); };
            const rateSource = rateSourceOf(req);
            const cookie = { path: forwardedServicePath(req), secure: forwardedSecure(req) };
            if (SIGNUP_DELIVERY.has(path) && !emailAvailable) throw fail('registration_disabled', 403);
            if (path === '/service/auth/attempt') {
                const browserProof = ensureBrowserProof(req, res, cookie);
                return sendJson(res, 200, { ok: true, expiresAt: parent.expiresAt, ...(await wizardConfiguration({ emailAvailable })),
                    attempt: await attemptStatus({ parent, browserProof }) });
            }
            if (path === '/service/auth/attempt/cancel') {
                if (body.googleTransaction !== undefined) {
                    await cancelGoogleTransactionForParent({ req, handle: text(body, 'googleTransaction', 128), flow: 'explorer', parentId: requestId });
                    return sendJson(res, 200, { ok: true, status: 'cancelled' });
                }
                const browserProof = readBrowserProof(req);
                return sendJson(res, 200, { ok: true, ...(browserProof ? await cancelSignIn({ parent, browserProof }) : { status: 'cancelled' }) });
            }
            if (path === '/service/auth/discover') {
                return sendJson(res, 200, { ok: true, ...(await discoverAccount({ parent, email: text(body, 'email', 320), rateSource, validateParent, emailAvailable })) });
            }
            if (path === '/service/auth/password/login') {
                if (!(await isAuthMethodEnabled('password'))) throw fail('auth_method_disabled', 404);
                const result = await loginWithUserPassword({ parent, email: text(body, 'email', 320), password: secret(body, 'password'), rateSource, validateParent });
                return sendJson(res, 200, callbackPayload(await issueAuthCodeLocked({ providerState: requestId, userId: result.user.id, generation: authGenerationOf(result.user) }), state));
            }
            if (path === '/service/auth/signup/start') {
                const browserProof = ensureBrowserProof(req, res, cookie);
                const started = await startSignup({ parent, browserProof, email: text(body, 'email', 320), password: secret(body, 'password'),
                    passwordConfirmation: secret(body, 'passwordConfirmation'), rateSource, validateParent, deliver: deliverEmail });
                return sendJson(res, 200, { ok: true, ...started });
            }
            if (path === '/service/auth/signup/resend') {
                const resent = await resendSignup({ parent, browserProof: requireBrowserProof(req), rateSource, validateParent, deliver: deliverEmail });
                return sendJson(res, 200, { ok: true, ...resent });
            }
            if (path === '/service/auth/signup/email') {
                const changed = await changeSignupEmail({ parent, browserProof: requireBrowserProof(req), email: text(body, 'email', 320),
                    rateSource, validateParent, deliver: deliverEmail });
                return sendJson(res, 200, { ok: true, ...changed });
            }
            if (path === '/service/auth/signup/verify') {
                const result = await completeSignup({ parent, browserProof: requireBrowserProof(req), code: text(body, 'code', 16), validateParent,
                    prepareHandoff: () => prepareSsoHandoff(requestId) });
                if (!result.handoff) throw fail('attempt_invalid', 409);
                return sendJson(res, 200, { ...callbackPayload(result.handoff, state),
                    ...(result.replayed ? { replayed: true } : { created: result.created, initialAdministrator: result.initialAdministrator }) });
            }
            if (path === '/service/auth/email-code/start') {
                if (!emailAvailable) throw fail('auth_method_disabled', 404);
                const browserProof = ensureBrowserProof(req, res, cookie);
                const started = await startEmailSignIn({ parent, browserProof, email: text(body, 'email', 320), purpose: text(body, 'purpose', 16),
                    resend: body.resend === true, rateSource, validateParent, deliver: deliverEmail });
                return sendJson(res, 200, { ok: true, ...started });
            }
            if (path === '/service/auth/email-code/verify') {
                const result = await completeEmailSignIn({ parent, browserProof: requireBrowserProof(req), code: text(body, 'code', 16), validateParent,
                    prepareHandoff: () => prepareSsoHandoff(requestId) });
                if (!result.handoff) throw fail('attempt_invalid', 409);
                return sendJson(res, 200, { ...callbackPayload(result.handoff, state), ...(result.replayed ? { replayed: true } : {}) });
            }
            if (path === '/service/auth/passkey/options' || path === '/service/auth/passkey/verify') {
                if (!(await isAuthMethodEnabled('passkey'))) throw fail('auth_method_disabled', 404);
                const origin = assertSameOrigin(req);
                const email = text(body, 'email', 320);
                const purpose = `sso-login:${requestId}`;
                if (path === '/service/auth/passkey/options') {
                    const result = await passkey.loginOptions({ email, origin, rpId: new URL(origin).hostname, purpose });
                    if (!result.ok) throw fail('authentication_failed', 401);
                    return sendJson(res, 200, result);
                }
                const result = await passkey.loginVerify({ email, assertion: body.assertion, challengeKey: text(body, 'challengeKey', 128), origin, purpose });
                if (!result.ok) throw fail('authentication_failed', 401);
                return sendJson(res, 200, callbackPayload(await issueAuthCodeLocked({ providerState: requestId, userId: result.user.id, generation: authGenerationOf(result.user) }), state));
            }
            if (path === '/service/auth/totp/verify') {
                if (!(await isAuthMethodEnabled('totp'))) throw fail('auth_method_disabled', 404);
                const result = await totp.loginVerify({ email: text(body, 'email', 320), token: text(body, 'token', 16) });
                if (!result.ok) throw result.reason === 'account_locked' ? fail('rate_limited', 429, { retryAfter: 300 }) : fail('authentication_failed', 401);
                return sendJson(res, 200, callbackPayload(await issueAuthCodeLocked({ providerState: requestId, userId: result.user.id, generation: authGenerationOf(result.user) }), state));
            }
            return sendJson(res, 404, { ok: false, error: 'not_found' });
        });
        return true;
    }
    return { handle };
}
